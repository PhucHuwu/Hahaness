import { z } from "zod"
import { define } from "../define.ts"
import { normalizePath, normalizePrefix, type DocumentStore } from "../../context/documents.ts"
import { readNode } from "../../context/knowledge.ts"

/**
 * Tài liệu của công ty nằm trong DB nhưng agent vẫn thấy chúng như path
 * (`knowledge/x.md`, `drafts/x.md`, `deliverables/x.md`) để permission theo
 * prefix và thói quen của model không đổi. Path được chuẩn hóa; `..` bị từ chối.
 */
export function documentTools(docs: DocumentStore) {
  const read = define({
    name: "read",
    description:
      "Read a company document, e.g. COMPANY.md, drafts/post.md. For the knowledge library, pass a node path (e.g. knowledge/brand or knowledge/brand/voice): you get that node's content and its sub-nodes; `knowledge` alone lists all sets. Use offset/limit for long documents.",
    input: z.object({
      path: z.string(),
      offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    permission: { action: "read", resource: (i) => safe(i.path) },
    async execute({ path, offset = 1, limit = 2000 }) {
      const node = readNode(docs, path)
      if (node && offset === 1 && limit === 2000) return node
      const doc = docs.get(path) ?? (node ? docs.get(`${path.replace(/\.md$/i, "")}.md`) : undefined)
      if (!doc) {
        if (node) return node
        const near = docs.children(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "").map((c) => c.name)
        return { output: `No document "${path}".${near.length ? ` Nearby: ${near.slice(0, 20).join(", ")}` : ""}`, isError: true }
      }
      const lines = doc.content.split("\n")
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const rest = lines.length - (offset - 1 + slice.length)
      return { output: slice.join("\n") + (rest > 0 ? `\n[${rest} more lines]` : ""), metadata: { lines: lines.length } }
    },
  })

  const list = define({
    name: "list",
    description: "List documents in a folder of the company workspace (e.g. knowledge, drafts, deliverables). Empty path lists the top level.",
    input: z.object({ path: z.string().default("") }),
    permission: { action: "read", resource: (i) => normalizePrefix(i.path) || "*" },
    async execute({ path }) {
      const rows = docs.children(path).map((c) => (c.dir ? c.name : `${c.name} (${c.size} chars)`))
      return { output: rows.join("\n") || "(empty)" }
    },
  })

  const search = define({
    name: "search",
    description: "Find company documents containing a phrase (case-insensitive). Returns matching paths with the matching lines. Narrow with path, e.g. knowledge.",
    input: z.object({
      query: z.string().min(1),
      path: z.string().optional().describe("Folder to search in, e.g. knowledge"),
    }),
    permission: { action: "read", resource: (i) => normalizePrefix(i.path) || "*" },
    async execute({ query, path }) {
      const hits = docs.search(query, { prefix: path })
      if (hits.length === 0) return { output: `No documents match "${query}".` }
      return {
        output: hits
          .map((h) => [h.path, ...h.matches.map((m) => `  ${m.line}: ${m.text}`)].join("\n"))
          .join("\n"),
      }
    },
  })

  const write = define({
    name: "write",
    description: "Create or overwrite a company document (e.g. drafts/post.md, deliverables/plan.md). Deliverables are shown to the CEO in the Results page.",
    input: z.object({ path: z.string(), content: z.string() }),
    permission: { action: "write", resource: (i) => safe(i.path) },
    async execute({ path, content }, ctx) {
      const p = docs.put(path, content, ctx.agent)
      return { output: `Saved ${p} (${content.length} chars)`, metadata: { filesTouched: [p] } }
    },
  })

  return [read, list, search, write]
}

/** Resource cho permission: path chuẩn hóa; path lỗi trả nguyên để execute báo lỗi. */
function safe(p: string) {
  try {
    return normalizePath(p)
  } catch {
    return p
  }
}
