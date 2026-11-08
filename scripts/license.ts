/**
 * Vendor-side licence tool. Never run on a customer machine; the private key stays with the vendor.
 *
 *   npx tsx scripts/license.ts keygen                      # prints public key (paste into VENDOR_PUBLIC_KEY) and private PEM
 *   npx tsx scripts/license.ts sign --instance <uuid> --plan pro --expires 2027-01-01 [--customer "Công ty A"]
 *       reads the private key from HAHANESS_LICENSE_KEY (PEM) or --key <path>
 *   npx tsx scripts/license.ts inspect <licence>           # decodes and verifies against the public key in the source
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { keygen, parseLicense, privateKeyFrom, publicKeyFrom, signLicense, VENDOR_PUBLIC_KEY } from "../src/server/license.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    instance: { type: "string" },
    plan: { type: "string", default: "pro" },
    customer: { type: "string" },
    expires: { type: "string" },
    key: { type: "string" },
  },
})
const cmd = positionals[0]

if (cmd === "keygen") {
  const k = keygen()
  console.log(`VENDOR_PUBLIC_KEY = "${k.publicKey}"\n`)
  console.log("Private key (keep secret, put in HAHANESS_LICENSE_KEY):")
  console.log(k.privateKeyPem)
} else if (cmd === "sign") {
  if (!values.instance || !values.expires) fail("sign needs --instance and --expires")
  if (Number.isNaN(Date.parse(values.expires))) fail("--expires must be a date, e.g. 2027-01-01")
  const pem = values.key ? readFileSync(values.key, "utf8") : process.env.HAHANESS_LICENSE_KEY
  if (!pem) fail("private key: set HAHANESS_LICENSE_KEY or pass --key <file>")
  const licence = signLicense(
    { instance: values.instance, plan: values.plan, customer: values.customer, issuedAt: new Date().toISOString().slice(0, 10), expiresAt: values.expires },
    privateKeyFrom(pem),
  )
  console.log(licence)
} else if (cmd === "inspect") {
  const licence = positionals[1]
  if (!licence) fail("inspect needs the licence string")
  console.log(JSON.stringify(parseLicense(licence, publicKeyFrom(VENDOR_PUBLIC_KEY)), null, 2))
} else {
  fail("usage: license.ts keygen | sign --instance <uuid> --plan <plan> --expires <date> [--customer <name>] | inspect <licence>")
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}
