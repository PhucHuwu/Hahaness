import type { Message, Usage } from "../core/types.ts"
import type { ModelInfo, ModelRequest, ProviderClient, StreamEvent } from "./types.ts"
import { retryAfter, sse } from "./openai.ts"

export interface AnthropicConfig {
  baseURL?: string
  apiKey: string
  headers?: Record<string, string>
  models?: Record<string, Partial<ModelInfo>>
}

type Block =
  | { type: "text"; text: string; cache_control?: Cache }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: Cache }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: Cache }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: Cache }
type Cache = { type: "ephemeral" }
export type AnthropicMessage = { role: "user" | "assistant"; content: Block[] }

const EPHEMERAL: Cache = { type: "ephemeral" }
const VERSION = "2023-06-01"

/**
 * Anthropic Messages API (SSE). Prompt cache: breakpoint ở system cuối, tool cuối và block cuối
 * của message cuối; system đóng băng trong phiên nên prefix trúng cache từ lượt thứ hai.
 */
export class AnthropicProvider implements ProviderClient {
  private baseURL: string
  constructor(private cfg: AnthropicConfig) {
    this.baseURL = (cfg.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "").replace(/\/v1$/, "")
  }

  info(model: string): ModelInfo {
    const o = this.cfg.models?.[model] ?? {}
    return { id: model, contextWindow: o.contextWindow ?? 200_000, maxOutput: o.maxOutput ?? 16_384 }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await this.post(requestBody(request, this.info(request.model).maxOutput), signal).catch((e: Error) => e)
    if (res instanceof Error) {
      yield { type: "error", error: res, retryable: true }
      return
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "")
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500
      const hint =
        res.status === 401 || res.status === 403
          ? ` — API key bị từ chối bởi ${this.baseURL}. Kiểm tra lại key trong Cài đặt.`
          : res.status === 404
            ? ` — kiểm tra Base URL và tên model "${request.model}".`
            : ""
      yield { type: "error", error: new Error(`${res.status} ${errorText(text)}${hint}`), retryable, retryAfterMs: retryAfter(res.headers) }
      return
    }

    const blocks = new Map<number, { id: string; name: string; json: string }>()
    const calls: Array<{ id: string; name: string; json: string }> = []
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let finish: "stop" | "tool-calls" | "length" | "error" = "stop"

    for await (const data of sse(res.body, signal)) {
      let ev: any
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {}
          const cacheRead = u.cache_read_input_tokens ?? 0
          // input_tokens chỉ là phần không trúng cache; loop cần tổng prompt để quyết định compaction.
          usage = { inputTokens: (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0, cacheReadTokens: cacheRead || undefined }
          break
        }
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" })
          break
        case "content_block_delta": {
          const d = ev.delta ?? {}
          if (d.type === "text_delta") yield { type: "text-delta", text: d.text }
          else if (d.type === "thinking_delta") yield { type: "reasoning-delta", text: d.thinking }
          else if (d.type === "input_json_delta") {
            const b = blocks.get(ev.index)
            if (b) b.json += d.partial_json
          }
          break
        }
        case "content_block_stop": {
          const b = blocks.get(ev.index)
          if (b) calls.push(b)
          blocks.delete(ev.index)
          break
        }
        case "message_delta":
          if (ev.usage?.output_tokens !== undefined) usage = { ...usage, outputTokens: ev.usage.output_tokens }
          if (ev.delta?.stop_reason) finish = stopReason(ev.delta.stop_reason)
          break
        case "error": {
          const kind = ev.error?.type ?? "error"
          yield { type: "error", error: new Error(`${kind}: ${ev.error?.message ?? "stream error"}`), retryable: kind === "overloaded_error" || kind === "api_error" || kind === "rate_limit_error" }
          return
        }
      }
    }

    if (signal.aborted) return
    for (const c of calls) {
      let args: unknown
      try {
        args = c.json ? JSON.parse(c.json) : {}
      } catch {
        args = { __raw: c.json }
      }
      yield { type: "tool-call", callID: c.id, name: c.name, args }
    }
    yield { type: "finish", reason: calls.length ? "tool-calls" : finish, usage }
  }

  private post(body: unknown, signal: AbortSignal) {
    return fetch(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.cfg.apiKey, "anthropic-version": VERSION, ...this.cfg.headers },
      body: JSON.stringify(body),
      signal,
    })
  }
}

function stopReason(r: string): "stop" | "tool-calls" | "length" {
  if (r === "tool_use") return "tool-calls"
  if (r === "max_tokens") return "length"
  return "stop"
}

/** `{"type":"error","error":{"type":"…","message":"prompt is too long: …"}}` → message gọn (giữ chữ để isOverflow nhận ra). */
function errorText(text: string) {
  try {
    const j = JSON.parse(text)
    if (j?.error?.message) return `${j.error.type ?? "error"}: ${j.error.message}`.slice(0, 500)
  } catch {}
  return text.slice(0, 500)
}

export function requestBody(request: ModelRequest, maxOutput: number) {
  const system = request.system.filter((s) => s.trim()).map((text) => ({ type: "text" as const, text }))
  if (system.length) system[system.length - 1] = { ...system.at(-1)!, cache_control: EPHEMERAL } as any
  const tools = request.tools.map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }))
  const messages = toAnthropicMessages(request.messages)
  const last = messages.at(-1)?.content.at(-1)
  if (last) last.cache_control = EPHEMERAL
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? maxOutput,
    stream: true,
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: request.toolChoice === "none" ? "none" : "auto" } } : {}),
  }
}

/**
 * Message nội bộ → Anthropic: role phải luân phiên user/assistant, tool_result nằm trong
 * message user ngay sau tool_use. Message `system` giữa phiên (notice, workspace-update) đi dạng user.
 * Reasoning không gửi lại (không có chữ ký thinking).
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const push = (role: "user" | "assistant", content: Block[]) => {
    if (!content.length) return
    const prev = out.at(-1)
    if (prev?.role === role) prev.content.push(...content)
    else out.push({ role, content })
  }
  for (const m of messages) {
    if (m.role === "assistant") {
      const content: Block[] = []
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text })
        else if (p.type === "tool-call") content.push({ type: "tool_use", id: p.callID, name: p.name, input: p.args ?? {} })
      }
      push("assistant", content)
      push(
        "user",
        m.parts.flatMap((p) => (p.type === "tool-result" ? [{ type: "tool_result" as const, tool_use_id: p.callID, content: p.output || "(empty)", ...(p.isError ? { is_error: true } : {}) }] : [])),
      )
    } else {
      push(
        "user",
        m.parts.flatMap((p): Block[] =>
          p.type === "text" && p.text ? [{ type: "text", text: p.text }] : p.type === "image" ? [{ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }] : [],
        ),
      )
    }
  }
  // tool_result phải đứng trước text trong cùng message user.
  for (const m of out) if (m.role === "user") m.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"))
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] })
  return out
}
