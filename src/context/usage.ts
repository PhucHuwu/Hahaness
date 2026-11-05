import type { Message, UsageRecord } from "../core/types.ts"
import type { ToolDefinition } from "../provider/types.ts"
import { CHARS_PER_TOKEN, estimateText } from "./budget.ts"

export type ContextCategory = "system" | "workspace" | "tools" | "checkpoint" | "user" | "agent" | "notice" | "assistant" | "tool-calls" | "tool-results"

export interface ContextBreakdown {
  /** Ước lượng (ký tự / 4) cho từng loại nội dung trong request kế tiếp. */
  categories: Array<{ key: ContextCategory; tokens: number }>
  /** Theo từng tool: phần lời gọi (args) và phần kết quả nằm trong context. */
  tools: Array<{ name: string; calls: number; callTokens: number; resultTokens: number }>
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface UsageSummary {
  total: UsageTotals
  byPurpose: Record<UsageRecord["purpose"], UsageTotals>
  byModel: Array<{ model: string } & UsageTotals>
  /** input_tokens của lượt chat gần nhất = context thật provider đã đếm. */
  lastInput?: number
}

const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

/**
 * `system[0]` là Tier A (vai + hướng dẫn + skills), `system[1]` là Tier B (tài liệu công ty, môi trường).
 * `messages` là đúng những gì gửi model (đã qua `fromCheckpoint`).
 */
export function contextBreakdown(system: string[], tools: ToolDefinition[], messages: Message[], checkpointID?: string): ContextBreakdown {
  const sum = new Map<ContextCategory, number>()
  const add = (k: ContextCategory, n: number) => n > 0 && sum.set(k, (sum.get(k) ?? 0) + n)
  add("system", estimateText(system[0] ?? ""))
  add("workspace", estimateText(system[1] ?? ""))
  add("tools", tools.reduce((n, t) => n + tok(t.name.length + t.description.length + JSON.stringify(t.parameters).length), 0))

  const perTool = new Map<string, { name: string; calls: number; callTokens: number; resultTokens: number }>()
  const toolOf = (name: string) => perTool.get(name) ?? perTool.set(name, { name, calls: 0, callTokens: 0, resultTokens: 0 }).get(name)!

  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool-call") {
        const n = tok(JSON.stringify(p.args).length + p.name.length)
        add("tool-calls", n)
        const t = toolOf(p.name)
        t.calls++
        t.callTokens += n
      } else if (p.type === "tool-result") {
        const n = tok(p.output.length)
        add("tool-results", n)
        toolOf(p.name).resultTokens += n
      } else {
        const n = p.type === "image" ? 1500 : tok(p.text.length)
        add(textCategory(m, checkpointID), n)
      }
    }
  }
  const order: ContextCategory[] = ["system", "workspace", "tools", "checkpoint", "user", "agent", "notice", "assistant", "tool-calls", "tool-results"]
  return {
    categories: order.filter((k) => sum.has(k)).map((key) => ({ key, tokens: sum.get(key)! })),
    tools: [...perTool.values()].sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens)),
  }
}

function textCategory(m: Message, checkpointID?: string): ContextCategory {
  if (m.role === "assistant") return "assistant"
  if (checkpointID && m.id === checkpointID) return "checkpoint"
  if (m.source === "system") return "notice"
  if (m.source === "agent" || m.source === "subagent" || (m.from && m.from !== "ceo")) return "agent"
  return "user"
}

const zero = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
const plus = (t: UsageTotals, u: UsageRecord) => {
  t.calls++
  t.inputTokens += u.inputTokens
  t.outputTokens += u.outputTokens
  t.cacheReadTokens += u.cacheReadTokens ?? 0
}

export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const total = zero()
  const byPurpose = { turn: zero(), compaction: zero(), memory: zero() }
  const byModel = new Map<string, { model: string } & UsageTotals>()
  for (const r of records) {
    plus(total, r)
    plus(byPurpose[r.purpose], r)
    plus(byModel.get(r.model) ?? byModel.set(r.model, { model: r.model, ...zero() }).get(r.model)!, r)
  }
  const lastTurn = [...records].reverse().find((r) => r.purpose === "turn")
  return { total, byPurpose, byModel: [...byModel.values()], lastInput: lastTurn?.inputTokens }
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { calls: a.calls + b.calls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens }
}
