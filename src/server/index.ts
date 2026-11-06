import { createServer } from "node:http"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { bootstrap } from "../bootstrap.ts"
import { id } from "../core/id.ts"
import { Router, SseBus, json, serveStatic, HttpError } from "./http.ts"
import { chatRoutes, sessionView } from "./routes-chat.ts"
import { adminRoutes } from "./routes-admin.ts"
import { scheduleRoutes } from "./routes-schedule.ts"

const here = dirname(fileURLToPath(import.meta.url))

export interface ServerOptions {
  cwd: string
  /** Mặc định `<cwd>/.hahaness/hahaness.db` (hoặc HAHANESS_DB). */
  dbPath?: string
  port?: number
  host?: string
  /** Thư mục build UI (ui/dist). Không có → chỉ API (dùng Vite dev server + proxy). */
  uiDir?: string
  /** false → không tự chạy việc định kỳ (test). */
  scheduler?: boolean
  /** false → không tự làm tiếp việc dở lúc khởi động (test). */
  recover?: boolean
  /** false → không kết nối Telegram (test). */
  channels?: boolean
}

/**
 * Permission ask đang chờ CEO trả lời qua UI (chỉ trong bộ nhớ: restart thì lượt đang hỏi bị cắt
 * và `recover` chạy lại). Tool `question` không đi qua đây: nó kết thúc lượt, câu hỏi nằm trong
 * lịch sử chat (xem `docs/architecture/12-durable-work.md`).
 */
interface Pending {
  id: string
  sessionID: string
  kind: "permission"
  text: string
  options?: string[]
  resolve: (answer: string) => void
}

export async function startServer(opts: ServerOptions) {
  const bus = new SseBus()
  const pending = new Map<string, Pending>()

  const ask = (sessionID: string, kind: Pending["kind"], text: string, options?: string[]) =>
    new Promise<string>((resolve) => {
      const q: Pending = { id: id("q"), sessionID, kind, text, options, resolve }
      pending.set(q.id, q)
      bus.emit({ type: "question", id: q.id, sessionID, kind, text, options })
    })

  const app = await bootstrap({
    cwd: opts.cwd,
    dbPath: opts.dbPath,
    scheduler: opts.scheduler,
    recover: opts.recover,
    channels: opts.channels,
    onScheduleChange: (scheduleID) => bus.emit({ type: "schedule", id: scheduleID }),
    askHandler: async (req) => {
      const a = await ask(req.sessionID, "permission", `${req.agent} wants to ${req.action} ${req.resource}`, ["Allow", "Deny"])
      return a.toLowerCase().startsWith("d") ? { kind: "reject" } : { kind: "always" }
    },
    events: {
      onText: (sessionID, delta) => bus.emit({ type: "text", sessionID, delta }),
      onReasoning: (sessionID, delta) => bus.emit({ type: "reasoning", sessionID, delta }),
      onToolStart: (sessionID, name, args, callID) => bus.emit({ type: "tool-start", sessionID, name, args, callID }),
      onToolEnd: (sessionID, name, output, isError, callID) => bus.emit({ type: "tool-end", sessionID, name, output: output.slice(0, 4000), isError, callID }),
      onNotice: (sessionID, text) => bus.emit({ type: "notice", sessionID, text }),
      onUsage: (sessionID, usage) => bus.emit({ type: "usage", sessionID, usage }),
      onSession: (session) => bus.emit({ type: "session", session: sessionView(app, session) }),
      onTurnStart: (sessionID) => bus.emit({ type: "turn", sessionID, running: true }),
      onTurnEnd: (sessionID, outcome) => bus.emit({ type: "turn", sessionID, running: false, outcome: outcome.tag, error: outcome.tag === "failed" ? outcome.error.message : undefined }),
    },
  })

  const router = new Router()
  router.get("/api/health", () => ({ ok: true, db: app.db.path, providerError: app.providerError ?? null, clients: bus.size }))
  router.get("/api/events", (_req, res) => {
    bus.subscribe(res)
  })
  router.get("/api/questions", () => [...pending.values()].map(({ resolve: _r, ...q }) => q))
  router.post("/api/questions/:id", async (req) => {
    const q = pending.get(req.params.id!)
    if (!q) throw new HttpError(404, "question already answered")
    const body = await req.json<{ answer?: string }>()
    if (!body.answer?.trim()) throw new HttpError(400, "answer is required")
    pending.delete(q.id)
    q.resolve(body.answer)
    bus.emit({ type: "question-answered", id: q.id, sessionID: q.sessionID })
    return { ok: true }
  })
  chatRoutes(router, app)
  adminRoutes(router, app)
  scheduleRoutes(router, app)

  const uiDir = opts.uiDir ?? join(here, "..", "..", "ui", "dist")
  const hasUI = existsSync(join(uiDir, "index.html"))

  const server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
    if (hasUI && (await serveStatic(uiDir, url, res))) return
    json(res, 404, { error: hasUI ? "not found" : "UI not built. Run `npm run ui:build`, or `npm run ui` for the dev server." })
  })

  const port = opts.port ?? 7331
  const host = opts.host ?? "127.0.0.1"
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const close = () =>
    new Promise<void>((resolve) => {
      bus.closeAll()
      server.closeAllConnections?.()
      server.close(() => {
        app.close()
        resolve()
      })
    })
  return { app, server, url: `http://${host}:${port}`, hasUI, close }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url, hasUI, app } = await startServer({ cwd: process.cwd(), port: Number(process.env.PORT ?? 7331) })
  console.log(`Hahaness server: ${url}${hasUI ? "" : "  (API only — run \`npm run ui\` for the interface)"}`)
  console.log(`Company data: ${app.db.path}`)
  if (app.providerError) console.log(`Provider: ${app.providerError} — configure in Settings.`)
}
