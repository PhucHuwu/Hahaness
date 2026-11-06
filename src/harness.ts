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
import type { Compaction, Message, Outcome, Part, Session, UsageRecord } from "./core/types.ts"
import { addTotals, contextBreakdown, summarizeUsage, type ContextBreakdown, type UsageSummary, type UsageTotals } from "./context/usage.ts"
import { build as buildSystem } from "./context/system.ts"
import { changed, environment, removed, updateNotice, type InstructionSource } from "./context/instructions.ts"
import * as workspace from "./context/workspace.ts"
import { ceiling, estimateMessage } from "./context/budget.ts"
import { AskGate, type AskHandler } from "./permission/ask.ts"
import { denied, evaluate, type Ruleset } from "./permission/ruleset.ts"
import type { ProviderRegistry } from "./provider/registry.ts"
import type { ProviderClient } from "./provider/types.ts"
import type { ToolRegistry } from "./tool/registry.ts"
import { makeAsk } from "./tool/execute.ts"
import type { Tool } from "./tool/define.ts"
import type { SkillStore } from "./context/skills.ts"
import type { CompactionConfig } from "./config.ts"

export interface HarnessConfig {
  cwd: string
  /** Thư mục làm việc của tool `bash`; bản gốc file CEO gửi nằm ở `uploads/` trong đó. */
  workdir?: string
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
  /** Mọi lần gọi model của phiên (token thật provider trả về). */
  usage: UsageRecord[]
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
  abort: AbortController
  running?: Promise<Outcome>
  /** Lỗi của lượt gần nhất (xóa khi lượt mới bắt đầu) để UI hiện lại sau khi tải lại trang. */
  lastError?: string
  /** Model đang dùng nếu đã chuyển sang dự phòng (chỉ trong bộ nhớ; restart thì thử lại model chính). */
  activeModel?: string
  /** Việc được giao đang làm (mỗi phiên làm một việc một lúc); `tasks` là việc đang xếp hàng. */
  task?: Assignment
  tasks: Assignment[]
  /** > 0: đang chạy việc định kỳ, không ai ngồi trả lời → tắt `question` cho các lượt này. */
  unattended: number
}

/**
 * Một lần giao việc vào phiên duy nhất của nhân viên. Lưu xuống store của phiên nhân viên
 * (`assign`/`assign-state`/`assign-end`) để restart vẫn làm tiếp và vẫn báo cáo về người giao.
 */
interface Assignment {
  id: string
  /** Agent nhận báo cáo; báo cáo vào phiên duy nhất của agent đó. */
  lead: string
  /** Người giao hiển thị trên UI: id agent, `ceo` hoặc `scheduler`. */
  from: string
  wakeLead: boolean
  brief: Message
  /** 1 = CTO giao; nhân viên orchestrator giao tiếp thì +1 (giới hạn `maxDepth`). */
  depth: number
  /** Nhân viên đã hỏi (`ask_lead`) và đang chờ; lượt kế tiếp kết thúc thì báo lại. */
  waiting?: boolean
  /** Đã trả kết quả đầu tiên (tool result của delegate hoặc tin nhắn nền); lần sau luôn vào inbox người giao. */
  reported?: boolean
  /** Kết quả đầu tiên. */
  resolve: (entry: ResultEntry) => void
}

export class Harness {
  readonly store: SessionStore
  readonly askGate: AskGate
  private live = new Map<string, Live>()
  private homes = new Map<string, Promise<Live>>()
  /** agent → id phiên chính, biết đồng bộ (cho `sessionView`). */
  private homeIDs = new Map<string, string>()
  /** Việc đã giao nhưng chưa có báo cáo đầu tiên (đang làm hoặc xếp hàng). */
  private activeSubagents = 0

  constructor(readonly cfg: HarnessConfig) {
    this.store = new SessionStore(cfg.db)
    this.askGate = new AskGate(cfg.askHandler)
  }

  /**
   * Phiên duy nhất của agent (1 nhân viên = 1 phiên chat): phiên gốc mới nhất đã lưu, chưa có thì tạo.
   * Phiên cũ khác (trước khi đổi sang mô hình này) chỉ còn để xem, xem `isHome`.
   */
  sessionFor(agentID: string): Promise<Live> {
    let p = this.homes.get(agentID)
    if (!p) {
      p = this.openHome(agentID)
      this.homes.set(agentID, p)
      p.catch(() => this.homes.delete(agentID))
    }
    return p
  }

  private async openHome(agentID: string): Promise<Live> {
    const agent = this.cfg.agents.get(agentID)
    const existing = homeSessions(await this.store.listSessions()).get(agentID)
    if (existing) {
      this.homeIDs.set(agentID, existing.id)
      return this.resume(existing.id)
    }
    const modelRef = agent.model[0] ?? this.cfg.defaultModel
    this.cfg.providers.resolve(modelRef)
    const session: Session = { id: id("ses"), agent: agent.id, model: modelRef, title: agent.name, createdAt: Date.now() }
    await this.store.createSession(session)
    this.homeIDs.set(agentID, session.id)
    return this.activate(session, agent)
  }

  /** Id phiên chính của agent nếu đã biết trong tiến trình này (không đọc DB). */
  homeOf(agentID: string): string | undefined {
    return this.homeIDs.get(agentID)
  }

  /** Nạp lại phiên từ store (sau khi restart). System prompt được dựng lại từ workspace hiện tại. */
  async resume(sessionID: string): Promise<Live> {
    const existing = this.live.get(sessionID)
    if (existing) return existing
    const state = await this.store.load(sessionID)
    if (!state) throw new Error(`no stored session ${sessionID}`)
    const agent = this.cfg.agents.get(state.session.agent)
    const live = await this.activate(state.session, agent)
    live.messages.push(...state.messages)
    live.usage.push(...state.usage)
    live.compaction = state.compactions.at(-1)
    // System vừa dựng lại từ workspace hiện tại → không cần báo gì cho tới khi tài liệu đổi tiếp.
    live.knownCheckpoint = live.compaction?.id
    live.inbox.restore(state.inbox)
    // Việc được giao chưa xong: kết quả đầu tiên không còn ai chờ trong tool call → mọi báo cáo vào inbox người giao.
    for (const r of state.assignments) {
      const task: Assignment = { id: r.id, lead: r.lead, from: r.from, wakeLead: r.wakeLead, brief: r.brief, depth: r.depth, waiting: r.waiting, reported: true, resolve: () => {} }
      if (r.started && !live.task) {
        live.task = task
        // Tắt ngay giữa lúc đánh dấu bắt đầu và đưa brief vào inbox → đưa lại.
        if (!live.messages.some((m) => m.id === r.brief.id) && !state.inbox.some((i) => i.message.id === r.brief.id)) live.inbox.push("queue", r.brief)
      } else live.tasks.push(task)
    }
    // DB cũ (trước khi lưu việc được giao): nhân viên đang chờ câu trả lời thì vẫn phải báo lại người giao việc.
    if (!live.task && agent.mode !== "primary" && pendingQuestion(live.messages) !== undefined) {
      const brief = [...live.messages].reverse().find((m) => m.role === "user" && m.source === "agent" && !!m.from)
      const from = brief?.from
      if (brief && from) {
        const lead = this.cfg.agents.has(from) ? from : (this.cfg.agents.list("primary")[0]?.id ?? "cto")
        live.task = { id: id("task"), lead, from, wakeLead: true, brief, depth: 1, waiting: true, reported: true, resolve: () => {} }
      }
    }
    const repaired = await repairDangling({ sessionID, messages: live.messages, store: this.store })
    live.estimate.estimated += fromCheckpoint(live.messages, live.compaction).reduce((n, m) => n + estimateMessage(m), 0)
    const told = state.inbox.some((i) => i.message.parts.some((p) => p.type === "text" && p.text === RESUMED_AFTER_CRASH))
    if ((state.staleClaim || repaired > 0) && !told) {
      // Báo cho model ở lượt kế tiếp; `recover` lúc khởi động sẽ chạy lượt đó luôn.
      live.inbox.push("queue", { id: id("msg"), role: "user", source: "system", createdAt: Date.now(), parts: [{ type: "text", text: RESUMED_AFTER_CRASH }] })
    }
    return live
  }

  /**
   * Gọi lúc server khởi động: làm tiếp việc dở từ trước khi tắt (deploy, reboot, crash),
   * không cần ai mở web. Đánh thức phiên có lượt bị cắt (claim chưa release) hoặc việc được
   * giao còn input chưa xử lý (brief, câu trả lời); chạy việc đang xếp hàng. Tin trong inbox của phiên
   * rảnh (vd báo cáo `wakeLead: false`) vẫn chờ tin nhắn kế tiếp như trước restart.
   * Gọi lại nhiều lần an toàn (vd sau khi sửa cấu hình provider). Trả số phiên được chạy tiếp.
   */
  async recover(): Promise<number> {
    let woken = 0
    for (const s of homeSessions(await this.store.listSessions()).values()) {
      if (!this.cfg.agents.has(s.agent)) continue
      const known = this.live.get(s.id)
      if (known?.running) continue
      const state = known ? undefined : await this.store.load(s.id)
      if (state && !state.staleClaim && state.inbox.length === 0 && state.assignments.length === 0) continue
      const live = await this.sessionFor(s.agent)
      if (live.session.id !== s.id || live.running) continue
      const task = live.task
      // Việc đang chờ câu trả lời mà câu trả lời đã nằm trong inbox → cũng chạy tiếp.
      if (state?.staleClaim || (task && live.inbox.size > 0)) {
        woken++
        void this.wake(live)
      } else if (task && !task.waiting) {
        // Lượt đã xong nhưng tắt trước khi kịp báo cáo.
        this.settle(live, { tag: "completed", text: "" })
        this.next(live)
      } else if (!task && live.tasks.length > 0) {
        woken++
        this.next(live)
      }
    }
    return woken
  }

  private async activate(session: Session, agent: AgentDef): Promise<Live> {
    const instructions = await this.contextSources(agent)
    const skills = instructions.find((s) => s.id === SKILLS_SOURCE)
    const live: Live = {
      session,
      agent,
      inbox: new Inbox({
        added: (item, front) => void this.store.append(session.id, { kind: "inbox", item, ...(front ? { front } : {}) }),
        taken: (ids) => void this.store.append(session.id, { kind: "inbox-taken", ids }),
      }),
      messages: [],
      estimate: { measured: 0, estimated: 0 },
      usage: [],
      system: buildSystem({ agent, instructions: instructions.filter((s) => s !== skills), skillsIndex: skills?.content }),
      instructions,
      known: instructions,
      knownAt: Date.now(),
      ruleset: [...(this.cfg.permissions ?? []), ...agent.permissions, ...employeeRules(agent)],
      saved: new Set(),
      abort: new AbortController(),
      tasks: [],
      unattended: 0,
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
  send(sessionID: string, text: string, delivery: "queue" | "steer" = "steer", from = "ceo", attachments: Part[] = []): Promise<Outcome> {
    const live = this.get(sessionID)
    const parts: Part[] = [...(text ? [{ type: "text" as const, text }] : []), ...attachments]
    const msg: Message = { id: id("msg"), role: "user", source: from === "ceo" ? "user" : "agent", from, createdAt: Date.now(), parts }
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
    const tools = this.toolsFor(live)
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
      tools,
      toolContext: { ...toolContextBase, ask: makeAsk({ ...toolContextBase, signal: live.abort.signal }, live.saved) },
      inbox: live.inbox,
      store: this.store,
      messages: live.messages,
      compactionSummary: live.compaction,
      estimate: live.estimate,
      usage: live.usage,
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
        this.settle(live, outcome)
        this.cfg.events.onTurnEnd?.(live.session.id, outcome)
        this.next(live)
        return outcome
      })
      .catch((e) => {
        live.running = undefined
        const outcome = { tag: "failed", error: e as Error } as Outcome
        live.lastError = (e as Error).message
        this.settle(live, outcome)
        this.cfg.events.onTurnEnd?.(live.session.id, outcome)
        this.next(live)
        return outcome
      })
    return live.running
  }

  /**
   * Tool theo tình huống của lượt (ruleset cố định cả phiên, nhưng phiên dùng chung cho nhiều việc):
   * `ask_lead` chỉ khi đang làm việc được giao; `question` không có khi đang làm việc được giao
   * (hỏi người giao bằng `ask_lead`) hay khi chạy định kỳ (không ai ngồi trả lời).
   */
  private toolsFor(live: Live): Tool[] {
    return this.cfg.tools.snapshot(live.ruleset).tools.filter((t) => {
      if (t.name === "ask_lead") return !!live.task
      if (t.name === "question") return !live.task && live.unattended === 0
      return true
    })
  }

  /** Đánh dấu phiên đang chạy việc không người trực (lịch); trả hàm để gỡ. */
  unattended(live: Live): () => void {
    live.unattended++
    let done = false
    return () => {
      if (!done) live.unattended--
      done = true
    }
  }

  /**
   * Báo cáo token của phiên: số thật provider trả về (theo mục đích, theo model) + ước lượng context
   * hiện tại chia theo loại nội dung + tổng của nhân viên (phiên con, đệ quy).
   * Phiên không sống thì không có system/tools → chỉ chia phần messages.
   */
  async usageReport(sessionID: string): Promise<UsageReport> {
    const live = this.live.get(sessionID)
    let records: UsageRecord[]
    let breakdown: ContextBreakdown
    let contextWindow: number | undefined
    let model: string
    if (live) {
      records = live.usage
      const messages = fromCheckpoint(live.messages, live.compaction)
      breakdown = contextBreakdown(live.system, this.toolsFor(live).map((t) => t.definition()), messages, live.compaction?.id)
      model = live.activeModel ?? live.session.model
      try {
        contextWindow = this.cfg.providers.resolve(model).info.contextWindow
      } catch {}
    } else {
      const state = await this.store.load(sessionID)
      if (!state) throw new Error(`no stored session ${sessionID}`)
      records = state.usage
      const compaction = state.compactions.at(-1)
      breakdown = contextBreakdown([], [], fromCheckpoint(state.messages, compaction), compaction?.id)
      model = state.session.model
      try {
        contextWindow = this.cfg.providers.resolve(model).info.contextWindow
      } catch {}
    }
    const agent = live?.session.agent ?? (await this.store.listSessions()).find((s) => s.id === sessionID)?.agent
    const children = this.cfg.agents.has(agent ?? "") && this.cfg.agents.get(agent!).mode === "primary" ? [...(await this.staffUsage()), ...(await this.childUsage(sessionID))] : await this.childUsage(sessionID)
    return {
      sessionID,
      model,
      contextWindow,
      ceiling: contextWindow ? ceiling(contextWindow) : undefined,
      estimatedContext: breakdown.categories.reduce((n, c) => n + c.tokens, 0),
      live: !!live,
      ...summarizeUsage(records),
      context: breakdown,
      children,
    }
  }

  /** Phiên của từng nhân viên (CTO giao việc vào đó), gồm cả phiên con cũ trước khi đổi sang 1 phiên/agent. */
  private async staffUsage(): Promise<UsageReport["children"]> {
    const stored = await this.store.listSessions()
    for (const l of this.list()) if (!stored.some((s) => s.id === l.session.id)) stored.push(l.session)
    const out: UsageReport["children"] = []
    for (const s of stored) {
      if (s.parentID || (this.cfg.agents.has(s.agent) && this.cfg.agents.get(s.agent).mode === "primary")) continue
      const own = summarizeUsage(this.live.get(s.id)?.usage ?? (await this.store.usage(s.id))).total
      if (own.calls === 0) continue
      out.push({ sessionID: s.id, agent: s.agent, title: s.title, total: own })
    }
    return out
  }

  /** Phiên con kiểu cũ (có `parentID`). */
  private async childUsage(parentID: string): Promise<UsageReport["children"]> {
    const stored = await this.store.listSessions()
    const ids = new Set([...stored.filter((s) => s.parentID === parentID).map((s) => s.id), ...this.list().filter((l) => l.session.parentID === parentID).map((l) => l.session.id)])
    const out: UsageReport["children"] = []
    for (const id of ids) {
      const live = this.live.get(id)
      const session = live?.session ?? stored.find((s) => s.id === id)!
      const own = summarizeUsage(live?.usage ?? (await this.store.usage(id))).total
      const nested = await this.childUsage(id)
      out.push({ sessionID: id, agent: session.agent, title: session.title, total: nested.reduce((t, c) => addTotals(t, c.total), own) })
    }
    return out
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
   * Giao việc cho nhân viên, vào phiên duy nhất của họ (1 nhân viên = 1 phiên chat).
   * Nhân viên đang làm việc khác → việc mới xếp hàng, làm lần lượt.
   * Foreground trả ResultEntry; background trả ngay, báo cáo về inbox phiên người giao.
   * `wakeLead: false` (direct mode từ UI): báo cáo vẫn vào inbox CTO nhưng không đánh thức,
   * CTO thấy ở lượt sau thay vì tự trả lời CEO.
   */
  async spawn(
    leadSessionID: string,
    opts: {
      agent: string
      brief: Brief
      context?: "isolated" | "fork"
      background?: boolean
      wakeLead?: boolean
      /** Người giao hiển thị (mặc định agent của phiên giao): `ceo`, `scheduler`… */
      from?: string
      signal?: AbortSignal
      /** Background: gọi sau khi báo cáo đầu tiên đã vào inbox người giao (và đã đánh thức nếu có). */
      onReport?: (entry: ResultEntry) => void
    },
  ): Promise<ResultEntry | { sessionID: string; status: "running" | "queued" }> {
    const lead = this.get(leadSessionID)
    const depth = (lead.task?.depth ?? 0) + 1
    const maxDepth = this.cfg.maxDepth ?? 1
    if (lead.agent.mode !== "primary" && !lead.task) throw new Error("delegate: only work assigned to you can be passed on")
    if (depth > maxDepth) throw new Error(`delegate: max depth ${maxDepth} reached`)
    const agentDef = this.cfg.agents.get(opts.agent)
    if (agentDef.mode === "primary") throw new Error(`delegate: ${opts.agent} is a primary agent`)
    if (agentDef.id === lead.agent.id) throw new Error("delegate: cannot assign work to yourself")
    if (this.activeSubagents >= (this.cfg.maxConcurrentSubagents ?? 4)) throw new Error("delegate: too many assignments in progress")

    const worker = await this.sessionFor(opts.agent)
    const from = opts.from ?? lead.agent.id
    const context = opts.context ?? agentDef.context
    const forked = context === "fork" ? forkContext(lead) : ""
    const who = from === "ceo" ? "the CEO" : from === "scheduler" ? "the scheduler (a recurring job)" : from
    const brief: Message = {
      id: id("msg"),
      role: "user",
      source: "agent",
      from,
      createdAt: Date.now(),
      parts: [{ type: "text", text: `New task from ${who}. Your final message is your report to them.${saveHint(worker.ruleset)}\n${forked}\n${renderBrief(opts.brief)}` }],
    }
    let resolve!: (e: ResultEntry) => void
    const first = new Promise<ResultEntry>((r) => (resolve = r))
    const task: Assignment = { id: id("task"), lead: lead.agent.id, from, wakeLead: opts.wakeLead !== false, brief, depth, resolve }
    await this.store.append(worker.session.id, { kind: "assign", task: { id: task.id, lead: task.lead, from, wakeLead: task.wakeLead, brief, depth } })
    this.activeSubagents++

    // Foreground: người giao đang chờ trong tool call → họ dừng (hoặc tool timeout) thì dừng luôn việc này.
    // Background chạy độc lập; dừng bằng delegate(stop) hoặc nút Dừng ở phiên nhân viên.
    const link = !opts.background ? opts.signal : undefined
    const cancel = () => {
      if (worker.task === task) worker.abort.abort("lead stopped")
      else if (worker.tasks.includes(task)) {
        worker.tasks = worker.tasks.filter((t) => t !== task)
        this.closeTask(worker, task)
        this.deliver(task, { ...emptyResult(worker), status: "stopped", exitReason: "cancelled before it started" })
      }
    }
    if (link?.aborted) {
      this.activeSubagents--
      this.closeTask(worker, task)
      throw new Error("delegate: cancelled")
    }
    link?.addEventListener("abort", cancel, { once: true })
    void first.finally(() => link?.removeEventListener("abort", cancel))

    const queued = !!worker.task
    if (queued) worker.tasks.push(task)
    else this.begin(worker, task)

    if (opts.background) {
      void first.then((entry) => {
        this.report(task, entry)
        opts.onReport?.(entry)
      })
      return { sessionID: worker.session.id, status: queued ? "queued" : "running" }
    }
    return first
  }

  /** Nhân viên đang làm gì (cho `delegate list` và UI). */
  work(live: Live): { status: "working" | "waiting" | "idle"; goal?: string; from?: string; queued: number } {
    const goal = live.task && /<goal>([\s\S]*?)<\/goal>/.exec(textOf(live.task.brief))?.[1]
    return {
      status: live.task?.waiting ? "waiting" : live.task || live.running ? "working" : "idle",
      goal: goal || undefined,
      from: live.task?.from,
      queued: live.tasks.length,
    }
  }

  private begin(live: Live, task: Assignment) {
    live.task = task
    void this.store.append(live.session.id, { kind: "assign-state", id: task.id, started: true })
    live.inbox.push("queue", task.brief)
    void this.wake(live)
  }

  private closeTask(live: Live, task: Assignment) {
    void this.store.append(live.session.id, { kind: "assign-end", id: task.id })
  }

  /** Lượt vừa xong mà inbox rỗng: chạy việc kế tiếp trong hàng (nếu đã xong việc hiện tại). */
  private next(live: Live) {
    if (live.task || live.running || live.tasks.length === 0) return
    this.begin(live, live.tasks.shift()!)
  }

  /**
   * Lượt kết thúc khi đang làm việc được giao → báo cáo. Hỏi lại (`ask_lead`) thì việc vẫn mở,
   * chờ câu trả lời; xong/lỗi/dừng thì đóng việc.
   */
  private settle(live: Live, outcome: Outcome) {
    const task = live.task
    if (!task) return
    const entry = this.result(live, task, outcome)
    task.waiting = entry.status === "needs_input"
    if (!task.waiting) {
      live.task = undefined
      this.closeTask(live, task)
    } else void this.store.append(live.session.id, { kind: "assign-state", id: task.id, waiting: true })
    this.deliver(task, entry)
  }

  /** Kết quả đầu tiên trả cho người giao (tool result / tin nhắn nền); các lần sau (sau khi hỏi lại) vào inbox họ. */
  private deliver(task: Assignment, entry: ResultEntry) {
    if (task.reported) return this.report(task, entry)
    task.reported = true
    this.activeSubagents--
    task.resolve(entry)
  }

  /** Đồng bộ khi phiên người giao đang sống: `onReport` (scheduler) đánh thức ngay sau đó phải thấy báo cáo. */
  private report(task: Assignment, entry: ResultEntry) {
    const post = (lead: Live) => {
      lead.inbox.push("queue", { id: id("msg"), role: "user", source: "subagent", from: entry.agent, createdAt: Date.now(), parts: [{ type: "text", text: renderResult(entry) }] })
      this.cfg.events.onNotice?.(lead.session.id, `${entry.agent} reported (${entry.status})`)
      if (!lead.running && task.wakeLead) void this.wake(lead)
    }
    const home = this.homeIDs.get(task.lead)
    const live = home ? this.live.get(home) : undefined
    if (live) return post(live)
    void this.sessionFor(task.lead).then(post, () => {})
  }

  /** Chỉ tính phần phiên từ brief của việc này trở đi (phiên nhân viên chứa nhiều việc). */
  private result(live: Live, task: Assignment, outcome: Outcome): ResultEntry {
    const at = live.messages.findIndex((m) => m.id === task.brief.id)
    const messages = at >= 0 ? live.messages.slice(at) : []
    const asked = outcome.tag === "completed" ? pendingQuestion(messages) : undefined
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"))
    const summary = last?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? ""
    // Chỉ tính write thành công; write lỗi báo riêng để người giao việc không chuyển lời khẳng định sai.
    const files = new Set<string>()
    const failed = new Map<string, string>()
    const writes = new Map<string, string>()
    for (const m of messages)
      for (const p of m.parts) {
        if (p.type === "tool-call" && (p.name === "write" || p.name === "edit")) writes.set(p.callID, String((p.args as any)?.path ?? ""))
        if (p.type === "tool-result" && writes.has(p.callID)) {
          const path = writes.get(p.callID)!
          if (p.isError) failed.set(path, String(p.output).split("\n")[0]!.slice(0, 160))
          else {
            files.add(path)
            failed.delete(path)
          }
        }
      }
    for (const f of files) failed.delete(f)
    return {
      ...emptyResult(live),
      status: asked ? "needs_input" : outcome.tag === "completed" ? "completed" : outcome.tag === "interrupted" ? "stopped" : "failed",
      exitReason: asked ? "needs_input" : outcome.tag === "failed" ? `error: ${outcome.error.message}` : outcome.tag,
      summary: (asked ?? summary).slice(0, 8000),
      filesTouched: [...files].filter(Boolean),
      failedWrites: [...failed].map(([path, error]) => ({ path, error })),
      usage: {
        steps: messages.filter((m) => m.role === "assistant").length,
        inputTokens: live.estimate.measured,
        outputTokens: messages.reduce((n, m) => (m.role === "assistant" ? n + estimateMessage(m) : n), 0),
      },
    }
  }
}

function emptyResult(live: Live): ResultEntry {
  return { sessionID: live.session.id, agent: live.agent.id, status: "stopped", exitReason: "", summary: "", filesTouched: [], failedWrites: [], usage: { steps: 0, inputTokens: 0, outputTokens: 0 } }
}

const textOf = (m: Message) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")

/**
 * Phiên chính của mỗi agent: phiên gốc (không `parentID`) mới nhất. Phiên con kiểu cũ và
 * phiên gốc cũ hơn là lịch sử từ trước khi chuyển sang 1 phiên/agent, chỉ để xem.
 */
export function homeSessions(sessions: Session[]): Map<string, Session> {
  const out = new Map<string, Session>()
  for (const s of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) if (!s.parentID && !out.has(s.agent)) out.set(s.agent, s)
  return out
}

/**
 * Nhân viên (mode khác primary) không bao giờ có tool quản lý. `delegate` chỉ cho orchestrator,
 * và chỉ dùng được khi đang làm việc được giao (`spawn` kiểm tra). `question` để nguyên vì CEO
 * chat thẳng trong cùng phiên; khi đang làm việc được giao thì `toolsFor` ẩn nó (dùng `ask_lead`).
 */
function employeeRules(agent: AgentDef): Ruleset {
  if (agent.mode === "primary") return []
  const deny = (action: string) => ({ action, resource: "*", effect: "deny" as const })
  // bash chỉ khi vai được cấp rõ ràng (capability `bash` hoặc rule allow trong markdown).
  const bash = agent.permissions.some((r) => r.action === "bash" && r.effect === "allow") ? [] : [deny("bash")]
  return [...MANAGEMENT_ACTIONS.filter((a) => a !== "question" && (a !== "delegate" || agent.role === "leaf")).map(deny), ...bash]
}

/** Cho nhân viên biết chỗ được lưu, để không thử `deliverables/` rồi bị từ chối. */
function saveHint(rules: Ruleset): string {
  const can = (p: string) => !denied(rules, "write", p) && evaluate(rules, "write", p) === "allow"
  if (can("deliverables/x.md")) return ""
  if (can("drafts/x.md")) return "\nSave documents only under drafts/ (e.g. drafts/plan.md) and give the path in your report; your lead publishes the final version."
  return "\nYou cannot save documents; put the full result in your final message."
}

export interface Brief {
  goal: string
  context: string
  done_when: string
  output?: string
}

export interface UsageReport extends UsageSummary {
  sessionID: string
  model: string
  contextWindow?: number
  /** Ngưỡng tự compact. */
  ceiling?: number
  /** Tổng các mục trong `context` (ước lượng ký tự/4). */
  estimatedContext: number
  live: boolean
  context: ContextBreakdown
  /** Phiên nhân viên, tổng đã gồm cả nhân viên cấp dưới của họ. */
  children: Array<{ sessionID: string; agent: string; title: string; total: UsageTotals }>
}

export interface ResultEntry {
  sessionID: string
  agent: string
  /** `needs_input`: nhân viên hỏi ngược (`ask_lead`), đang chờ câu trả lời qua `delegate steer`. */
  status: "completed" | "failed" | "stopped" | "needs_input"
  exitReason: string
  summary: string
  filesTouched: string[]
  /** `write` bị lỗi và không có lần ghi thành công sau đó → tài liệu KHÔNG tồn tại dù summary nói gì. */
  failedWrites?: Array<{ path: string; error: string }>
  usage: { steps: number; inputTokens: number; outputTokens: number }
}

export function renderBrief(b: Brief) {
  return `<brief>\n<goal>${b.goal}</goal>\n<context>${b.context}</context>\n<done_when>${b.done_when}</done_when>\n<output>${b.output ?? "report"}</output>\n</brief>`
}

export function renderResult(r: ResultEntry) {
  const failed = r.failedWrites?.length
    ? `\nWRITE FAILED (these documents were NOT saved, whatever the summary says): ${r.failedWrites.map((f) => `${f.path} — ${f.error}`).join("; ")}`
    : ""
  const files = (r.filesTouched.length ? `\nfiles saved: ${r.filesTouched.join(", ")}` : "") + failed
  const ask =
    r.status === "needs_input"
      ? `\n\n${r.agent} is waiting for your answer. Reply with delegate(action: "steer", agent: "${r.agent}", message: …); if only the CEO can decide, ask them first. Their next report arrives as a message.`
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
