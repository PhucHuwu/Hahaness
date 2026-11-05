import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { InstructionSource } from "./instructions.ts"

/**
 * Workspace của công ty. Người dùng no-code chỉ cần sửa vài file markdown:
 *   COMPANY.md  — công ty làm gì, sản phẩm, khách hàng, giọng văn
 *   USER.md     — CEO là ai, sở thích, cách muốn được báo cáo
 *   MEMORY.md   — CTO tự ghi: quyết định, sự thật đã học (tool `memory`)
 *   drafts/     — nhân viên nộp bài
 *   deliverables/ — CTO lưu kết quả cuối
 */
export const FILES = {
  company: "COMPANY.md",
  user: "USER.md",
  memory: "MEMORY.md",
} as const

export const MEMORY_CAP = 4_000
export const FILE_CAP = 20_000

const COMPANY_TEMPLATE = `# Company

<!-- Mô tả công ty của bạn. CTO và mọi nhân viên sẽ đọc file này. -->

## What we do

## Products / services

## Customers

## Voice & tone
`

const USER_TEMPLATE = `# CEO

<!-- Vài dòng về bạn: tên, cách bạn muốn được báo cáo (ngắn/dài, ngôn ngữ), điều bạn ghét. -->
`

export const KNOWLEDGE_DIR = "knowledge"
export const KNOWLEDGE_INDEX_CAP = 60

export async function ensure(root: string) {
  await mkdir(join(root, "drafts"), { recursive: true })
  await mkdir(join(root, "deliverables"), { recursive: true })
  await mkdir(join(root, KNOWLEDGE_DIR), { recursive: true })
  for (const [file, template] of [
    [FILES.company, COMPANY_TEMPLATE],
    [FILES.user, USER_TEMPLATE],
    [FILES.memory, ""],
  ] as const) {
    const path = join(root, file)
    if (!existsSync(path)) await writeFile(path, template, "utf8")
  }
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16)
}

async function readCapped(path: string, cap: number) {
  if (!existsSync(path)) return ""
  const text = (await readFile(path, "utf8")).trim()
  return text.length > cap ? text.slice(0, cap) + "\n[truncated]" : text
}

export interface KnowledgeFile {
  path: string
  size: number
  /** Dòng đầu không rỗng (bỏ `#`), làm mô tả trong index. */
  title: string
}

/** Tài liệu tham khảo CEO bỏ vào `knowledge/` (đệ quy, chỉ file text). */
export async function knowledge(root: string): Promise<KnowledgeFile[]> {
  const dir = join(root, KNOWLEDGE_DIR)
  if (!existsSync(dir)) return []
  const out: KnowledgeFile[] = []
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(d, e.name), p)
      else if (/\.(md|txt|csv|json|html)$/i.test(e.name)) {
        const text = await readFile(join(d, e.name), "utf8")
        const title = text.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? ""
        out.push({ path: `${KNOWLEDGE_DIR}/${p}`, size: text.length, title: title.slice(0, 120) })
      }
    }
  }
  await walk(dir, "")
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function knowledgeIndex(files: KnowledgeFile[]): string | undefined {
  if (files.length === 0) return undefined
  const rows = files.slice(0, KNOWLEDGE_INDEX_CAP).map((f) => `- ${f.path}${f.title ? ` — ${f.title}` : ""}`)
  if (files.length > KNOWLEDGE_INDEX_CAP) rows.push(`- … ${files.length - KNOWLEDGE_INDEX_CAP} more (use \`list knowledge\`)`)
  return `<knowledge>\nReference documents the CEO provided. Read them with the \`read\` tool when relevant.\n${rows.join("\n")}\n</knowledge>`
}

/** Tier B cho agent: COMPANY + knowledge index luôn; USER + MEMORY chỉ cho primary (nhân viên không cần biết sếp thích gì). */
export async function sources(root: string, opts: { includePersonal: boolean }): Promise<InstructionSource[]> {
  const out: InstructionSource[] = []
  const company = await readCapped(join(root, FILES.company), FILE_CAP)
  if (company) out.push({ id: "workspace/company", content: `<company>\n${company}\n</company>`, hash: hash(company) })
  const index = knowledgeIndex(await knowledge(root))
  if (index) out.push({ id: "workspace/knowledge", content: index, hash: hash(index) })
  if (opts.includePersonal) {
    const user = await readCapped(join(root, FILES.user), FILE_CAP)
    if (user) out.push({ id: "workspace/user", content: `<ceo>\n${user}\n</ceo>`, hash: hash(user) })
    const memory = await readCapped(join(root, FILES.memory), MEMORY_CAP)
    if (memory) out.push({ id: "workspace/memory", content: `<memory>\n${memory}\n</memory>`, hash: hash(memory) })
  }
  return out
}

/** MEMORY.md: mục ngăn bằng dòng `§`. */
export async function readMemory(root: string): Promise<string[]> {
  const text = await readCapped(join(root, FILES.memory), Number.MAX_SAFE_INTEGER)
  return text ? text.split(/\n§\n/).map((s) => s.trim()).filter(Boolean) : []
}

export async function writeMemory(root: string, entries: string[]) {
  let text = entries.join("\n§\n")
  while (text.length > MEMORY_CAP && entries.length > 1) {
    entries.shift()
    text = entries.join("\n§\n")
  }
  await writeFile(join(root, FILES.memory), text, "utf8")
}
