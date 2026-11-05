import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * skills/<id>/SKILL.md — frontmatter `name`, `description`; phần thân là hướng dẫn.
 * Chỉ index (id + description) vào system prompt; nội dung load qua tool `skill`.
 */
export interface SkillMeta {
  id: string
  name: string
  description: string
}

function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "")
  }
  return { meta, body: m[2]!.trim() }
}

export class SkillStore {
  constructor(readonly dir: string) {}

  private file(id: string) {
    return join(this.dir, id, "SKILL.md")
  }

  async list(): Promise<SkillMeta[]> {
    if (!existsSync(this.dir)) return []
    const out: SkillMeta[] = []
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = this.file(entry.name)
      if (!existsSync(path)) continue
      const { meta } = parse(await readFile(path, "utf8"))
      out.push({ id: entry.name, name: meta.name ?? entry.name, description: meta.description ?? "" })
    }
    return out
  }

  async read(id: string): Promise<string | undefined> {
    const path = this.file(id)
    if (!existsSync(path)) return undefined
    return readFile(path, "utf8")
  }

  async write(id: string, content: string) {
    const slug = id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "")
    if (!slug) throw new Error("invalid skill id")
    await mkdir(join(this.dir, slug), { recursive: true })
    await writeFile(this.file(slug), content, "utf8")
    return slug
  }

  async remove(id: string) {
    await rm(join(this.dir, id), { recursive: true, force: true })
  }

  /** Khối `<available_skills>` cho Tier A. Rỗng → undefined để không chiếm token. */
  async index(): Promise<string | undefined> {
    const skills = await this.list()
    if (skills.length === 0) return undefined
    const rows = skills.map((s) => `  <skill id="${s.id}">${s.description || s.name}</skill>`).join("\n")
    return `<available_skills>\nLoad a skill with the \`skill\` tool when a task matches its description.\n${rows}\n</available_skills>`
  }

  static template(id: string) {
    return `---\nname: ${id}\ndescription: When to use this skill, in one sentence.\n---\n# ${id}\n\nStep-by-step instructions the employee should follow.\n`
  }
}
