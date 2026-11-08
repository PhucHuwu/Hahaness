import { createServer } from "node:http"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync } from "node:fs"
import { bootstrap } from "../bootstrap.ts"
import { id } from "../core/id.ts"
import { Router, SseBus, json, serveStatic, HttpError } from "./http.ts"
import { chatRoutes, sessionView } from "./routes-chat.ts"
import { adminRoutes } from "./routes-admin.ts"
import { scheduleRoutes } from "./routes-schedule.ts"
import { Auth, AuthError, MIN_PASSWORD, sameOrigin } from "./auth.ts"
import { UpdateChecker } from "./updates.ts"
import { Marketplace } from "./marketplace.ts"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "..")
export const VERSION: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version

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
  /** false → không cần đăng nhập (test). Mặc định bật. */
  auth?: boolean
  /** false → không tự kiểm tra bản mới (test). Mặc định bật; HAHANESS_UPDATE_URL=off cũng tắt. */
  updates?: boolean
  /** URL catalog chợ ứng dụng; mặc định HAHANESS_CATALOG_URL. `off` → chỉ dùng catalog.json đóng gói (test). */
  catalogUrl?: string
  /** Khoá công khai kiểm giấy phép (base64 SPKI); mặc định khoá của nhà cung cấp (test dùng khoá riêng). */
  licensePublicKey?: string
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
    licensePublicKey: opts.licensePublicKey,
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

  const auth = new Auth(app.db)
  const authOn = opts.auth !== false
  const { instance, license } = app
  const updates = new UpdateChecker({ current: VERSION, instance, url: process.env.HAHANESS_UPDATE_URL, channel: process.env.HAHANESS_UPDATE_CHANNEL })
  if (opts.updates !== false) updates.start()
  const market = new Marketplace({ mcp: app.mcp, bundledPath: join(root, "catalog.json"), url: opts.catalogUrl ?? process.env.HAHANESS_CATALOG_URL, licensed: () => license.active() })
  const router = new Router()
  const wrap = (fn: () => unknown) => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof AuthError) throw new HttpError(e.status, e.message)
      throw e
    }
  }
  router.get("/api/auth", (req) => ({ ...auth.status(req.raw), required: authOn, minPassword: MIN_PASSWORD }))
  router.post("/api/auth/setup", async (req, res) => {
    const b = await req.json<{ password?: string; code?: string }>()
    wrap(() => auth.setup(req.raw, res, b.password ?? "", b.code ?? ""))
    return { ok: true }
  })
  router.post("/api/auth/login", async (req, res) => {
    const b = await req.json<{ password?: string }>()
    wrap(() => auth.login(req.raw, res, b.password ?? ""))
    return { ok: true }
  })
  router.post("/api/auth/logout", (req, res) => {
    auth.logout(req.raw, res)
    return { ok: true }
  })
  router.post("/api/auth/password", async (req) => {
    const b = await req.json<{ current?: string; next?: string }>()
    wrap(() => auth.changePassword(req.raw, b.current ?? "", b.next ?? ""))
    return { ok: true }
  })
  router.post("/api/auth/logout-others", (req) => {
    auth.logoutOthers(req.raw)
    return { ok: true, sessions: auth.sessionCount() }
  })
  router.get("/api/health", () => ({ ok: true, version: VERSION, instance, db: app.db.path, providerError: app.providerError ?? null, clients: bus.size }))
  router.get("/api/updates", () => updates.state)
  router.post("/api/updates/check", () => updates.check())
  router.get("/api/license", () => ({ instance, ...license.status() }))
  router.put("/api/license", async (req) => {
    const b = await req.json<{ key?: string }>()
    if (!b.key?.trim()) throw new HttpError(400, "Cần mã giấy phép.")
    let st
    try {
      st = license.set(b.key)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    // Server qua gateway của nhà cung cấp xác thực bằng giấy phép → nối lại với key mới.
    await app.mcp.reconnectUsing("license")
    return { instance, ...st }
  })
  router.delete("/api/license", async () => {
    license.clear()
    await app.mcp.reconnectUsing("license")
    return { instance, ...license.status() }
  })
  router.get("/api/marketplace", () => market.view())
  router.post("/api/marketplace/refresh", () => market.view(true))
  router.post("/api/marketplace/:id/install", async (req) => {
    try {
      return await market.install(req.params.id!)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
  })
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

  const uiDir = opts.uiDir ?? join(root, "ui", "dist")
  const hasUI = existsSync(join(uiDir, "index.html"))

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname.startsWith("/api/")) {
      // Request ghi từ trang khác (CSRF) bị chặn kể cả khi đã đăng nhập.
      if (req.method !== "GET" && !sameOrigin(req)) return json(res, 403, { error: "cross-origin request blocked" })
      if (authOn && !url.pathname.startsWith("/api/auth") && !auth.session(req)) {
        return json(res, 401, { error: auth.configured() ? "Cần đăng nhập." : "Chưa đặt mật khẩu." })
      }
    }
    if (await router.handle(req, res)) return
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
    if (hasUI && (await serveStatic(uiDir, url, res))) return
    json(res, 404, { error: hasUI ? "not found" : "UI not built. Run `npm run ui:build`, or `npm run ui` for the dev server." })
  })

  const port = opts.port ?? 7331
  const host = opts.host ?? "127.0.0.1"
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const close = () =>
    new Promise<void>((resolve) => {
      updates.stop()
      bus.closeAll()
      server.closeAllConnections?.()
      server.close(() => {
        app.close()
        resolve()
      })
    })
  return { app, server, auth, updates, url: `http://${host}:${port}`, hasUI, close }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { url, hasUI, app, auth } = await startServer({ cwd: process.cwd(), port: Number(process.env.PORT ?? 7331), host: process.env.HOST })
  console.log(`Hahaness ${VERSION}: ${url}${hasUI ? "" : "  (API only — run \`npm run ui\` for the interface)"}`)
  console.log(`Company data: ${app.db.path}`)
  logSetup(auth)
  if (app.providerError) console.log(`Provider: ${app.providerError} — configure in Settings.`)
}

/** Chưa có mật khẩu → in mã cài đặt (chỉ ai xem được log server mới đặt được mật khẩu). */
export function logSetup(auth: Auth) {
  if (auth.configured()) return
  console.log(`\nChưa có mật khẩu. Mở trang web và đặt mật khẩu với Mã cài đặt: ${auth.setupCode}\n`)
}
