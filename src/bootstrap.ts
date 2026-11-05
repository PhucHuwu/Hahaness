import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "./harness.ts"
import { AgentRegistry } from "./agent/registry.ts"
import { ToolRegistry } from "./tool/registry.ts"
import { buildProviders, loadConfig, type Config } from "./config.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import { Db } from "./core/db.ts"
import { importLegacy } from "./core/migrate.ts"
import { DocumentStore } from "./context/documents.ts"
import { SkillStore } from "./context/skills.ts"
import { McpManager } from "./mcp/manager.ts"
import * as workspace from "./context/workspace.ts"
import { documentTools } from "./tool/builtin/fs.ts"
import { webfetch, websearch } from "./tool/builtin/web.ts"
import { todo } from "./tool/builtin/todo.ts"
import { memory } from "./tool/builtin/memory.ts"
import { question, type QuestionHandler } from "./tool/builtin/question.ts"
import { delegate } from "./tool/builtin/delegate.ts"
import { askLead } from "./tool/builtin/ask-lead.ts"
import { hire } from "./tool/builtin/hire.ts"
import { skill } from "./tool/builtin/skill.ts"
import { knowledgeTool, manageSkillTool, mcpTool, staffTool } from "./tool/builtin/manage.ts"
import type { AskHandler } from "./permission/ask.ts"
import type { LoopEvents } from "./core/loop.ts"

const here = dirname(fileURLToPath(import.meta.url))

export interface App {
  cwd: string
  db: Db
  docs: DocumentStore
  config: Config
  /** Lỗi khi dựng provider (vd thiếu API key) — UI hiển thị thay vì thoát. */
  providerError?: string
  /** Mục đã nhập từ workspace dạng file cũ trong lần chạy này. */
  imported: string[]
  agents: AgentRegistry
  tools: ToolRegistry
  skills: SkillStore
  mcp: McpManager
  harness: Harness
  close(): void
}

export interface BootstrapOptions {
  cwd: string
  /** Mặc định `<cwd>/.hahaness/hahaness.db`, hoặc env HAHANESS_DB. `:memory:` cho test. */
  dbPath?: string
  events: LoopEvents
  askHandler: AskHandler
  questionHandler: QuestionHandler
  /** false → không kết nối MCP lúc khởi động (test). */
  mcp?: boolean
}

export function defaultDbPath(cwd: string) {
  return process.env.HAHANESS_DB ?? join(cwd, ".hahaness", "hahaness.db")
}

/** Wiring chuẩn: DB, workspace, vai, tool builtin, skills, MCP, harness. */
export async function bootstrap(opts: BootstrapOptions): Promise<App> {
  const { cwd } = opts
  const db = new Db(opts.dbPath ?? defaultDbPath(cwd))
  const docs = new DocumentStore(db)
  const imported = db.fresh && opts.dbPath !== ":memory:" ? await importLegacy(cwd, db, docs) : []
  workspace.ensure(docs)

  const { config } = await loadConfig(cwd, db)
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
  tools.register(
    ...documentTools(docs),
    webfetch,
    websearch,
    todo,
    memory(docs),
    question(opts.questionHandler),
    delegate(agents),
    askLead,
    hire(agents),
    skill(skills),
    knowledgeTool(docs),
    manageSkillTool(skills),
    staffTool(agents),
    mcpTool(mcp),
  )
  await mcp.load({ connect: opts.mcp !== false })

  const harness = new Harness({
    cwd,
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
    events: opts.events,
  })

  const close = () => {
    mcp.closeAll()
    db.close()
  }
  return { cwd, db, docs, config, providerError, imported, agents, tools, skills, mcp, harness, close }
}
