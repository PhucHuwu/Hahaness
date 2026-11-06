import type { Db } from "./db.ts"
import type { AssignmentRecord, Compaction, InboxItem, Message, Part, Session, StoreEvent, UsageRecord } from "./types.ts"

/**
 * Event log append-only trong SQLite (bảng `events`), một dòng mỗi event.
 * Đọc lại bằng cách fold toàn bộ event của session, giống JSONL trước đây.
 * Metadata session nằm riêng ở bảng `sessions` để liệt kê nhanh.
 */
export class SessionStore {
  constructor(private db: Db) {}

  async append(sessionID: string, event: StoreEvent) {
    this.db.sql.prepare("INSERT INTO events(session_id, kind, data) VALUES(?, ?, ?)").run(sessionID, event.kind, JSON.stringify(event))
  }

  async read(sessionID: string): Promise<StoreEvent[]> {
    const rows = this.db.sql.prepare("SELECT data FROM events WHERE session_id = ? ORDER BY seq").all(sessionID) as Array<{ data: string }>
    return rows.map((r) => JSON.parse(r.data) as StoreEvent)
  }

  async usage(sessionID: string): Promise<UsageRecord[]> {
    const rows = this.db.sql.prepare("SELECT data FROM events WHERE session_id = ? AND kind = 'usage' ORDER BY seq").all(sessionID) as Array<{ data: string }>
    return rows.map((r) => (JSON.parse(r.data) as { usage: UsageRecord }).usage)
  }

  /** Mọi phiên đã lưu, mới nhất trước. */
  async listSessions(): Promise<Session[]> {
    const rows = this.db.sql.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Array<Record<string, any>>
    return rows.map((r) => ({
      id: r.id,
      ...(r.parent_id ? { parentID: r.parent_id } : {}),
      agent: r.agent,
      model: r.model,
      title: r.title,
      createdAt: Number(r.created_at),
    }))
  }

  async load(sessionID: string): Promise<SessionState | undefined> {
    const events = await this.read(sessionID)
    if (events.length === 0) return undefined
    return fold(events)
  }

  async createSession(session: Session) {
    this.db.tx(() => {
      this.db.sql
        .prepare("INSERT INTO sessions(id, parent_id, agent, model, title, created_at) VALUES(?, ?, ?, ?, ?, ?)")
        .run(session.id, session.parentID ?? null, session.agent, session.model, session.title, session.createdAt)
      this.db.sql.prepare("INSERT INTO events(session_id, kind, data) VALUES(?, ?, ?)").run(session.id, "session", JSON.stringify({ kind: "session", session }))
    })
  }

  async addMessage(sessionID: string, message: Message) {
    await this.append(sessionID, { kind: "message", message })
  }

  async addPart(sessionID: string, messageID: string, part: Part) {
    await this.append(sessionID, { kind: "part", messageID, part })
  }

  async addCompaction(sessionID: string, compaction: Compaction) {
    await this.append(sessionID, { kind: "compaction", compaction })
  }

  async addUsage(sessionID: string, usage: UsageRecord) {
    await this.append(sessionID, { kind: "usage", usage })
  }

  async claim(sessionID: string) {
    await this.append(sessionID, { kind: "claim", at: Date.now() })
  }

  async release(sessionID: string) {
    await this.append(sessionID, { kind: "release", at: Date.now() })
  }
}

export interface SessionState {
  session: Session
  messages: Message[]
  compactions: Compaction[]
  usage: UsageRecord[]
  /** true nếu có claim chưa release → turn trước bị cắt giữa chừng. */
  staleClaim: boolean
  /** Inbox chưa xử lý lúc dừng, đúng thứ tự. */
  inbox: InboxItem[]
  /** Việc được giao chưa xong (đang làm trước, rồi hàng chờ). */
  assignments: AssignmentRecord[]
}

export function fold(events: StoreEvent[]): SessionState {
  let session: Session | undefined
  const messages = new Map<string, Message>()
  const compactions: Compaction[] = []
  const usage: UsageRecord[] = []
  let claimed = false
  let inbox: InboxItem[] = []
  const assignments = new Map<string, AssignmentRecord>()
  for (const e of events) {
    switch (e.kind) {
      case "session":
        session = e.session
        break
      case "message":
        messages.set(e.message.id, { ...e.message, parts: [...e.message.parts] })
        break
      case "part":
        messages.get(e.messageID)?.parts.push(e.part)
        break
      case "compaction":
        compactions.push(e.compaction)
        break
      case "usage":
        usage.push(e.usage)
        break
      case "claim":
        claimed = true
        break
      case "release":
        claimed = false
        break
      case "inbox":
        if (e.front) inbox.unshift(e.item)
        else inbox.push(e.item)
        break
      case "inbox-taken": {
        const ids = new Set(e.ids)
        inbox = inbox.filter((i) => !ids.has(i.id))
        break
      }
      case "assign":
        assignments.set(e.task.id, { ...e.task })
        break
      case "assign-state": {
        const t = assignments.get(e.id)
        if (t) assignments.set(e.id, { ...t, ...(e.started !== undefined ? { started: e.started } : {}), ...(e.waiting !== undefined ? { waiting: e.waiting } : {}) })
        break
      }
      case "assign-end":
        assignments.delete(e.id)
        break
    }
  }
  if (!session) throw new Error("store: missing session event")
  const open = [...assignments.values()]
  return {
    session,
    messages: [...messages.values()],
    compactions,
    usage,
    staleClaim: claimed,
    inbox,
    assignments: [...open.filter((t) => t.started), ...open.filter((t) => !t.started)],
  }
}
