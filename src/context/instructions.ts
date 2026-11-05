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

/** Source đổi so với baseline → nội dung mới dạng notice (v0.2 sẽ thành unified diff). */
export function changed(baseline: InstructionSource[], current: InstructionSource[]): InstructionSource[] {
  const map = new Map(baseline.map((s) => [s.id, s.hash]))
  return current.filter((s) => map.get(s.id) !== s.hash)
}
