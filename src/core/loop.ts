import type { Message, Outcome, Part, Session, Usage, UsageRecord } from "./types.ts"
import type { ModelRequest, ProviderClient, StreamEvent } from "../provider/types.ts"
import type { Tool, ToolContext } from "../tool/define.ts"
import { executeTool } from "../tool/execute.ts"
import { id } from "./id.ts"
import { ceiling, estimateMessage, estimateText, outputLimit, type Estimate, total } from "../context/budget.ts"
import {
  KEEP_RECENT_TOKENS,
  MEMORY_FLUSH_PROMPT,
  NO_REPLY,
  OVERFLOW_SHRINK,
  SUMMARY_MAX_OUTPUT,
  SummaryFormatError,
  fallbackSummary,
  fitForSummary,
  fromCheckpoint,
  isOverflow,
  keepBoundary,
  prune,
  summarize,
} from "../context/compaction.ts"
import type { Inbox } from "./inbox.ts"
import type { SessionStore } from "./store.ts"
import type { AgentDef } from "../agent/types.ts"

export const MAX_STEPS_PROMPT = "You have reached the step limit for this turn. Summarize what you did, what remains, and stop. Do not call tools."
export const WRAPUP_NOTICE = "[harness] You have used 80% of your step budget. Start wrapping up: finish the current item, then report."
export const REPEATED_TOOL_NOTICE = "[harness] You are repeating the same tool call. Change approach or report what is blocking you."

export interface LoopEvents {
  onText?(sessionID: string, delta: string): void
  onReasoning?(sessionID: string, delta: string): void
  onToolStart?(sessionID: string, name: string, args: unknown, callID: string): void
  onToolEnd?(sessionID: string, name: string, output: string, isError: boolean, callID: string): void
  onNotice?(sessionID: string, text: string): void
  /** Harness-level: phiên mới được tạo/nạp lại; turn kết thúc (idle). */
  onSession?(session: Session): void
  onTurnStart?(sessionID: string): void
  onTurnEnd?(sessionID: string, outcome: Outcome): void
  onUsage?(sessionID: string, usage: UsageRecord): void
}

export interface TurnContext {
  sessionID: string
  agent: AgentDef
  model: string
  provider: ProviderClient
  system: string[]
  tools: Tool[]
  toolContext: Omit<ToolContext, "signal">
  inbox: Inbox
  store: SessionStore
  messages: Message[]
  compactionSummary?: { summary: string; keepFromID: string; id: string; createdAt: number }
  estimate: Estimate
  /** Model riêng để tóm tắt khi compaction (rẻ hơn / context lớn hơn); không có thì dùng model của phiên. */
  summarizer?: { provider: ProviderClient; model: string }
  /** false → bỏ pha memory flush trước compaction. */
  memoryFlush?: boolean
  /** Model dự phòng theo thứ tự; dùng khi model hiện tại lỗi hẳn (hết retry hoặc lỗi không retry được). Bị tiêu thụ dần. */
  fallbacks?: Array<{ ref: string; provider: ProviderClient; model: string }>
  onModelSwitch?(ref: string): void
  saveOutput?: (callID: string, output: string) => string
  /** Sổ token của phiên (mọi lần gọi model); loop ghi thêm vào đây và vào store. */
  usage?: UsageRecord[]
  events: LoopEvents
  signal: AbortSignal
}

const MAX_OUTPUT_LIMIT_STREAK = 3
const MAX_RETRIES = 5
/** Provider bảo chờ lâu hơn mức này (vd hết quota theo ngày) → báo lỗi luôn thay vì treo lượt. */
const MAX_RETRY_DELAY = 60_000

/** Lỗi do provider/model (không phải do agent): đáng thử model dự phòng. */
export class ProviderError extends Error {}

export const INTERRUPTED_TOOL_OUTPUT = "interrupted: the turn stopped before this tool finished. Its effect is unknown; check before repeating it."

export async function runTurn(ctx: TurnContext): Promise<Outcome> {
  await ctx.store.claim(ctx.sessionID)
  await repairDangling(ctx)
  let step = 0
  let wrapupSent = false
  let outputLimitStreak = 0
  let retries = 0
  const guard = new DoomGuard()
  const compaction: CompactionState = { overflow: 0, step: -2 }
  const switchModel = (error: Error) => {
    const next = ctx.fallbacks?.shift()
    if (!next) return false
    ctx.events.onNotice?.(ctx.sessionID, `model ${ctx.model} failed (${error.message.slice(0, 200)}); switching to ${next.ref}`)
    ctx.provider = next.provider
    ctx.model = next.model
    ctx.onModelSwitch?.(next.ref)
    retries = 0
    return true
  }
  try {
    while (true) {
      if (ctx.signal.aborted) return { tag: "interrupted" }
      const items = step === 0 ? ctx.inbox.drainAll() : ctx.inbox.drainSteer()
      for (const it of items) await appendMessage(ctx, it.message)
      if (step === 0 && items.length === 0) return { tag: "completed", text: "" }

      if (!wrapupSent && step >= Math.floor(ctx.agent.steps * 0.8)) {
        wrapupSent = true
        await appendNotice(ctx, WRAPUP_NOTICE)
      }

      const outcome = await runStep(ctx, step, guard, retries, compaction)
      step++
      switch (outcome.tag) {
        case "continue":
          retries = 0
          outputLimitStreak = 0
          continue
        case "compacted":
          continue
        case "output-limit":
          if (++outputLimitStreak >= MAX_OUTPUT_LIMIT_STREAK) return { tag: "failed", error: new Error("output limit reached repeatedly") }
          await appendNotice(ctx, "[harness] Your previous reply was cut off by the output limit. Continue from where you stopped.")
          continue
        case "retry": {
          const giveUp =
            ++retries > MAX_RETRIES
              ? new ProviderError(`provider: ${outcome.reason}`)
              : outcome.delay > MAX_RETRY_DELAY
                ? new ProviderError(`provider asked to wait ${Math.ceil(outcome.delay / 1000)}s: ${outcome.reason}`)
                : undefined
          if (giveUp) {
            if (switchModel(giveUp)) continue
            return { tag: "failed", error: giveUp }
          }
          ctx.events.onNotice?.(ctx.sessionID, `retry in ${outcome.delay}ms: ${outcome.reason}`)
          await sleep(outcome.delay, ctx.signal)
          continue
        }
        case "failed":
          if (outcome.error instanceof ProviderError && switchModel(outcome.error)) continue
          return outcome
        default:
          return outcome
      }
    }
  } finally {
    await ctx.store.release(ctx.sessionID)
  }
}

interface CompactionState {
  /** Số lần đã nén vì provider báo tràn trong lượt này (index vào OVERFLOW_SHRINK). */
  overflow: number
  /** Step gần nhất đã nén; step ngay sau đó không nén theo ước lượng nữa (tránh vòng nén liên tục). */
  step: number
}

async function runStep(ctx: TurnContext, step: number, guard: DoomGuard, retryCount: number, cs: CompactionState): Promise<Outcome> {
  const info = ctx.provider.info(ctx.model)
  // Model context nhỏ: 15k nguyên văn có thể đã quá ceiling → giữ tối đa 40% ceiling.
  const keepBase = Math.min(KEEP_RECENT_TOKENS, Math.floor(ceiling(info.contextWindow) * 0.4))
  if (total(ctx.estimate) >= ceiling(info.contextWindow) && cs.step !== step - 1) {
    if (await compact(ctx, { flush: true, keepRecentTokens: keepBase })) {
      cs.step = step
      return { tag: "compacted" }
    }
  }

  const lastStep = step >= ctx.agent.steps - 1
  const messages = fromCheckpoint(ctx.messages, ctx.compactionSummary)
  if (lastStep) messages.push({ id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text: MAX_STEPS_PROMPT }] })

  const request: ModelRequest = {
    model: ctx.model,
    system: ctx.system,
    messages,
    tools: ctx.tools.map((t) => t.definition()),
    toolChoice: lastStep ? "none" : "auto",
    maxOutputTokens: outputLimit(info.contextWindow, info.maxOutput, total(ctx.estimate)),
  }

  const assistant: Message = { id: id("msg"), role: "assistant", parts: [], createdAt: Date.now() }
  let persisted = false
  let text = ""
  const toolRuns: Array<Promise<Part>> = []
  const serialChain: { p: Promise<void>; endTurn?: boolean } = { p: Promise.resolve() }
  let finish: Extract<StreamEvent, { type: "finish" }> | undefined

  const persist = async () => {
    if (persisted) return
    persisted = true
    await ctx.store.addMessage(ctx.sessionID, { ...assistant, parts: [] })
    ctx.messages.push(assistant)
  }
  const addPart = async (part: Part) => {
    await persist()
    assistant.parts.push(part)
    await ctx.store.addPart(ctx.sessionID, assistant.id, part)
  }

  let streamError: Extract<StreamEvent, { type: "error" }> | undefined
  try {
    for await (const ev of ctx.provider.stream(request, ctx.signal)) {
      if (ev.type === "error") {
        streamError = ev
        break
      }
      await onEvent(ev)
    }
  } catch (e) {
    // fetch/reader ném khi abort hoặc đứt mạng giữa stream: coi như lỗi retry được.
    streamError = { type: "error", error: e as Error, retryable: true }
  }

  if (streamError) {
    // Tool-call đã ghi thì vẫn phải có result, nếu không transcript hỏng cho mọi request sau.
    if (toolRuns.length) for (const r of await Promise.all(toolRuns)) await addPart(r)
    if (ctx.signal.aborted) {
      if (text) await addPart({ type: "text", text })
      return { tag: "interrupted" }
    }
    if (toolRuns.length) {
      if (guard.observe(assistant.parts) === "fail") return { tag: "failed", error: new Error("doom loop detected") }
      return { tag: "continue" }
    }
    const ev = streamError
    if (isOverflow(ev.error.message) && !persisted) {
      // Ước lượng sai (tokenizer khác, ảnh, …): nén lại, mỗi lần giữ ít nguyên văn hơn.
      const factor = OVERFLOW_SHRINK[cs.overflow++]
      if (factor === undefined) return { tag: "failed", error: new Error(`context still too long after ${OVERFLOW_SHRINK.length} compactions: ${ev.error.message}`) }
      ctx.events.onNotice?.(ctx.sessionID, `provider says context is too long; compacting (keep ${Math.round(factor * 100)}% of recent)`)
      if (await compact(ctx, { keepRecentTokens: Math.floor(keepBase * factor) })) {
        cs.step = step
        return { tag: "compacted" }
      }
      return { tag: "failed", error: new Error(`context too long and compaction could not shrink it: ${ev.error.message}`) }
    }
    return ev.retryable
      ? { tag: "retry", delay: ev.retryAfterMs ?? Math.min(8000, 1000 * 2 ** Math.min(3, retryCount)), reason: ev.error.message }
      : { tag: "failed", error: new ProviderError(ev.error.message, { cause: ev.error }) }
  }
  if (text) await addPart({ type: "text", text })

  if (toolRuns.length) {
    const results = await Promise.all(toolRuns)
    for (const r of results) await addPart(r)
    if (ctx.signal.aborted) return { tag: "interrupted" }
    const verdict = guard.observe(assistant.parts)
    if (verdict === "fail") return { tag: "failed", error: new Error("doom loop detected") }
    if (verdict === "warn") await appendNotice(ctx, REPEATED_TOOL_NOTICE)
  }
  if (ctx.signal.aborted) {
    if (!persisted) await persist()
    return { tag: "interrupted" }
  }

  if (finish && finish.usage.inputTokens > 0) {
    ctx.estimate = { measured: finish.usage.inputTokens, estimated: estimateMessage(assistant) }
  } else {
    // Provider không trả usage → giữ ước lượng tích lũy, đừng reset về 0 (nếu không compaction không bao giờ chạy).
    ctx.estimate.estimated += estimateMessage(assistant)
  }

  if (!persisted) await persist()
  // Tool yêu cầu dừng lượt (vd `ask_lead`: chờ câu trả lời từ người giao việc) → không gọi model thêm.
  if (serialChain.endTurn) return { tag: "completed", text: "" }
  if (toolRuns.length) return { tag: "continue" }
  if (finish?.reason === "length") return { tag: "output-limit" }
  return { tag: "completed", text: assistant.parts.filter((p) => p.type === "text").map((p) => p.text).join("") }

  async function onEvent(ev: Exclude<StreamEvent, { type: "error" }>) {
    switch (ev.type) {
      case "text-delta":
        text += ev.text
        ctx.events.onText?.(ctx.sessionID, ev.text)
        break
      case "reasoning-delta":
        ctx.events.onReasoning?.(ctx.sessionID, ev.text)
        break
      case "tool-call": {
        if (ctx.signal.aborted) break
        if (text) {
          await addPart({ type: "text", text })
          text = ""
        }
        await addPart({ type: "tool-call", callID: ev.callID, name: ev.name, args: ev.args })
        toolRuns.push(launchTool(ctx, ev, serialChain))
        break
      }
      case "finish":
        finish = ev
        await recordUsage(ctx, ctx.model, "turn", ev.usage)
        break
    }
  }
}

/** Provider không trả usage (0/0) thì không ghi: con số 0 làm sai thống kê hơn là thiếu dòng. */
async function recordUsage(ctx: TurnContext, model: string, purpose: UsageRecord["purpose"], u: Usage) {
  if (!u.inputTokens && !u.outputTokens) return
  const record: UsageRecord = { at: Date.now(), model, purpose, inputTokens: u.inputTokens, outputTokens: u.outputTokens, ...(u.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}) }
  ctx.usage?.push(record)
  await ctx.store.addUsage(ctx.sessionID, record)
  ctx.events.onUsage?.(ctx.sessionID, record)
}

function launchTool(ctx: TurnContext, ev: Extract<StreamEvent, { type: "tool-call" }>, serial: { p: Promise<void>; endTurn?: boolean }): Promise<Part> {
  const tool = ctx.tools.find((t) => t.name === ev.name)
  const run = async (): Promise<Part> => {
    if (!tool) return { type: "tool-result", callID: ev.callID, name: ev.name, output: `Unknown tool: ${ev.name}`, isError: true }
    ctx.events.onToolStart?.(ctx.sessionID, ev.name, ev.args, ev.callID)
    const result = await executeTool(tool, ev.args, { ...ctx.toolContext, signal: ctx.signal }, { saveOutput: ctx.saveOutput, callID: ev.callID })
    if (result.metadata?.endTurn === true && !result.isError) serial.endTurn = true
    ctx.events.onToolEnd?.(ctx.sessionID, ev.name, result.output, result.isError ?? false, ev.callID)
    return { type: "tool-result", callID: ev.callID, name: ev.name, output: result.output, isError: result.isError ?? false }
  }
  if (tool?.concurrency === "serial") {
    const p = serial.p.then(run)
    serial.p = p.then(() => {})
    return p
  }
  return run()
}

/**
 * Nén context. `keepRecentTokens` nhỏ dần khi overflow recovery. Thứ tự dự phòng cho bản tóm tắt:
 * model compaction → model chính → checkpoint dựng tay (`fallbackSummary`). Trả false khi không có
 * gì để nén, bị dừng, hoặc mọi model lỗi mạng (để loop retry như bình thường).
 */
export async function compact(ctx: TurnContext, opts: { keepRecentTokens?: number; flush?: boolean; focus?: string } = {}): Promise<boolean> {
  ctx.events.onNotice?.(ctx.sessionID, "compacting context…")
  if (opts.flush && ctx.memoryFlush !== false) await flushMemory(ctx)
  if (ctx.signal.aborted) return false

  const pruned = prune(ctx.messages)
  const boundary = keepBoundary(pruned, opts.keepRecentTokens)
  const keepFrom = pruned[boundary]
  if (!keepFrom || boundary <= 1) return false
  // Checkpoint chỉ được tiến lên; lùi lại hoặc đứng yên = không giải phóng được gì.
  const previous = ctx.compactionSummary ? pruned.findIndex((m) => m.id === ctx.compactionSummary!.keepFromID) : -1
  if (boundary <= previous) return false

  const input = fromCheckpoint(pruned, ctx.compactionSummary)
  const candidates = [ctx.summarizer, { provider: ctx.provider, model: ctx.model }].filter(
    (c, i, all): c is NonNullable<typeof c> => !!c && all.findIndex((x) => x?.provider === c.provider && x?.model === c.model) === i,
  )
  let summary: string | undefined
  let formatFailed = false
  for (const c of candidates) {
    try {
      summary = await summarizeFitted(ctx, c, input, opts.focus)
      break
    } catch (e) {
      if (ctx.signal.aborted) return false
      if (e instanceof SummaryFormatError) formatFailed = true
      ctx.events.onNotice?.(ctx.sessionID, `compaction (${c.model}) failed: ${(e as Error).message}`)
    }
  }
  if (summary === undefined) {
    if (!formatFailed) return false
    summary = fallbackSummary(ctx.messages.slice(0, ctx.messages.findIndex((m) => m.id === keepFrom.id)), ctx.compactionSummary?.summary)
  }

  const skills = skillsBefore(ctx.messages, keepFrom.id)
  if (skills.length) summary += `\n\nSkills loaded earlier (their text is no longer in context; call \`skill\` again if needed): ${skills.map((s) => `[SKILL_PRUNED: ${s}]`).join(" ")}`

  const compaction = { id: id("cmp"), summary, keepFromID: keepFrom.id, createdAt: Date.now() }
  await ctx.store.addCompaction(ctx.sessionID, compaction)
  ctx.compactionSummary = compaction
  // Re-anchor: số đo của provider không còn đúng sau khi đổi transcript → ước lượng lại từ đầu (gồm system).
  const systemTokens = ctx.system.reduce((n, s) => n + estimateText(s), 0)
  ctx.estimate = { measured: 0, estimated: systemTokens + fromCheckpoint(ctx.messages, compaction).reduce((n, m) => n + estimateMessage(m), 0) }
  return true
}

/** Request summarize phải vừa context của model tóm tắt; tự nó báo tràn → thu nhỏ input tiếp. */
async function summarizeFitted(ctx: TurnContext, c: { provider: ProviderClient; model: string }, input: Message[], focus?: string) {
  const info = c.provider.info(c.model)
  const systemTokens = ctx.system.reduce((n, s) => n + estimateText(s), 0)
  const room = ceiling(info.contextWindow) - systemTokens - SUMMARY_MAX_OUTPUT
  for (const f of [1, ...OVERFLOW_SHRINK.slice(1)]) {
    try {
      return await summarize(c.provider, c.model, ctx.system, fitForSummary(input, Math.max(2_000, Math.floor(room * f))), ctx.signal, (u) => recordUsage(ctx, c.model, "compaction", u), focus)
    } catch (e) {
      if (!isOverflow((e as Error).message) || f === OVERFLOW_SHRINK.at(-1)) throw e
    }
  }
  throw new Error("unreachable")
}

function skillsBefore(messages: Message[], keepFromID: string) {
  const idx = messages.findIndex((m) => m.id === keepFromID)
  const ids = (ms: Message[]) =>
    new Set(ms.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool-call" && p.name === "skill" && typeof (p.args as { id?: unknown })?.id === "string" ? [(p.args as { id: string }).id] : []))))
  const kept = ids(messages.slice(idx))
  return [...ids(messages.slice(0, idx))].filter((s) => !kept.has(s))
}

const FLUSH_STEPS = 3

/**
 * Pha 0: trước khi nén, cho agent có tool `memory` cơ hội ghi lại điều cần nhớ lâu dài.
 * Chạy "ngoài transcript": prompt và reply không được lưu (chỉ tác dụng của tool memory còn lại),
 * nên không làm bẩn phần recent-context. Gửi đủ tool definitions để giữ cache prefix,
 * nhưng chỉ thực thi `memory`.
 */
async function flushMemory(ctx: TurnContext) {
  const memory = ctx.tools.find((t) => t.name === "memory")
  if (!memory) return
  const convo: Message[] = [...fromCheckpoint(ctx.messages, ctx.compactionSummary)]
  convo.push({ id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text: MEMORY_FLUSH_PROMPT }] })
  try {
    for (let i = 0; i < FLUSH_STEPS && !ctx.signal.aborted; i++) {
      const reply: Message = { id: id("msg"), role: "assistant", parts: [], createdAt: Date.now() }
      let text = ""
      const calls: Array<Extract<StreamEvent, { type: "tool-call" }>> = []
      const tools = ctx.tools.map((t) => t.definition())
      for await (const ev of ctx.provider.stream({ model: ctx.model, system: ctx.system, messages: convo, tools, toolChoice: "auto", maxOutputTokens: 2_000 }, ctx.signal)) {
        if (ev.type === "text-delta") text += ev.text
        else if (ev.type === "tool-call") calls.push(ev)
        else if (ev.type === "finish") await recordUsage(ctx, ctx.model, "memory", ev.usage)
        else if (ev.type === "error") throw ev.error
      }
      if (calls.length === 0 || text.trim() === NO_REPLY) return
      if (text) reply.parts.push({ type: "text", text })
      for (const c of calls) reply.parts.push({ type: "tool-call", callID: c.callID, name: c.name, args: c.args })
      for (const c of calls) {
        if (c.name !== "memory") {
          reply.parts.push({ type: "tool-result", callID: c.callID, name: c.name, output: "Only `memory` is available right now.", isError: true })
          continue
        }
        ctx.events.onToolStart?.(ctx.sessionID, c.name, c.args, c.callID)
        const r = await executeTool(memory, c.args, { ...ctx.toolContext, signal: ctx.signal }, { callID: c.callID })
        ctx.events.onToolEnd?.(ctx.sessionID, c.name, r.output, r.isError ?? false, c.callID)
        reply.parts.push({ type: "tool-result", callID: c.callID, name: c.name, output: r.output, isError: r.isError ?? false })
      }
      convo.push(reply)
    }
  } catch (e) {
    if (!ctx.signal.aborted) ctx.events.onNotice?.(ctx.sessionID, `memory flush skipped: ${(e as Error).message}`)
  }
}

/**
 * Tool-call không có result (server tắt giữa lúc tool chạy, hoặc lỗi giữa chừng) → ghi result
 * "interrupted". API kiểu OpenAI từ chối request có tool_calls thiếu tool message, nên nếu
 * không vá thì phiên hỏng vĩnh viễn.
 */
export async function repairDangling(ctx: Pick<TurnContext, "sessionID" | "messages" | "store">) {
  let repaired = 0
  for (const m of ctx.messages) {
    if (m.role !== "assistant") continue
    const done = new Set(m.parts.flatMap((p) => (p.type === "tool-result" ? [p.callID] : [])))
    for (const p of [...m.parts]) {
      if (p.type !== "tool-call" || done.has(p.callID)) continue
      const part: Part = { type: "tool-result", callID: p.callID, name: p.name, output: INTERRUPTED_TOOL_OUTPUT, isError: true }
      m.parts.push(part)
      await ctx.store.addPart(ctx.sessionID, m.id, part)
      repaired++
    }
  }
  return repaired
}

async function appendMessage(ctx: TurnContext, message: Message) {
  await ctx.store.addMessage(ctx.sessionID, message)
  ctx.messages.push(message)
  ctx.estimate.estimated += estimateMessage(message)
}

async function appendNotice(ctx: TurnContext, text: string) {
  ctx.events.onNotice?.(ctx.sessionID, text)
  await appendMessage(ctx, { id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text }] })
}

class DoomGuard {
  private last = ""
  private same = 0
  private errors = 0

  observe(parts: Part[]): "ok" | "warn" | "fail" {
    const calls = parts.filter((p) => p.type === "tool-call")
    const results = parts.filter((p) => p.type === "tool-result")
    const sig = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join("|")
    this.same = sig && sig === this.last ? this.same + 1 : 0
    this.last = sig
    this.errors = results.length && results.every((r) => r.isError) ? this.errors + 1 : 0
    if (this.same >= 4 || this.errors >= 5) return "fail"
    if (this.same >= 2 || this.errors >= 3) return "warn"
    return "ok"
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })
}
