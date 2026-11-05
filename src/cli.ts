import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "./harness.ts"
import { AgentRegistry } from "./agent/registry.ts"
import { ToolRegistry } from "./tool/registry.ts"
import { buildProviders, loadConfig } from "./config.ts"
import { read, write, edit } from "./tool/builtin/fs.ts"
import { glob, grep } from "./tool/builtin/search.ts"
import { shell } from "./tool/builtin/shell.ts"
import { todo } from "./tool/builtin/todo.ts"
import { question } from "./tool/builtin/question.ts"
import { delegate } from "./tool/builtin/delegate.ts"

const here = dirname(fileURLToPath(import.meta.url))
const cwd = process.cwd()
const rl = createInterface({ input: stdin, output: stdout })

const { config, path: configPath } = await loadConfig(cwd)
let providers
try {
  providers = await buildProviders(config, cwd)
} catch (e) {
  console.error((e as Error).message)
  console.error("See docs/architecture/06-providers.md for hahaness.json format.")
  process.exit(1)
}
const defaultModel = process.env.HAHANESS_MODEL ?? config.defaultModel ?? "gpt-4.1"

const agents = await new AgentRegistry().load(join(here, "agent", "builtin"), join(cwd, "agents"))
const tools = new ToolRegistry().register(
  read, write, edit, glob, grep, shell, todo,
  question(async (q, options) => {
    const opts = options?.length ? `\n  options: ${options.join(" | ")}` : ""
    return rl.question(`\n? ${q}${opts}\n> `)
  }),
  delegate(agents.subagents()),
)

const harness = new Harness({
  cwd,
  dataDir: join(cwd, ".hahaness"),
  providers,
  defaultModel,
  agents,
  tools,
  permissions: [],
  askHandler: async (req) => {
    const a = (await rl.question(`\n[permission] ${req.agent} wants ${req.action}: ${req.resource}\n  (y)es / (a)lways / (n)o [+reason]: `)).trim()
    if (a === "a") return { kind: "always" }
    if (a === "y" || a === "") return { kind: "once" }
    return { kind: "reject", feedback: a.replace(/^n\s*/, "") || undefined }
  },
  events: {
    onText: (_s, d) => stdout.write(d),
    onToolStart: (s, name, args) => console.log(`\n  ⚙ [${label(s)}] ${name} ${JSON.stringify(args).slice(0, 160)}`),
    onToolEnd: (s, name, out, err) => console.log(`  ${err ? "✗" : "✓"} [${label(s)}] ${name}: ${out.split("\n")[0]?.slice(0, 120)}`),
    onNotice: (s, t) => console.log(`\n  ℹ [${label(s)}] ${t}`),
  },
})

function label(sessionID: string) {
  try {
    return harness.get(sessionID).agent.id
  } catch {
    return sessionID
  }
}

const main = await harness.createSession({ agent: "cto", title: "main" })
console.log(`Hahaness — you are the CEO. Talking to: ${main.agent.name} (${main.session.model})`)
console.log(`Providers: ${providers.ids().join(", ")}${configPath ? ` from ${configPath}` : " (from env)"}`)
console.log(`Commands: @<agent> <task> (direct), /sessions, /steer <id> <msg>, /stop <id>, /quit\n`)

while (true) {
  const line = (await rl.question("\nCEO> ")).trim()
  if (!line) continue
  if (line === "/quit") break
  if (line === "/sessions") {
    for (const l of harness.list()) console.log(`${l.session.id} ${l.agent.id} ${l.running ? "running" : "idle"} depth=${l.depth} — ${l.session.title}`)
    continue
  }
  if (line.startsWith("/steer ")) {
    const [, sid, ...rest] = line.split(" ")
    void harness.send(sid!, rest.join(" "), "steer")
    continue
  }
  if (line.startsWith("/stop ")) {
    harness.interrupt(line.split(" ")[1]!)
    continue
  }
  const direct = /^@(\w+)\s+([\s\S]+)$/.exec(line)
  if (direct) {
    const [, agent, task] = direct
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
