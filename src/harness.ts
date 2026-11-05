import { createHash } from "node:crypto"
import type { AgentDef } from "./agent/types.ts"
import { MANAGEMENT_ACTIONS, type AgentRegistry } from "./agent/registry.ts"
import type { Db } from "./core/db.ts"
import type { DocumentStore } from "./context/documents.ts"
import { Inbox } from "./core/inbox.ts"
import { id } from "./core/id.ts"
import { repairDangling, runTurn, type LoopEvents, type TurnContext } from "./core/loop.ts"
import { fromCheckpoint } from "./context/compaction.ts"

const SKILLS_SOURCE = "skills/index"

export const RESUMED_AFTER_CRASH =
  "[harness] Your previous turn in this conversation was cut off (the app was restarted). Tool calls marked \"interrupted\" may or may not have taken effect; check the workspace before redoing them."
import { SessionStore } from "./core/store.ts"
import type { Compaction, Message, Outcome, Session } from "./core/types.ts"
import { build as buildSystem } from "./context/system.ts"
import { changed, environment, removed, updateNotice, type InstructionSource } from "./context/instructions.ts"
import * as workspace from "./context/workspace.ts"
import { estimateMessage } from "./context/budget.ts"
import { AskGate, type AskHandler } from "./permission/ask.ts"
import { inherit, type Ruleset } from "./permission/ruleset.ts"
import type { ProviderRegistry } from "./provider/registry.ts"
import type { ProviderClient } from "./provider/types.ts"
import type { ToolRegistry } from "./tool/registry.ts"
import { makeAsk } from "./tool/execute.ts"
import type { Tool } from "./tool/define.ts"
import type { SkillStore } from "./context/skills.ts"
import type { CompactionConfig } from "./config.ts"

export interface HarnessConfig {
  cwd: string
  db: Db
  docs: DocumentStore
  providers: ProviderRegistry
  /** Dạng `providerID/modelID`; agent không khai báo model thì dùng cái này. */
  defaultModel: string
  agents: AgentRegistry
  tools: ToolRegistry
  skills?: SkillStore
  askHandler: AskHandler
  events: LoopEvents
  permissions?: Ruleset
  maxConcurrentSubagents?: number
  maxDepth?: number
  compaction?: CompactionConfig
  /** Dự phòng cấp công ty, thử sau danh sách `model` của agent. */
  fallbackModels?: string[]
}

interface Live {
  session: Session
  agent: AgentDef
  inbox: Inbox
  messages: Message[]
  compaction?: Compaction
  estimate: { measured: number; estimated: number }
  system: string[]
  /** Nguồn đã dựng system prompt (đóng băng cả phiên). */
  instructions: InstructionSource[]
  /** Những gì model đang biết = system + mọi workspace-update đã gửi. So với hiện tại để báo thay đổi. */
  known: InstructionSource[]
  /** Checkpoint lúc `known` được tính; compaction mới có thể đã nuốt các workspace-update trước đó. */
  knownCheckpoint?: string
  knownAt: number
  ruleset: Ruleset
  saved: Set<string>
  depth: number
  abort: AbortController
  running?: Promise<Outcome>
  /** Lỗi của lượt gần nhất (xóa khi lượt mới bắt đầu) để UI hiện lại sau khi tải lại trang. */
  lastError?: string
  /** Tool riêng cho session (vd delegate bind vào parent). */
  extraTools: Tool[]
  /** Model đang dùng nếu đã chuyển sang dự phòng (chỉ trong bộ nhớ; restart thì thử lại model chính). */
  activeModel?: string
  /**
   * Phiên con: người giao việc. `waiting` = nhân viên đã hỏi (`ask_lead`) và đang chờ trả lời;
   * lượt kế tiếp kết thúc thì báo cáo lại lên phiên cha (spawn ban đầu đã trả kết quả rồi).
   */
  lead?: { parentID: string; wakeParent: boolean; waiting?: boolean }
}

export class Harness {
  readonly store: SessionStore
  readonly askGate: AskGate
  private live = new Map<string, Live>()
  private activeSubagents = 0

  constructor(readonly cfg: HarnessConfig) {
    this.store = new SessionStore(cfg.db)
    this.askGate = new AskGate(cfg.askHandler)
  }

  async createSession(opts: { agent: string; parentID?: string; title?: string; model?: string; ruleset?: Ruleset; depth?: number; extraTools?: Tool[] }): Promise<Live> {
    const agent = this.cfg.agents.get(opts.agent)
    const modelRef = opts.model ?? agent.model[0] ?? this.cfg.defaultModel
    this.cfg.providers.resolve(modelRef)
    const session: Session = {
      id: id("ses"),
      parentID: opts.parentID,
      agent: agent.id,
      model: modelRef,
      title: opts.title ?? agent.name,
      createdAt: Date.now(),
    }
    await this.store.createSession(session)
    return this.activate(session, agent, { ruleset: opts.ruleset, depth: opts.depth, extraTools: opts.extraTools })
  }

  /** Nạp lại phiên từ store (sau khi restart). System prompt được dựng lại từ workspace hiện tại. */
  async resume(sessionID: string): Promise<Live> {
    const existing = this.live.get(sessionID)
    if (existing) return existing
    const state = await this.store.load(sessionID)
    if (!state) throw new Error(`no stored session ${sessionID}`)
    const agent = this.cfg.agents.get(state.session.agent)
    const live = await this.activate(state.session, agent, {})
    live.messages.push(...state.messages)
    live.compaction = state.compactions.at(-1)
    // System vừa dựng lại từ workspace hiện tại → không cần báo gì cho tới khi tài liệu đổi tiếp.
    live.knownCheckpoint = live.compaction?.id
    // Nhân viên đang chờ câu trả lời lúc restart: trả lời xong vẫn phải báo lại người giao việc.
    if (state.session.parentID) live.lead = { parentID: state.session.parentID, wakeParent: true, waiting: pendingQuestion(live.messages) !== undefined }
    const repaired = await repairDangling({ sessionID, messages: live.messages, store: this.store })
    live.estimate.estimated += fromCheckpoint(live.messages, live.compaction).reduce((n, m) => n + estimateMessage(m), 0)
    if (state.staleClaim || repaired > 0) {
      // Không tự chạy tiếp (tốn tiền, CEO có thể không muốn); báo cho model ở lượt kế tiếp.
      live.inbox.push("queue", { id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text: RESUMED_AFTER_CRASH }] })
    }
    return live
  }

  private async activate(session: Session, agent: AgentDef, opts: { ruleset?: Ruleset; depth?: number; extraTools?: Tool[] }): Promise<Live> {
    const instructions = await this.contextSources(agent)
    const skills = instructions.find((s) => s.id === SKILLS_SOURCE)
    const live: Live = {
      session,
      agent,
      inbox: new Inbox(),
      messages: [],
      estimate: { measured: 0, estimated: 0 },
      system: buildSystem({ agent, instructions: instructions.filter((s) => s !== skills), skillsIndex: skills?.content }),
      instructions,
      known: instructions,
      knownAt: Date.now(),
      ruleset: [...(this.cfg.permissions ?? []), ...agent.permissions, ...(opts.ruleset ?? []), ...employeeRules(agent, session)],
      saved: new Set(),
      depth: opts.depth ?? 0,
      abort: new AbortController(),
      extraTools: opts.extraTools ?? [],
    }
    live.estimate.estimated = live.system.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
    this.live.set(session.id, live)
    this.cfg.events.onSession?.(session)
    return live
  }

  get(sessionID: string) {
    const l = this.live.get(sessionID)
    if (!l) throw new Error(`no live session ${sessionID}`)
    return l
  }

  has(sessionID: string) {
    return this.live.has(sessionID)
  }

  list() {
    return [...this.live.values()]
  }

  /**
   * Đẩy message vào inbox; nếu session đang idle thì chạy turn mới.
   * `from`: "ceo" (mặc định) hoặc id agent gửi (vd CTO steer nhân viên) — chỉ là metadata cho UI.
   */
  send(sessionID: string, text: string, delivery: "queue" | "steer" = "steer", from = "ceo"): Promise<Outcome> {
    const live = this.get(sessionID)
    const msg: Message = { id: id("msg"), role: "user", source: from === "ceo" ? "user" : "agent", from, createdAt: Date.now(), parts: [{ type: "text", text }] }
    live.inbox.push(live.running ? delivery : "queue", msg)
    return this.wake(live)
  }

  /** Tier B + env + skills index, mỗi thứ một source có hash để so sánh giữa phiên. */
  private async contextSources(agent: AgentDef): Promise<InstructionSource[]> {
    const out = [...workspace.sources(this.cfg.docs, { includePersonal: agent.mode === "primary" }), environment(this.cfg.cwd)]
    const skills = await this.cfg.skills?.index()
    if (skills) out.push({ id: SKILLS_SOURCE, content: skills, hash: createHash("sha256").update(skills).digest("hex").slice(0, 16) })
    return out
  }

  /**
   * Tài liệu đổi kể từ lần model biết gần nhất → message `<workspace-update>` đứng trước input của lượt.
   * System prompt không đổi (giữ cache). Thay đổi do chính agent này ghi (vd CTO dùng `memory`)
   * không báo lại: tool đã trả nội dung mới cho nó rồi.
   */
  private async refreshContext(live: Live) {
    if (live.compaction?.id !== live.knownCheckpoint) {
      // Sau compaction, update cũ có thể chỉ còn trong summary → so lại với system prompt gốc.
      live.known = live.instructions
      live.knownCheckpoint = live.compaction?.id
    }
    const current = await this.contextSources(live.agent)
    const since = live.knownAt
    // Index knowledge không có tác giả riêng: là "của mình" nếu mọi tài liệu đổi từ lần trước đều do agent này ghi.
    const knowledgeBySelf = () => {
      const recent = workspace.knowledge(this.cfg.docs).filter((f) => f.updatedAt >= since)
      return recent.length > 0 && recent.every((f) => f.author === live.agent.id)
    }
    const self = (s: InstructionSource) => (s.id === "workspace/knowledge" ? knowledgeBySelf() : s.author !== undefined && s.author === live.agent.id)
    const baseline = live.known
    const fresh = changed(baseline, current).filter((s) => !self(s))
    const docPath: Record<string, string> = { "workspace/company": workspace.FILES.company, "workspace/user": workspace.FILES.user, "workspace/memory": workspace.FILES.memory }
    const gone = removed(baseline, current).filter((s) => !self({ ...s, author: docPath[s.id] ? this.cfg.docs.get(docPath[s.id]!)?.author : undefined }))
    live.known = current
    live.knownAt = Date.now()
    if (fresh.length === 0 && gone.length === 0) return
    const ids = new Set([...fresh, ...gone].map((s) => s.id))
    const notice = updateNotice(
      baseline.filter((s) => ids.has(s.id)),
      fresh,
    )
    if (!notice) return
    live.inbox.pushFront("queue", { id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text: notice }] })
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
    // `ask_lead` chỉ có nghĩa khi có người giao việc. Không lọc bằng rule deny: phiên con thừa kế mọi deny của cha.
    const tools = this.cfg.tools.snapshot(live.ruleset).tools.filter((t) => t.name !== "ask_lead" || !!live.session.parentID)
    const [resolved, ...fallbacks] = this.modelChain(live)
    if (!resolved) {
      live.lastError = `no usable model for ${live.session.model}`
      return Promise.resolve({ tag: "failed", error: new Error(live.lastError) })
    }
    const ctx: TurnContext = {
      sessionID: live.session.id,
      agent: live.agent,
      model: resolved.model,
      provider: resolved.provider,
      fallbacks,
      onModelSwitch: (ref) => (live.activeModel = ref),
      system: live.system,
      tools: [...tools, ...live.extraTools],
      toolContext: { ...toolContextBase, ask: makeAsk({ ...toolContextBase, signal: live.abort.signal }, live.saved) },
      inbox: live.inbox,
      store: this.store,
      messages: live.messages,
      compactionSummary: live.compaction,
      estimate: live.estimate,
      summarizer: this.summarizer(live.session.id),
      memoryFlush: this.cfg.compaction?.memoryFlush,
      saveOutput: (callID, output) => this.cfg.docs.put(`tool-output/${callID}.txt`, output, live.agent.id),
      events: this.cfg.events,
      signal: live.abort.signal,
    }
    live.lastError = undefined
    this.cfg.events.onTurnStart?.(live.session.id)
    // Chỉ khi có việc thật: workspace-update một mình không được tự kích hoạt một lượt (tốn tiền).
    const refresh = live.inbox.size > 0 ? this.refreshContext(live) : Promise.resolve()
    live.running = refresh
      .then(() => runTurn(ctx))
      .then(async (outcome) => {
        live.estimate = ctx.estimate
        live.compaction = ctx.compactionSummary
        live.running = undefined
        if (outcome.tag === "failed") live.lastError = outcome.error.message
        if (live.inbox.size > 0) return this.wake(live)
        if (live.lead?.waiting) this.reportToLead(live, outcome)
        this.cfg.events.onTurnEnd?.(live.session.id, outcome)
        return outcome
      })
      .catch((e) => {
        live.running = undefined
        const outcome = { tag: "failed", error: e as Error } as Outcome
        live.lastError = (e as Error).message
        this.cfg.events.onTurnEnd?.(live.session.id, outcome)
        return outcome
      })
    return live.running
  }

  interrupt(sessionID: string) {
    this.get(sessionID).abort.abort("user")
  }

  /** Đổi provider/model sau khi CEO sửa cấu hình; phiên đang sống giữ model cũ cho đến khi tạo phiên mới. */
  reconfigure(opts: { providers?: ProviderRegistry; defaultModel?: string; compaction?: CompactionConfig; fallbackModels?: string[] }) {
    if (opts.providers) this.cfg.providers = opts.providers
    if (opts.defaultModel) this.cfg.defaultModel = opts.defaultModel
    if ("compaction" in opts) this.cfg.compaction = opts.compaction
    if ("fallbackModels" in opts) this.cfg.fallbackModels = opts.fallbackModels
  }

  /**
   * Thứ tự thử model: model của phiên → các model còn lại của agent → `fallbackModels` công ty →
   * model mặc định. Đã chuyển sang dự phòng thì bắt đầu từ model đó (không thử lại model hỏng mỗi lượt).
   * Ref không resolve được (provider đã xoá) thì bỏ qua kèm notice.
   */
  private modelChain(live: Live): Array<{ ref: string; provider: ProviderClient; model: string }> {
    const refs = [...new Set([live.session.model, ...live.agent.model, ...(this.cfg.fallbackModels ?? []), this.cfg.defaultModel].map((r) => r?.trim()).filter(Boolean) as string[])]
    const start = live.activeModel ? Math.max(0, refs.indexOf(live.activeModel)) : 0
    const out: Array<{ ref: string; provider: ProviderClient; model: string }> = []
    for (const ref of refs.slice(start)) {
      try {
        const r = this.cfg.providers.resolve(ref)
        if (!out.some((o) => o.provider === r.client && o.model === r.model)) out.push({ ref, provider: r.client, model: r.model })
      } catch (e) {
        if (ref === live.session.model) this.cfg.events.onNotice?.(live.session.id, `model ${ref} unavailable: ${(e as Error).message}`)
      }
    }
    return out
  }

  /** `compaction.model` cấu hình sai không được làm hỏng lượt chat: báo và dùng model của phiên. */
  private summarizer(sessionID: string) {
    const ref = this.cfg.compaction?.model
    if (!ref) return undefined
    try {
      const r = this.cfg.providers.resolve(ref)
      return { provider: r.client, model: r.model }
    } catch (e) {
      this.cfg.events.onNotice?.(sessionID, `compaction.model ignored: ${(e as Error).message}`)
      return undefined
    }
  }

  /**
   * Spawn child session. Trả ResultEntry (foreground) hoặc id (background).
   * `wakeParent: false` (direct mode từ UI): kết quả vẫn vào inbox CTO nhưng
   * không đánh thức — CTO thấy ở lượt sau thay vì tự trả lời CEO.
   */
  async spawn(parentID: string, opts: { agent: string; brief: Brief; context?: "isolated" | "fork"; background?: boolean; wakeParent?: boolean; model?: string; from?: string; signal?: AbortSignal }) {
    const parent = this.get(parentID)
    const maxDepth = this.cfg.maxDepth ?? 1
    if (parent.depth >= maxDepth) throw new Error(`delegate: max depth ${maxDepth} reached`)
    const agentDef = this.cfg.agents.get(opts.agent)
    if (agentDef.mode === "primary") throw new Error(`delegate: ${opts.agent} is a primary agent`)
    if (this.activeSubagents >= (this.cfg.maxConcurrentSubagents ?? 4)) throw new Error("delegate: too many concurrent subagents")

    const childRules = inherit(parent.ruleset, [
      ...MANAGEMENT_ACTIONS.filter((a) => a !== "delegate").map((action) => ({ action, resource: "*", effect: "deny" as const })),
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
    child.lead = { parentID, wakeParent: opts.wakeParent !== false }
    const context = opts.context ?? agentDef.context
    const forked = context === "fork" ? forkContext(parent) : ""
    child.inbox.push("queue", {
      id: id("msg"),
      role: "user",
      source: "agent",
      from: opts.from ?? parent.agent.id,
      createdAt: Date.now(),
      parts: [{ type: "text", text: `You are a subagent spawned by another session.\n${forked}\n${renderBrief(opts.brief)}` }],
    })

    // Foreground: parent đang chờ trong tool call → dừng parent (hoặc tool timeout) thì dừng luôn child.
    // Background chạy độc lập; dừng bằng delegate(stop) hoặc nút Dừng ở phiên nhân viên.
    const stopChild = () => child.abort.abort("parent stopped")
    const link = !opts.background ? opts.signal : undefined
    this.activeSubagents++
    const run = this.wake(child)
      .then((outcome) => {
        const entry = this.result(child, outcome)
        if (entry.status === "needs_input") child.lead!.waiting = true
        return entry
      })
      .finally(() => {
        this.activeSubagents--
        link?.removeEventListener("abort", stopChild)
      })
    if (link?.aborted) stopChild()
    else link?.addEventListener("abort", stopChild, { once: true })

    if (opts.background) {
      void run.then((entry) => {
        parent.inbox.push("queue", {
          id: id("msg"),
          role: "user",
          source: "subagent",
          from: child.agent.id,
          createdAt: Date.now(),
          parts: [{ type: "text", text: renderResult(entry) }],
        })
        this.cfg.events.onNotice?.(parentID, `subagent ${child.session.id} finished (${entry.status})`)
        if (!parent.running && opts.wakeParent !== false) void this.wake(parent)
      })
      return { sessionID: child.session.id, status: "running" as const }
    }
    return run
  }

  /** Nhân viên đã được trả lời và làm xong lượt tiếp theo → gửi kết quả mới lên người giao việc. */
  private reportToLead(child: Live, outcome: Outcome) {
    const lead = child.lead!
    lead.waiting = false
    if (!this.live.has(lead.parentID)) return
    const parent = this.get(lead.parentID)
    const entry = this.result(child, outcome)
    if (entry.status === "needs_input") lead.waiting = true
    parent.inbox.push("queue", { id: id("msg"), role: "user", source: "subagent", from: child.agent.id, createdAt: Date.now(), parts: [{ type: "text", text: renderResult(entry) }] })
    this.cfg.events.onNotice?.(parent.session.id, `subagent ${child.session.id} reported (${entry.status})`)
    if (!parent.running && lead.wakeParent) void this.wake(parent)
  }

  private result(child: Live, outcome: Outcome): ResultEntry {
    const asked = outcome.tag === "completed" ? pendingQuestion(child.messages) : undefined
    const last = [...child.messages].reverse().find((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"))
    const summary = last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? ""
    const files = new Set<string>()
    for (const m of child.messages) for (const p of m.parts) if (p.type === "tool-call" && p.name === "write") files.add((p.args as any)?.path)
    const steps = child.messages.filter((m) => m.role === "assistant").length
    return {
      sessionID: child.session.id,
      agent: child.agent.id,
      status: asked ? "needs_input" : outcome.tag === "completed" ? "completed" : outcome.tag === "interrupted" ? "stopped" : "failed",
      exitReason: asked ? "needs_input" : outcome.tag === "failed" ? `error: ${outcome.error.message}` : outcome.tag,
      summary: (asked ?? summary).slice(0, 8000),
      filesTouched: [...files].filter(Boolean),
      usage: { steps, inputTokens: child.estimate.measured, outputTokens: child.messages.reduce((n, m) => (m.role === "assistant" ? n + estimateMessage(m) : n), 0) },
    }
  }
}

/**
 * Nhân viên (mode khác primary) không bao giờ có tool quản lý, kể cả khi CEO chat thẳng
 * (phiên gốc) hay khi phiên con được resume sau restart (lúc đó rule của spawn không còn).
 * `question` chỉ cho phép ở phiên gốc vì CEO đang ngồi đó; `delegate` chỉ cho
 * orchestrator được giao việc từ phiên cha.
 */
function employeeRules(agent: AgentDef, session: Session): Ruleset {
  if (agent.mode === "primary") return []
  const deny = (action: string) => ({ action, resource: "*", effect: "deny" as const })
  return MANAGEMENT_ACTIONS.filter((a) => {
    if (a === "question") return !!session.parentID
    if (a === "delegate") return !session.parentID || agent.role === "leaf"
    return true
  }).map(deny)
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
  /** `needs_input`: nhân viên hỏi ngược (`ask_lead`), đang chờ câu trả lời qua `delegate steer`. */
  status: "completed" | "failed" | "stopped" | "needs_input"
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
  const ask =
    r.status === "needs_input"
      ? `\n\n${r.agent} is waiting for your answer. Reply with delegate(action: "steer", sessionID: "${r.sessionID}", message: …); if only the CEO can decide, ask them first. Their next report arrives as a message.`
      : ""
  return `<subagent sessionID="${r.sessionID}" agent="${r.agent}" status="${r.status}" steps="${r.usage.steps}">\n${r.summary || "(no summary)"}${files}${ask}\n</subagent>`
}

/** Lượt cuối của nhân viên kết thúc bằng `ask_lead` → nội dung câu hỏi (để báo lên người giao việc). */
function pendingQuestion(messages: Message[]): string | undefined {
  const last = messages.at(-1)
  if (last?.role !== "assistant") return undefined
  const call = [...last.parts].reverse().find((p) => p.type === "tool-call" && p.name === "ask_lead")
  if (!call || call.type !== "tool-call") return undefined
  const ok = last.parts.some((p) => p.type === "tool-result" && p.callID === call.callID && !p.isError)
  if (!ok) return undefined
  const a = (call.args ?? {}) as { question?: string; options?: string[]; progress?: string }
  return [
    `Question: ${a.question ?? "(none)"}`,
    a.options?.length ? `Options: ${a.options.map((o) => `"${o}"`).join(", ")}` : "",
    a.progress ? `Progress so far: ${a.progress}` : "",
  ]
    .filter(Boolean)
    .join("\n")
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
