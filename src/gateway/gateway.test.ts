import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Db } from "../core/db.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { McpManager } from "../mcp/manager.ts"
import { McpClient } from "../mcp/client.ts"
import { LicenseStore, keygen, privateKeyFrom, signLicense } from "../server/license.ts"
import { loadUpstreams, startGateway } from "./gateway.ts"

const vendor = keygen()
const priv = privateKeyFrom(vendor.privateKeyPem)
const inst = "11111111-2222-3333-4444-555555555555"
const lic = (over: Partial<Parameters<typeof signLicense>[0]> = {}) =>
  signLicense({ instance: inst, plan: "pro", issuedAt: "2026-01-01", expiresAt: "2027-01-01", ...over }, priv)

/** MCP http giả: đòi header x-api-key của nhà cung cấp, một tool `echo`. */
let upstream: Server
let upstreamUrl: string
const seen: Array<{ auth: string | undefined; apiKey: string | undefined }> = []
before(async () => {
  upstream = createServer(async (req, res) => {
    seen.push({ auth: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined })
    if (req.headers["x-api-key"] !== "vendor-secret") {
      res.writeHead(401, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: "bad upstream key" }))
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const msg = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
    }
    if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "paid-echo", version: "1" } })
    if (msg.method === "tools/list") return reply({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] })
    if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `echo: ${msg.params.arguments.text}` }] })
    res.writeHead(202)
    res.end()
  })
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
  const a = upstream.address() as { port: number }
  upstreamUrl = `http://127.0.0.1:${a.port}/mcp`
})
after(() => upstream.close())

test("loadUpstreams: ${ENV} in headers is substituted, missing env fails at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-gw-"))
  const file = join(dir, "upstreams.json")
  await writeFile(file, JSON.stringify({ upstreams: { exa: { url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "${EXA_KEY}" }, plans: ["pro"] } } }))
  try {
    assert.throws(() => loadUpstreams(file, {}), /needs env EXA_KEY/)
    const up = loadUpstreams(file, { EXA_KEY: "k1" })
    assert.equal(up.exa?.headers["x-api-key"], "k1")
    assert.deepEqual(up.exa?.plans, ["pro"])
    await writeFile(file, JSON.stringify({ upstreams: { "Bad Name": { url: "https://x.test" } } }))
    assert.throws(() => loadUpstreams(file, {}))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gateway: verifies the licence, forwards JSON-RPC with the vendor key, hides it from the customer", async () => {
  const logs: Array<{ instance: string; upstream: string; method: string; status: number }> = []
  const gw = await startGateway({
    upstreams: { echo: { url: upstreamUrl, headers: { "x-api-key": "vendor-secret" } }, vip: { url: upstreamUrl, headers: { "x-api-key": "vendor-secret" }, plans: ["enterprise"] } },
    publicKey: vendor.publicKey,
    port: 0,
    log: (e) => logs.push(e),
  })
  try {
    const call = (path: string, auth?: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) =>
      fetch(gw.url + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) })

    assert.equal((await fetch(gw.url + "/")).status, 200)
    assert.equal((await call("/mcp/echo")).status, 401)
    assert.match(((await (await call("/mcp/echo")).json()) as { error: string }).error, /Thiếu giấy phép/)
    assert.equal((await call("/mcp/echo", "HH1.x.y")).status, 401)
    assert.equal((await call("/mcp/echo", lic({ expiresAt: "2020-01-01" }))).status, 401)
    assert.match(((await (await call("/mcp/echo", lic({ expiresAt: "2020-01-01" }))).json()) as { error: string }).error, /hết hạn/)
    const other = keygen()
    assert.equal((await call("/mcp/echo", signLicense({ instance: inst, plan: "pro", issuedAt: "2026-01-01", expiresAt: "2099-01-01" }, privateKeyFrom(other.privateKeyPem)))).status, 401)
    assert.equal((await call("/mcp/nope", lic())).status, 404)
    assert.equal((await call("/mcp/vip", lic())).status, 403)
    assert.equal(seen.length, 0, "nothing reached the upstream without a valid licence")

    const ok = await call("/mcp/echo", lic())
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get("mcp-session-id"), "s1")
    const init = (await ok.json()) as { result: { serverInfo: { name: string } } }
    assert.equal(init.result.serverInfo.name, "paid-echo")
    assert.equal(seen[0]?.apiKey, "vendor-secret")
    assert.equal(seen[0]?.auth, undefined, "customer licence is not forwarded upstream")
    assert.deepEqual(logs.at(-1), { instance: inst, plan: "pro", upstream: "echo", method: "initialize", status: 200 })

    // Qua McpClient của instance: cấu hình http với header Bearer.
    const c = await McpClient.connect({ type: "http", url: `${gw.url}/mcp/echo`, headers: { Authorization: `Bearer ${lic()}` } })
    assert.deepEqual((await c.listTools()).map((t) => t.name), ["echo"])
    assert.equal((await c.callTool("echo", { text: "hi" })).content[0]?.text, "echo: hi")
    c.close()
  } finally {
    await gw.close()
  }
})

test("McpManager: {{license}} placeholder is filled at connect time and never stored; licence changes reconnect", async () => {
  const gw = await startGateway({ upstreams: { echo: { url: upstreamUrl, headers: { "x-api-key": "vendor-secret" } } }, publicKey: vendor.publicKey, port: 0, log: () => {} })
  const db = new Db(":memory:")
  const tools = new ToolRegistry()
  let now = new Date("2026-06-01T00:00:00Z")
  const license = new LicenseStore({ db, instance: inst, publicKey: vendor.publicKey, now: () => now })
  const mcp = new McpManager(db, tools, { license: () => (license.active() ? license.key() : undefined) })
  try {
    const cfg = { type: "http" as const, url: `${gw.url}/mcp/echo`, headers: { Authorization: "Bearer {{license}}" } }
    let st = await mcp.add("paid", cfg)
    assert.equal(st.state, "error")
    assert.match(st.error ?? "", /cần giấy phép/)
    assert.deepEqual(tools.names(), [])

    license.set(lic())
    assert.deepEqual(await mcp.reconnectUsing("license"), ["paid"])
    st = mcp.get("paid")!
    assert.equal(st.state, "connected", st.error)
    assert.deepEqual(tools.names(), ["paid_echo"])
    const row = db.sql.prepare("SELECT config FROM mcp_servers WHERE id = 'paid'").get() as { config: string }
    assert.ok(row.config.includes("{{license}}") && !row.config.includes("HH1."), "db keeps the placeholder, not the key")
    const view = mcp.get("paid")!.config
    assert.equal(view.type === "http" ? view.headers?.Authorization : undefined, "Bearer {{license}}", "status view keeps the placeholder")

    // Hết hạn phía instance: kết nối lại thất bại với lời nhắc, tool đã đăng ký bị gỡ.
    now = new Date("2027-06-01T00:00:00Z")
    await mcp.reconnectUsing("license")
    assert.equal(mcp.get("paid")!.state, "error")
    assert.match(mcp.get("paid")!.error ?? "", /giấy phép/)
    assert.deepEqual(tools.names(), [])
  } finally {
    mcp.closeAll()
    db.close()
    await gw.close()
  }
})
