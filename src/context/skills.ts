import type { Db } from "../core/db.ts"

/**
 * Kỹ năng (quy trình làm việc) lưu trong bảng `skills`. Nội dung là markdown có
 * frontmatter `name`, `description`; phần thân là hướng dẫn.
 * Chỉ index (id + description) vào system prompt; nội dung load qua tool `skill`.
 */
export interface SkillMeta {
  id: string
  name: string
  description: string
}

export function parseSkill(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "")
  }
  return { meta, body: m[2]!.trim() }
}

export function slug(id: string) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "")
}

export function skillMarkdown(name: string, description: string, body: string) {
  const line = (s: string) => s.replace(/\r?\n/g, " ").trim()
  return `---\nname: ${line(name)}\ndescription: ${line(description)}\n---\n${body.trim()}\n`
}

export class SkillStore {
  constructor(private db: Db) {}

  async list(): Promise<SkillMeta[]> {
    const rows = this.db.sql.prepare("SELECT id, content FROM skills ORDER BY id").all() as Array<{ id: string; content: string }>
    return rows.map((r) => {
      const { meta } = parseSkill(r.content)
      return { id: r.id, name: meta.name ?? r.id, description: meta.description ?? "" }
    })
  }

  async read(id: string): Promise<string | undefined> {
    const row = this.db.sql.prepare("SELECT content FROM skills WHERE id = ?").get(id) as { content: string } | undefined
    return row?.content
  }

  async write(id: string, content: string) {
    const s = slug(id)
    if (!s) throw new Error("invalid skill id")
    this.db.sql
      .prepare("INSERT INTO skills(id, content, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at")
      .run(s, content, Date.now())
    return s
  }

  async remove(id: string): Promise<boolean> {
    return Number(this.db.sql.prepare("DELETE FROM skills WHERE id = ?").run(id).changes) > 0
  }

  /** Khối `<available_skills>` cho Tier A. Rỗng → undefined để không chiếm token. */
  async index(): Promise<string | undefined> {
    const skills = await this.list()
    if (skills.length === 0) return undefined
    const rows = skills.map((s) => `  <skill id="${s.id}">${s.description || s.name}</skill>`).join("\n")
    return `<available_skills>\nLoad a skill with the \`skill\` tool when a task matches its description.\n${rows}\n</available_skills>`
  }

  static template(id: string) {
    return skillMarkdown(id, "When to use this skill, in one sentence.", `# ${id}\n\nStep-by-step instructions the employee should follow.`)
  }
}
