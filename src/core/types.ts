export type Role = "system" | "user" | "assistant" | "tool"

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callID: string; name: string; args: unknown }
  | { type: "tool-result"; callID: string; name: string; output: string; isError: boolean }
  | { type: "image"; mime: string; data: string }

export interface Message {
  id: string
  role: Role
  parts: Part[]
  createdAt: number
  /** Người tạo message: user thật, subagent trả kết quả, hay harness. */
  source?: "user" | "subagent" | "system"
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export type Outcome =
  | { tag: "completed"; text: string }
  | { tag: "continue" }
  | { tag: "retry"; delay: number; reason: string }
  | { tag: "compacted" }
  | { tag: "output-limit" }
  | { tag: "interrupted" }
  | { tag: "failed"; error: Error }

export interface InboxItem {
  id: string
  delivery: "queue" | "steer"
  message: Message
}

export interface Session {
  id: string
  parentID?: string
  agent: string
  model: string
  title: string
  createdAt: number
}

export interface Compaction {
  id: string
  summary: string
  /** Message từ ID này trở đi được giữ nguyên văn. */
  keepFromID: string
  createdAt: number
}

export type StoreEvent =
  | { kind: "session"; session: Session }
  | { kind: "message"; message: Message }
  | { kind: "part"; messageID: string; part: Part }
  | { kind: "compaction"; compaction: Compaction }
  | { kind: "claim"; at: number }
  | { kind: "release"; at: number }
