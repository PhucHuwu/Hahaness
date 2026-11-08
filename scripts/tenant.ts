/**
 * Vendor-side tenant tool for the managed tier (docs/architecture/23-managed.md). Runs in managed/.
 *
 *   npx tsx scripts/tenant.ts add <name> [--customer "Công ty A"]   # new container + volume + site, prints URL and setup code
 *   npx tsx scripts/tenant.ts list
 *   npx tsx scripts/tenant.ts backup <name> [--out <dir>]            # stops the tenant, archives /data, starts it again
 *   npx tsx scripts/tenant.ts remove <name> [--purge]                # stops and removes; --purge also deletes the volume
 *   npx tsx scripts/tenant.ts upgrade [<name>]                       # pull image and recreate (all tenants by default)
 *   npx tsx scripts/tenant.ts render                                 # regenerate tenants.yml and Caddyfile only
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { addTenant, parseTenantsFile, removeTenant, renderCaddy, renderCompose, service, url, volume, type TenantsFile } from "../src/managed/tenants.ts"

const dir = process.env.HAHANESS_MANAGED_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "managed")
const file = join(dir, "tenants.json")

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { customer: { type: "string" }, out: { type: "string" }, purge: { type: "boolean", default: false } },
})
const [cmd, name] = positionals

const load = (): TenantsFile => parseTenantsFile(JSON.parse(readFileSync(file, "utf8")))
const save = (f: TenantsFile) => {
  writeFileSync(file, JSON.stringify(f, null, 2) + "\n")
  render(f)
}
const render = (f: TenantsFile) => {
  writeFileSync(join(dir, "tenants.yml"), renderCompose(f))
  writeFileSync(join(dir, "Caddyfile"), renderCaddy(f))
  mkdirSync(join(dir, "env"), { recursive: true })
}
const compose = (...args: string[]) => {
  const r = spawnSync("docker", ["compose", ...args], { cwd: dir, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: process.platform === "win32" })
  if (r.status !== 0) fail(`docker compose ${args.join(" ")} failed`)
  return r.stdout
}
const composeProject = () => {
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" })
  return (JSON.parse(r.stdout || "{}") as { name?: string }).name ?? "managed"
}

if (cmd === "add") {
  if (!name) fail("add needs a name")
  const f = addTenant(load(), name, values.customer)
  save(f)
  compose("up", "-d", "--remove-orphans")
  const code = waitForSetupCode(name)
  console.log(`${name}: ${url(f, name)}`)
  console.log(code ? `Mã cài đặt: ${code}` : `(setup code not printed yet: docker compose -f managed/docker-compose.yml logs ${service(name)})`)
} else if (cmd === "list") {
  const f = load()
  const names = Object.keys(f.tenants).sort()
  if (names.length === 0) console.log("no tenants")
  for (const n of names) console.log(`${n.padEnd(20)} ${url(f, n).padEnd(44)} ${f.tenants[n]!.customer ?? ""} (${f.tenants[n]!.createdAt})`)
} else if (cmd === "backup") {
  if (!name) fail("backup needs a name")
  const f = load()
  if (!f.tenants[name]) fail(`unknown tenant ${name}`)
  const out = resolve(values.out ?? join(dir, "backups"))
  mkdirSync(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)
  const archive = `${name}-${stamp}.tgz`
  const vol = `${composeProject()}_${volume(name)}`
  compose("stop", service(name))
  const r = spawnSync("docker", ["run", "--rm", "-v", `${vol}:/data:ro`, "-v", `${out}:/out`, "alpine", "tar", "czf", `/out/${archive}`, "-C", "/data", "."], { stdio: "inherit", shell: process.platform === "win32" })
  compose("start", service(name))
  if (r.status !== 0) fail("backup failed")
  console.log(join(out, archive))
} else if (cmd === "remove") {
  if (!name) fail("remove needs a name")
  const f = load()
  if (!f.tenants[name]) fail(`unknown tenant ${name}`)
  const vol = `${composeProject()}_${volume(name)}`
  compose("rm", "-sf", service(name))
  save(removeTenant(f, name))
  compose("up", "-d", "--remove-orphans")
  if (values.purge) spawnSync("docker", ["volume", "rm", vol], { stdio: "inherit", shell: process.platform === "win32" })
  console.log(values.purge ? `${name} removed, volume ${vol} deleted` : `${name} removed; volume ${vol} kept (docker volume rm ${vol} to delete)`)
} else if (cmd === "upgrade") {
  const f = load()
  const targets = name ? [service(name)] : Object.keys(f.tenants).map(service)
  if (name && !f.tenants[name]) fail(`unknown tenant ${name}`)
  render(f)
  compose("pull", ...targets)
  compose("up", "-d", ...targets)
  console.log(`upgraded ${targets.length} tenant(s) to ${f.image}`)
} else if (cmd === "render") {
  render(load())
  console.log("tenants.yml and Caddyfile written")
} else {
  fail("usage: tenant.ts add <name> [--customer <n>] | list | backup <name> [--out <dir>] | remove <name> [--purge] | upgrade [<name>] | render")
}

/** Setup code appears in the container log within a few seconds of the first start. */
function waitForSetupCode(n: string): string | undefined {
  for (let i = 0; i < 20; i++) {
    const log = spawnSync("docker", ["compose", "logs", "--no-log-prefix", service(n)], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" }).stdout ?? ""
    const m = /Mã cài đặt: ([0-9a-f]{8})/.exec(log)
    if (m) return m[1]
    if (/Hahaness \S+: http/.test(log)) return undefined
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return undefined
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}
