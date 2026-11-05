import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join, relative } from "node:path"

export const FILE_CAP = 20_000
export const TOTAL_CAP = 60_000

export interface InstructionSource {
  id: string
  content: string
  hash: string
  /** Ai sửa lần cuối (agent id hoặc "ceo"); dùng để không báo agent về thay đổi do chính nó làm. */
  author?: string
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16)
}

function projectRoot(cwd: string) {
  let dir = cwd
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

/** AGENTS.md từ project root xuống cwd (root trước), cap per-file và tổng. */
export async function discover(cwd: string): Promise<InstructionSource[]> {
  const root = projectRoot(cwd)
  const dirs: string[] = []
  let dir = cwd
  while (true) {
    dirs.unshift(dir)
    if (dir === root) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const out: InstructionSource[] = []
  let total = 0
  for (const d of dirs) {
    const path = join(d, "AGENTS.md")
    if (!existsSync(path)) continue
    let content = await readFile(path, "utf8")
    if (content.length > FILE_CAP) content = content.slice(0, FILE_CAP) + "\n[truncated]"
    if (total + content.length > TOTAL_CAP) break
    total += content.length
    const rel = relative(cwd, path).replaceAll("\\", "/") || "AGENTS.md"
    out.push({ id: `agents:${rel}`, content: `Instructions from: ${rel}\n${content}`, hash: hash(content) })
  }
  return out
}

export function environment(cwd: string): InstructionSource {
  const content = [
    "<env>",
    `  Working directory: ${cwd}`,
    `  Platform: ${process.platform}`,
    `  Date: ${new Date().toISOString().slice(0, 10)}`,
    "</env>",
  ].join("\n")
  return { id: "core/environment", content, hash: hash(content) }
}

/** Source đổi so với baseline (mới hoặc khác hash). Source bị xoá xem `removed`. */
export function changed(baseline: InstructionSource[], current: InstructionSource[]): InstructionSource[] {
  const map = new Map(baseline.map((s) => [s.id, s.hash]))
  return current.filter((s) => map.get(s.id) !== s.hash)
}

export function removed(baseline: InstructionSource[], current: InstructionSource[]): InstructionSource[] {
  const ids = new Set(current.map((s) => s.id))
  return baseline.filter((s) => !ids.has(s.id))
}

/** Nội dung mới ngắn hơn mức này → gửi nguyên văn thay vì diff (dễ đọc hơn). */
export const FULL_CONTENT_UNDER = 1_500
export const UPDATE_SOURCE_CAP = 6_000

/**
 * Message Tier C khi tài liệu đổi giữa phiên. System prompt giữ nguyên (cache); message này
 * nói rõ phần nào trong system đã cũ. Trả undefined nếu không có gì để báo.
 */
export function updateNotice(baseline: InstructionSource[], current: InstructionSource[]): string | undefined {
  const before = new Map(baseline.map((s) => [s.id, s]))
  const blocks: string[] = []
  for (const s of changed(baseline, current)) {
    const old = before.get(s.id)
    const label = describe(s.id)
    if (!old) {
      blocks.push(`${label} was added:\n${cap(s.content)}`)
      continue
    }
    const diff = lineDiff(old.content, s.content)
    if (s.content.length <= FULL_CONTENT_UNDER || diff.length >= s.content.length) blocks.push(`${label} now reads:\n${cap(s.content)}`)
    else blocks.push(`${label} changed (lines starting with - were removed, + were added):\n${cap(diff)}`)
  }
  for (const s of removed(baseline, current)) blocks.push(`${describe(s.id)} was removed or emptied; ignore what your system context says about it.`)
  if (blocks.length === 0) return undefined
  return `<workspace-update>\nThe company workspace changed since this conversation started. These updates replace the matching parts of your system context.\n\n${blocks.join("\n\n")}\n</workspace-update>`
}

const LABELS: Record<string, string> = {
  "workspace/company": "COMPANY.md (<company>)",
  "workspace/user": "USER.md (<ceo>)",
  "workspace/memory": "MEMORY.md (<memory>)",
  "workspace/knowledge": "The knowledge index (<knowledge>)",
  "skills/index": "The skills list (<available_skills>)",
}

function describe(id: string) {
  return LABELS[id] ?? id
}

function cap(s: string) {
  return s.length > UPDATE_SOURCE_CAP ? s.slice(0, UPDATE_SOURCE_CAP) + "\n[truncated; `read` the document for the rest]" : s
}

/** Diff theo dòng (multiset, giữ thứ tự): đủ cho văn bản người viết, không cần LCS. */
export function lineDiff(a: string, b: string): string {
  const count = (lines: string[]) => {
    const m = new Map<string, number>()
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const al = a.split("\n").filter((l) => l.trim())
  const bl = b.split("\n").filter((l) => l.trim())
  const inB = count(bl)
  const inA = count(al)
  const out: string[] = []
  for (const l of al) {
    const n = inB.get(l) ?? 0
    if (n > 0) inB.set(l, n - 1)
    else out.push(`- ${l}`)
  }
  for (const l of bl) {
    const n = inA.get(l) ?? 0
    if (n > 0) inA.set(l, n - 1)
    else out.push(`+ ${l}`)
  }
  return out.join("\n")
}
