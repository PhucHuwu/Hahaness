import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, basename } from "node:path"
import { DEFAULTS, type AgentDef } from "./types.ts"
import { evaluate, type Rule } from "../permission/ruleset.ts"
import type { Db } from "../core/db.ts"

/** Frontmatter tối giản: key: value, list `- a` hoặc `[a, b]`, rule `- { action: x, resource: y, effect: z }`. */
function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, unknown> = {}
  let key: string | undefined
  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && key) {
      const list = (meta[key] as unknown[] | undefined) ?? []
      list.push(parseValue(item[1]!))
      meta[key] = list
      continue
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]!
      meta[key] = kv[2] ? parseValue(kv[2]) : []
    }
  }
  return { meta, body: m[2]!.trim() }
}

function parseValue(v: string): unknown {
  v = v.trim()
  if (/^\d+$/.test(v)) return Number(v)
  if (v === "true") return true
  if (v === "false") return false
  if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
  if (v.startsWith("{") && v.endsWith("}")) {
    const obj: Record<string, string> = {}
    for (const pair of v.slice(1, -1).split(",")) {
      const [k, ...rest] = pair.split(":")
      if (k && rest.length) obj[k.trim()] = rest.join(":").trim().replace(/^["']|["']$/g, "")
    }
    return obj
  }
  return v.replace(/^["']|["']$/g, "")
}

export function fromMarkdown(text: string, fallbackID: string): AgentDef {
  const { meta, body } = parseFrontmatter(text)
  const id = String(meta.id ?? fallbackID)
  const model = Array.isArray(meta.model) ? meta.model.map(String) : meta.model ? [String(meta.model)] : DEFAULTS.model
  return {
    ...DEFAULTS,
    id,
    name: String(meta.name ?? id),
    description: String(meta.description ?? ""),
    mode: (meta.mode as AgentDef["mode"]) ?? DEFAULTS.mode,
    model,
    steps: typeof meta.steps === "number" ? meta.steps : DEFAULTS.steps,
    context: (meta.context as AgentDef["context"]) ?? DEFAULTS.context,
    role: (meta.role as AgentDef["role"]) ?? DEFAULTS.role,
    permissions: Array.isArray(meta.permissions) ? (meta.permissions as Rule[]) : [],
    system: body,
  }
}

export function toMarkdown(def: AgentDef): string {
  const rules = def.permissions.map((r) => `  - { action: ${r.action}, resource: "${r.resource}", effect: ${r.effect} }`).join("\n")
  return [
    "---",
    `id: ${def.id}`,
    `name: ${def.name}`,
    `description: ${def.description}`,
    `mode: ${def.mode}`,
    def.model.length ? `model: [${def.model.join(", ")}]` : undefined,
    `steps: ${def.steps}`,
    `context: ${def.context}`,
    `role: ${def.role}`,
    rules ? `permissions:\n${rules}` : "permissions: []",
    "---",
    def.system,
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\n")
}

export const CAPABILITIES = ["read", "write", "webfetch", "websearch"] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface HireRequest {
  id: string
  name: string
  description: string
  system: string
  /** Nhân viên mới chỉ được chọn từ các "quyền" an toàn; CTO không cấp được hơn chính mình. */
  capabilities: Capability[]
}

/** Tool chỉ CTO dùng; nhân viên luôn bị deny (harness cũng deny lúc spawn). */
export const MANAGEMENT_ACTIONS = ["delegate", "hire", "memory", "question", "knowledge", "manage_skill", "staff", "mcp_manage"] as const

export function capabilityRules(capabilities: readonly Capability[]): Rule[] {
  const caps = new Set(capabilities)
  return [
    { action: "read", resource: "*", effect: caps.has("read") ? "allow" : "deny" },
    { action: "write", resource: "drafts/*", effect: caps.has("write") ? "allow" : "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: caps.has("webfetch") ? "allow" : "deny" },
    { action: "websearch", resource: "*", effect: caps.has("websearch") ? "allow" : "deny" },
    ...MANAGEMENT_ACTIONS.filter((a) => a !== "question").map((action) => ({ action, resource: "*", effect: "deny" as const })),
  ]
}

/** Đọc ngược capability từ ruleset (để CTO xem/sửa nhân viên). */
export function capabilitiesOf(def: AgentDef): Capability[] {
  return CAPABILITIES.filter((c) => evaluate(def.permissions, c, c === "write" ? "drafts/x" : "x") === "allow")
}

export function slugID(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "")
}

export class AgentRegistry {
  private agents = new Map<string, AgentDef>()
  private db?: Db

  /** Load builtin `.md` (vai có sẵn). Cùng id thì cái sau thắng, permissions nối thêm. */
  async load(...dirs: string[]) {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const f of await readdir(dir)) {
        if (!f.endsWith(".md")) continue
        const def = fromMarkdown(await readFile(join(dir, f), "utf8"), basename(f, ".md"))
        const prev = this.agents.get(def.id)
        this.agents.set(def.id, prev ? { ...prev, ...def, permissions: [...prev.permissions, ...def.permissions], system: def.system || prev.system } : def)
      }
    }
    return this
  }

  /**
   * Nhân viên trong DB (bảng `staff`) đè lên vai có sẵn; `fired = 1` xóa vai đó.
   * Từ đây mọi hire/update/fire ghi vào DB.
   */
  useDb(db: Db) {
    this.db = db
    const rows = db.sql.prepare("SELECT id, markdown, fired FROM staff").all() as Array<{ id: string; markdown: string; fired: number }>
    for (const r of rows) {
      const current = this.agents.get(r.id)
      if (current?.mode === "primary") continue
      if (Number(r.fired)) this.agents.delete(r.id)
      else this.agents.set(r.id, fromMarkdown(r.markdown, r.id))
    }
    return this
  }

  private persist(def: AgentDef, markdown = toMarkdown(def)) {
    this.db?.sql
      .prepare("INSERT INTO staff(id, markdown, fired, updated_at) VALUES(?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown, fired = 0, updated_at = excluded.updated_at")
      .run(def.id, markdown, Date.now())
  }

  get(id: string) {
    const a = this.agents.get(id)
    if (!a) throw new Error(`unknown agent: ${id}`)
    return a
  }

  has(id: string) {
    return this.agents.has(id)
  }

  async hire(req: HireRequest): Promise<AgentDef> {
    const id = slugID(req.id)
    if (!id) throw new Error("hire: invalid id")
    if (this.agents.get(id)?.mode === "primary") throw new Error(`hire: cannot replace primary agent ${id}`)
    const def: AgentDef = {
      ...DEFAULTS,
      id,
      name: req.name,
      description: req.description,
      mode: "subagent",
      steps: 30,
      permissions: capabilityRules(req.capabilities),
      system: req.system,
    }
    this.agents.set(id, def)
    this.persist(def)
    return def
  }

  /** Sửa từng phần (tool `staff` của CTO). Đổi capabilities thì dựng lại ruleset chuẩn. */
  async edit(id: string, patch: Partial<Pick<AgentDef, "name" | "description" | "system">> & { capabilities?: Capability[] }): Promise<AgentDef> {
    const prev = this.get(id)
    if (prev.mode === "primary") throw new Error(`edit: cannot edit primary agent ${id}`)
    const def: AgentDef = {
      ...prev,
      name: patch.name ?? prev.name,
      description: patch.description ?? prev.description,
      system: patch.system ?? prev.system,
      permissions: patch.capabilities ? capabilityRules(patch.capabilities) : prev.permissions,
    }
    this.agents.set(id, def)
    this.persist(def)
    return def
  }

  /** CEO sửa tay toàn bộ markdown (UI). Không đụng vai primary. */
  async update(id: string, text: string): Promise<AgentDef> {
    const def = fromMarkdown(text, id)
    if (def.id !== id) throw new Error(`update: id in frontmatter (${def.id}) must match ${id}`)
    if (this.agents.get(id)?.mode === "primary") throw new Error(`update: cannot edit primary agent ${id}`)
    if (def.mode === "primary") throw new Error("update: staff cannot be made primary")
    this.agents.set(id, def)
    this.persist(def, text)
    return def
  }

  async fire(id: string) {
    const def = this.agents.get(id)
    if (!def) throw new Error(`unknown agent: ${id}`)
    if (def.mode === "primary") throw new Error(`fire: cannot fire primary agent ${id}`)
    this.agents.delete(id)
    this.db?.sql
      .prepare("INSERT INTO staff(id, markdown, fired, updated_at) VALUES(?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET fired = 1, updated_at = excluded.updated_at")
      .run(id, toMarkdown(def), Date.now())
  }

  list(mode?: AgentDef["mode"]) {
    return [...this.agents.values()].filter((a) => !mode || a.mode === mode || a.mode === "all")
  }

  subagents() {
    return this.list().filter((a) => a.mode !== "primary")
  }
}
