import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Db } from "../core/db.ts"

/**
 * Đăng nhập cho giao diện web: một người (CEO), một mật khẩu.
 * - Mật khẩu băm bằng scrypt; phiên đăng nhập là token ngẫu nhiên trong cookie HttpOnly. DB chỉ giữ
 *   sha256 của token.
 * - Lần đầu (chưa có mật khẩu) phải nhập **mã cài đặt** in ra log server, để người lạ mở được trang
 *   trên VPS không đặt mật khẩu trước chủ.
 * - Sai mật khẩu quá nhiều lần từ một IP → khoá tạm.
 * Xem `docs/architecture/16-auth.md`.
 */

export const AUTH_KEY = "auth"
export const COOKIE = "hh_session"
const SESSION_DAYS = 30
const MAX_FAILS = 5
const LOCK_MS = 15 * 60_000
export const MIN_PASSWORD = 8

interface StoredSession {
  /** sha256(token) */
  id: string
  createdAt: number
  seenAt: number
  agent?: string
}

interface AuthSettings {
  salt: string
  hash: string
  sessions: StoredSession[]
}

export interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

export class Auth {
  /** Mã một lần để đặt mật khẩu lần đầu; tạo mới mỗi lần server khởi động. */
  readonly setupCode = randomBytes(4).toString("hex")
  private fails = new Map<string, { count: number; until: number }>()

  constructor(private db: Db) {}

  private get settings() {
    return this.db.getSetting<AuthSettings>(AUTH_KEY)
  }

  private save(s: AuthSettings) {
    this.db.setSetting(AUTH_KEY, s)
  }

  configured() {
    return !!this.settings
  }

  status(req: IncomingMessage): AuthStatus {
    return { configured: this.configured(), authenticated: !!this.session(req) }
  }

  /** Phiên hợp lệ của request (và gia hạn), hoặc undefined. */
  session(req: IncomingMessage): StoredSession | undefined {
    const token = cookie(req, COOKIE)
    const s = this.settings
    if (!token || !s) return undefined
    const id = sha(token)
    const now = Date.now()
    const found = s.sessions.find((x) => x.id === id && now - x.seenAt < SESSION_DAYS * 86_400_000)
    if (found && now - found.seenAt > 3_600_000) {
      found.seenAt = now
      this.save(s)
    }
    return found
  }

  /** Đặt mật khẩu lần đầu bằng mã cài đặt. */
  setup(req: IncomingMessage, res: ServerResponse, password: string, code: string) {
    if (this.configured()) throw new AuthError(409, "Đã có mật khẩu. Hãy đăng nhập.")
    this.throttle(req)
    if (!safeEqual(code.trim().toLowerCase(), this.setupCode)) {
      this.fail(req)
      throw new AuthError(401, "Mã cài đặt không đúng. Xem mã trong log của server (dòng \"Mã cài đặt\").")
    }
    checkPassword(password)
    this.save({ ...hashPassword(password), sessions: [] })
    this.login(req, res, password)
  }

  login(req: IncomingMessage, res: ServerResponse, password: string) {
    const s = this.settings
    if (!s) throw new AuthError(409, "Chưa đặt mật khẩu.")
    this.throttle(req)
    if (!verify(password, s)) {
      this.fail(req)
      throw new AuthError(401, "Sai mật khẩu.")
    }
    this.fails.delete(ip(req))
    const token = randomBytes(32).toString("base64url")
    const now = Date.now()
    const live = s.sessions.filter((x) => now - x.seenAt < SESSION_DAYS * 86_400_000).slice(-19)
    this.save({ ...s, sessions: [...live, { id: sha(token), createdAt: now, seenAt: now, agent: String(req.headers["user-agent"] ?? "").slice(0, 120) }] })
    setCookie(req, res, token, SESSION_DAYS * 86_400)
  }

  logout(req: IncomingMessage, res: ServerResponse) {
    const token = cookie(req, COOKIE)
    const s = this.settings
    if (token && s) this.save({ ...s, sessions: s.sessions.filter((x) => x.id !== sha(token)) })
    setCookie(req, res, "", 0)
  }

  /** Đổi mật khẩu: đăng xuất mọi thiết bị khác, giữ phiên hiện tại. */
  changePassword(req: IncomingMessage, current: string, next: string) {
    const s = this.settings
    if (!s) throw new AuthError(409, "Chưa đặt mật khẩu.")
    this.throttle(req)
    if (!verify(current, s)) {
      this.fail(req)
      throw new AuthError(401, "Mật khẩu hiện tại không đúng.")
    }
    checkPassword(next)
    const keep = this.session(req)
    this.save({ ...hashPassword(next), sessions: keep ? [keep] : [] })
  }

  /** Đăng xuất mọi thiết bị khác. */
  logoutOthers(req: IncomingMessage) {
    const s = this.settings
    const keep = this.session(req)
    if (s) this.save({ ...s, sessions: keep ? [keep] : [] })
  }

  sessionCount() {
    return this.settings?.sessions.length ?? 0
  }

  private throttle(req: IncomingMessage) {
    const f = this.fails.get(ip(req))
    if (f && f.until > Date.now()) throw new AuthError(429, `Sai quá nhiều lần. Thử lại sau ${Math.ceil((f.until - Date.now()) / 60_000)} phút.`)
  }

  private fail(req: IncomingMessage) {
    const key = ip(req)
    const f = this.fails.get(key) ?? { count: 0, until: 0 }
    f.count++
    if (f.count >= MAX_FAILS) {
      f.until = Date.now() + LOCK_MS
      f.count = 0
    }
    this.fails.set(key, f)
  }
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function checkPassword(p: string) {
  if (p.length < MIN_PASSWORD) throw new AuthError(400, `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`)
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") }
}

function verify(password: string, s: AuthSettings) {
  return timingSafeEqual(scryptSync(password, s.salt, 64), Buffer.from(s.hash, "hex"))
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(sha(a))
  const y = Buffer.from(sha(b))
  return timingSafeEqual(x, y)
}

function sha(s: string) {
  return createHash("sha256").update(s).digest("hex")
}

/** IP thật; sau reverse proxy trên cùng máy (nginx/caddy) thì lấy X-Forwarded-For. */
function ip(req: IncomingMessage) {
  const remote = req.socket.remoteAddress ?? ""
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim()
  return fwd && isLoopback(remote) ? fwd : remote
}

function isLoopback(a: string) {
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"
}

export function cookie(req: IncomingMessage, name: string) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number) {
  const secure = req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted
  res.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`)
}

/**
 * Chặn request ghi từ trang web khác (CSRF): cookie SameSite=Lax đã chặn phần lớn; thêm kiểm tra
 * Origin cho chắc khi trình duyệt có gửi header này.
 */
export function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers["x-forwarded-host"] ?? req.headers.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
