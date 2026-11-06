import { normalizePath, type DocMeta, type DocumentStore } from "./documents.ts"

/**
 * Kho tri thức dạng cây (xem docs/architecture/10-knowledge-tree.md).
 *
 * Node có id là path không đuôi: `knowledge/brand`, `knowledge/brand/voice`.
 * Nội dung node nằm ở `<id>.md`, con của nó nằm dưới `<id>/`. Mỗi node con
 * trực tiếp của `knowledge/` là một bộ tri thức. Tài liệu phẳng cũ
 * (`knowledge/x.md`) là một bộ chỉ có gốc, không cần chuyển đổi.
 *
 * Định dạng node: `# Tiêu đề`, dòng tóm tắt `> …`, rồi nội dung. Tiêu đề và
 * tóm tắt hiện trong outline để agent chọn đúng node mà không phải đọc cả bộ.
 */
export const KNOWLEDGE_ROOT = "knowledge"

export interface KnowledgeNode {
  id: string
  name: string
  title: string
  summary: string
  /** Path tài liệu của node; không có = node chỉ là nhóm (thư mục không có `<id>.md`). */
  doc?: string
  size: number
  updatedAt: number
  author?: string
  children: KnowledgeNode[]
}

/** Chuẩn hóa id do agent/UI gửi: "brand/voice", "knowledge/brand/voice.md" → "knowledge/brand/voice". */
export function normalizeNodeID(input: string) {
  const p = normalizePath(input)
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, "-"))
    .join("/")
  const rel = p === KNOWLEDGE_ROOT ? "" : p.startsWith(`${KNOWLEDGE_ROOT}/`) ? p.slice(KNOWLEDGE_ROOT.length + 1) : p
  const id = rel.replace(/\.md$/i, "")
  if (!id) throw new Error("node path is empty")
  return `${KNOWLEDGE_ROOT}/${id}`
}

export function parentOf(id: string) {
  return id.slice(0, id.lastIndexOf("/"))
}

/** Tóm tắt: đoạn đầu ngay sau tiêu đề (bỏ `>`); nếu đó là heading thì coi như không có. */
export function summaryOf(content: string) {
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  const start = lines.findIndex((l) => l.length > 0)
  if (start < 0) return ""
  const from = /^#\s/.test(lines[start]!) ? start + 1 : start
  const next = lines.slice(from).find((l) => l.length > 0 && !l.startsWith("<!--"))
  if (!next || /^#+\s/.test(next)) return ""
  const s = next.replace(/^>\s?/, "").trim()
  return s.length > 160 ? s.slice(0, 159) + "…" : s
}

export function nodeMarkdown(title: string, summary: string | undefined, body: string) {
  const line = (s: string) => s.replace(/\r?\n/g, " ").trim()
  const head = `# ${line(title)}\n${summary?.trim() ? `\n> ${line(summary)}\n` : ""}`
  return body.trim() ? `${head}\n${body.trim()}\n` : head
}

function makeNode(id: string): KnowledgeNode {
  return { id, name: id.slice(id.lastIndexOf("/") + 1), title: "", summary: "", size: 0, updatedAt: 0, children: [] }
}

/** Dựng rừng tri thức (mỗi cây là một bộ) từ các tài liệu dưới `knowledge/`. */
export function knowledgeTree(docs: DocumentStore, metas: DocMeta[] = docs.list(KNOWLEDGE_ROOT)): KnowledgeNode[] {
  const byID = new Map<string, KnowledgeNode>()
  const root = makeNode(KNOWLEDGE_ROOT)
  byID.set(KNOWLEDGE_ROOT, root)
  const ensure = (id: string): KnowledgeNode => {
    const found = byID.get(id)
    if (found) return found
    const n = makeNode(id)
    byID.set(id, n)
    ensure(parentOf(id)).children.push(n)
    return n
  }
  for (const m of metas) {
    const n = ensure(m.path.replace(/\.md$/i, ""))
    if (n.doc?.endsWith(".md")) continue
    Object.assign(n, { doc: m.path, title: m.title, summary: summaryOf(docs.read(m.path) ?? ""), size: m.size, updatedAt: m.updatedAt, author: m.author })
  }
  const finish = (n: KnowledgeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const c of n.children) {
      finish(c)
      if (!c.title) c.title = c.name
      n.updatedAt = Math.max(n.updatedAt, c.updatedAt)
    }
  }
  finish(root)
  return root.children
}

export function findNode(forest: KnowledgeNode[], id: string): KnowledgeNode | undefined {
  for (const n of forest) {
    if (n.id === id) return n
    if (id.startsWith(n.id + "/")) return findNode(n.children, id)
  }
  return undefined
}

export function countBelow(n: KnowledgeNode): number {
  return n.children.reduce((s, c) => s + 1 + countBelow(c), 0)
}

/** `- knowledge/brand/voice — Giọng văn: tóm tắt (1200 chars, 3 sub-nodes)` */
export function nodeLine(n: KnowledgeNode, indent = "") {
  const below = countBelow(n)
  const facts = [n.doc ? `${n.size} chars` : "group only", below ? `${below} sub-node${below > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")
  return `${indent}- ${n.id} — ${n.title}${n.summary ? `: ${n.summary}` : ""} (${facts})`
}

/** Outline tới độ sâu `depth` (1 = chỉ các node này). */
export function outline(nodes: KnowledgeNode[], depth: number, indent = ""): string[] {
  return nodes.flatMap((n) => [nodeLine(n, indent), ...(depth > 1 ? outline(n.children, depth - 1, indent + "  ") : [])])
}

export const INDEX_LINE_CAP = 80

/** Index trong system prompt: mỗi bộ + các nhánh cấp 1; quá dài thì chỉ còn tên bộ. */
export function knowledgeIndex(forest: KnowledgeNode[]): string | undefined {
  if (forest.length === 0) return undefined
  let rows = outline(forest, 2)
  if (rows.length > INDEX_LINE_CAP) rows = outline(forest, 1)
  if (rows.length > INDEX_LINE_CAP) rows = [...rows.slice(0, INDEX_LINE_CAP), `- … ${rows.length - INDEX_LINE_CAP} more sets (use \`read knowledge\`)`]
  return `<knowledge>
The company's knowledge sets. Each set is a tree of nodes addressed by path. \`read\` a node path to get that node's content plus the list of its sub-nodes; go down only the branches you need instead of reading whole sets. \`read knowledge\` lists every set.
${rows.join("\n")}
</knowledge>`
}

/**
 * `read` trên kho tri thức: id node (có hoặc không `.md`) → nội dung node + danh sách node con.
 * Không phải đường dẫn tri thức → undefined (read thường xử lý).
 */
export function readNode(docs: DocumentStore, path: string): { output: string; isError?: boolean } | undefined {
  let id: string
  try {
    const p = normalizePath(path)
    if (p !== KNOWLEDGE_ROOT && !p.startsWith(`${KNOWLEDGE_ROOT}/`)) return undefined
    if (p === KNOWLEDGE_ROOT) {
      const forest = knowledgeTree(docs)
      return { output: forest.length ? `Knowledge sets:\n${outline(forest, 1).join("\n")}` : "(no knowledge sets yet)" }
    }
    id = normalizeNodeID(p)
  } catch {
    return undefined
  }
  const forest = knowledgeTree(docs)
  const node = findNode(forest, id)
  if (!node) {
    const parent = findNode(forest, parentOf(id))
    const near = (parent ? parent.children : forest).map((n) => n.id)
    return { output: `No knowledge node "${id}".${near.length ? ` ${parent ? `Sub-nodes of ${parent.id}` : "Sets"}: ${near.slice(0, 30).join(", ")}` : ""}`, isError: true }
  }
  return { output: renderNode(docs, node) }
}

export function renderNode(docs: DocumentStore, node: KnowledgeNode) {
  const crumbs = node.id.split("/").slice(1)
  const trail = crumbs.length > 1 ? `[${crumbs.map((_, i) => `knowledge/${crumbs.slice(0, i + 1).join("/")}`).join(" › ")}]\n` : ""
  const body = node.doc ? (docs.read(node.doc) ?? "").trim() : `# ${node.title}\n(group node: no content of its own)`
  const subs = node.children.length ? `\n\nSub-nodes (read one by its path):\n${outline(node.children, 1).join("\n")}` : ""
  return `${trail}${body}${subs}`
}

/** Path tài liệu của node + mọi tài liệu trong cây con. */
export function subtreeDocs(docs: DocumentStore, id: string): string[] {
  const own = docs.list(parentOf(id)).filter((d) => d.path.replace(/\.md$/i, "") === id).map((d) => d.path)
  return [...own, ...docs.list(id).map((d) => d.path)]
}
