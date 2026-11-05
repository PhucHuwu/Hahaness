import { z } from "zod"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve, relative } from "node:path"
import { define } from "../define.ts"

function abs(cwd: string, p: string) {
  return resolve(cwd, p)
}

export const read = define({
  name: "read",
  description: "Read a text file. Returns lines prefixed with 1-based line numbers. Use offset/limit for large files.",
  input: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  permission: { action: "read", resource: (i) => i.path },
  async execute({ path, offset = 1, limit = 2000 }, ctx) {
    const text = await readFile(abs(ctx.cwd, path), "utf8")
    const lines = text.split("\n")
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const out = slice.map((l, i) => `${offset + i}: ${l}`).join("\n")
    const more = offset - 1 + slice.length < lines.length ? `\n[${lines.length - (offset - 1 + slice.length)} more lines]` : ""
    return { output: out + more, metadata: { lines: lines.length } }
  },
})

export const write = define({
  name: "write",
  description: "Create or overwrite a file with the given content. Parent directories are created.",
  input: z.object({ path: z.string(), content: z.string() }),
  permission: { action: "write", resource: (i) => i.path },
  async execute({ path, content }, ctx) {
    const full = abs(ctx.cwd, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, "utf8")
    return { output: `Wrote ${relative(ctx.cwd, full)} (${content.length} chars)`, metadata: { filesTouched: [full] } }
  },
})

export const edit = define({
  name: "edit",
  description: "Replace an exact string in a file. oldString must occur exactly once unless replaceAll is true.",
  input: z.object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  permission: { action: "edit", resource: (i) => i.path },
  async execute({ path, oldString, newString, replaceAll }, ctx) {
    const full = abs(ctx.cwd, path)
    const text = await readFile(full, "utf8")
    const count = text.split(oldString).length - 1
    if (count === 0) return { output: "oldString not found in file", isError: true }
    if (count > 1 && !replaceAll) return { output: `oldString occurs ${count} times; add more context or set replaceAll`, isError: true }
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString)
    await writeFile(full, next, "utf8")
    return { output: `Edited ${relative(ctx.cwd, full)} (${count} replacement${count > 1 ? "s" : ""})`, metadata: { filesTouched: [full] } }
  },
})
