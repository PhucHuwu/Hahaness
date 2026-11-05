import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "./index.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
let dir: string
let base: string
let close: () => void

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hahaness-server-"))
  await writeFile(
    join(dir, "hahaness.json"),
    JSON.stringify({ defaultModel: "scripted/any", providers: { scripted: { type: "custom", module: join(root, "examples", "providers", "scripted.ts") } } }),
  )
  const s = await startServer({ cwd: dir, port: 0, uiDir: join(dir, "no-ui") })
  base = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`
  close = s.close
})
after(async () => {
  close()
  await rm(dir, { recursive: true, force: true })
})

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

test("health + config via custom provider from hahaness.json", async () => {
  const h = await get<{ ok: boolean; providerError: string | null }>("/api/health")
  assert.equal(h.ok, true)
  assert.equal(h.providerError, null)
  const c = await get<{ providers: string[]; defaultModel: string }>("/api/config")
  assert.deepEqual(c.providers, ["scripted"])
  assert.equal(c.defaultModel, "scripted/any")
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
  assert.ok(existsSync(join(dir, "staff", "seo-guy.md")))
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
  assert.ok(!existsSync(join(dir, "staff", "seo-guy.md")))
})

test("knowledge: core files, knowledge/ CRUD, path jail", async () => {
  const put = await send("PUT", "/api/knowledge/file", { path: "knowledge/brand.md", content: "# Brand voice\nFriendly." })
  assert.equal(put.status, 200)
  const k = await get<{ core: Array<{ path: string }>; files: Array<{ path: string; title: string }> }>("/api/knowledge")
  assert.ok(k.core.some((c) => c.path === "COMPANY.md"))
  assert.deepEqual(k.files.map((f) => [f.path, f.title]), [["knowledge/brand.md", "Brand voice"]])
  const bad = await send("PUT", "/api/knowledge/file", { path: "../outside.md", content: "x" })
  assert.equal(bad.status, 400)
  const core = await send("PUT", "/api/knowledge/file", { path: "COMPANY.md", content: "# Acme\nWe sell anvils." })
  assert.equal(core.status, 200)
  assert.equal(await readFile(join(dir, "COMPANY.md"), "utf8"), "# Acme\nWe sell anvils.")
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
  const saved = JSON.parse(await readFile(join(dir, ".hahaness", "mcp.json"), "utf8"))
  assert.equal(saved.servers["echo-test"].enabled, false)
  const rm = await fetch(base + "/api/mcp/echo-test", { method: "DELETE" })
  assert.equal(rm.status, 200)
  assert.deepEqual(await get("/api/mcp"), [])
})
