import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "./index.ts"
import type { App } from "../bootstrap.ts"
import { Db } from "../core/db.ts"
import { saveConfig } from "../config.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
let dir: string
let base: string
let app: App
let close: () => Promise<void>

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hahaness-server-"))
  const dbPath = join(dir, "data", "company.db")
  const seed = new Db(dbPath)
  saveConfig(seed, { defaultModel: "scripted/any", providers: { scripted: { type: "custom", module: join(root, "examples", "providers", "scripted.ts") } } })
  seed.close()
  const s = await startServer({ cwd: dir, dbPath, port: 0, uiDir: join(dir, "no-ui") })
  base = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`
  app = s.app
  close = s.close
})
after(async () => {
  await close()
  await rm(dir, { recursive: true, force: true })
})

const staffRow = (id: string) => app.db.sql.prepare("SELECT fired FROM staff WHERE id = ?").get(id) as { fired: number } | undefined

const get = async <T>(p: string) => (await fetch(base + p)).json() as Promise<T>
const send = async <T>(method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
  return { status: res.status, data: (await res.json()) as T }
}

/** Đọc SSE cho tới khi predicate khớp (hoặc timeout). */
async function waitEvent(pred: (ev: any) => boolean, ms = 10_000): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(base + "/api/events", { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error("stream ended")
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = chunk.split("\n").find((l) => l.startsWith("data:"))?.slice(5)
        if (!data) continue
        const ev = JSON.parse(data)
        if (pred(ev)) return ev
      }
    }
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
}

test("health + config: providers come from the DB settings", async () => {
  const h = await get<{ ok: boolean; providerError: string | null; db: string }>("/api/health")
  assert.equal(h.ok, true)
  assert.equal(h.providerError, null)
  assert.equal(h.db, join(dir, "data", "company.db"))
  const c = await get<{ providers: string[]; defaultModel: string; config: { defaultModel?: string } }>("/api/config")
  assert.deepEqual(c.providers, ["scripted"])
  assert.equal(c.defaultModel, "scripted/any")
  assert.equal(c.config.defaultModel, "scripted/any")
  assert.deepEqual(app.db.getSetting<{ defaultModel: string }>("config")?.defaultModel, "scripted/any")
})

test("chat: create session, send message, stream text over SSE, transcript persisted", async () => {
  const { data: s } = await send<{ session: { id: string } }>("POST", "/api/sessions", { agent: "cto" })
  const done = waitEvent((ev) => ev.type === "turn" && ev.sessionID === s.session.id && ev.running === false)
  const { status } = await send("POST", `/api/sessions/${s.session.id}/messages`, { text: "hello" })
  assert.equal(status, 200)
  const turn = await done
  assert.equal(turn.outcome, "completed")
  const d = await get<{ messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>; running: boolean }>(`/api/sessions/${s.session.id}`)
  assert.equal(d.running, false)
  const assistant = d.messages.find((m) => m.role === "assistant")
  assert.equal(assistant?.parts.map((p) => p.text).join(""), "reply: hello")
  const list = await get<Array<{ session: { id: string } }>>("/api/sessions")
  assert.ok(list.some((x) => x.session.id === s.session.id))
})

test("staff: hire via API persists markdown, update and fire", async () => {
  const { status, data } = await send<{ id: string }>("POST", "/api/staff", { id: "SEO Guy", name: "SEO", description: "seo", system: "You do SEO.", capabilities: ["read", "websearch"] })
  assert.equal(status, 200)
  assert.equal(data.id, "seo-guy")
  assert.equal(staffRow("seo-guy")?.fired, 0)
  const md = await get<{ markdown: string }>("/api/staff/seo-guy/markdown")
  assert.match(md.markdown, /websearch, resource: "\*", effect: allow/)
  const upd = await send("PUT", "/api/staff/seo-guy", { markdown: md.markdown.replace("You do SEO.", "You do great SEO.") })
  assert.equal(upd.status, 200)
  const staff = await get<Array<{ id: string; system: string }>>("/api/staff")
  assert.equal(staff.find((s) => s.id === "seo-guy")?.system, "You do great SEO.")
  const primary = await send("DELETE", "/api/staff/cto")
  assert.equal(primary.status, 500)
  const fired = await send("DELETE", "/api/staff/seo-guy")
  assert.equal(fired.status, 200)
  assert.equal(staffRow("seo-guy")?.fired, 1)
})

test("knowledge: core files, knowledge/ CRUD, path jail", async () => {
  const put = await send("PUT", "/api/knowledge/file", { path: "knowledge/brand.md", content: "# Brand voice\nFriendly." })
  assert.equal(put.status, 200)
  await send("PUT", "/api/knowledge/file", { path: "knowledge/brand/logo.md", content: "# Logo\n> Màu và cách đặt logo\nĐỏ." })
  type Node = { id: string; title: string; summary: string; doc?: string; children: Node[] }
  const k = await get<{ core: Array<{ path: string }>; tree: Node[] }>("/api/knowledge")
  assert.ok(k.core.some((c) => c.path === "COMPANY.md"))
  assert.deepEqual(k.tree.map((n) => [n.id, n.title, n.doc]), [["knowledge/brand", "Brand voice", "knowledge/brand.md"]])
  assert.deepEqual(k.tree[0]!.children.map((n) => [n.id, n.summary]), [["knowledge/brand/logo", "Màu và cách đặt logo"]])
  const delNode = await fetch(base + "/api/knowledge/node?path=knowledge%2Fbrand%2Flogo", { method: "DELETE" })
  assert.equal(delNode.status, 200)
  assert.ok(!app.docs.has("knowledge/brand/logo.md"))
  const bad = await send("PUT", "/api/knowledge/file", { path: "../outside.md", content: "x" })
  assert.equal(bad.status, 400)
  const core = await send("PUT", "/api/knowledge/file", { path: "COMPANY.md", content: "# Acme\nWe sell anvils." })
  assert.equal(core.status, 200)
  const company = await get<{ content: string }>("/api/knowledge/file?path=COMPANY.md")
  assert.equal(company.content, "# Acme\nWe sell anvils.")
  assert.equal(app.docs.get("COMPANY.md")?.author, "ceo")
  const outside = await fetch(base + "/api/knowledge/file?path=drafts%2Fx.md")
  assert.equal(outside.status, 400)
  const del = await fetch(base + "/api/knowledge/file?path=knowledge%2Fbrand.md", { method: "DELETE" })
  assert.equal(del.status, 200)
  const noCoreDelete = await fetch(base + "/api/knowledge/file?path=COMPANY.md", { method: "DELETE" })
  assert.equal(noCoreDelete.status, 400)
})

test("skills: CRUD and index appears in a new session's system prompt", async () => {
  const tpl = await get<{ content: string }>("/api/skills-template/weekly-report")
  assert.match(tpl.content, /name: weekly-report/)
  const put = await send<{ id: string }>("PUT", "/api/skills/Weekly Report", { content: tpl.content.replace("When to use this skill, in one sentence.", "Use when the CEO asks for a weekly summary.") })
  assert.equal(put.data.id, "weekly-report")
  const list = await get<Array<{ id: string; description: string }>>("/api/skills")
  assert.equal(list[0]?.description, "Use when the CEO asks for a weekly summary.")
  const { data: s } = await send<{ session: { id: string } }>("POST", "/api/sessions", { agent: "cto" })
  const done = waitEvent((ev) => ev.type === "turn" && ev.sessionID === s.session.id && ev.running === false)
  await send("POST", `/api/sessions/${s.session.id}/messages`, { text: "ping" })
  await done
  const del = await fetch(base + "/api/skills/weekly-report", { method: "DELETE" })
  assert.equal(del.status, 200)
  assert.deepEqual(await get("/api/skills"), [])
})

test("mcp: add stdio server, tools registered as <server>_<tool>, model can call it, disable removes it", async () => {
  const { status, data } = await send<{ state: string; tools: Array<{ toolName: string }>; error?: string }>("POST", "/api/mcp", {
    id: "echo-test",
    config: { type: "stdio", command: "npx", args: ["tsx", join(root, "examples", "mcp", "echo-server.ts")] },
  })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(data.state, "connected", data.error)
  assert.deepEqual(data.tools.map((t) => t.toolName), ["echo-test_echo"])

  const { data: s } = await send<{ session: { id: string } }>("POST", "/api/sessions", { agent: "cto" })
  const done = waitEvent((ev) => ev.type === "turn" && ev.sessionID === s.session.id && ev.running === false)
  await send("POST", `/api/sessions/${s.session.id}/messages`, { text: "use the mcp tool" })
  await done
  const d = await get<{ messages: Array<{ parts: Array<{ type: string; name?: string; output?: string; text?: string }> }> }>(`/api/sessions/${s.session.id}`)
  const result = d.messages.flatMap((m) => m.parts).find((p) => p.type === "tool-result")
  assert.equal(result?.name, "echo-test_echo")
  assert.equal(result?.output, "echo: hi")
  const final = d.messages.at(-1)!.parts.map((p) => p.text ?? "").join("")
  assert.equal(final, "tool said: echo: hi")

  const off = await send<{ state: string; tools: unknown[] }>("POST", "/api/mcp/echo-test/enabled", { enabled: false })
  assert.equal(off.data.state, "disabled")
  assert.equal(off.data.tools.length, 0)
  assert.equal(app.mcp.saved("echo-test")?.enabled, false)
  const row = app.db.sql.prepare("SELECT config FROM mcp_servers WHERE id = ?").get("echo-test") as { config: string }
  assert.equal(JSON.parse(row.config).enabled, false)
  const rm = await fetch(base + "/api/mcp/echo-test", { method: "DELETE" })
  assert.equal(rm.status, 200)
  assert.deepEqual(await get("/api/mcp"), [])
  assert.equal(app.db.sql.prepare("SELECT 1 FROM mcp_servers WHERE id = ?").get("echo-test"), undefined)
})

test("results: deliverables and drafts are listed, viewed, downloaded and deleted", async () => {
  app.docs.put("deliverables/Kế hoạch Q1.md", "# Kế hoạch Q1\nBa mục tiêu.", "cto")
  app.docs.put("drafts/post.md", "# Post\nDraft.", "writer")
  app.docs.put("knowledge/secret.md", "x")
  const list = await get<{ deliverables: Array<{ path: string; title: string; author: string }>; drafts: Array<{ path: string }> }>("/api/results")
  assert.deepEqual(list.deliverables.map((d) => [d.path, d.title, d.author]), [["deliverables/Kế hoạch Q1.md", "Kế hoạch Q1", "cto"]])
  assert.deepEqual(list.drafts.map((d) => d.path), ["drafts/post.md"])
  const q = encodeURIComponent("deliverables/Kế hoạch Q1.md")
  const file = await get<{ content: string }>(`/api/results/file?path=${q}`)
  assert.match(file.content, /Ba mục tiêu/)
  const dl = await fetch(base + `/api/results/download?path=${q}`)
  assert.equal(dl.status, 200)
  assert.match(dl.headers.get("content-type")!, /text\/markdown/)
  assert.match(dl.headers.get("content-disposition")!, /attachment; filename=".*\.md"; filename\*=UTF-8''K%E1%BA%BF/)
  assert.equal(await dl.text(), "# Kế hoạch Q1\nBa mục tiêu.")
  assert.equal((await fetch(base + "/api/results/file?path=knowledge%2Fsecret.md")).status, 400)
  assert.equal((await fetch(base + "/api/results/download?path=deliverables%2Fnope.md")).status, 404)
  assert.equal((await fetch(base + `/api/results/file?path=${q}`, { method: "DELETE" })).status, 200)
  assert.equal(app.docs.has("deliverables/Kế hoạch Q1.md"), false)
})

test("employee chat + conversations: CEO chats with an employee directly; direct task shows brief and report in the timeline", async () => {
  const { status, data: emp } = await send<{ session: { id: string; agent: string; parentID?: string } }>("POST", "/api/sessions", { agent: "writer" })
  assert.equal(status, 200)
  assert.equal(emp.session.agent, "writer")
  assert.equal(emp.session.parentID, undefined)
  const live = app.harness.get(emp.session.id)
  assert.ok(!app.tools.snapshot(live.ruleset).tools.some((t) => t.name === "delegate" || t.name === "hire"))
  const empDone = waitEvent((ev) => ev.type === "turn" && ev.sessionID === emp.session.id && ev.running === false)
  await send("POST", `/api/sessions/${emp.session.id}/messages`, { text: "chào" })
  await empDone
  const bad = await send("POST", `/api/sessions/${emp.session.id}/direct`, { agent: "writer", task: "x" })
  assert.equal(bad.status, 400)

  const { data: cto } = await send<{ session: { id: string } }>("POST", "/api/sessions", { agent: "cto" })
  const childDone = waitEvent((ev) => ev.type === "turn" && ev.running === false && ev.sessionID !== cto.session.id && ev.sessionID !== emp.session.id)
  const d = await send<{ sessionID: string }>("POST", `/api/sessions/${cto.session.id}/direct`, { agent: "writer", task: "viết tiêu đề" })
  await childDone
  const items = await get<Array<{ kind: string; from: string; to: string; sessionID: string; text: string }>>(`/api/conversations?root=${cto.session.id}`)
  assert.deepEqual(items.map((i) => [i.kind, i.from, i.to]), [["brief", "ceo", "writer"], ["report", "writer", "cto"]])
  assert.equal(items[0]!.sessionID, d.data.sessionID)
  assert.match(items[0]!.text, /^viết tiêu đề/)
})

test("schedules: create, validate, run now (CTO session opens and finishes), pause, delete", async () => {
  const bad = await send<{ error: string }>("POST", "/api/schedules", { title: "x", agent: "researcher", cron: "every night", task: { goal: "g" } })
  assert.equal(bad.status, 400)
  assert.match(bad.data.error, /5 fields/)
  assert.equal((await send("POST", "/api/schedules", { title: "x", agent: "nobody", cron: "0 2 * * *", task: { goal: "g" } })).status, 400)

  const { status, data: s } = await send<{ id: string; enabled: boolean; upcoming: number[]; nextRunAt: number }>("POST", "/api/schedules", { title: "Đọc tin", agent: "researcher", cron: "0 2 * * *", task: { goal: "đọc tin thị trường" } })
  assert.equal(status, 200)
  assert.equal(s.upcoming.length, 3)
  assert.equal(new Date(s.nextRunAt).getHours(), 2)
  const list = await get<{ timezone: string; schedules: Array<{ id: string }> }>("/api/schedules")
  assert.ok(list.timezone)
  assert.ok(list.schedules.some((x) => x.id === s.id))

  const run = await send<{ sessionID: string; status: string }>("POST", `/api/schedules/${s.id}/run`)
  assert.equal(run.status, 200)
  assert.equal(run.data.status, "running")
  await app.scheduler.idle()
  const detail = await get<{ schedule: { lastStatus: string; lastSessionID: string }; runs: Array<{ status: string; reason: string }> }>(`/api/schedules/${s.id}`)
  assert.equal(detail.schedule.lastStatus, "completed")
  assert.equal(detail.schedule.lastSessionID, run.data.sessionID)
  assert.deepEqual(detail.runs.map((r) => [r.reason, r.status]), [["manual", "completed"]])
  const sessions = await get<Array<{ session: { id: string; agent: string; parentID?: string } }>>("/api/sessions")
  assert.ok(sessions.some((x) => x.session.id === run.data.sessionID && x.session.agent === "cto" && !x.session.parentID))

  const paused = await send<{ enabled: boolean; nextRunAt?: number }>("PUT", `/api/schedules/${s.id}`, { enabled: false })
  assert.equal(paused.data.enabled, false)
  assert.equal(paused.data.nextRunAt, undefined)
  assert.equal((await send("DELETE", `/api/schedules/${s.id}`)).status, 200)
  assert.equal((await fetch(`${base}/api/schedules/${s.id}`)).status, 404)
})
