import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { McpClient, type McpServerConfig, type McpTool } from "./client.ts"
import type { Tool } from "../tool/define.ts"
import type { ToolRegistry } from "../tool/registry.ts"

const ServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  }),
])

export const McpConfigSchema = z.object({ servers: z.record(z.string(), ServerSchema).default({}) })
export type McpConfig = z.infer<typeof McpConfigSchema>

export interface McpServerStatus {
  id: string
  config: McpServerConfig
  state: "disabled" | "connecting" | "connected" | "error"
  error?: string
  serverInfo?: { name?: string; version?: string }
  tools: Array<{ name: string; description?: string; toolName: string }>
}

/**
 * Quản lý server MCP: đọc/ghi `<dataDir>/mcp.json`, kết nối, đăng ký tool vào
 * ToolRegistry dưới tên `<server>_<tool>` với permission `mcp:<server>:<tool>`.
 * Tool MCP có sẵn cho mọi vai trừ khi ruleset deny `mcp:*`.
 */
export class McpManager {
  private config: McpConfig = { servers: {} }
  private clients = new Map<string, McpClient>()
  private status = new Map<string, McpServerStatus>()

  constructor(private file: string, private tools: ToolRegistry) {}

  async load() {
    if (existsSync(this.file)) {
      this.config = McpConfigSchema.parse(JSON.parse(await readFile(this.file, "utf8")))
    }
    for (const id of Object.keys(this.config.servers)) this.status.set(id, this.fresh(id))
    await Promise.allSettled(Object.keys(this.config.servers).map((id) => this.connect(id)))
    return this
  }

  private fresh(id: string): McpServerStatus {
    const config = this.config.servers[id]!
    return { id, config, state: config.enabled === false ? "disabled" : "connecting", tools: [] }
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.config, null, 2), "utf8")
  }

  list(): McpServerStatus[] {
    return [...this.status.values()]
  }

  get(id: string) {
    return this.status.get(id)
  }

  async add(id: string, cfg: McpServerConfig) {
    const slug = id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "")
    if (!slug) throw new Error("mcp: invalid server id")
    this.config.servers[slug] = ServerSchema.parse(cfg)
    await this.save()
    this.disconnect(slug)
    this.status.set(slug, this.fresh(slug))
    await this.connect(slug)
    return this.status.get(slug)!
  }

  async remove(id: string) {
    this.disconnect(id)
    delete this.config.servers[id]
    this.status.delete(id)
    await this.save()
  }

  async setEnabled(id: string, enabled: boolean) {
    const cfg = this.config.servers[id]
    if (!cfg) throw new Error(`mcp: unknown server ${id}`)
    cfg.enabled = enabled
    await this.save()
    this.disconnect(id)
    this.status.set(id, this.fresh(id))
    if (enabled) await this.connect(id)
    return this.status.get(id)!
  }

  async reconnect(id: string) {
    if (!this.config.servers[id]) throw new Error(`mcp: unknown server ${id}`)
    this.disconnect(id)
    this.status.set(id, this.fresh(id))
    await this.connect(id)
    return this.status.get(id)!
  }

  private async connect(id: string) {
    const st = this.status.get(id)
    if (!st || st.state === "disabled") return
    st.state = "connecting"
    st.error = undefined
    try {
      const client = await McpClient.connect(st.config)
      const tools = await client.listTools()
      this.clients.set(id, client)
      st.serverInfo = client.serverInfo
      st.tools = tools.map((t) => ({ name: t.name, description: t.description, toolName: toolName(id, t.name) }))
      this.tools.register(...tools.map((t) => wrap(id, t, client)))
      st.state = "connected"
    } catch (e) {
      st.state = "error"
      st.error = (e as Error).message
    }
  }

  private disconnect(id: string) {
    const st = this.status.get(id)
    if (st) this.tools.unregister(...st.tools.map((t) => t.toolName))
    this.clients.get(id)?.close()
    this.clients.delete(id)
  }

  closeAll() {
    for (const id of [...this.clients.keys()]) this.disconnect(id)
  }
}

function toolName(server: string, tool: string) {
  return `${server}_${tool}`.replace(/[^A-Za-z0-9_-]+/g, "_")
}

function wrap(server: string, t: McpTool, client: McpClient): Tool {
  const name = toolName(server, t.name)
  const parameters = { ...t.inputSchema, type: "object" } as Record<string, unknown>
  return {
    name,
    description: t.description ? `[${server}] ${t.description}` : `Tool ${t.name} from MCP server ${server}`,
    schema: z.record(z.string(), z.unknown()).default({}),
    permission: { action: `mcp:${server}:${t.name}` },
    concurrency: "parallel",
    timeoutMs: 120_000,
    definition: () => ({ name, description: t.description ?? name, parameters }),
    async execute(input, ctx) {
      const r = await client.callTool(t.name, input, ctx.signal)
      const text = r.content
        .map((c) => (c.type === "text" ? c.text ?? "" : c.type === "image" ? `[image ${c.mimeType ?? ""}]` : `[${c.type}]`))
        .join("\n")
      return { output: text || "(empty)", isError: r.isError ?? false }
    },
  }
}
