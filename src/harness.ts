import { join } from "node:path"
import type { AgentDef } from "./agent/types.ts"
import type { AgentRegistry } from "./agent/registry.ts"
import { Inbox } from "./core/inbox.ts"
import { id } from "./core/id.ts"
import { runTurn, type LoopEvents, type TurnContext } from "./core/loop.ts"
import { SessionStore } from "./core/store.ts"
import type { Compaction, Message, Outcome, Session } from "./core/types.ts"
import { build as buildSystem } from "./context/system.ts"
import { discover, environment, type InstructionSource } from "./context/instructions.ts"
import { estimateMessage } from "./context/budget.ts"
import { AskGate, type AskHandler } from "./permission/ask.ts"
import { inherit, type Ruleset } from "./permission/ruleset.ts"
import type { ProviderClient } from "./provider/types.ts"
import type { ToolRegistry } from "./tool/registry.ts"
import { makeAsk } from "./tool/execute.ts"
import type { Tool } from "./tool/define.ts"

export interface HarnessConfig {
  cwd: string
  dataDir: string
  provider: ProviderClient
  defaultModel: string
  agents: AgentRegistry
  tools: ToolRegistry
  askHandler: AskHandler
  events: LoopEvents
  permissions?: Ruleset
  maxConcurrentSubagents?: number
  maxDepth?: number
}

interface Live {
  session: Session
  agent: AgentDef
  inbox: Inbox
  messages: Message[]
  compaction?: Compaction
  estimate: { measured: number; estimated: number }
  system: string[]
  instructions: InstructionSource[]
  ruleset: Ruleset
  saved: Set<string>
  depth: number
  abort: AbortController
  running?: Promise<Outcome>
  /** Tool riêng cho session (vd delegate bind vào parent). */
  extraTools: Tool[]
}

export class Harness {
  readonly store: SessionStore
  readonly askGate: AskGate
  private live = new Map<string, Live>()
  private activeSubagents = 0

  constructor(readonly cfg: HarnessConfig) {
    this.store = new SessionStore(cfg.dataDir)
    this.askGate = new AskGate(cfg.askHandler)
  }

  async createSession(opts: { agent: string; parentID?: string; title?: string; model?: string; ruleset?: Ruleset; depth?: number; extraTools?: Tool[] }): Promise<Live> {
    const agent = this.cfg.agents.get(opts.agent)
    const session: Session = {
      id: id("ses"),
      parentID: opts.parentID,
      agent: agent.id,
      model: opts.model ?? agent.model[0] ?? this.cfg.defaultModel,
      title: opts.title ?? agent.name,
      createdAt: Date.now(),
    }
    await this.store.createSession(session)
    const instructions = [...(await discover(this.cfg.cwd)), environment(this.cfg.cwd)]
    const live: Live = {
      session,
      agent,
      inbox: new Inbox(),
      messages: [],
      estimate: { measured: 0, estimated: 0 },
      system: buildSystem({ agent, instructions }),
      instructions,
      ruleset: [...(this.cfg.permissions ?? []), ...agent.permissions, ...(opts.ruleset ?? [])],
      saved: new Set(),
      depth: opts.depth ?? 0,
      abort: new AbortController(),
      extraTools: opts.extraTools ?? [],
    }
    live.estimate.estimated = live.system.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
    this.live.set(session.id, live)
    return live
  }

  get(sessionID: string) {
    const l = this.live.get(sessionID)
    if (!l) throw new Error(`no live session ${sessionID}`)
    return l
  }

  list() {
    return [...this.live.values()]
  }

  /** Đẩy message vào inbox; nếu session đang idle thì chạy turn mới. */
  send(sessionID: string, text: string, delivery: "queue" | "steer" = "steer"): Promise<Outcome> {
    const live = this.get(sessionID)
    const msg: Message = { id: id("msg"), role: "user", source: "user", createdAt: Date.now(), parts: [{ type: "text", text }] }
    live.inbox.push(live.running ? delivery : "queue", msg)
    return this.wake(live)
  }

  wake(live: Live): Promise<Outcome> {
    if (live.running) return live.running
    live.abort = new AbortController()
    const toolContextBase = {
      sessionID: live.session.id,
      agent: live.agent.id,
      cwd: this.cfg.cwd,
      ruleset: live.ruleset,
      askGate: this.askGate,
      harness: this,
    }
    const { tools } = this.cfg.tools.snapshot(live.ruleset)
    const ctx: TurnContext = {
      sessionID: live.session.id,
      agent: live.agent,
      model: live.session.model,
      provider: this.cfg.provider,
      system: live.system,
      tools: [...tools, ...live.extraTools],
      toolContext: { ...toolContextBase, ask: makeAsk({ ...toolContextBase, signal: live.abort.signal }, live.saved) },
      inbox: live.inbox,
      store: this.store,
      messages: live.messages,
      compactionSummary: live.compaction,
      estimate: live.estimate,
      outputDir: join(this.cfg.dataDir, "tool-output"),
      events: this.cfg.events,
      signal: live.abort.signal,
    }
    live.running = runTurn(ctx)
      .then(async (outcome) => {
        live.estimate = ctx.estimate
        live.compaction = ctx.compactionSummary
        live.running = undefined
        if (live.inbox.size > 0) return this.wake(live)
        return outcome
      })
      .catch((e) => {
        live.running = undefined
        return { tag: "failed", error: e as Error } as Outcome
      })
    return live.running
  }

  interrupt(sessionID: string) {
    this.get(sessionID).abort.abort("user")
  }

  /** Spawn child session. Trả ResultEntry (foreground) hoặc id (background). */
  async spawn(parentID: string, opts: { agent: string; brief: Brief; context?: "isolated" | "fork"; background?: boolean; model?: string }) {
    const parent = this.get(parentID)
    const maxDepth = this.cfg.maxDepth ?? 1
    if (parent.depth >= maxDepth) throw new Error(`delegate: max depth ${maxDepth} reached`)
    const agentDef = this.cfg.agents.get(opts.agent)
    if (agentDef.mode === "primary") throw new Error(`delegate: ${opts.agent} is a primary agent`)
    if (this.activeSubagents >= (this.cfg.maxConcurrentSubagents ?? 4)) throw new Error("delegate: too many concurrent subagents")

    const childRules = inherit(parent.ruleset, [
      { action: "question", resource: "*", effect: "deny" },
      { action: "memory", resource: "*", effect: "deny" },
      ...(agentDef.role === "leaf" ? [{ action: "delegate", resource: "*", effect: "deny" } as const] : []),
    ])
    const child = await this.createSession({
      agent: opts.agent,
      parentID,
      title: opts.brief.goal.slice(0, 60),
      model: opts.model,
      ruleset: childRules,
      depth: parent.depth + 1,
    })
    const context = opts.context ?? agentDef.context
    const forked = context === "fork" ? forkContext(parent) : ""
    child.inbox.push("queue", {
      id: id("msg"),
      role: "user",
      source: "system",
      createdAt: Date.now(),
      parts: [{ type: "text", text: `You are a subagent spawned by another session.\n${forked}\n${renderBrief(opts.brief)}` }],
    })

    this.activeSubagents++
    const run = this.wake(child)
      .then((outcome) => this.result(child, outcome))
      .finally(() => this.activeSubagents--)

    if (opts.background) {
      void run.then((entry) => {
        parent.inbox.push("queue", {
          id: id("msg"),
          role: "user",
          source: "subagent",
          createdAt: Date.now(),
          parts: [{ type: "text", text: renderResult(entry) }],
        })
        this.cfg.events.onNotice?.(parentID, `subagent ${child.session.id} finished (${entry.status})`)
        if (!parent.running) void this.wake(parent)
      })
      return { sessionID: child.session.id, status: "running" as const }
    }
    return run
  }

  private result(child: Live, outcome: Outcome): ResultEntry {
    const last = [...child.messages].reverse().find((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"))
    const summary = last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? ""
    const files = new Set<string>()
    for (const m of child.messages) for (const p of m.parts) if (p.type === "tool-call" && (p.name === "write" || p.name === "edit")) files.add((p.args as any)?.path)
    const steps = child.messages.filter((m) => m.role === "assistant").length
    return {
      sessionID: child.session.id,
      agent: child.agent.id,
      status: outcome.tag === "completed" ? "completed" : outcome.tag === "interrupted" ? "stopped" : "failed",
      exitReason: outcome.tag === "failed" ? `error: ${outcome.error.message}` : outcome.tag,
      summary: summary.slice(0, 8000),
      filesTouched: [...files].filter(Boolean),
      usage: { steps, inputTokens: child.estimate.measured, outputTokens: child.messages.reduce((n, m) => (m.role === "assistant" ? n + estimateMessage(m) : n), 0) },
    }
  }
}

export interface Brief {
  goal: string
  context: string
  done_when: string
  output?: string
}

export interface ResultEntry {
  sessionID: string
  agent: string
  status: "completed" | "failed" | "stopped"
  exitReason: string
  summary: string
  filesTouched: string[]
  usage: { steps: number; inputTokens: number; outputTokens: number }
}

export function renderBrief(b: Brief) {
  return `<brief>\n<goal>${b.goal}</goal>\n<context>${b.context}</context>\n<done_when>${b.done_when}</done_when>\n<output>${b.output ?? "report"}</output>\n</brief>`
}

export function renderResult(r: ResultEntry) {
  const files = r.filesTouched.length ? `\nfiles: ${r.filesTouched.join(", ")}` : ""
  return `<subagent sessionID="${r.sessionID}" agent="${r.agent}" status="${r.status}" steps="${r.usage.steps}">\n${r.summary || "(no summary)"}${files}\n</subagent>`
}

/** Fork: summary compaction gần nhất (nếu có) + 20 message gần nhất, cap ~30k token. */
function forkContext(parent: Live): string {
  const parts: string[] = []
  if (parent.compaction) parts.push(`<parent-summary>\n${parent.compaction.summary}\n</parent-summary>`)
  let budget = 30_000
  const recent: string[] = []
  for (const m of [...parent.messages].reverse().slice(0, 20)) {
    const t = m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-call" ? `[call ${p.name}]` : p.type === "tool-result" ? `[result ${p.name}: ${p.output.slice(0, 300)}]` : "")).join("\n")
    budget -= Math.ceil(t.length / 4)
    if (budget < 0) break
    recent.unshift(`${m.role}: ${t}`)
  }
  if (recent.length) parts.push(`<parent-recent-context>\n${recent.join("\n\n")}\n</parent-recent-context>`)
  return parts.join("\n")
}
