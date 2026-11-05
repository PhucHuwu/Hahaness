import { mkdir, readFile, appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Compaction, Message, Part, Session, StoreEvent } from "./types.ts"

/**
 * Append-only JSONL store, một file mỗi session. Đọc lại bằng cách fold toàn bộ
 * event; đủ cho v0.1, chưa cần index.
 */
export class SessionStore {
  constructor(private root: string) {}

  private file(sessionID: string) {
    return join(this.root, "sessions", `${sessionID}.jsonl`)
  }

  async append(sessionID: string, event: StoreEvent) {
    await mkdir(join(this.root, "sessions"), { recursive: true })
    await appendFile(this.file(sessionID), JSON.stringify(event) + "\n")
  }

  async read(sessionID: string): Promise<StoreEvent[]> {
    const path = this.file(sessionID)
    if (!existsSync(path)) return []
    const text = await readFile(path, "utf8")
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoreEvent)
  }

  async load(sessionID: string): Promise<SessionState | undefined> {
    const events = await this.read(sessionID)
    if (events.length === 0) return undefined
    return fold(events)
  }

  async createSession(session: Session) {
    await this.append(session.id, { kind: "session", session })
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
  /** true nếu có claim chưa release → turn trước bị cắt giữa chừng. */
  staleClaim: boolean
}

export function fold(events: StoreEvent[]): SessionState {
  let session: Session | undefined
  const messages = new Map<string, Message>()
  const compactions: Compaction[] = []
  let claimed = false
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
      case "claim":
        claimed = true
        break
      case "release":
        claimed = false
        break
    }
  }
  if (!session) throw new Error("store: missing session event")
  return { session, messages: [...messages.values()], compactions, staleClaim: claimed }
}
