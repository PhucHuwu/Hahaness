export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body ?? {}),
  delete: <T>(path: string) => call<T>("DELETE", path),
}

// ---- Types mirrored from the server --------------------------------------------

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callID: string; name: string; args: unknown }
  | { type: "tool-result"; callID: string; name: string; output: string; isError: boolean }
  | { type: "image"; mime: string; data: string }

export interface Message {
  id: string
  role: "system" | "user" | "assistant" | "tool"
  parts: Part[]
  createdAt: number
  source?: "user" | "agent" | "subagent" | "system"
  from?: string
}

export interface CommItem {
  at: number
  kind: "brief" | "steer" | "ceo" | "report"
  from: string
  to: string
  sessionID: string
  parentID: string
  text: string
  status?: string
}

export interface Session {
  id: string
  parentID?: string
  agent: string
  model: string
  title: string
  createdAt: number
}

export interface SessionView {
  session: Session
  running: boolean
  live: boolean
  depth: number
  error?: string
}

export interface SessionDetail extends SessionView {
  messages: Message[]
  children: SessionView[]
}

export interface Staff {
  id: string
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  model: string[]
  steps: number
  context: "isolated" | "fork"
  permissions: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>
  system: string
}

export interface Question {
  id: string
  sessionID: string
  kind: "question" | "permission"
  text: string
  options?: string[]
}

export type ProviderConfig =
  | { type: "openai"; baseURL?: string; apiKey?: string; headers?: Record<string, string>; models?: Record<string, { contextWindow?: number; maxOutput?: number }> }
  | { type: "anthropic"; baseURL?: string; apiKey?: string; headers?: Record<string, string>; models?: Record<string, { contextWindow?: number; maxOutput?: number }> }
  | { type: "custom"; module: string; options?: Record<string, unknown> }

export interface Config {
  defaultModel?: string
  fallbackModels?: string[]
  providers: Record<string, ProviderConfig>
}

export interface ConfigView {
  /** File SQLite chứa toàn bộ dữ liệu công ty. */
  db: string
  config: Config
  providerError: string | null
  providers: string[]
  defaultModel: string
  env: { OPENAI_API_KEY: boolean; ANTHROPIC_API_KEY?: boolean; HAHANESS_MODEL: string | null }
}

export interface DocView {
  path: string
  size: number
  title: string
  updatedAt: number
  author: string | null
}

export interface KnowledgeView {
  core: Array<{ path: string; size: number; updatedAt: number; author: string | null }>
  files: DocView[]
}

export interface ResultsView {
  deliverables: DocView[]
  drafts: DocView[]
}

export interface Doc extends DocView {
  content: string
  createdAt: number
}

export interface SkillMeta {
  id: string
  name: string
  description: string
}

export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

export interface McpServerStatus {
  id: string
  config: McpServerConfig
  state: "disabled" | "connecting" | "connected" | "error"
  error?: string
  serverInfo?: { name?: string; version?: string }
  tools: Array<{ name: string; description?: string; toolName: string }>
}

export type ServerEvent =
  | { type: "text"; sessionID: string; delta: string }
  | { type: "reasoning"; sessionID: string; delta: string }
  | { type: "tool-start"; sessionID: string; name: string; args: unknown; callID: string }
  | { type: "tool-end"; sessionID: string; name: string; output: string; isError: boolean; callID: string }
  | { type: "notice"; sessionID: string; text: string }
  | { type: "session"; session: SessionView }
  | { type: "turn"; sessionID: string; running: boolean; outcome?: string; error?: string }
  | { type: "question"; id: string; sessionID: string; kind: "question" | "permission"; text: string; options?: string[] }
  | { type: "question-answered"; id: string; sessionID: string }
