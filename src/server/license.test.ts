import { test } from "node:test"
import assert from "node:assert/strict"
import { Db } from "../core/db.ts"
import { LicenseStore, keygen, parseLicense, privateKeyFrom, publicKeyFrom, signLicense } from "./license.ts"

const vendor = keygen()
const priv = privateKeyFrom(vendor.privateKeyPem)
const pub = publicKeyFrom(vendor.publicKey)
const inst = "11111111-2222-3333-4444-555555555555"
const sign = (over: Partial<Parameters<typeof signLicense>[0]> = {}) =>
  signLicense({ instance: inst, plan: "pro", customer: "Công ty A", issuedAt: "2026-11-09", expiresAt: "2027-11-09", ...over }, priv)

test("sign + parse round trip; tampering and a foreign key are rejected", () => {
  const key = sign()
  assert.match(key, /^HH1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const p = parseLicense(key, pub)
  assert.equal(p.instance, inst)
  assert.equal(p.plan, "pro")
  assert.equal(p.customer, "Công ty A")

  const [h, body, sig] = key.split(".") as [string, string, string]
  const forged = Buffer.from(JSON.stringify({ ...p, expiresAt: "2099-01-01" })).toString("base64url")
  assert.throws(() => parseLicense(`${h}.${forged}.${sig}`, pub), /Chữ ký/)
  assert.throws(() => parseLicense(`${h}.${body}.${sig}`, publicKeyFrom(keygen().publicKey)), /Chữ ký/)
  assert.throws(() => parseLicense("abc", pub), /định dạng/)
  assert.throws(() => parseLicense(`HH0.${body}.${sig}`, pub), /định dạng/)
})

test("LicenseStore: none → valid → expired; wrong instance refused and not saved", () => {
  const db = new Db(":memory:")
  let now = new Date("2026-12-01T00:00:00Z")
  const store = new LicenseStore({ db, instance: inst, publicKey: vendor.publicKey, now: () => now })
  assert.equal(store.status().state, "none")
  assert.equal(store.active(), false)

  const st = store.set(sign())
  assert.equal(st.state, "valid")
  assert.equal(st.daysLeft, 343)
  assert.equal(store.active(), true)
  assert.equal(db.getSetting<{ key: string }>("license")?.key, sign())

  now = new Date("2027-12-01T00:00:00Z")
  assert.equal(store.status().state, "expired")
  assert.ok(store.status().daysLeft! < 0)
  assert.equal(store.active(), false)

  assert.throws(() => store.set(sign({ instance: "other" })), /mã cài đặt khác/)
  assert.equal(db.getSetting<{ key: string }>("license")?.key, sign(), "previous key kept")
  assert.throws(() => store.set("HH1.x.y"), /Chữ ký|định dạng/)

  store.clear()
  assert.equal(store.status().state, "none")
  db.close()
})

test("LicenseStore: a key signed by someone else shows as invalid, never valid", () => {
  const db = new Db(":memory:")
  const other = keygen()
  const store = new LicenseStore({ db, instance: inst, publicKey: vendor.publicKey })
  const forged = signLicense({ instance: inst, plan: "pro", issuedAt: "2026-01-01", expiresAt: "2099-01-01" }, privateKeyFrom(other.privateKeyPem))
  assert.throws(() => store.set(forged), /Chữ ký/)
  db.setSetting("license", { key: forged })
  assert.equal(store.status().state, "invalid")
  assert.equal(store.active(), false)
  db.close()
})
