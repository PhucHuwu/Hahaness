import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { addTenant, parseTenantsFile, removeTenant, renderCaddy, renderCompose, url } from "./tenants.ts"

const base = parseTenantsFile({ domain: "hahaness.vn", image: "ghcr.io/phuchuwu/hahaness:stable" })

test("tenants: add/remove validate names and keep the file immutable", () => {
  const f = addTenant(base, "cong-ty-a", "Công ty A", new Date("2026-11-09T10:00:00Z"))
  assert.deepEqual(f.tenants["cong-ty-a"], { customer: "Công ty A", createdAt: "2026-11-09" })
  assert.deepEqual(base.tenants, {}, "input not mutated")
  assert.throws(() => addTenant(f, "cong-ty-a"), /already exists/)
  assert.throws(() => addTenant(f, "Bad Name"), /tenant name/)
  assert.throws(() => addTenant(f, "-x"), /tenant name/)
  assert.throws(() => removeTenant(f, "nope"), /does not exist/)
  assert.deepEqual(removeTenant(f, "cong-ty-a").tenants, {})
  assert.equal(url(f, "cong-ty-a"), "https://cong-ty-a.hahaness.vn")
  assert.equal(url({ ...f, domain: "localhost" }, "cong-ty-a"), "http://cong-ty-a.localhost")
})

test("tenants: compose and Caddyfile render one service, volume and site per tenant", () => {
  const f = addTenant(addTenant(base, "b"), "a", "A Co")
  const yml = renderCompose({ ...f, catalogUrl: "https://cdn.test/catalog.json" })
  assert.match(yml, /^services:\n  hahaness-a:\n    image: ghcr.io\/phuchuwu\/hahaness:stable/m)
  assert.match(yml, /- data-a:\/data/)
  assert.match(yml, /path: env\/a.env/)
  assert.match(yml, /HAHANESS_UPDATE_URL: "off"/)
  assert.match(yml, /HAHANESS_CATALOG_URL: "https:\/\/cdn.test\/catalog.json"/)
  assert.match(yml, /hahaness.customer: "A Co"/)
  assert.match(yml, /volumes:\n  data-a: \{\}\n  data-b: \{\}\n$/)
  assert.ok(yml.indexOf("hahaness-a:") < yml.indexOf("hahaness-b:"), "sorted")

  const caddy = renderCaddy(f)
  assert.doesNotMatch(caddy, /auto_https off/)
  assert.match(caddy, /^a\.hahaness\.vn \{\n  reverse_proxy hahaness-a:7331/m)
  assert.match(caddy, /^b\.hahaness\.vn \{/m)

  const dev = renderCaddy({ ...f, domain: "localhost" })
  assert.match(dev, /auto_https off/)
  assert.match(dev, /^http:\/\/a\.localhost \{/m)

  assert.match(renderCompose(base), /services:\n  \{\}\n/)
  assert.match(renderCaddy(base), /no tenants yet/)
})

test("managed/tenants.json in the repo is valid and empty", async () => {
  const f = parseTenantsFile(JSON.parse(await readFile(new URL("../../managed/tenants.json", import.meta.url), "utf8")))
  assert.deepEqual(f.tenants, {})
})
