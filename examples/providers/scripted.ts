/**
 * Provider giả cho test server: trả lời theo kịch bản cố định, không gọi mạng.
 * - Có tool `echo-test_echo` (MCP) → gọi nó một lần rồi trả lời.
 * - Ngược lại → trả "reply: <text của message user cuối>".
 */
import type { ModelRequest, ProviderClient, StreamEvent } from "../../src/provider/types.ts"

export default function create(): ProviderClient {
  return {
    info: () => ({ id: "scripted", contextWindow: 100_000, maxOutput: 4_000 }),
    async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
      const last = req.messages.at(-1)
      const lastText = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? ""
      const hasEcho = req.tools.some((t) => t.name === "echo-test_echo")
      const alreadyCalled = req.messages.some((m) => m.parts.some((p) => p.type === "tool-call" && p.name === "echo-test_echo"))
      if (hasEcho && !alreadyCalled && /mcp/i.test(lastText)) {
        yield { type: "tool-call", callID: "mcp1", name: "echo-test_echo", args: { text: "hi" } }
        yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } }
        return
      }
      const result = last?.parts.find((p) => p.type === "tool-result")
      const text = result ? `tool said: ${result.output}` : `reply: ${lastText}`
      for (const chunk of text.match(/.{1,6}/g) ?? []) yield { type: "text-delta", text: chunk }
      yield { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
}
