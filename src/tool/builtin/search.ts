import { z } from "zod"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { define } from "../define.ts"

const IGNORE = new Set(["node_modules", ".git", ".hahaness", "dist", "build"])

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

function globToRegex(pattern: string) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
  return new RegExp("^" + re + "$")
}

export const glob = define({
  name: "glob",
  description: "Find files by glob pattern (e.g. src/**/*.ts). Returns relative paths.",
  input: z.object({ pattern: z.string(), limit: z.number().int().default(100) }),
  permission: { action: "read", resource: (i) => i.pattern },
  async execute({ pattern, limit }, ctx) {
    const re = globToRegex(pattern)
    const hits: string[] = []
    for await (const f of walk(ctx.cwd)) {
      const rel = relative(ctx.cwd, f).replaceAll("\\", "/")
      if (re.test(rel)) hits.push(rel)
      if (hits.length >= limit) break
    }
    return { output: hits.length ? hits.join("\n") : "No files matched" }
  },
})

export const grep = define({
  name: "grep",
  description: "Search file contents with a regular expression. Returns path:line: preview.",
  input: z.object({
    pattern: z.string(),
    include: z.string().optional().describe("Glob filter, e.g. *.ts"),
    limit: z.number().int().default(100),
  }),
  permission: { action: "read", resource: (i) => i.pattern },
  async execute({ pattern, include, limit }, ctx) {
    const re = new RegExp(pattern)
    const inc = include ? globToRegex(include.includes("/") ? include : `**/${include}`) : undefined
    const hits: string[] = []
    for await (const f of walk(ctx.cwd)) {
      const rel = relative(ctx.cwd, f).replaceAll("\\", "/")
      if (inc && !inc.test(rel)) continue
      if ((await stat(f)).size > 2_000_000) continue
      const text = await readFile(f, "utf8").catch(() => "")
      const lines = text.split("\n")
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
      }
      if (hits.length >= limit) break
    }
    return { output: hits.length ? hits.join("\n") : "No matches" }
  },
})
