import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "./harness.ts"
import { AgentRegistry } from "./agent/registry.ts"
import { ToolRegistry } from "./tool/registry.ts"
import { buildProviders, storedConfig, type Config } from "./config.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import { Db } from "./core/db.ts"
import { DocumentStore } from "./context/documents.ts"
import { SkillStore } from "./context/skills.ts"
import { McpManager } from "./mcp/manager.ts"
import * as workspace from "./context/workspace.ts"
import { documentTools } from "./tool/builtin/fs.ts"
import { bash } from "./tool/builtin/bash.ts"
import { webfetch, websearch } from "./tool/builtin/web.ts"
import { todo } from "./tool/builtin/todo.ts"
import { memory } from "./tool/builtin/memory.ts"
import { question } from "./tool/builtin/question.ts"
import { delegate } from "./tool/builtin/delegate.ts"
import { askLead } from "./tool/builtin/ask-lead.ts"
import { hire } from "./tool/builtin/hire.ts"
import { skill } from "./tool/builtin/skill.ts"
import { knowledgeTool, manageSkillTool, mcpTool, staffTool } from "./tool/builtin/manage.ts"
import { scheduleTool } from "./tool/builtin/schedule.ts"
import { Scheduler } from "./schedule/scheduler.ts"
import { TelegramChannel } from "./channel/telegram.ts"
import type { AskHandler } from "./permission/ask.ts"
import type { LoopEvents } from "./core/loop.ts"

const here = dirname(fileURLToPath(import.meta.url))

export interface App {
  cwd: string
  /** Thư mục làm việc của tool `bash`. */
  workdir: string
  db: Db
  docs: DocumentStore
  config: Config
  /** Lỗi khi dựng provider (vd thiếu API key) — UI hiển thị thay vì thoát. */
  providerError?: string
  agents: AgentRegistry
  tools: ToolRegistry
  skills: SkillStore
  mcp: McpManager
  harness: Harness
  scheduler: Scheduler
  telegram: TelegramChannel
  close(): void
}

export interface BootstrapOptions {
  cwd: string
  /** Mặc định `<cwd>/.hahaness/hahaness.db`, hoặc env HAHANESS_DB. `:memory:` cho test. */
  dbPath?: string
  events: LoopEvents
  askHandler: AskHandler
  /** false → không kết nối MCP lúc khởi động (test). */
  mcp?: boolean
  /** false → không tự chạy việc định kỳ (CRUD vẫn dùng được). */
  scheduler?: boolean
  onScheduleChange?: (scheduleID: string) => void
  /** false → không tự làm tiếp việc dở lúc khởi động (test). */
  recover?: boolean
  /** false → không kết nối Telegram lúc khởi động (test). */
  channels?: boolean
}

export function defaultDbPath(cwd: string) {
  return process.env.HAHANESS_DB ?? join(cwd, ".hahaness", "hahaness.db")
}

/** Wiring chuẩn: DB, workspace, vai, tool builtin, skills, MCP, harness. */
export async function bootstrap(opts: BootstrapOptions): Promise<App> {
  const { cwd } = opts
  const dbPath = opts.dbPath ?? defaultDbPath(cwd)
  const db = new Db(dbPath)
  /** Thư mục làm việc của `bash`, cạnh file DB (không phải thư mục mã nguồn). */
  const workdir = process.env.HAHANESS_WORKDIR ?? join(dbPath === ":memory:" ? join(cwd, ".hahaness") : dirname(dbPath), "workspace")
  const docs = new DocumentStore(db)
  workspace.ensure(docs)

  const config = storedConfig(db)
  let providers = new ProviderRegistry()
  let providerError: string | undefined
  try {
    providers = await buildProviders(config, cwd)
  } catch (e) {
    providerError = (e as Error).message
  }

  const agents = (await new AgentRegistry().load(join(here, "agent", "builtin"))).useDb(db)
  const skills = new SkillStore(db)

  const tools = new ToolRegistry()
  const mcp = new McpManager(db, tools)
  const scheduler = new Scheduler({ db, agents, tools, blocked: () => app.providerError, onChange: opts.onScheduleChange })
  tools.register(
    ...documentTools(docs),
    bash(workdir),
    webfetch,
    websearch,
    todo,
    memory(docs),
    question,
    delegate(agents),
    askLead,
    hire(agents),
    skill(skills),
    knowledgeTool(docs),
    manageSkillTool(skills),
    staffTool(agents),
    mcpTool(mcp),
    scheduleTool(scheduler),
  )
  await mcp.load({ connect: opts.mcp !== false })

  let harness!: Harness
  const telegram = new TelegramChannel(db, () => harness)
  harness = new Harness({
    cwd,
    workdir,
    db,
    docs,
    providers,
    defaultModel: process.env.HAHANESS_MODEL ?? config.defaultModel ?? "gpt-4.1",
    agents,
    tools,
    skills,
    compaction: config.compaction,
    fallbackModels: config.fallbackModels,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    askHandler: opts.askHandler,
    events: {
      ...opts.events,
      onTurnStart: (sessionID) => {
        opts.events.onTurnStart?.(sessionID)
        telegram.turnStarted(sessionID)
      },
      onTurnEnd: (sessionID, outcome) => {
        opts.events.onTurnEnd?.(sessionID, outcome)
        void telegram.turnEnded(sessionID, outcome)
      },
    },
  })

  scheduler.attach(harness)

  const close = () => {
    scheduler.stop()
    telegram.stop()
    mcp.closeAll()
    db.close()
  }
  const app: App = { cwd, workdir, db, docs, config, providerError, agents, tools, skills, mcp, harness, scheduler, telegram, close }
  if (opts.scheduler !== false) scheduler.start()
  if (opts.channels !== false) telegram.start()
  // Làm tiếp việc dở từ trước khi tắt (không chờ ai mở web). Chưa cấu hình provider thì lượt sẽ lỗi → để sau.
  if (opts.recover !== false && !providerError) void harness.recover().catch((e) => console.error("recover:", (e as Error).message))
  return app
}
