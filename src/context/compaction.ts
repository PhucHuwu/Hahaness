import type { Compaction, Message, Part } from "../core/types.ts"
import type { ProviderClient } from "../provider/types.ts"
import { id } from "../core/id.ts"
import { estimateMessage } from "./budget.ts"

export const PROTECT_FIRST = 2
export const PROTECT_LAST = 20
export const KEEP_RECENT_TOKENS = 15_000
export const PRUNE_MIN_CHARS = 200
/** Overflow recovery: mỗi lần provider vẫn báo tràn, phần giữ nguyên văn thu nhỏ theo hệ số kế tiếp; hết thì báo lỗi. */
export const OVERFLOW_SHRINK = [0.85, 0.7, 0.5] as const
export const SUMMARY_MAX_OUTPUT = 8_000
/** Messages cuối luôn giữ nguyên trong input summarize (không clip). */
const SUMMARY_TAIL = 4
const CLIP_CHARS = 2_000

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

export const REQUIRED_HEADINGS = ["## Objective", "## Work State", "## Next Move"]

export const SUMMARY_NUDGE =
  "Your summary is missing required headings: {missing}. Rewrite the whole summary using EXACTLY the headings listed before, in that order. Output only the summary."

export const NO_REPLY = "NO_REPLY"
export const MEMORY_FLUSH_PROMPT = `[harness] Context will be compacted now: older messages will be replaced by a summary. If this conversation contains anything that must be remembered in FUTURE conversations (CEO decisions, preferences, recurring facts about the company), save it now with the \`memory\` tool. Do not save task progress; the summary keeps that. If there is nothing to save, reply exactly ${NO_REPLY}.`

const OVERFLOW = /context.{0,30}(length|window|limit|exceed)|too long|too many tokens|maximum.{0,30}tokens|exceeds?.{0,30}(context|token)/i

/** Provider báo request vượt context window (mỗi gateway viết một kiểu). */
export function isOverflow(message: string) {
  return OVERFLOW.test(message)
}

/**
 * Pha 1: tool result cũ (ngoài PROTECT_LAST) và dài → placeholder. Skill đã load → `[SKILL_PRUNED: id]`
 * để model biết gọi lại. Không ghi store.
 */
export function prune(messages: Message[]): Message[] {
  const cut = Math.max(0, messages.length - PROTECT_LAST)
  return messages.map((m, i) => (i >= cut || m.role !== "assistant" ? m : { ...m, parts: m.parts.map((p) => prunePart(m, p)) }))
}

function prunePart(m: Message, p: Part): Part {
  if (p.type !== "tool-result") return p
  if (p.name === "skill" && !p.isError) return { ...p, output: `[SKILL_PRUNED: ${skillID(m, p.callID)}] Call \`skill\` again if you need it.` }
  return p.output.length > PRUNE_MIN_CHARS ? { ...p, output: `[tool output pruned: ${p.name}]` } : p
}

function skillID(m: Message, callID: string) {
  const call = m.parts.find((x) => x.type === "tool-call" && x.callID === callID)
  const args = call?.type === "tool-call" ? (call.args as { id?: unknown }) : undefined
  return typeof args?.id === "string" ? args.id : "?"
}

/** Pha 2: index của message đầu tiên giữ nguyên văn; lùi để không cắt đôi cặp tool-call/result. */
export function keepBoundary(messages: Message[], keepRecentTokens = KEEP_RECENT_TOKENS): number {
  let tokens = 0
  let i = messages.length
  while (i > PROTECT_FIRST) {
    const m = messages[i - 1]!
    tokens += estimateMessage(m)
    if (tokens >= keepRecentTokens) break
    i--
  }
  while (i > PROTECT_FIRST && i < messages.length && messages[i]!.role === "assistant" && messages[i]!.parts.some((p) => p.type === "tool-result")) {
    i--
  }
  return Math.min(i, messages.length)
}

const size = (ms: Message[]) => ms.reduce((n, m) => n + estimateMessage(m), 0)

/**
 * Request summarize không được tràn chính nó. Nặng dần tới khi vừa `budget` token:
 * clip text/output dài → bỏ hết tool output → bỏ message cũ nhất (sau PROTECT_FIRST).
 * SUMMARY_TAIL message cuối không bị đụng ở hai mức đầu.
 */
export function fitForSummary(messages: Message[], budget: number): Message[] {
  if (size(messages) <= budget) return messages
  const older = (ms: Message[], f: (m: Message) => Message) => ms.map((m, i) => (i >= ms.length - SUMMARY_TAIL ? m : f(m)))
  let out = older(messages, (m) => ({ ...m, parts: m.parts.map(clip) }))
  if (size(out) <= budget) return out
  out = older(out, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "tool-result" ? { ...p, output: `[tool output removed: ${p.name}]` } : p)) }))
  if (size(out) <= budget) return out

  const head = out.slice(0, PROTECT_FIRST)
  let total = size(out) + 20
  let start = PROTECT_FIRST
  while (start < out.length - 1 && total > budget) total -= estimateMessage(out[start++]!)
  const dropped = start - PROTECT_FIRST
  let rest = out.slice(start)
  if (size(rest) > budget) rest = rest.map((m) => ({ ...m, parts: m.parts.map(clip) }))
  const note: Message = { id: id("msg"), role: "user", source: "system", createdAt: rest[0]?.createdAt ?? Date.now(), parts: [{ type: "text", text: `[${dropped} earlier messages omitted to fit the summary request]` }] }
  return dropped > 0 ? [...head, note, ...rest] : [...head, ...rest]
}

function clip(p: Part): Part {
  if ((p.type === "text" || p.type === "reasoning") && p.text.length > CLIP_CHARS) return { ...p, text: p.text.slice(0, CLIP_CHARS) + "\n…[clipped]" }
  if (p.type === "tool-result" && p.output.length > CLIP_CHARS) return { ...p, output: p.output.slice(0, CLIP_CHARS) + "\n…[clipped]" }
  return p
}

export function missingHeadings(text: string) {
  return REQUIRED_HEADINGS.filter((h) => !text.includes(h))
}

/** Pha 3: messages hiện có + summary prompt (cùng prefix → tận dụng cache). Thiếu heading → thử lại 1 lần với nudge. */
export async function summarize(provider: ProviderClient, model: string, system: string[], messages: Message[], signal: AbortSignal): Promise<string> {
  const convo = [...messages, userMessage(SUMMARY_PROMPT)]
  let text = await once(provider, model, system, convo, signal)
  let missing = missingHeadings(text)
  if (missing.length === 0) return text
  if (text) convo.push({ id: id("msg"), role: "assistant", parts: [{ type: "text", text }], createdAt: Date.now() })
  convo.push(userMessage(SUMMARY_NUDGE.replace("{missing}", missing.join(", "))))
  text = await once(provider, model, system, convo, signal)
  missing = missingHeadings(text)
  if (missing.length) throw new SummaryFormatError(`summary missing required headings (${missing.join(", ")})`)
  return text
}

export class SummaryFormatError extends Error {}

async function once(provider: ProviderClient, model: string, system: string[], messages: Message[], signal: AbortSignal) {
  let text = ""
  for await (const ev of provider.stream({ model, system, messages, tools: [], toolChoice: "none", maxOutputTokens: SUMMARY_MAX_OUTPUT }, signal)) {
    if (ev.type === "text-delta") text += ev.text
    if (ev.type === "error") throw ev.error
  }
  return text.trim()
}

function userMessage(text: string): Message {
  return { id: id("msg"), role: "user", source: "system", parts: [{ type: "text", text }], createdAt: Date.now() }
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s)

/**
 * Không model nào tóm tắt đúng khung → checkpoint dựng tay từ transcript. Mất chi tiết
 * nhưng giữ yêu cầu nguyên văn của CEO và phiên chạy tiếp được.
 */
export function fallbackSummary(messages: Message[], previous?: string): string {
  const requests = messages.filter((m) => m.role === "user" && m.source !== "system").map(textOf).filter(Boolean)
  const tools = new Map<string, number>()
  for (const m of messages) for (const p of m.parts) if (p.type === "tool-call") tools.set(p.name, (tools.get(p.name) ?? 0) + 1)
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant" && textOf(m))
  return [
    "## Objective",
    "(Automatic summary unavailable; reconstructed from the transcript.)",
    requests[0] ? `- First request: ${cut(requests[0], 800)}` : "- (unknown)",
    "## Work State",
    "Requests in this conversation (latest last):",
    ...requests.slice(-10).map((r) => `- ${cut(r, 400)}`),
    tools.size ? `Tools used: ${[...tools].map(([n, c]) => `${n} ×${c}`).join(", ")}` : "",
    "## Next Move",
    "Continue from the most recent messages below. Re-read workspace documents if details are missing.",
    "## Important Context",
    lastReply ? `Last reply before compaction: ${cut(textOf(lastReply), 1500)}` : "",
    previous ? `Earlier checkpoint:\n${cut(previous, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
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
