import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { Harness } from "./harness.ts"
import { AgentRegistry } from "./agent/registry.ts"
import { ToolRegistry } from "./tool/registry.ts"
import { define } from "./tool/define.ts"
import { delegate } from "./tool/builtin/delegate.ts"
import { hire } from "./tool/builtin/hire.ts"
import { skill } from "./tool/builtin/skill.ts"
import { SkillStore } from "./context/skills.ts"
import * as workspace from "./context/workspace.ts"
import { existsSync } from "node:fs"
import type { ModelRequest, ProviderClient, StreamEvent } from "./provider/types.ts"
import { evaluate, denied } from "./permission/ruleset.ts"
import { fromMarkdown } from "./agent/registry.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import { buildProviders, expandEnv } from "./config.ts"

const here = dirname(fileURLToPath(import.meta.url))

/** Provider giả: script theo thứ tự request; mỗi entry là hàm nhận request và trả events. */
function scripted(steps: Array<(req: ModelRequest) => StreamEvent[]>): ProviderClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      requests.push(req)
      const fn = steps[requests.length - 1] ?? (() => [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 1 } }])
      for (const ev of fn(req)) yield ev
    },
  }
}

const finish = (reason: "stop" | "tool-calls" = "stop"): StreamEvent => ({ type: "finish", reason, usage: { inputTokens: 100, outputTokens: 10 } })

async function setup(provider: ProviderClient) {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-"))
  await workspace.ensure(dir)
  const agents = await new AgentRegistry().load(join(here, "agent", "builtin"))
  const echo = define({
    name: "echo",
    description: "echo",
    input: z.object({ text: z.string() }),
    async execute({ text }) {
      return { output: `echo:${text}` }
    },
  })
  agents.persistTo(join(dir, "staff"))
  const tools = new ToolRegistry().register(echo, delegate(agents), hire(agents))
  const harness = new Harness({
    cwd: dir,
    dataDir: join(dir, ".hahaness"),
    providers: new ProviderRegistry().register("mock", provider),
    defaultModel: "mock/mock",
    agents,
    tools,
    askHandler: async () => ({ kind: "once" }),
    events: {},
  })
  return { harness, dir, agents, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("hire: CTO creates a new employee at runtime, persisted, then delegates to them", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "c1", name: "hire", args: { id: "seo-specialist", name: "SEO Specialist", description: "SEO audits", system: "You audit SEO.", capabilities: ["read", "webfetch"] } }, finish("tool-calls")],
    (req) => {
      const r = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      assert.match(r!.output, /Hired SEO Specialist/)
      return [{ type: "tool-call", callID: "c2", name: "delegate", args: { action: "spawn", agent: "seo-specialist", brief: { goal: "audit", context: "c", done_when: "d" } } }, finish("tool-calls")]
    },
    (req) => {
      assert.match(req.system[0]!, /You audit SEO/)
      assert.ok(!req.tools.some((t) => t.name === "hire"), "employee must not hire")
      assert.ok(!req.tools.some((t) => t.name === "delegate"), "employee must not delegate")
      return [{ type: "text-delta", text: "audit done" }, finish()]
    },
    () => [{ type: "text-delta", text: "reported" }, finish()],
  ])
  const { harness, dir, agents, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "do an SEO audit")
    assert.equal(outcome.tag, "completed")
    assert.ok(agents.has("seo-specialist"))
    assert.ok(existsSync(join(dir, "staff", "seo-specialist.md")))
    const reloaded = await new AgentRegistry().load(join(dir, "staff"))
    assert.equal(reloaded.get("seo-specialist").system, "You audit SEO.")
    assert.equal(reloaded.get("seo-specialist").permissions.find((r) => r.action === "webfetch")?.effect, "allow")
    assert.equal(reloaded.get("seo-specialist").permissions.find((r) => r.action === "websearch")?.effect, "deny")
  } finally {
    await cleanup()
  }
})

test("skills: index in Tier A only when skills exist; `skill` tool loads body; knowledge index in Tier B", async () => {
  const provider = scripted([
    (req) => {
      assert.match(req.system[0]!, /<available_skills>[\s\S]*<skill id="weekly-report">Use for weekly summaries<\/skill>/)
      assert.match(req.system[1]!, /<knowledge>[\s\S]*knowledge\/brand.md — Brand voice/)
      return [{ type: "tool-call", callID: "c1", name: "skill", args: { id: "weekly-report" } }, finish("tool-calls")]
    },
    (req) => {
      const r = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      assert.match(r!.output, /Step one/)
      return [{ type: "text-delta", text: "ok" }, finish()]
    },
  ])
  const { harness, dir, cleanup } = await setup(provider)
  try {
    const store = new SkillStore(join(dir, "skills"))
    assert.equal(await store.index(), undefined)
    await store.write("weekly-report", "---\nname: Weekly report\ndescription: Use for weekly summaries\n---\nStep one.")
    await writeFile(join(dir, "knowledge", "brand.md"), "# Brand voice\nFriendly.")
    harness.cfg.skills = store
    harness.cfg.tools.register(skill(store))
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "weekly report please")
    assert.equal(outcome.tag, "completed")
  } finally {
    await cleanup()
  }
})

test("resume: a stored session is reloaded with its transcript and continues", async () => {
  const provider = scripted([
    () => [{ type: "text-delta", text: "first" }, finish()],
    (req) => {
      assert.equal(req.messages.length, 3)
      assert.equal(req.messages[0]!.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), "one")
      return [{ type: "text-delta", text: "second" }, finish()]
    },
  ])
  const { harness, dir, agents, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    await harness.send(main.session.id, "one")
    const fresh = new Harness({ ...harness.cfg, agents })
    assert.ok(!fresh.has(main.session.id))
    const sessions = await fresh.store.listSessions()
    assert.equal(sessions[0]?.id, main.session.id)
    const live = await fresh.resume(main.session.id)
    assert.equal(live.messages.length, 2)
    const outcome = await fresh.send(main.session.id, "two")
    assert.equal(outcome.tag, "completed")
    assert.equal(outcome.tag === "completed" && outcome.text, "second")
    assert.ok(existsSync(join(dir, ".hahaness", "sessions", `${main.session.id}.jsonl`)))
  } finally {
    await cleanup()
  }
})

test("loop: tool call then completion, persisted before execute", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "c1", name: "echo", args: { text: "hi" } }, finish("tool-calls")],
    (req) => {
      const last = req.messages.at(-1)!
      const result = last.parts.find((p) => p.type === "tool-result")
      assert.equal(result?.output, "echo:hi")
      return [{ type: "text-delta", text: "ok" }, finish()]
    },
  ])
  const { harness, dir, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "say hi")
    assert.equal(outcome.tag, "completed")
    assert.equal(provider.requests.length, 2)
    const log = await readFile(join(dir, ".hahaness", "sessions", `${main.session.id}.jsonl`), "utf8")
    const kinds = log.trim().split("\n").map((l) => JSON.parse(l).kind)
    assert.deepEqual(kinds.slice(0, 4), ["session", "claim", "message", "message"])
    assert.equal(kinds.at(-1), "release")
  } finally {
    await cleanup()
  }
})

test("validation error is returned to the model, not thrown", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "c1", name: "echo", args: { nope: 1 } }, finish("tool-calls")],
    (req) => {
      const result = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      assert.ok(result?.isError)
      assert.match(result!.output, /Invalid arguments/)
      return [{ type: "text-delta", text: "fixed" }, finish()]
    },
  ])
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "go")
    assert.equal(outcome.tag, "completed")
  } finally {
    await cleanup()
  }
})

test("delegate foreground: child isolated, only ResultEntry returns", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "c1", name: "delegate", args: { action: "spawn", agent: "researcher", brief: { goal: "find X", context: "ctx", done_when: "found" } } }, finish("tool-calls")],
    (req) => {
      assert.equal(req.messages.length, 1)
      assert.match(req.messages[0]!.parts[0]!.type === "text" ? req.messages[0]!.parts[0]!.text : "", /<brief>/)
      assert.ok(!req.tools.some((t) => t.name === "delegate"), "leaf child must not have delegate")
      return [{ type: "text-delta", text: "X is at src/a.ts" }, finish()]
    },
    (req) => {
      const result = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      assert.match(result!.output, /<subagent sessionID="ses_\w+" agent="researcher" status="completed"/)
      assert.match(result!.output, /X is at src\/a\.ts/)
      return [{ type: "text-delta", text: "reported" }, finish()]
    },
  ])
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "find X")
    assert.equal(outcome.tag, "completed")
    assert.equal(harness.list().length, 2)
  } finally {
    await cleanup()
  }
})

test("delegate background: result arrives as inbox message and wakes parent", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "c1", name: "delegate", args: { action: "spawn", agent: "researcher", background: true, brief: { goal: "g", context: "c", done_when: "d" } } }, finish("tool-calls")],
    (req) => {
      const r = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      if (r) {
        assert.match(r.output, /background/)
        return [{ type: "text-delta", text: "waiting" }, finish()]
      }
      return [{ type: "text-delta", text: "child done" }, finish()]
    },
    (req) => {
      const r = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      if (r) return [{ type: "text-delta", text: "waiting" }, finish()]
      return [{ type: "text-delta", text: "child done" }, finish()]
    },
    (req) => {
      const last = req.messages.at(-1)!
      assert.equal(last.source, "subagent")
      return [{ type: "text-delta", text: "got it" }, finish()]
    },
  ])
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    await harness.send(main.session.id, "go")
    await new Promise((r) => setTimeout(r, 50))
    const child = harness.list().find((l) => l.session.parentID === main.session.id)!
    await child.running
    await new Promise((r) => setTimeout(r, 50))
    await main.running
    assert.ok(main.messages.some((m) => m.source === "subagent"))
  } finally {
    await cleanup()
  }
})

test("permission: last match wins, deny never overridden", () => {
  const rules = [
    { action: "shell", resource: "*", effect: "ask" as const },
    { action: "shell", resource: "npm test*", effect: "allow" as const },
    { action: "shell", resource: "git push*", effect: "deny" as const },
  ]
  assert.equal(evaluate(rules, "shell", "npm test -- x"), "allow")
  assert.equal(evaluate(rules, "shell", "ls"), "ask")
  assert.equal(evaluate(rules, "shell", "git push origin"), "deny")
  assert.equal(evaluate(rules, "read", "a.ts"), "ask")
  assert.ok(denied([...rules, { action: "shell", resource: "*", effect: "allow" }], "shell", "git push"))
})

test("provider registry resolves provider/model refs and defaults", () => {
  const a = scripted([])
  const b = scripted([])
  const reg = new ProviderRegistry().register("a", a).register("b", b, { default: true })
  assert.equal(reg.resolve("a/x").client, a)
  assert.equal(reg.resolve("a/x").model, "x")
  assert.equal(reg.resolve("b/org/model").model, "org/model")
  assert.equal(reg.resolve("plain").client, b)
  assert.throws(() => new ProviderRegistry().resolve("x"), /no provider/)
})

test("config: custom provider module and env expansion", async () => {
  process.env.HAHA_TEST_KEY = "secret"
  assert.equal(expandEnv("{env:HAHA_TEST_KEY}"), "secret")
  assert.equal(expandEnv("Bearer {env:HAHA_TEST_KEY}"), "Bearer secret")
  const reg = await buildProviders(
    {
      defaultModel: "echo/any",
      providers: {
        echo: { type: "custom", module: join(here, "..", "examples", "providers", "echo.ts"), options: { reply: "pong" } },
        oa: { type: "openai", apiKey: "{env:HAHA_TEST_KEY}", baseURL: "http://localhost:1/v1" },
      },
    },
    here,
  )
  assert.deepEqual(reg.ids().sort(), ["echo", "oa"])
  const r = reg.resolve("whatever")
  assert.equal(r.providerID, "echo")
  const events: string[] = []
  for await (const ev of r.client.stream({ model: "any", system: [], messages: [], tools: [] }, new AbortController().signal)) {
    if (ev.type === "text-delta") events.push(ev.text)
  }
  assert.deepEqual(events, ["pong"])
})

test("agent markdown frontmatter parses rules and model list", () => {
  const def = fromMarkdown(`---
id: x
mode: subagent
model: [a/b, c/d]
steps: 7
permissions:
  - { action: read, resource: "*", effect: allow }
---
Body here`, "x")
  assert.equal(def.steps, 7)
  assert.deepEqual(def.model, ["a/b", "c/d"])
  assert.deepEqual(def.permissions, [{ action: "read", resource: "*", effect: "allow" }])
  assert.equal(def.system, "Body here")
})
