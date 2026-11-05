import type { App } from "../bootstrap.ts"
import { buildProviders, ConfigSchema, saveConfig, storedConfig } from "../config.ts"
import * as workspace from "../context/workspace.ts"
import { normalizePath, type DocMeta } from "../context/documents.ts"
import { SkillStore } from "../context/skills.ts"
import { toMarkdown } from "../agent/registry.ts"
import type { McpServerConfig } from "../mcp/client.ts"
import { HttpError, type Router } from "./http.ts"

const CORE = [workspace.FILES.company, workspace.FILES.user, workspace.FILES.memory] as string[]
const OUTPUT_DIRS = [workspace.DELIVERABLES_DIR, workspace.DRAFTS_DIR]

function param(req: { url: URL }, key: string) {
  const v = req.url.searchParams.get(key)
  if (!v) throw new HttpError(400, `${key} is required`)
  try {
    return normalizePath(v)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
}

/** UI chỉ sửa được 3 tài liệu cốt lõi và knowledge/*. */
function editable(path: string) {
  if (CORE.includes(path) || path.startsWith(`${workspace.KNOWLEDGE_DIR}/`)) return path
  throw new HttpError(400, `path must be one of ${CORE.join(", ")} or inside ${workspace.KNOWLEDGE_DIR}/`)
}

function isOutput(path: string) {
  return OUTPUT_DIRS.some((d) => path.startsWith(`${d}/`))
}

export function adminRoutes(r: Router, app: App) {
  const { docs, skills, mcp, db } = app

  // ---- Settings: providers / model ------------------------------------------
  r.get("/api/config", () => ({
    config: redact(storedConfig(db)),
    db: db.path,
    providerError: app.providerError ?? null,
    providers: app.harness.cfg.providers.ids(),
    defaultModel: app.harness.cfg.defaultModel,
    env: { OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, HAHANESS_MODEL: process.env.HAHANESS_MODEL ?? null },
  }))

  r.put("/api/config", async (req) => {
    const parsed = ConfigSchema.safeParse(await req.json<unknown>())
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    const next = restoreSecrets(parsed.data, storedConfig(db))
    saveConfig(db, next)
    try {
      const providers = await buildProviders(next, app.cwd)
      app.harness.reconfigure({ providers, defaultModel: process.env.HAHANESS_MODEL ?? next.defaultModel, compaction: next.compaction, fallbackModels: next.fallbackModels })
      app.providerError = undefined
    } catch (e) {
      app.providerError = (e as Error).message
    }
    return { ok: true, providerError: app.providerError ?? null }
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
  r.get("/api/knowledge", () => ({
    core: CORE.map((p) => {
      const d = docs.get(p)
      return { path: p, size: d?.size ?? 0, updatedAt: d?.updatedAt ?? 0, author: d?.author ?? null }
    }),
    files: workspace.knowledge(docs).map(view),
  }))

  r.get("/api/knowledge/file", (req) => {
    const p = editable(param(req, "path"))
    return { path: p, content: docs.read(p) ?? "" }
  })

  r.put("/api/knowledge/file", async (req) => {
    const body = await req.json<{ path?: string; content?: string }>()
    if (!body.path || body.content === undefined) throw new HttpError(400, "path and content are required")
    let p: string
    try {
      p = normalizePath(body.path)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    docs.put(editable(p), body.content, "ceo")
    return { ok: true, path: p }
  })

  r.delete("/api/knowledge/file", (req) => {
    const p = param(req, "path")
    if (CORE.includes(p)) throw new HttpError(400, "core documents cannot be deleted")
    if (!docs.delete(editable(p))) throw new HttpError(404, `no document ${p}`)
    return { ok: true }
  })

  // ---- Results: deliverables + drafts (xem + tải) ---------------------------
  r.get("/api/results", () => ({
    deliverables: docs.list(workspace.DELIVERABLES_DIR).map(view).sort(newest),
    drafts: docs.list(workspace.DRAFTS_DIR).map(view).sort(newest),
  }))

  r.get("/api/results/file", (req) => {
    const p = param(req, "path")
    if (!isOutput(p)) throw new HttpError(400, `path must be under ${OUTPUT_DIRS.join("/ or ")}/`)
    const d = docs.get(p)
    if (!d) throw new HttpError(404, `no document ${p}`)
    return d
  })

  r.get("/api/results/download", (req, res) => {
    const p = param(req, "path")
    if (!isOutput(p)) throw new HttpError(400, `path must be under ${OUTPUT_DIRS.join("/ or ")}/`)
    const d = docs.get(p)
    if (!d) throw new HttpError(404, `no document ${p}`)
    const name = p.split("/").pop()!
    const filename = /\.\w+$/.test(name) ? name : `${name}.md`
    res.writeHead(200, {
      "content-type": `${filename.endsWith(".md") ? "text/markdown" : "text/plain"}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    })
    res.end(d.content)
    return undefined
  })

  r.delete("/api/results/file", (req) => {
    const p = param(req, "path")
    if (!isOutput(p)) throw new HttpError(400, `path must be under ${OUTPUT_DIRS.join("/ or ")}/`)
    if (!docs.delete(p)) throw new HttpError(404, `no document ${p}`)
    return { ok: true }
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

function view(d: DocMeta) {
  return { path: d.path, size: d.size, title: d.title, updatedAt: d.updatedAt, author: d.author ?? null }
}

function newest(a: { updatedAt: number }, b: { updatedAt: number }) {
  return b.updatedAt - a.updatedAt
}

const SECRET = "••••"

/** Không trả apiKey thật ra UI; `{env:X}` vẫn hiện để CEO biết nguồn. */
function redact<T extends { providers: Record<string, any> }>(config: T): T {
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([id, p]) => [
      id,
      (p.type === "openai" || p.type === "anthropic") && p.apiKey && !p.apiKey.startsWith("{env:") ? { ...p, apiKey: SECRET } : p,
    ]),
  )
  return { ...config, providers }
}

/** UI gửi lại `••••` nghĩa là giữ nguyên key cũ. */
function restoreSecrets<T extends { providers: Record<string, any> }>(next: T, current: T): T {
  const providers = Object.fromEntries(
    Object.entries(next.providers).map(([id, p]) => {
      const old = current.providers[id]
      if (p.apiKey === SECRET) return [id, { ...p, apiKey: old?.type === p.type ? old.apiKey : undefined }]
      return [id, p]
    }),
  )
  return { ...next, providers }
}
