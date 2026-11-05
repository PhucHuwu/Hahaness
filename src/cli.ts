import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { bootstrap } from "./bootstrap.ts"

const rl = createInterface({ input: stdin, output: stdout })
let mainID = ""

const app = await bootstrap({
  cwd: process.cwd(),
  questionHandler: async (q, options) => {
    const opts = options?.length ? `\n  ${options.map((o, i) => `${i + 1}. ${o}`).join("\n  ")}` : ""
    return rl.question(`\n? ${q}${opts}\n> `)
  },
  askHandler: async (req) => {
    const a = (await rl.question(`\n[permission] ${req.agent} wants to ${req.action} ${req.resource}. Allow? (y/n): `)).trim().toLowerCase()
    return a === "n" ? { kind: "reject" } : { kind: "always" }
  },
  events: {
    onText: (s, d) => s === mainID && stdout.write(d),
    onToolStart: (s, name, args) => console.log(`\n  ${label(s)} -> ${name} ${brief(args)}`),
    onToolEnd: (s, name, out, err) => err && console.log(`  ! ${label(s)} ${name}: ${out.split("\n")[0]?.slice(0, 120)}`),
    onNotice: (s, t) => console.log(`\n  i ${label(s)}: ${t}`),
  },
})
const { harness, agents } = app

if (app.providerError) {
  console.error(app.providerError)
  console.error("See docs/architecture/06-providers.md for hahaness.json format, or run `npm run ui` to configure in the browser.")
  process.exit(1)
}

const main = await harness.createSession({ agent: "cto", title: "main" })
mainID = main.session.id

function label(id: string) {
  try {
    return harness.get(id).agent.name
  } catch {
    return id
  }
}
function brief(args: unknown) {
  const a = args as Record<string, unknown>
  const key = a?.goal ?? (a?.brief as any)?.goal ?? a?.query ?? a?.url ?? a?.path ?? a?.id ?? a?.action
  return key ? `(${String(key).slice(0, 80)})` : ""
}

console.log(`Hahaness — your company. CTO: ${main.session.model}`)
console.log(`Staff: ${agents.subagents().map((a) => a.id).join(", ")}`)
console.log(`Providers: ${harness.cfg.providers.ids().join(", ")}${app.configPath ? ` (${app.configPath})` : " (env)"}`)
console.log(`Workspace: ${app.cwd} — edit COMPANY.md and USER.md to teach the team about your business.`)
console.log(`Tip: talk to the CTO normally. @writer <task> talks to an employee directly. /staff, /quit\n`)

while (true) {
  const line = (await rl.question("\nCEO> ")).trim()
  if (!line) continue
  if (line === "/quit") break
  if (line === "/staff") {
    for (const a of agents.subagents()) console.log(`- ${a.id} (${a.name}): ${a.description}`)
    for (const l of harness.list().filter((l) => l.session.parentID)) console.log(`  ${l.running ? "working" : "done"} ${l.agent.id}: ${l.session.title}`)
    continue
  }
  const direct = /^@([\w-]+)\s+([\s\S]+)$/.exec(line)
  if (direct) {
    const [, agent, task] = direct
    if (!agents.has(agent!)) {
      console.log(`No employee "${agent}". Ask the CTO to hire one, or use /staff.`)
      continue
    }
    try {
      const r = await harness.spawn(main.session.id, {
        agent: agent!,
        brief: { goal: task!, context: "Direct request from the CEO.", done_when: "The goal above is satisfied." },
      })
      console.log("\n" + ("summary" in r ? r.summary : JSON.stringify(r)))
    } catch (e) {
      console.error((e as Error).message)
    }
    continue
  }
  const outcome = await harness.send(main.session.id, line)
  if (outcome.tag === "failed") console.error(`\n[failed] ${outcome.error.message}`)
  console.log()
}
rl.close()
app.mcp.closeAll()
process.exit(0)
