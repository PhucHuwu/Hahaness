import { createHash } from "node:crypto"
import type { InstructionSource } from "./instructions.ts"
import type { DocumentStore, DocMeta } from "./documents.ts"
import { knowledgeIndex, knowledgeTree, KNOWLEDGE_ROOT } from "./knowledge.ts"

/**
 * Workspace của công ty, lưu trong DB (bảng `documents`):
 *   COMPANY.md    — công ty làm gì, sản phẩm, khách hàng, giọng văn
 *   USER.md       — CEO là ai, sở thích, cách muốn được báo cáo
 *   MEMORY.md     — CTO tự ghi (tool `memory`)
 *   knowledge/*   — các bộ tri thức dạng cây (context/knowledge.ts; CTO quản lý bằng tool `knowledge`)
 *   drafts/*      — nhân viên nộp bài
 *   deliverables/* — kết quả cuối cho CEO (xem/tải trong UI)
 */
export const FILES = {
  company: "COMPANY.md",
  user: "USER.md",
  memory: "MEMORY.md",
} as const

export const MEMORY_CAP = 4_000
export const FILE_CAP = 20_000

export const COMPANY_TEMPLATE = `# Company

<!-- Mô tả công ty của bạn. CTO và mọi nhân viên sẽ đọc phần này. -->

## What we do

## Products / services

## Customers

## Voice & tone
`

export const USER_TEMPLATE = `# CEO

<!-- Vài dòng về bạn: tên, cách bạn muốn được báo cáo (ngắn/dài, ngôn ngữ), điều bạn ghét. -->
`

export const KNOWLEDGE_DIR = KNOWLEDGE_ROOT
export const DRAFTS_DIR = "drafts"
export const DELIVERABLES_DIR = "deliverables"
/** File CEO gửi kèm tin nhắn, đã chuyển thành chữ (`src/upload/attachments.ts`). */
export const UPLOADS_DIR = "uploads"

export function ensure(docs: DocumentStore) {
  docs.ensure(FILES.company, COMPANY_TEMPLATE)
  docs.ensure(FILES.user, USER_TEMPLATE)
  docs.ensure(FILES.memory, "")
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16)
}

/** Template chưa sửa gì (chỉ còn heading/comment) coi như rỗng, không tốn token. */
function meaningful(text: string) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/^#+.*$/gm, "").trim().length > 0
}

function capped(docs: DocumentStore, path: string, cap: number) {
  const text = (docs.read(path) ?? "").trim()
  return text.length > cap ? text.slice(0, cap) + "\n[truncated]" : text
}

export function knowledge(docs: DocumentStore): DocMeta[] {
  return docs.list(KNOWLEDGE_DIR)
}

/** Tier B cho agent: COMPANY + knowledge index luôn; USER + MEMORY chỉ cho primary (nhân viên không cần biết sếp thích gì). */
export function sources(docs: DocumentStore, opts: { includePersonal: boolean }): InstructionSource[] {
  const out: InstructionSource[] = []
  const author = (path: string) => docs.get(path)?.author
  const company = capped(docs, FILES.company, FILE_CAP)
  if (meaningful(company)) out.push({ id: "workspace/company", content: `<company>\n${company}\n</company>`, hash: hash(company), author: author(FILES.company) })
  const index = knowledgeIndex(knowledgeTree(docs))
  if (index) out.push({ id: "workspace/knowledge", content: index, hash: hash(index) })
  if (opts.includePersonal) {
    const user = capped(docs, FILES.user, FILE_CAP)
    if (meaningful(user)) out.push({ id: "workspace/user", content: `<ceo>\n${user}\n</ceo>`, hash: hash(user), author: author(FILES.user) })
    const memory = capped(docs, FILES.memory, MEMORY_CAP)
    if (memory) out.push({ id: "workspace/memory", content: `<memory>\n${memory}\n</memory>`, hash: hash(memory), author: author(FILES.memory) })
  }
  return out
}

/** MEMORY.md: mục ngăn bằng dòng `§`. */
export function readMemory(docs: DocumentStore): string[] {
  const text = (docs.read(FILES.memory) ?? "").trim()
  return text ? text.split(/\n§\n/).map((s) => s.trim()).filter(Boolean) : []
}

export function writeMemory(docs: DocumentStore, entries: string[]) {
  let text = entries.join("\n§\n")
  while (text.length > MEMORY_CAP && entries.length > 1) {
    entries.shift()
    text = entries.join("\n§\n")
  }
  docs.put(FILES.memory, text, "cto")
}
