import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

export interface TruncateOptions {
  dir: string
  callID: string
  /** Giữ phần cuối thay vì phần đầu (log build). */
  tail?: boolean
}

export async function truncate(output: string, opts: TruncateOptions): Promise<string> {
  const lines = output.split("\n")
  const bytes = Buffer.byteLength(output, "utf8")
  if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) return output

  await mkdir(opts.dir, { recursive: true })
  const path = join(opts.dir, `${opts.callID}.txt`)
  await writeFile(path, output, "utf8")

  const kept: string[] = []
  let size = 0
  const source = opts.tail ? [...lines].reverse() : lines
  for (const line of source) {
    const len = Buffer.byteLength(line, "utf8") + 1
    if (kept.length >= MAX_LINES || size + len > MAX_BYTES) break
    kept.push(line)
    size += len
  }
  if (opts.tail) kept.reverse()

  const range = opts.tail
    ? `lines ${lines.length - kept.length + 1}-${lines.length}`
    : `lines 1-${kept.length}`
  return `${kept.join("\n")}\n\n[showing ${range} of ${lines.length}; full output saved to ${path}]`
}
