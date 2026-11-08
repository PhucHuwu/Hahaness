import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CatalogSchema, Marketplace } from "./marketplace.ts"
import type { McpManager } from "../mcp/manager.ts"

const item = (id: string) => ({ id, kind: "mcp", title: id, config: { type: "http", url: `https://${id}.test/mcp` } })

/** McpManager giả: chỉ cần get/add. */
function fakeMcp() {
  const servers = new Map<string, unknown>()
  return {
    added: servers,
    get: (id: string) => (servers.has(id) ? { state: "connected" } : undefined),
    add: async (id: string, cfg: unknown) => (servers.set(id, cfg), { id, config: cfg, state: "connected", tools: [] }),
  } as unknown as McpManager & { added: Map<string, unknown> }
}

test("catalog schema: ids are slugs, only mcp kind, config must be http or stdio", () => {
  assert.ok(CatalogSchema.safeParse({ version: 1, items: [item("ok-1")] }).success)
  assert.equal(CatalogSchema.safeParse({ version: 1, items: [item("Bad Id")] }).success, false)
  assert.equal(CatalogSchema.safeParse({ version: 2, items: [] }).success, false)
  assert.equal(CatalogSchema.safeParse({ version: 1, items: [{ ...item("x"), kind: "skill" }] }).success, false)
})

test("bundled catalog.json in the repo is valid", async () => {
  const { readFile } = await import("node:fs/promises")
  const raw = JSON.parse(await readFile(new URL("../../catalog.json", import.meta.url), "utf8"))
  const c = CatalogSchema.parse(raw)
  assert.ok(c.items.length > 0)
  assert.ok(c.items.every((i) => i.config.type === "http"), "demo catalog only lists hosted MCP servers")
  assert.equal(new Set(c.items.map((i) => i.id)).size, c.items.length, "ids are unique")
})

test("Marketplace: remote wins, falls back to bundled on error, install goes through McpManager", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-market-"))
  const bundled = join(dir, "catalog.json")
  await writeFile(bundled, JSON.stringify({ version: 1, items: [item("bundled-one")] }))
  try {
    let remoteOk = true
    const fake = (async () => (remoteOk ? Response.json({ version: 1, updatedAt: "2026-02-02", items: [item("remote-one")] }) : new Response("x", { status: 503 }))) as typeof fetch

    const mcp = fakeMcp()
    const m = new Marketplace({ mcp, bundledPath: bundled, url: "https://cdn.test/catalog.json", fetch: fake })
    let v = await m.view()
    assert.equal(v.source, "remote")
    assert.deepEqual(v.items.map((i) => [i.id, i.installed]), [["remote-one", false]])
    assert.equal(v.updatedAt, "2026-02-02")

    const st = await m.install("remote-one")
    assert.equal(st.state, "connected")
    assert.deepEqual(mcp.added.get("remote-one"), { type: "http", url: "https://remote-one.test/mcp" })
    v = await m.view()
    assert.deepEqual(v.items.map((i) => [i.id, i.installed, i.state]), [["remote-one", true, "connected"]])
    await assert.rejects(m.install("nope"), /không có mục/)

    remoteOk = false
    v = await m.view(true)
    assert.equal(v.error, "HTTP 503")
    assert.equal(v.items[0]?.id, "remote-one", "keeps the last good remote catalog")

    const fresh = new Marketplace({ mcp: fakeMcp(), bundledPath: bundled, url: "https://cdn.test/catalog.json", fetch: fake })
    v = await fresh.view()
    assert.equal(v.source, "bundled")
    assert.equal(v.error, "HTTP 503")
    assert.deepEqual(v.items.map((i) => i.id), ["bundled-one"])

    const off = new Marketplace({ mcp: fakeMcp(), bundledPath: bundled, url: "off", fetch: fake })
    v = await off.view()
    assert.equal(v.source, "off")
    assert.equal(v.error, null)
    assert.equal(v.licensed, false)
    assert.deepEqual(v.items.map((i) => i.id), ["bundled-one"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Marketplace: requiresLicense items install only while licensed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-market-"))
  const bundled = join(dir, "catalog.json")
  await writeFile(bundled, JSON.stringify({ version: 1, items: [item("free"), { ...item("paid"), requiresLicense: true }] }))
  try {
    let licensed = false
    const mcp = fakeMcp()
    const m = new Marketplace({ mcp, bundledPath: bundled, url: "off", licensed: () => licensed })
    assert.equal((await m.view()).items.find((i) => i.id === "paid")?.requiresLicense, true)
    await m.install("free")
    await assert.rejects(m.install("paid"), /giấy phép/)
    licensed = true
    assert.equal((await m.view()).licensed, true)
    await m.install("paid")
    assert.ok(mcp.added.has("paid"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
