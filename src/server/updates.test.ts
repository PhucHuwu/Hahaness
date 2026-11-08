import { test } from "node:test"
import assert from "node:assert/strict"
import { Db } from "../core/db.ts"
import { UpdateChecker, compareVersions, instanceID, parseRelease } from "./updates.ts"

test("compareVersions: numeric parts, v prefix, pre-release", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0)
  assert.equal(compareVersions("v0.2.0", "0.1.9"), 1)
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1)
  assert.equal(compareVersions("1.0", "1.0.0"), 0)
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1)
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1)
})

test("parseRelease: GitHub shape and own shape", () => {
  assert.deepEqual(parseRelease({ tag_name: "v0.2.0", html_url: "https://x/r", body: "notes" }), { version: "0.2.0", url: "https://x/r", notes: "notes" })
  assert.deepEqual(parseRelease({ version: "0.3.0" }), { version: "0.3.0", url: undefined, notes: undefined })
  assert.equal(parseRelease({}), null)
  assert.equal(parseRelease("x"), null)
})

test("instanceID: generated once and persisted", () => {
  const db = new Db(":memory:")
  const a = instanceID(db)
  assert.match(a, /^[0-9a-f-]{36}$/)
  assert.equal(instanceID(db), a)
  db.close()
})

test("UpdateChecker: sends channel/version/instance, flags newer release, tolerates errors", async () => {
  const seen: URL[] = []
  const fake = (async (input: URL | string | Request) => {
    const u = new URL(String(input))
    seen.push(u)
    if (u.searchParams.get("channel") === "beta") return new Response("nope", { status: 500 })
    return Response.json({ tag_name: "v0.2.0", html_url: "https://example.test/r/0.2.0" })
  }) as typeof fetch

  const c = new UpdateChecker({ current: "0.1.0", instance: "inst-1", url: "https://example.test/latest", fetch: fake })
  assert.equal(c.state.enabled, true)
  const s = await c.check()
  assert.equal(seen[0]!.searchParams.get("channel"), "stable")
  assert.equal(seen[0]!.searchParams.get("v"), "0.1.0")
  assert.equal(seen[0]!.searchParams.get("instance"), "inst-1")
  assert.equal(s.available, true)
  assert.equal(s.latest?.version, "0.2.0")
  assert.equal(s.error, null)
  assert.ok(s.checkedAt)

  const same = new UpdateChecker({ current: "0.2.0", instance: "inst-1", url: "https://example.test/latest", fetch: fake })
  assert.equal((await same.check()).available, false)

  const bad = new UpdateChecker({ current: "0.1.0", instance: "inst-1", url: "https://example.test/latest", channel: "beta", fetch: fake })
  const b = await bad.check()
  assert.equal(b.available, false)
  assert.equal(b.error, "HTTP 500")

  const off = new UpdateChecker({ current: "0.1.0", instance: "inst-1", url: "off", fetch: fake })
  assert.equal(off.state.enabled, false)
  await off.check()
  assert.equal(seen.length, 3, "disabled checker never fetches")
})
