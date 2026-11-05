import type { ModelInfo, ModelRequest, ProviderClient, StreamEvent } from "../../src/provider/types.ts"

/**
 * Custom provider mẫu. Config:
 *   "echo": { "type": "custom", "module": "examples/providers/echo.ts", "options": { "reply": "pong" } }
 *
 * Factory nhận (options, { id, cwd }) và trả ProviderClient. Có thể async.
 */
export default function create(options: { reply?: string }): ProviderClient {
  return {
    info(model: string): ModelInfo {
      return { id: model, contextWindow: 32_000, maxOutput: 4_000 }
    },
    async *stream(request: ModelRequest, _signal: AbortSignal): AsyncIterable<StreamEvent> {
      const last = request.messages.at(-1)
      const userText = last?.parts.find((p) => p.type === "text")?.text ?? ""
      const text = options.reply ?? `echo: ${userText}`
      yield { type: "text-delta", text }
      yield { type: "finish", reason: "stop", usage: { inputTokens: Math.ceil(userText.length / 4), outputTokens: Math.ceil(text.length / 4) } }
    },
  }
}
