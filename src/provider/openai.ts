import type { Message, Usage } from "../core/types.ts"
import type { ModelInfo, ModelRequest, ProviderClient, StreamEvent } from "./types.ts"

export interface OpenAIConfig {
  baseURL?: string
  apiKey: string
  headers?: Record<string, string>
  /** Mặc định cho mọi model của provider; `models[id]` đè lên. */
  contextWindow?: number
  maxOutput?: number
  models?: Record<string, Partial<ModelInfo>>
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

/** OpenAI Chat Completions, tương thích với mọi gateway cùng wire format. */
export class OpenAIProvider implements ProviderClient {
  private baseURL: string
  constructor(private cfg: OpenAIConfig) {
    this.baseURL = (cfg.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "")
  }

  info(model: string): ModelInfo {
    const o = this.cfg.models?.[model] ?? {}
    return { id: model, contextWindow: o.contextWindow ?? this.cfg.contextWindow ?? 128_000, maxOutput: o.maxOutput ?? this.cfg.maxOutput ?? 16_384 }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...request.system.map((content) => ({ role: "system", content }) as ChatMessage),
        ...toChatMessages(request.messages),
      ],
      tools: request.tools.length
        ? request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined,
      tool_choice: request.tools.length ? (request.toolChoice ?? "auto") : undefined,
      max_tokens: request.maxOutputTokens,
    }

    let res: Response
    try {
      res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}`, ...this.cfg.headers },
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      yield { type: "error", error: e as Error, retryable: true }
      return
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "")
      const retryable = res.status === 429 || res.status >= 500
      const hint =
        res.status === 401 || res.status === 403
          ? ` — API key bị từ chối bởi ${this.baseURL}. Kiểm tra lại key trong Cài đặt.`
          : res.status === 404 || (res.status === 400 && !text.trim())
            ? ` — kiểm tra Base URL (thường kết thúc bằng /v1) và tên model "${request.model}" có trong danh sách model của provider.`
            : ""
      yield { type: "error", error: new Error(`${res.status} ${text.slice(0, 500)}${hint}`), retryable, retryAfterMs: retryAfter(res.headers) }
      return
    }

    const calls = new Map<number, { id: string; name: string; args: string }>()
    let finish: "stop" | "tool-calls" | "length" | "error" = "stop"
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }

    for await (const data of sse(res.body, signal)) {
      if (data === "[DONE]") break
      const chunk = JSON.parse(data)
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
        }
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (delta.content) yield { type: "text-delta", text: delta.content }
      if (delta.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content }
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        calls.set(tc.index, cur)
      }
      if (choice.finish_reason) {
        finish = choice.finish_reason === "tool_calls" ? "tool-calls" : choice.finish_reason === "length" ? "length" : "stop"
      }
    }

    // Bị dừng giữa stream: args có thể dở dang → không phát tool-call nào.
    if (signal.aborted) return
    for (const c of [...calls.values()]) {
      let args: unknown
      try {
        args = c.args ? JSON.parse(c.args) : {}
      } catch {
        args = { __raw: c.args }
      }
      yield { type: "tool-call", callID: c.id, name: c.name, args }
    }
    yield { type: "finish", reason: calls.size ? "tool-calls" : finish, usage }
  }
}

/** `retry-after-ms` (OpenAI) hoặc `retry-after` (giây hoặc HTTP date). */
export function retryAfter(h: Headers): number | undefined {
  const ms = Number(h.get("retry-after-ms"))
  if (ms > 0) return ms
  const v = h.get("retry-after")
  if (!v) return undefined
  const s = Number(v)
  if (s > 0) return s * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function toChatMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      out.push({ role: m.role, content: text })
    } else if (m.role === "assistant") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
      const calls = m.parts.filter((p) => p.type === "tool-call")
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.length
          ? calls.map((c) => ({ id: c.callID, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
          : undefined,
      })
      for (const r of m.parts.filter((p) => p.type === "tool-result")) {
        out.push({ role: "tool", tool_call_id: r.callID, content: r.output })
      }
    }
  }
  return out
}

export async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line.startsWith("data:")) yield line.slice(5).trim()
      }
    }
  } finally {
    reader.releaseLock()
  }
}
