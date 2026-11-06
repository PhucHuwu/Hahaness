import type { Db } from "../core/db.ts"
import { id } from "../core/id.ts"
import type { Message, Outcome } from "../core/types.ts"
import type { AgentRegistry } from "../agent/registry.ts"
import type { ToolRegistry } from "../tool/registry.ts"
import { renderBrief, type Brief, type Harness, type ResultEntry } from "../harness.ts"
import { formatLocal, nextRun, parseCron, timezone } from "./cron.ts"

/**
 * Việc định kỳ: tới giờ thì harness tự mở một phiên CTO mới, giao `task` cho `agent`
 * (hoặc cho chính CTO), báo cáo về CTO để xử lý theo `followUp`. Xem docs/architecture/09-schedules.md.
 */
export interface Schedule {
  id: string
  title: string
  /** Người làm: id nhân viên, hoặc agent primary (CTO tự làm). */
  agent: string
  /** Cron 5 trường, giờ máy chủ. */
  cron: string
  task: Brief
  /** CTO làm gì khi nhận báo cáo (vd lưu vào knowledge). Không có → mặc định `DEFAULT_FOLLOW_UP`. */
  followUp?: string
  /**
   * Tool bắt buộc (tên hoặc glob, vd `facebook_*`). Thiếu → lần chạy `blocked`, không gọi model
   * (tool chưa làm / MCP chưa nối thì chạy chỉ tốn tiền).
   */
  tools?: string[]
  enabled: boolean
  createdBy: string
  createdAt: number
  updatedAt: number
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: RunStatus
  lastSessionID?: string
  lastError?: string
}

export type RunStatus = "running" | "completed" | "failed" | "stopped" | "needs_input" | "skipped" | "blocked" | "interrupted"

export interface ScheduleRun {
  id: string
  scheduleID: string
  /** Giờ đáng lẽ chạy (khác `startedAt` khi chạy bù sau khi máy tắt). */
  dueAt: number
  startedAt: number
  finishedAt?: number
  reason: "due" | "manual"
  status: RunStatus
  /** Phiên CTO của lần chạy này. */
  sessionID?: string
  /** Phiên nhân viên (nếu giao cho nhân viên). */
  workerSessionID?: string
  error?: string
}

export type ScheduleInput = Pick<Schedule, "title" | "agent" | "cron" | "task"> & { followUp?: string; tools?: string[]; enabled?: boolean }

export const DEFAULT_FOLLOW_UP =
  "Check the report against the brief. Keep what is new and worth knowing with `knowledge`: check the outline first, put each finding in the node of the set that covers its topic (append to it, or save a new sub-node under it) instead of creating near-duplicate sets; skip what the library already says. Finish with a short summary for the CEO: what was learned, what was stored where, anything that needs their decision."

const TICK_MS = 30_000
/** Trễ hơn mức này coi là chạy bù (máy tắt / ngủ lúc tới giờ). */
const LATE_MS = 2 * 60_000

export const SCHEDULER_FROM = "scheduler"

export interface SchedulerOptions {
  db: Db
  agents: AgentRegistry
  /** Để kiểm tra `Schedule.tools`. */
  tools?: ToolRegistry
  /** Lý do không chạy được (vd provider chưa cấu hình) → ghi lần chạy là failed. */
  blocked?: () => string | undefined
  onChange?: (scheduleID: string) => void
  now?: () => number
}

export class Scheduler {
  private harness?: Harness
  private timer?: ReturnType<typeof setInterval>
  /** scheduleID → lần chạy đang dở (tránh chồng lần). */
  private active = new Map<string, Promise<ScheduleRun>>()
  private ticking = false

  constructor(private opts: SchedulerOptions) {}

  private get db() {
    return this.opts.db
  }

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  attach(harness: Harness) {
    this.harness = harness
    return this
  }

  /** Lần chạy dở từ trước khi tắt app → interrupted; rồi kiểm tra mỗi 30s (bù luôn lịch đã lỡ). */
  start() {
    for (const run of this.runs()) if (run.status === "running") this.saveRun({ ...run, status: "interrupted", finishedAt: this.now(), error: "the app stopped during this run" })
    for (const s of this.list()) if (s.lastStatus === "running") this.save({ ...s, lastStatus: "interrupted" })
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ---- CRUD -------------------------------------------------------------------

  list(): Schedule[] {
    const rows = this.db.sql.prepare("SELECT data FROM schedules ORDER BY created_at").all() as Array<{ data: string }>
    return rows.map((r) => JSON.parse(r.data) as Schedule)
  }

  get(scheduleID: string): Schedule | undefined {
    const row = this.db.sql.prepare("SELECT data FROM schedules WHERE id = ?").get(scheduleID) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Schedule) : undefined
  }

  private save(s: Schedule) {
    this.db.sql
      .prepare("INSERT INTO schedules(id, data, created_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(s.id, JSON.stringify(s), s.createdAt)
    this.opts.onChange?.(s.id)
    return s
  }

  /** Ném lỗi có thông điệp cho model/CEO nếu cron sai hoặc người làm không tồn tại. */
  validate(input: Partial<ScheduleInput>) {
    if (input.cron !== undefined) parseCron(input.cron)
    if (input.agent !== undefined && !this.opts.agents.has(input.agent)) throw new Error(`No employee "${input.agent}". Use delegate(action: "list") to see staff, or hire one first.`)
    if (input.title !== undefined && !input.title.trim()) throw new Error("title must not be empty")
  }

  create(input: ScheduleInput, createdBy: string): Schedule {
    this.validate(input)
    const now = this.now()
    const enabled = input.enabled !== false
    return this.save({
      id: id("sch"),
      title: input.title.trim(),
      agent: input.agent,
      cron: parseCron(input.cron).expr,
      task: input.task,
      followUp: input.followUp?.trim() || undefined,
      tools: cleanTools(input.tools),
      enabled,
      createdBy,
      createdAt: now,
      updatedAt: now,
      nextRunAt: enabled ? nextRun(input.cron, now) : undefined,
    })
  }

  update(scheduleID: string, patch: Partial<ScheduleInput>): Schedule {
    const prev = this.get(scheduleID)
    if (!prev) throw new Error(`No schedule "${scheduleID}".`)
    this.validate(patch)
    const now = this.now()
    const next: Schedule = {
      ...prev,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
      ...(patch.cron !== undefined ? { cron: parseCron(patch.cron).expr } : {}),
      ...(patch.task !== undefined ? { task: patch.task } : {}),
      ...(patch.followUp !== undefined ? { followUp: patch.followUp.trim() || undefined } : {}),
      ...(patch.tools !== undefined ? { tools: cleanTools(patch.tools) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: now,
    }
    // Bật lại / đổi giờ: tính từ bây giờ, không chạy bù khoảng đã tạm dừng.
    if (!next.enabled) next.nextRunAt = undefined
    else if (!prev.enabled || next.cron !== prev.cron || !prev.nextRunAt) next.nextRunAt = nextRun(next.cron, now)
    return this.save(next)
  }

  setEnabled(scheduleID: string, enabled: boolean) {
    return this.update(scheduleID, { enabled })
  }

  remove(scheduleID: string): boolean {
    const r = this.db.sql.prepare("DELETE FROM schedules WHERE id = ?").run(scheduleID)
    if (Number(r.changes) === 0) return false
    this.opts.onChange?.(scheduleID)
    return true
  }

  runs(scheduleID?: string, limit = 50): ScheduleRun[] {
    const rows = (
      scheduleID
        ? this.db.sql.prepare("SELECT data FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?").all(scheduleID, limit)
        : this.db.sql.prepare("SELECT data FROM schedule_runs ORDER BY started_at DESC LIMIT ?").all(limit)
    ) as Array<{ data: string }>
    return rows.map((r) => JSON.parse(r.data) as ScheduleRun)
  }

  private saveRun(run: ScheduleRun) {
    this.db.sql
      .prepare("INSERT INTO schedule_runs(id, schedule_id, started_at, data) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(run.id, run.scheduleID, run.startedAt, JSON.stringify(run))
    return run
  }

  /** Tool bắt buộc chưa có trong registry (MCP chưa nối, tool chưa làm). */
  missingTools(s: Pick<Schedule, "tools">): string[] {
    const names = this.opts.tools?.names() ?? []
    return (s.tools ?? []).filter((pattern) => !names.some((n) => glob(pattern, n)))
  }

  isRunning(scheduleID: string) {
    return this.active.has(scheduleID)
  }

  /** Chờ mọi lần chạy đang dở xong (test, tắt app). */
  async idle() {
    while (this.active.size) await Promise.allSettled([...this.active.values()])
  }

  // ---- Chạy -------------------------------------------------------------------

  /** Chạy mọi lịch đã tới giờ. Lỡ nhiều lần (máy tắt) chỉ chạy bù một lần, rồi tính lần kế từ bây giờ. */
  async tick(): Promise<ScheduleRun[]> {
    if (this.ticking || !this.harness) return []
    this.ticking = true
    try {
      const now = this.now()
      const out: ScheduleRun[] = []
      for (const s of this.list()) {
        if (!s.enabled || s.nextRunAt === undefined || s.nextRunAt > now) continue
        this.save({ ...s, nextRunAt: nextRun(s.cron, now) })
        out.push(await this.start1(s.id, "due", s.nextRunAt))
      }
      return out
    } finally {
      this.ticking = false
    }
  }

  /** Chạy ngay (CEO bấm, hoặc CTO `run_now`). Không đổi giờ chạy kế tiếp. */
  runNow(scheduleID: string) {
    if (!this.get(scheduleID)) throw new Error(`No schedule "${scheduleID}".`)
    return this.start1(scheduleID, "manual", this.now())
  }

  /**
   * Bắt đầu một lần chạy; trả về khi phiên đã mở (không chờ làm xong).
   * Lần trước chưa xong → ghi `skipped`, không chạy chồng.
   */
  private async start1(scheduleID: string, reason: ScheduleRun["reason"], dueAt: number): Promise<ScheduleRun> {
    const s = this.get(scheduleID)!
    const run: ScheduleRun = { id: id("run"), scheduleID, dueAt, startedAt: this.now(), reason, status: "running" }
    const finish = (status: RunStatus, error?: string) => {
      const done = this.saveRun({ ...run, status, error, finishedAt: this.now() })
      const cur = this.get(scheduleID)
      if (cur) this.save({ ...cur, lastRunAt: run.startedAt, lastStatus: status, lastSessionID: run.sessionID ?? cur.lastSessionID, lastError: error })
      return done
    }
    if (this.active.has(scheduleID)) return finish("skipped", "the previous run is still in progress")
    const blocked = this.opts.blocked?.() ?? (this.harness ? undefined : "scheduler is not attached to a harness")
    if (blocked) return finish("failed", blocked)
    if (!this.opts.agents.has(s.agent)) return finish("failed", `employee "${s.agent}" no longer exists`)
    const missing = this.missingTools(s)
    if (missing.length) return finish("blocked", `missing tool: ${missing.join(", ")}`)

    const harness = this.harness!
    let release!: (r: ScheduleRun) => void
    this.active.set(scheduleID, new Promise<ScheduleRun>((r) => (release = r)))
    const end = (status: RunStatus, error?: string) => {
      const done = finish(status, error)
      this.active.delete(scheduleID)
      release(done)
      return done
    }
    try {
      const primary = this.opts.agents.list("primary")[0]?.id ?? "cto"
      // Không ai ngồi trả lời lúc chạy định kỳ → bỏ `question` (nếu không model sẽ treo tới timeout).
      const lead = await harness.createSession({ agent: primary, title: `Định kỳ · ${s.title}`, ruleset: [{ action: "question", resource: "*", effect: "deny" }] })
      run.sessionID = lead.session.id
      const late = run.startedAt - dueAt > LATE_MS
      const self = this.opts.agents.get(s.agent).mode === "primary"
      const note: Message = {
        id: id("msg"),
        role: "user",
        source: "agent",
        from: SCHEDULER_FROM,
        createdAt: this.now(),
        parts: [{ type: "text", text: renderNote(s, run, late, self) }],
      }
      // Ghi chú vào trước, không đánh thức: nếu giao cho nhân viên, CTO đọc nó cùng lúc với báo cáo.
      lead.inbox.push("queue", note)
      const started = () => {
        this.saveRun(run)
        this.save({ ...this.get(scheduleID)!, lastRunAt: run.startedAt, lastStatus: "running", lastSessionID: run.sessionID, lastError: undefined })
      }
      if (self) {
        started()
        void harness.wake(lead).then(
          (o: Outcome) => end(outcomeStatus(o), o.tag === "failed" ? o.error.message : undefined),
          (e: Error) => end("failed", (e as Error).message),
        )
        return run
      }
      const r = await harness.spawn(lead.session.id, {
        agent: s.agent,
        brief: s.task,
        background: true,
        from: SCHEDULER_FROM,
        // Lần chạy xong khi CTO đã xử lý báo cáo (lưu tri thức, tóm tắt), không chỉ khi nhân viên nộp bài.
        onReport: (entry: ResultEntry) =>
          void harness.wake(lead).then(
            (o: Outcome) => end(o.tag === "failed" ? "failed" : entry.status, o.tag === "failed" ? o.error.message : entry.status === "failed" ? entry.exitReason : undefined),
            (e: Error) => end("failed", (e as Error).message),
          ),
      })
      run.workerSessionID = r.sessionID
      started()
      return run
    } catch (e) {
      return end("failed", (e as Error).message)
    }
  }
}

function cleanTools(tools?: string[]) {
  const out = [...new Set((tools ?? []).map((t) => t.trim()).filter(Boolean))]
  return out.length ? out : undefined
}

function glob(pattern: string, value: string) {
  return new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(value)
}

function outcomeStatus(o: Outcome): RunStatus {
  return o.tag === "completed" ? "completed" : o.tag === "interrupted" ? "stopped" : "failed"
}

function renderNote(s: Schedule, run: ScheduleRun, late: boolean, self: boolean) {
  const when = `${formatLocal(run.startedAt)} (${timezone()})`
  const head = [
    `[Scheduled job] "${s.title}" (${s.id}), cron "${s.cron}". This run started ${when}${run.reason === "manual" ? " on request" : ""}${late ? `; it was due ${formatLocal(run.dueAt)} but the app was not running then` : ""}.`,
    "The harness started this conversation automatically and nobody is reading it live; the CEO sees the outcome later. If something needs the CEO's decision, say so at the top of your final message. If a tool the task needs is missing, say exactly which one instead of improvising.",
  ]
  if (self) return [...head, "", "Task:", renderBrief(s.task), "", `When done: ${s.followUp ?? DEFAULT_FOLLOW_UP}`].join("\n")
  return [
    ...head,
    "",
    `${s.agent} has already been given the brief below by the scheduler. Their report arrives as the next message; do not assign it again.`,
    renderBrief(s.task),
    "",
    `When the report arrives: ${s.followUp ?? DEFAULT_FOLLOW_UP}`,
  ].join("\n")
}
