import type { Message, Outcome, Part, Session } from "./types.ts"
import type { ModelRequest, ProviderClient, StreamEvent } from "../provider/types.ts"
import type { Tool, ToolContext } from "../tool/define.ts"
import { executeTool } from "../tool/execute.ts"
import { id } from "./id.ts"
import { ceiling, estimateMessage, outputLimit, type Estimate, total } from "../context/budget.ts"
import { fromCheckpoint, keepBoundary, prune, summarize } from "../context/compaction.ts"
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
  outputDir: string
  events: LoopEvents
  signal: AbortSignal
}

const MAX_OUTPUT_LIMIT_STREAK = 3
const MAX_RETRIES = 5

export async function runTurn(ctx: TurnContext): Promise<Outcome> {
  await ctx.store.claim(ctx.sessionID)
  let step = 0
  let wrapupSent = false
  let outputLimitStreak = 0
  let retries = 0
  const guard = new DoomGuard()
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

      const outcome = await runStep(ctx, step, guard)
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
        case "retry":
          if (++retries > MAX_RETRIES) return { tag: "failed", error: new Error(`provider: ${outcome.reason}`) }
          ctx.events.onNotice?.(ctx.sessionID, `retry in ${outcome.delay}ms: ${outcome.reason}`)
          await sleep(outcome.delay, ctx.signal)
          continue
        default:
          return outcome
      }
    }
  } finally {
    await ctx.store.release(ctx.sessionID)
  }
}

async function runStep(ctx: TurnContext, step: number, guard: DoomGuard): Promise<Outcome> {
  const info = ctx.provider.info(ctx.model)
  if (total(ctx.estimate) >= ceiling(info.contextWindow)) {
    const ok = await compact(ctx)
    if (ok) return { tag: "compacted" }
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
  const serialChain = { p: Promise.resolve() }
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

  for await (const ev of ctx.provider.stream(request, ctx.signal)) {
    switch (ev.type) {
      case "text-delta":
        text += ev.text
        ctx.events.onText?.(ctx.sessionID, ev.text)
        break
      case "reasoning-delta":
        ctx.events.onReasoning?.(ctx.sessionID, ev.text)
        break
      case "tool-call": {
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
        break
      case "error":
        if (ctx.signal.aborted) return { tag: "interrupted" }
        if (/context|too long|maximum.*tokens/i.test(ev.error.message) && !persisted) {
          const ok = await compact(ctx)
          if (ok) return { tag: "compacted" }
        }
        return ev.retryable
          ? { tag: "retry", delay: Math.min(8000, 1000 * 2 ** Math.min(3, step)), reason: ev.error.message }
          : { tag: "failed", error: ev.error }
    }
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

  if (finish) {
    ctx.estimate = { measured: finish.usage.inputTokens, estimated: estimateMessage(assistant) }
  } else {
    ctx.estimate.estimated += estimateMessage(assistant)
  }

  if (!persisted) await persist()
  if (toolRuns.length) return { tag: "continue" }
  if (finish?.reason === "length") return { tag: "output-limit" }
  return { tag: "completed", text: assistant.parts.filter((p) => p.type === "text").map((p) => p.text).join("") }
}

function launchTool(ctx: TurnContext, ev: Extract<StreamEvent, { type: "tool-call" }>, serial: { p: Promise<void> }): Promise<Part> {
  const tool = ctx.tools.find((t) => t.name === ev.name)
  const run = async (): Promise<Part> => {
    if (!tool) return { type: "tool-result", callID: ev.callID, name: ev.name, output: `Unknown tool: ${ev.name}`, isError: true }
    ctx.events.onToolStart?.(ctx.sessionID, ev.name, ev.args, ev.callID)
    const result = await executeTool(tool, ev.args, { ...ctx.toolContext, signal: ctx.signal }, { outputDir: ctx.outputDir, callID: ev.callID })
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

async function compact(ctx: TurnContext): Promise<boolean> {
  ctx.events.onNotice?.(ctx.sessionID, "compacting context…")
  const pruned = prune(ctx.messages)
  const boundary = keepBoundary(pruned)
  const keepFrom = pruned[boundary]
  if (!keepFrom || boundary <= 1) return false
  try {
    const summary = await summarize(ctx.provider, ctx.model, ctx.system, fromCheckpoint(pruned, ctx.compactionSummary), ctx.signal)
    const compaction = { id: id("cmp"), summary, keepFromID: keepFrom.id, createdAt: Date.now() }
    await ctx.store.addCompaction(ctx.sessionID, compaction)
    ctx.compactionSummary = compaction
    ctx.estimate = { measured: 0, estimated: fromCheckpoint(ctx.messages, compaction).reduce((n, m) => n + estimateMessage(m), 0) }
    return true
  } catch (e) {
    ctx.events.onNotice?.(ctx.sessionID, `compaction failed: ${(e as Error).message}`)
    return false
  }
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
