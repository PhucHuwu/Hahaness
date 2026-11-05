import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, basename } from "node:path"
import { DEFAULTS, type AgentDef } from "./types.ts"
import type { Rule } from "../permission/ruleset.ts"

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

export class AgentRegistry {
  private agents = new Map<string, AgentDef>()

  /** Load builtin trước, user `agents/` sau — cùng id thì user thắng, permissions nối thêm. */
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

  get(id: string) {
    const a = this.agents.get(id)
    if (!a) throw new Error(`unknown agent: ${id}`)
    return a
  }

  list(mode?: AgentDef["mode"]) {
    return [...this.agents.values()].filter((a) => !mode || a.mode === mode || a.mode === "all")
  }

  subagents() {
    return this.list().filter((a) => a.mode !== "primary")
  }
}
