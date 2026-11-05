import type { Db } from "../core/db.ts"

/**
 * Mọi tài liệu của công ty nằm trong bảng `documents`, khóa bằng path ảo kiểu
 * `COMPANY.md`, `knowledge/brand.md`, `drafts/post.md`, `deliverables/plan.md`.
 * Giữ dạng path để permission (`write drafts/*`) và prompt của agent không đổi.
 */
export interface DocMeta {
  path: string
  size: number
  title: string
  createdAt: number
  updatedAt: number
  author?: string
}

export interface Doc extends DocMeta {
  content: string
}

/** Thư mục ẩn khỏi `list` mặc định (output tool bị cắt). */
export const HIDDEN_PREFIXES = ["tool-output/"]

export function normalizePath(p: string): string {
  const parts = p.replaceAll("\\", "/").trim().split("/").filter((s) => s && s !== ".")
  if (parts.some((s) => s === "..")) throw new Error(`invalid path: ${p}`)
  const out = parts.join("/")
  if (!out) throw new Error("path is empty")
  return out
}

/** Prefix thư mục: "" (gốc) hoặc kết thúc bằng "/". */
export function normalizePrefix(p: string | undefined): string {
  if (!p) return ""
  const parts = p.replaceAll("\\", "/").trim().split("/").filter((s) => s && s !== ".")
  if (parts.some((s) => s === "..")) throw new Error(`invalid path: ${p}`)
  return parts.length ? parts.join("/") + "/" : ""
}

export function titleOf(content: string) {
  return (content.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "").slice(0, 120)
}

function likePrefix(prefix: string) {
  return prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%"
}

type Row = { path: string; content: string; created_at: number; updated_at: number; author: string | null }

function toDoc(r: Row): Doc {
  return {
    path: r.path,
    content: r.content,
    size: r.content.length,
    title: titleOf(r.content),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ...(r.author ? { author: r.author } : {}),
  }
}

function meta({ content: _c, ...m }: Doc): DocMeta {
  return m
}

export class DocumentStore {
  constructor(private db: Db) {}

  get(path: string): Doc | undefined {
    const row = this.db.sql.prepare("SELECT * FROM documents WHERE path = ?").get(normalizePath(path)) as Row | undefined
    return row ? toDoc(row) : undefined
  }

  read(path: string): string | undefined {
    return this.get(path)?.content
  }

  has(path: string) {
    return this.db.sql.prepare("SELECT 1 FROM documents WHERE path = ?").get(normalizePath(path)) !== undefined
  }

  put(path: string, content: string, author?: string): string {
    const p = normalizePath(path)
    const now = Date.now()
    this.db.sql
      .prepare(
        `INSERT INTO documents(path, content, created_at, updated_at, author) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, author = excluded.author`,
      )
      .run(p, content, now, now, author ?? null)
    return p
  }

  /** Tạo nếu chưa có (template). */
  ensure(path: string, content: string) {
    if (!this.has(path)) this.put(path, content)
  }

  delete(path: string): boolean {
    const r = this.db.sql.prepare("DELETE FROM documents WHERE path = ?").run(normalizePath(path))
    return Number(r.changes) > 0
  }

  /** Mọi tài liệu dưới prefix (đệ quy), sắp theo path. Bỏ thư mục ẩn trừ khi hỏi thẳng. */
  list(prefix?: string): DocMeta[] {
    const pre = normalizePrefix(prefix)
    const rows = this.db.sql
      .prepare("SELECT * FROM documents WHERE path LIKE ? ESCAPE '\\' ORDER BY path")
      .all(likePrefix(pre)) as Row[]
    return rows
      .map((r) => meta(toDoc(r)))
      .filter((d) => pre || !HIDDEN_PREFIXES.some((h) => d.path.startsWith(h)))
  }

  /** Con trực tiếp của một "thư mục": file và thư mục con (kết thúc bằng /). */
  children(prefix?: string): Array<{ name: string; dir: boolean; size?: number }> {
    const pre = normalizePrefix(prefix)
    const seen = new Map<string, { name: string; dir: boolean; size?: number }>()
    for (const d of this.list(pre)) {
      const rest = d.path.slice(pre.length)
      const slash = rest.indexOf("/")
      if (slash < 0) seen.set(rest, { name: rest, dir: false, size: d.size })
      else {
        const name = rest.slice(0, slash) + "/"
        if (!seen.has(name)) seen.set(name, { name, dir: true })
      }
    }
    return [...seen.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  /**
   * Tìm không phân biệt hoa thường (cả tiếng Việt) trong path và nội dung.
   * SQLite LIKE/lower() chỉ xử lý ASCII và bản node:sqlite này không có FTS5,
   * nên lọc trong JS; đủ nhanh với vài nghìn tài liệu của một công ty nhỏ.
   */
  search(query: string, opts: { prefix?: string; limit?: number } = {}) {
    const q = query.toLocaleLowerCase().trim()
    if (!q) return []
    const pre = normalizePrefix(opts.prefix)
    const rows = this.db.sql
      .prepare("SELECT path, content FROM documents WHERE path LIKE ? ESCAPE '\\' ORDER BY updated_at DESC")
      .all(likePrefix(pre)) as Array<{ path: string; content: string }>
    const out: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = []
    for (const r of rows) {
      if (!pre && HIDDEN_PREFIXES.some((h) => r.path.startsWith(h))) continue
      const lines = r.content.split(/\r?\n/)
      const matches = lines
        .map((text, i) => ({ line: i + 1, text }))
        .filter((l) => l.text.toLocaleLowerCase().includes(q))
        .slice(0, 5)
        .map((l) => ({ line: l.line, text: l.text.trim().slice(0, 200) }))
      if (matches.length || r.path.toLocaleLowerCase().includes(q)) out.push({ path: r.path, matches })
      if (out.length >= (opts.limit ?? 30)) break
    }
    return out
  }
}
