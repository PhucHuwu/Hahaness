import type { Compaction, Message } from "../core/types.ts"
import type { ProviderClient } from "../provider/types.ts"
import { id } from "../core/id.ts"
import { estimateMessage } from "./budget.ts"

export const PROTECT_FIRST = 2
export const PROTECT_LAST = 20
export const KEEP_RECENT_TOKENS = 15_000
export const PRUNE_MIN_CHARS = 200

export const SUMMARY_PROMPT = `Context is about to be compacted. Write a checkpoint summary of the conversation so far using EXACTLY these headings:

## Objective
## Constraints & Requirements
## Decisions Made
## Work State
## Relevant Files
## Active Subagents
## Next Move
## Important Context

Preserve all opaque identifiers exactly as written: UUIDs, hashes, session IDs, paths, ports, URLs, error messages. Be specific; omit pleasantries.`

/** Pha 1: tool result cũ (ngoài PROTECT_LAST) và dài → thay bằng placeholder. Không ghi store. */
export function prune(messages: Message[]): Message[] {
  const cut = Math.max(0, messages.length - PROTECT_LAST)
  return messages.map((m, i) => {
    if (i >= cut || m.role !== "assistant") return m
    return {
      ...m,
      parts: m.parts.map((p) =>
        p.type === "tool-result" && p.output.length > PRUNE_MIN_CHARS
          ? { ...p, output: `[tool output pruned: ${p.name}]` }
          : p,
      ),
    }
  })
}

/** Pha 2: index của message đầu tiên giữ nguyên văn; lùi để không cắt đôi cặp tool-call/result. */
export function keepBoundary(messages: Message[]): number {
  let tokens = 0
  let i = messages.length
  while (i > PROTECT_FIRST) {
    const m = messages[i - 1]!
    tokens += estimateMessage(m)
    if (tokens >= KEEP_RECENT_TOKENS) break
    i--
  }
  while (i > PROTECT_FIRST && i < messages.length && messages[i]!.role === "assistant" && messages[i]!.parts.some((p) => p.type === "tool-result")) {
    i--
  }
  return Math.min(i, messages.length)
}

/** Pha 3: gửi toàn bộ request hiện có + summary prompt để tận dụng cache. */
export async function summarize(
  provider: ProviderClient,
  model: string,
  system: string[],
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  const ask: Message = { id: id("msg"), role: "user", parts: [{ type: "text", text: SUMMARY_PROMPT }], createdAt: Date.now() }
  let text = ""
  for await (const ev of provider.stream({ model, system, messages: [...messages, ask], tools: [], toolChoice: "none" }, signal)) {
    if (ev.type === "text-delta") text += ev.text
    if (ev.type === "error") throw ev.error
  }
  if (!text.includes("## Objective")) throw new Error("compaction: summary missing required headings")
  return text
}

/** Build messages gửi model từ checkpoint gần nhất. */
export function fromCheckpoint(messages: Message[], compaction: Compaction | undefined): Message[] {
  if (!compaction) return messages
  const idx = messages.findIndex((m) => m.id === compaction.keepFromID)
  const recent = idx >= 0 ? messages.slice(idx) : messages.slice(-PROTECT_LAST)
  const checkpoint: Message = {
    id: compaction.id,
    role: "user",
    source: "system",
    createdAt: compaction.createdAt,
    parts: [{ type: "text", text: `<conversation-checkpoint>\n<summary>\n${compaction.summary}\n</summary>\n</conversation-checkpoint>\nThe messages below are the most recent context. Continue from "Next Move".` }],
  }
  return [checkpoint, ...recent]
}
