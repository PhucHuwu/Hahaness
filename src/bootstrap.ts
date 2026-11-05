import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "./harness.ts"
import { AgentRegistry } from "./agent/registry.ts"
import { ToolRegistry } from "./tool/registry.ts"
import { buildProviders, loadConfig, type Config } from "./config.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import { SkillStore } from "./context/skills.ts"
import { McpManager } from "./mcp/manager.ts"
import * as workspace from "./context/workspace.ts"
import { read, list, write } from "./tool/builtin/fs.ts"
import { webfetch, websearch } from "./tool/builtin/web.ts"
import { todo } from "./tool/builtin/todo.ts"
import { memory } from "./tool/builtin/memory.ts"
import { question, type QuestionHandler } from "./tool/builtin/question.ts"
import { delegate } from "./tool/builtin/delegate.ts"
import { hire } from "./tool/builtin/hire.ts"
import { skill } from "./tool/builtin/skill.ts"
import type { AskHandler } from "./permission/ask.ts"
import type { LoopEvents } from "./core/loop.ts"

const here = dirname(fileURLToPath(import.meta.url))

export interface App {
  cwd: string
  dataDir: string
  config: Config
  configPath?: string
  /** Lỗi khi dựng provider (vd thiếu API key) — UI hiển thị thay vì thoát. */
  providerError?: string
  agents: AgentRegistry
  tools: ToolRegistry
  skills: SkillStore
  mcp: McpManager
  harness: Harness
}

export interface BootstrapOptions {
  cwd: string
  events: LoopEvents
  askHandler: AskHandler
  questionHandler: QuestionHandler
  /** false → không kết nối MCP lúc khởi động (test). */
  mcp?: boolean
}

/** Wiring chuẩn: workspace, vai, tool builtin, skills, MCP, harness. */
export async function bootstrap(opts: BootstrapOptions): Promise<App> {
  const { cwd } = opts
  const dataDir = join(cwd, ".hahaness")
  const { config, path: configPath } = await loadConfig(cwd)

  let providers = new ProviderRegistry()
  let providerError: string | undefined
  try {
    providers = await buildProviders(config, cwd)
  } catch (e) {
    providerError = (e as Error).message
  }

  await workspace.ensure(cwd)
  const staffDir = join(cwd, "staff")
  const agents = await new AgentRegistry().load(join(here, "agent", "builtin"), staffDir)
  agents.persistTo(staffDir)
  const skills = new SkillStore(join(cwd, "skills"))

  const tools = new ToolRegistry().register(
    read, list, write, webfetch, websearch, todo, memory,
    question(opts.questionHandler),
    delegate(agents),
    hire(agents),
    skill(skills),
  )
  const mcp = new McpManager(join(dataDir, "mcp.json"), tools)
  if (opts.mcp !== false) await mcp.load()

  const harness = new Harness({
    cwd,
    dataDir,
    providers,
    defaultModel: process.env.HAHANESS_MODEL ?? config.defaultModel ?? "gpt-4.1",
    agents,
    tools,
    skills,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    askHandler: opts.askHandler,
    events: opts.events,
  })

  return { cwd, dataDir, config, configPath, providerError, agents, tools, skills, mcp, harness }
}
