import { z } from "zod"
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { dirname, resolve, relative, isAbsolute } from "node:path"
import { define } from "../define.ts"

/** Mọi path phải nằm trong workspace; không cho thoát ra ngoài. */
function inside(cwd: string, p: string) {
  const full = resolve(cwd, p)
  const rel = relative(cwd, full)
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path is outside the workspace: ${p}`)
  return full
}

export const read = define({
  name: "read",
  description: "Read a document from the workspace. Use offset/limit for long files.",
  input: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  permission: { action: "read", resource: (i) => i.path },
  async execute({ path, offset = 1, limit = 2000 }, ctx) {
    const text = await readFile(inside(ctx.cwd, path), "utf8")
    const lines = text.split("\n")
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const rest = lines.length - (offset - 1 + slice.length)
    return { output: slice.join("\n") + (rest > 0 ? `\n[${rest} more lines]` : ""), metadata: { lines: lines.length } }
  },
})

export const list = define({
  name: "list",
  description: "List files in a workspace folder.",
  input: z.object({ path: z.string().default(".") }),
  permission: { action: "read", resource: (i) => i.path },
  async execute({ path }, ctx) {
    const entries = await readdir(inside(ctx.cwd, path), { withFileTypes: true })
    const rows = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return { output: rows.join("\n") || "(empty)" }
  },
})

export const write = define({
  name: "write",
  description: "Create or overwrite a document in the workspace (e.g. drafts/post.md, deliverables/plan.md).",
  input: z.object({ path: z.string(), content: z.string() }),
  permission: { action: "write", resource: (i) => i.path },
  async execute({ path, content }, ctx) {
    const full = inside(ctx.cwd, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, "utf8")
    return { output: `Saved ${relative(ctx.cwd, full)} (${content.length} chars)`, metadata: { filesTouched: [full] } }
  },
})
