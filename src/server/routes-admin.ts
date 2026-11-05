import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { App } from "../bootstrap.ts"
import { buildProviders, ConfigSchema, CONFIG_FILES, loadConfig } from "../config.ts"
import * as workspace from "../context/workspace.ts"
import { SkillStore } from "../context/skills.ts"
import { toMarkdown } from "../agent/registry.ts"
import type { McpServerConfig } from "../mcp/client.ts"
import { HttpError, type Router } from "./http.ts"

const KNOWLEDGE_FILES = new Set<string>([workspace.FILES.company, workspace.FILES.user, workspace.FILES.memory])

/** Path hợp lệ cho Knowledge: 3 file gốc hoặc bất kỳ file trong knowledge/. */
function knowledgePath(cwd: string, p: string) {
  if (KNOWLEDGE_FILES.has(p)) return join(cwd, p)
  const full = resolve(cwd, p)
  const rel = relative(join(cwd, workspace.KNOWLEDGE_DIR), full)
  if (rel.startsWith("..") || isAbsolute(rel)) throw new HttpError(400, `path must be inside ${workspace.KNOWLEDGE_DIR}/`)
  return full
}

export function adminRoutes(r: Router, app: App) {
  const { cwd, skills, mcp } = app

  // ---- Settings: providers / model ------------------------------------------
  r.get("/api/config", async () => {
    const { config, path } = await loadConfig(cwd)
    return {
      path: path ?? null,
      writePath: path ?? join(cwd, CONFIG_FILES[0]!),
      config: redact(config),
      providerError: app.providerError ?? null,
      providers: app.harness.cfg.providers.ids(),
      defaultModel: app.harness.cfg.defaultModel,
      env: { OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, HAHANESS_MODEL: process.env.HAHANESS_MODEL ?? null },
    }
  })

  r.put("/api/config", async (req) => {
    const body = await req.json<unknown>()
    const parsed = ConfigSchema.safeParse(body)
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    const { path } = await loadConfig(cwd)
    const target = path && path.startsWith(cwd) ? path : join(cwd, CONFIG_FILES[0]!)
    const current = existsSync(target) ? ConfigSchema.parse(JSON.parse(await readFile(target, "utf8"))) : { providers: {} }
    const next = restoreSecrets(parsed.data, current)
    await writeFile(target, JSON.stringify(next, null, 2), "utf8")
    try {
      const providers = await buildProviders(next, cwd)
      app.harness.reconfigure({ providers, defaultModel: process.env.HAHANESS_MODEL ?? next.defaultModel })
      app.providerError = undefined
    } catch (e) {
      app.providerError = (e as Error).message
    }
    return { ok: true, path: target, providerError: app.providerError ?? null }
  })

  r.post("/api/config/test", async (req) => {
    const body = await req.json<{ model?: string }>()
    const ref = body.model ?? app.harness.cfg.defaultModel
    if (app.providerError) throw new HttpError(409, app.providerError)
    const { client, model } = app.harness.cfg.providers.resolve(ref)
    const started = Date.now()
    let text = ""
    for await (const ev of client.stream(
      { model, system: ["Reply with the single word OK."], messages: [{ id: "m", role: "user", createdAt: 0, parts: [{ type: "text", text: "ping" }] }], tools: [], toolChoice: "none", maxOutputTokens: 8 },
      AbortSignal.timeout(30_000),
    )) {
      if (ev.type === "text-delta") text += ev.text
      if (ev.type === "error") throw new HttpError(502, ev.error.message)
    }
    return { ok: true, model: ref, reply: text.trim(), ms: Date.now() - started }
  })

  // ---- Knowledge ----------------------------------------------------------
  r.get("/api/knowledge", async () => {
    const core = await Promise.all(
      [...KNOWLEDGE_FILES].map(async (f) => {
        const p = join(cwd, f)
        const text = existsSync(p) ? await readFile(p, "utf8") : ""
        return { path: f, size: text.length }
      }),
    )
    return { core, files: await workspace.knowledge(cwd), staffDir: "staff", outputs: await outputs(cwd) }
  })

  r.get("/api/knowledge/file", async (req) => {
    const p = req.url.searchParams.get("path")
    if (!p) throw new HttpError(400, "path is required")
    const full = knowledgePath(cwd, p)
    if (!existsSync(full)) return { path: p, content: "" }
    return { path: p, content: await readFile(full, "utf8") }
  })

  r.put("/api/knowledge/file", async (req) => {
    const body = await req.json<{ path?: string; content?: string }>()
    if (!body.path || body.content === undefined) throw new HttpError(400, "path and content are required")
    const full = knowledgePath(cwd, body.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body.content, "utf8")
    return { ok: true }
  })

  r.delete("/api/knowledge/file", async (req) => {
    const p = req.url.searchParams.get("path")
    if (!p || KNOWLEDGE_FILES.has(p)) throw new HttpError(400, "only files under knowledge/ can be deleted")
    await rm(knowledgePath(cwd, p), { force: true })
    return { ok: true }
  })

  r.get("/api/outputs/file", async (req) => {
    const p = req.url.searchParams.get("path")
    if (!p) throw new HttpError(400, "path is required")
    const full = resolve(cwd, p)
    const rel = relative(cwd, full)
    if (!/^(drafts|deliverables)[\\/]/.test(rel)) throw new HttpError(400, "path must be under drafts/ or deliverables/")
    if (!existsSync(full)) throw new HttpError(404, `no file ${p}`)
    return { path: p, content: await readFile(full, "utf8") }
  })

  r.get("/api/staff/:id/markdown", (req) => {
    const id = req.params.id!
    if (!app.agents.has(id)) throw new HttpError(404, `no employee ${id}`)
    return { id, markdown: toMarkdown(app.agents.get(id)) }
  })

  // ---- Skills ----------------------------------------------------------------
  r.get("/api/skills", () => skills.list())
  r.get("/api/skills/:id", async (req) => {
    const content = await skills.read(req.params.id!)
    if (content === undefined) throw new HttpError(404, `no skill ${req.params.id}`)
    return { id: req.params.id, content }
  })
  r.put("/api/skills/:id", async (req) => {
    const body = await req.json<{ content?: string }>()
    if (!body.content) throw new HttpError(400, "content is required")
    const id = await skills.write(req.params.id!, body.content)
    return { id }
  })
  r.delete("/api/skills/:id", async (req) => {
    await skills.remove(req.params.id!)
    return { ok: true }
  })
  r.get("/api/skills-template/:id", (req) => ({ content: SkillStore.template(req.params.id!) }))

  // ---- MCP -------------------------------------------------------------------
  r.get("/api/mcp", () => mcp.list())
  r.post("/api/mcp", async (req) => {
    const body = await req.json<{ id?: string; config?: McpServerConfig }>()
    if (!body.id || !body.config) throw new HttpError(400, "id and config are required")
    return mcp.add(body.id, body.config)
  })
  r.post("/api/mcp/:id/enabled", async (req) => {
    const body = await req.json<{ enabled?: boolean }>()
    return mcp.setEnabled(req.params.id!, body.enabled !== false)
  })
  r.post("/api/mcp/:id/reconnect", (req) => mcp.reconnect(req.params.id!))
  r.delete("/api/mcp/:id", async (req) => {
    await mcp.remove(req.params.id!)
    return { ok: true }
  })
}

const SECRET = "••••"

/** Không trả apiKey thật ra UI; `{env:X}` vẫn hiện để CEO biết nguồn. */
function redact<T extends { providers: Record<string, any> }>(config: T): T {
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([id, p]) => [
      id,
      p.type === "openai" && p.apiKey && !p.apiKey.startsWith("{env:") ? { ...p, apiKey: SECRET } : p,
    ]),
  )
  return { ...config, providers }
}

/** UI gửi lại `••••` nghĩa là giữ nguyên key cũ. */
function restoreSecrets<T extends { providers: Record<string, any> }>(next: T, current: T): T {
  const providers = Object.fromEntries(
    Object.entries(next.providers).map(([id, p]) => {
      const old = current.providers[id]
      if (p.type === "openai" && p.apiKey === SECRET) return [id, { ...p, apiKey: old?.type === "openai" ? old.apiKey : undefined }]
      return [id, p]
    }),
  )
  return { ...next, providers }
}

async function outputs(cwd: string) {
  const out: Array<{ path: string; size: number; mtime: number }> = []
  for (const dir of ["deliverables", "drafts"]) {
    const full = join(cwd, dir)
    if (!existsSync(full)) continue
    for (const f of await readdir(full)) {
      const s = await stat(join(full, f))
      if (s.isFile()) out.push({ path: `${dir}/${f}`, size: s.size, mtime: s.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
