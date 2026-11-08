export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const unauthorized = new Set<() => void>()
/** Đăng ký xử lý khi server trả 401 (hết phiên đăng nhập). */
export function onUnauthorized(fn: () => void) {
  unauthorized.add(fn)
  return () => void unauthorized.delete(fn)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (res.status === 401 && !path.startsWith("/api/auth")) for (const fn of unauthorized) fn()
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
  /** Phiên chính của agent; false = lịch sử cũ, chỉ xem. */
  home: boolean
  work?: { status: "working" | "waiting" | "idle"; goal?: string; from?: string; queued: number }
  error?: string
}

export interface SessionDetail extends SessionView {
  messages: Message[]
}

/** Lệnh slash (`src/command/slash.ts`). */
export interface CommandSpec {
  name: string
  aliases: string[]
  args?: string
  description: string
}

export interface CommandResult {
  command?: string
  text: string
  /** `/new`: phiên mới để chuyển sang. */
  sessionID?: string
}

export interface UsageRecord {
  at: number
  model: string
  purpose: "turn" | "compaction" | "memory"
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export type ContextCategory = "system" | "workspace" | "tools" | "checkpoint" | "user" | "agent" | "notice" | "assistant" | "tool-calls" | "tool-results"

export interface UsageReport {
  sessionID: string
  model: string
  contextWindow?: number
  ceiling?: number
  estimatedContext: number
  live: boolean
  total: UsageTotals
  byPurpose: Record<UsageRecord["purpose"], UsageTotals>
  byModel: Array<{ model: string } & UsageTotals>
  lastInput?: number
  context: {
    categories: Array<{ key: ContextCategory; tokens: number }>
    tools: Array<{ name: string; calls: number; callTokens: number; resultTokens: number }>
  }
  children: Array<{ sessionID: string; agent: string; title: string; total: UsageTotals }>
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
  | { type: "openai"; baseURL?: string; apiKey?: string; headers?: Record<string, string>; contextWindow?: number; maxOutput?: number; models?: Record<string, { contextWindow?: number; maxOutput?: number }> }
  | { type: "anthropic"; baseURL?: string; apiKey?: string; headers?: Record<string, string>; contextWindow?: number; maxOutput?: number; models?: Record<string, { contextWindow?: number; maxOutput?: number }> }
  | { type: "custom"; module: string; options?: Record<string, unknown> }

export interface Config {
  defaultModel?: string
  fallbackModels?: string[]
  providers: Record<string, ProviderConfig>
}

export interface TelegramStatus {
  configured: boolean
  bot?: string
  linked?: string
  pairCode?: string
  running: boolean
  error?: string
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

/** GET /api/updates: bản đang chạy và bản mới nhất (kiểm tra mỗi 24 giờ). */
export interface UpdateState {
  current: string
  channel: string
  enabled: boolean
  latest: { version: string; url?: string; notes?: string } | null
  available: boolean
  checkedAt: string | null
  error: string | null
}

export interface DocView {
  path: string
  size: number
  title: string
  updatedAt: number
  author: string | null
}

/** Một node của bộ tri thức; node con trực tiếp của `knowledge/` là một bộ. */
export interface KnowledgeNode {
  id: string
  name: string
  title: string
  summary: string
  /** Tài liệu của node; không có = node nhóm. */
  doc?: string
  size: number
  updatedAt: number
  author?: string
  children: KnowledgeNode[]
}

export interface KnowledgeView {
  core: Array<{ path: string; size: number; updatedAt: number; author: string | null }>
  tree: KnowledgeNode[]
}

export interface ResultsView {
  deliverables: DocView[]
  drafts: DocView[]
  uploads: DocView[]
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

/** GET /api/marketplace: danh mục từ catalog.json kèm trạng thái đã cài. */
export interface MarketItem {
  id: string
  kind: "mcp"
  title: string
  description: string
  tags: string[]
  publisher?: string
  homepage?: string
  config: McpServerConfig
  installed: boolean
  state: McpServerStatus["state"] | null
}

export interface MarketplaceView {
  source: "remote" | "bundled" | "off"
  url: string | null
  updatedAt: string | null
  fetchedAt: string | null
  error: string | null
  items: MarketItem[]
}

export interface Brief {
  goal: string
  context: string
  done_when: string
  output?: string
}

export type RunStatus = "running" | "completed" | "failed" | "stopped" | "needs_input" | "skipped" | "blocked" | "interrupted"

export interface Schedule {
  id: string
  title: string
  agent: string
  cron: string
  task: Brief
  followUp?: string
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
  /** Chỉ có trong response của server. */
  running: boolean
  missingTools: string[]
  upcoming: number[]
}

export interface ScheduleRun {
  id: string
  scheduleID: string
  dueAt: number
  startedAt: number
  finishedAt?: number
  reason: "due" | "manual"
  status: RunStatus
  sessionID?: string
  workerSessionID?: string
  error?: string
}

export type ServerEvent =
  | { type: "schedule"; id: string }
  | { type: "text"; sessionID: string; delta: string }
  | { type: "reasoning"; sessionID: string; delta: string }
  | { type: "tool-start"; sessionID: string; name: string; args: unknown; callID: string }
  | { type: "tool-end"; sessionID: string; name: string; output: string; isError: boolean; callID: string }
  | { type: "notice"; sessionID: string; text: string }
  | { type: "usage"; sessionID: string; usage: UsageRecord }
  | { type: "session"; session: SessionView }
  | { type: "turn"; sessionID: string; running: boolean; outcome?: string; error?: string }
  | { type: "question"; id: string; sessionID: string; kind: "question" | "permission"; text: string; options?: string[] }
  | { type: "question-answered"; id: string; sessionID: string }
