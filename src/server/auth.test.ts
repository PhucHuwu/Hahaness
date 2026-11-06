import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "./index.ts"
import type { Auth } from "./auth.ts"

let dir: string
let base: string
let auth: Auth
let close: () => Promise<void>

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hahaness-auth-"))
  const s = await startServer({ cwd: dir, dbPath: join(dir, "c.db"), port: 0, uiDir: join(dir, "no-ui"), scheduler: false, recover: false, channels: false })
  base = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`
  auth = s.auth
  close = s.close
})
after(async () => {
  await close()
  await rm(dir, { recursive: true, force: true })
})

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const cookie = res.headers.get("set-cookie")?.split(";")[0]
  return { status: res.status, data: (await res.json()) as any, cookie }
}

test("auth: API is closed until the CEO sets a password with the setup code, then needs the session cookie", async () => {
  assert.equal((await req("GET", "/api/staff")).status, 401)
  assert.equal((await req("GET", "/api/events")).status, 401, "SSE stream is protected too")
  const st = await req("GET", "/api/auth")
  assert.deepEqual([st.data.configured, st.data.authenticated, st.data.required], [false, false, true])

  assert.equal((await req("POST", "/api/auth/setup", { password: "longpassword", code: "wrong" })).status, 401)
  assert.equal((await req("POST", "/api/auth/setup", { password: "short", code: auth.setupCode })).status, 400)
  const ok = await req("POST", "/api/auth/setup", { password: "longpassword", code: auth.setupCode })
  assert.equal(ok.status, 200)
  assert.ok(ok.cookie?.startsWith("hh_session="))
  assert.equal((await req("POST", "/api/auth/setup", { password: "other-password", code: auth.setupCode })).status, 409, "setup works only once")

  const me = { cookie: ok.cookie! }
  assert.equal((await req("GET", "/api/staff", undefined, me)).status, 200)
  assert.equal((await req("GET", "/api/auth", undefined, me)).data.authenticated, true)
  // Request ghi từ trang khác bị chặn dù có cookie.
  assert.equal((await req("POST", "/api/auth/logout-others", {}, { ...me, origin: "https://evil.example" })).status, 403)
  assert.equal((await req("POST", "/api/auth/logout-others", {}, { ...me, origin: base })).status, 200)

  // Đăng nhập lại, đổi mật khẩu → thiết bị khác bị đăng xuất.
  const second = await req("POST", "/api/auth/login", { password: "longpassword" })
  assert.equal(second.status, 200)
  assert.equal((await req("POST", "/api/auth/password", { current: "nope", next: "new-password-1" }, me)).status, 401)
  assert.equal((await req("POST", "/api/auth/password", { current: "longpassword", next: "new-password-1" }, me)).status, 200)
  assert.equal((await req("GET", "/api/staff", undefined, { cookie: second.cookie! })).status, 401)
  assert.equal((await req("GET", "/api/staff", undefined, me)).status, 200)

  // Đăng xuất → cookie hết hiệu lực.
  await req("POST", "/api/auth/logout", {}, me)
  assert.equal((await req("GET", "/api/staff", undefined, me)).status, 401)
})

test("auth: repeated wrong passwords lock the address for a while", async () => {
  // Mọi lần sai (kể cả mã cài đặt, mật khẩu hiện tại ở test trước) đều tính → khoá sau tối đa 5 lần.
  const statuses: number[] = []
  for (let i = 0; i < 5; i++) statuses.push((await req("POST", "/api/auth/login", { password: `wrong-${i}` })).status)
  assert.ok(statuses.includes(401) && statuses.at(-1) === 429, statuses.join(","))
  const locked = await req("POST", "/api/auth/login", { password: "new-password-1" })
  assert.equal(locked.status, 429)
  assert.match(locked.data.error, /Thử lại sau/)
})
