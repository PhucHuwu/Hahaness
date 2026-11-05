import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, basename } from "node:path"
import type { Db } from "./db.ts"
import type { StoreEvent } from "./types.ts"
import type { DocumentStore } from "../context/documents.ts"

/**
 * Lần đầu tạo DB: nhập workspace dạng file của bản cũ (nếu có) vào DB. Không
 * xóa file gốc; sau lần này DB là nguồn sự thật duy nhất.
 * Trả danh sách mục đã nhập để in ra cho người dùng.
 */
export async function importLegacy(root: string, db: Db, docs: DocumentStore): Promise<string[]> {
  const imported: string[] = []
  const text = (p: string) => readFile(p, "utf8")

  for (const f of ["COMPANY.md", "USER.md", "MEMORY.md"]) {
    const p = join(root, f)
    if (existsSync(p)) {
      docs.put(f, await text(p))
      imported.push(f)
    }
  }

  for (const dir of ["knowledge", "drafts", "deliverables"]) {
    const walk = async (abs: string, rel: string) => {
      if (!existsSync(abs)) return
      for (const e of await readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) await walk(join(abs, e.name), r)
        else if (/\.(md|txt|csv|json|html)$/i.test(e.name)) {
          docs.put(r, await text(join(abs, e.name)))
          imported.push(r)
        }
      }
    }
    await walk(join(root, dir), dir)
  }

  const staffDir = join(root, "staff")
  if (existsSync(staffDir)) {
    for (const f of await readdir(staffDir)) {
      if (!f.endsWith(".md")) continue
      db.sql.prepare("INSERT OR REPLACE INTO staff(id, markdown, fired, updated_at) VALUES(?, ?, 0, ?)").run(basename(f, ".md"), await text(join(staffDir, f)), Date.now())
      imported.push(`staff/${f}`)
    }
  }

  const skillsDir = join(root, "skills")
  if (existsSync(skillsDir)) {
    for (const e of await readdir(skillsDir, { withFileTypes: true })) {
      const p = join(skillsDir, e.name, "SKILL.md")
      if (!e.isDirectory() || !existsSync(p)) continue
      db.sql.prepare("INSERT OR REPLACE INTO skills(id, content, updated_at) VALUES(?, ?, ?)").run(e.name, await text(p), Date.now())
      imported.push(`skills/${e.name}`)
    }
  }

  const data = join(root, ".hahaness")
  const mcpFile = join(data, "mcp.json")
  if (existsSync(mcpFile)) {
    const servers = (JSON.parse(await text(mcpFile)) as { servers?: Record<string, unknown> }).servers ?? {}
    for (const [id, cfg] of Object.entries(servers)) db.sql.prepare("INSERT OR REPLACE INTO mcp_servers(id, config) VALUES(?, ?)").run(id, JSON.stringify(cfg))
    if (Object.keys(servers).length) imported.push(".hahaness/mcp.json")
  }

  const sessionsDir = join(data, "sessions")
  if (existsSync(sessionsDir)) {
    let n = 0
    for (const f of await readdir(sessionsDir)) {
      if (!f.endsWith(".jsonl")) continue
      const events = (await text(join(sessionsDir, f)))
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as StoreEvent]
          } catch {
            return []
          }
        })
      const head = events[0]
      if (head?.kind !== "session") continue
      const s = head.session
      db.tx(() => {
        db.sql.prepare("INSERT OR IGNORE INTO sessions(id, parent_id, agent, model, title, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(s.id, s.parentID ?? null, s.agent, s.model, s.title, s.createdAt)
        const ins = db.sql.prepare("INSERT INTO events(session_id, kind, data) VALUES(?, ?, ?)")
        for (const e of events) ins.run(s.id, e.kind, JSON.stringify(e))
      })
      n++
    }
    if (n) imported.push(`${n} sessions`)
  }

  return imported
}
