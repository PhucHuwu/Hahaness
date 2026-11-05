import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
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
import { documentTools } from "./tool/builtin/fs.ts"
import { knowledgeTool, manageSkillTool, staffTool } from "./tool/builtin/manage.ts"
import { SkillStore } from "./context/skills.ts"
import { DocumentStore } from "./context/documents.ts"
import { Db } from "./core/db.ts"
import { importLegacy } from "./core/migrate.ts"
import * as workspace from "./context/workspace.ts"
import type { ModelRequest, ProviderClient, StreamEvent } from "./provider/types.ts"
import { evaluate, denied } from "./permission/ruleset.ts"
import { fromMarkdown } from "./agent/registry.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import { buildProviders, ConfigSchema, expandEnv } from "./config.ts"

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
  const db = new Db(join(dir, "test.db"))
  const docs = new DocumentStore(db)
  workspace.ensure(docs)
  const agents = (await new AgentRegistry().load(join(here, "agent", "builtin"))).useDb(db)
  const echo = define({
    name: "echo",
    description: "echo",
    input: z.object({ text: z.string() }),
    async execute({ text }) {
      return { output: `echo:${text}` }
    },
  })
  const skills = new SkillStore(db)
  const tools = new ToolRegistry().register(echo, delegate(agents), hire(agents), ...documentTools(docs), knowledgeTool(docs), manageSkillTool(skills), staffTool(agents))
  const harness = new Harness({
    cwd: dir,
    db,
    docs,
    skills,
    providers: new ProviderRegistry().register("mock", provider),
    defaultModel: "mock/mock",
    agents,
    tools,
    askHandler: async () => ({ kind: "once" }),
    events: {},
  })
  return {
    harness,
    dir,
    db,
    docs,
    skills,
    agents,
    cleanup: async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
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
  const { harness, db, agents, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "do an SEO audit")
    assert.equal(outcome.tag, "completed")
    assert.ok(agents.has("seo-specialist"))
    const reloaded = new AgentRegistry().useDb(db)
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
  const { harness, docs, skills: store, cleanup } = await setup(provider)
  try {
    assert.equal(await store.index(), undefined)
    await store.write("weekly-report", "---\nname: Weekly report\ndescription: Use for weekly summaries\n---\nStep one.")
    docs.put("knowledge/brand.md", "# Brand voice\nFriendly.")
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
  const { harness, agents, cleanup } = await setup(provider)
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
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(main.session.id, "say hi")
    assert.equal(outcome.tag, "completed")
    assert.equal(provider.requests.length, 2)
    const kinds = (await harness.store.read(main.session.id)).map((e) => e.kind)
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

test("employee chat: root session for an employee has no management tools; CEO message marked from ceo", async () => {
  const provider = scripted([
    (req) => {
      const names = req.tools.map((t) => t.name)
      for (const t of ["delegate", "hire", "knowledge", "manage_skill", "staff"]) assert.ok(!names.includes(t), `employee must not have ${t}`)
      return [{ type: "text-delta", text: "hi CEO" }, finish()]
    },
  ])
  const { harness, cleanup } = await setup(provider)
  try {
    const s = await harness.createSession({ agent: "researcher" })
    assert.equal((await harness.send(s.session.id, "hello")).tag, "completed")
    assert.equal(s.messages[0]!.source, "user")
    assert.equal(s.messages[0]!.from, "ceo")
    // Resume (vd sau restart) vẫn giữ rule nhân viên.
    const resumed = await new Harness(harness.cfg).resume(s.session.id)
    assert.ok(evaluate(resumed.ruleset, "hire", "*") === "deny")
  } finally {
    await cleanup()
  }
})

test("delegate: brief and steer are marked as coming from the CTO, not the CEO", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      const first = req.messages[0]
      const text = first?.parts[0]?.type === "text" ? first.parts[0].text : ""
      if (text.includes("<brief>")) {
        await gate
        yield { type: "text-delta", text: "child report" }
        yield finish()
        return
      }
      yield { type: "text-delta", text: "ok" }
      yield finish()
    },
  }
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const r = await harness.spawn(main.session.id, { agent: "researcher", brief: { goal: "g", context: "c", done_when: "d" }, background: true })
    const child = harness.get((r as { sessionID: string }).sessionID)
    void harness.send(child.session.id, "focus on Y", "steer", "cto")
    release()
    await child.running
    const userMsgs = child.messages.filter((m) => m.role === "user")
    assert.deepEqual(userMsgs.map((m) => [m.source, m.from]), [["agent", "cto"], ["agent", "cto"]])
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

test("config: key pasted inside {env:…} is treated as the literal key; missing env var is explained", async () => {
  const parse = (apiKey: string) => ConfigSchema.parse({ providers: { p: { type: "openai", apiKey } } }).providers.p as { apiKey?: string }
  assert.equal(parse("{env:sk-abc-123}").apiKey, "sk-abc-123")
  assert.equal(parse("  sk-abc  ").apiKey, "sk-abc")
  assert.equal(parse("{env:MY_KEY}").apiKey, "{env:MY_KEY}")
  assert.equal(parse("").apiKey, undefined)
  delete process.env.HAHA_MISSING_KEY
  await assert.rejects(buildProviders({ providers: { p: { type: "openai", apiKey: "{env:HAHA_MISSING_KEY}" } } }, here), /HAHA_MISSING_KEY chưa được đặt/)
})

const call = (name: string, args: unknown, callID = "c1"): StreamEvent[] => [{ type: "tool-call", callID, name, args }, finish("tool-calls")]
const lastResult = (req: ModelRequest) => req.messages.at(-1)!.parts.find((p) => p.type === "tool-result") as { output: string; isError?: boolean }

test("CTO tools: knowledge, manage_skill, staff change the company; next session sees them", async () => {
  const provider = scripted([
    () => call("knowledge", { action: "save", path: "pricing", content: "# Bảng giá 2026\nGói A: 1 triệu" }),
    (req) => {
      assert.match(lastResult(req).output, /Saved knowledge\/pricing\.md/)
      return call("manage_skill", { action: "save", id: "Weekly Report", description: "Use for weekly summaries", instructions: "1. Collect.\n2. Summarize." })
    },
    (req) => {
      assert.match(lastResult(req).output, /Created skill weekly-report/)
      return call("staff", { action: "edit", id: "writer", capabilities: ["read"], description: "Writes short posts" })
    },
    (req) => {
      assert.match(lastResult(req).output, /Capabilities: read\./)
      return call("staff", { action: "edit", id: "cto", system: "x" })
    },
    (req) => {
      assert.ok(lastResult(req).isError)
      return call("staff", { action: "fire", id: "researcher" })
    },
    () => [{ type: "text-delta", text: "done" }, finish()],
    (req) => {
      assert.match(req.system[0]!, /<skill id="weekly-report">Use for weekly summaries<\/skill>/)
      assert.match(req.system[1]!, /knowledge\/pricing\.md — Bảng giá 2026/)
      return [{ type: "text-delta", text: "ok" }, finish()]
    },
  ])
  const { harness, db, docs, agents, cleanup } = await setup(provider)
  try {
    harness.cfg.tools.register(skill(harness.cfg.skills!))
    const first = await harness.createSession({ agent: "cto" })
    assert.equal((await harness.send(first.session.id, "keep this")).tag, "completed")
    assert.equal(docs.get("knowledge/pricing.md")?.author, "cto")
    assert.ok(!agents.has("researcher"))
    const reloaded = (await new AgentRegistry().load(join(here, "agent", "builtin"))).useDb(db)
    assert.ok(!reloaded.has("researcher"), "fired role stays fired")
    assert.equal(reloaded.get("writer").description, "Writes short posts")
    assert.equal(evaluate(reloaded.get("writer").permissions, "write", "drafts/a.md"), "deny")
    const second = await harness.createSession({ agent: "cto" })
    assert.equal((await harness.send(second.session.id, "hi")).tag, "completed")
  } finally {
    await cleanup()
  }
})

test("employees never get management tools", async () => {
  const provider = scripted([
    () => call("delegate", { action: "spawn", agent: "writer", brief: { goal: "g", context: "c", done_when: "d" } }),
    (req) => {
      for (const name of ["knowledge", "manage_skill", "staff", "hire", "delegate"]) {
        assert.ok(!req.tools.some((t) => t.name === name), `employee must not have ${name}`)
      }
      assert.ok(req.tools.some((t) => t.name === "read"))
      return [{ type: "text-delta", text: "draft done" }, finish()]
    },
    () => [{ type: "text-delta", text: "ok" }, finish()],
  ])
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    assert.equal((await harness.send(main.session.id, "write")).tag, "completed")
  } finally {
    await cleanup()
  }
})

test("truncated tool output is saved as a hidden document the agent can read", async () => {
  const provider = scripted([
    () => call("big", {}, "callbig"),
    (req) => {
      assert.match(lastResult(req).output, /full output saved to tool-output\/callbig\.txt/)
      return [{ type: "text-delta", text: "ok" }, finish()]
    },
  ])
  const { harness, docs, cleanup } = await setup(provider)
  try {
    harness.cfg.tools.register(
      define({ name: "big", description: "big", input: z.object({}), async execute() {
        return { output: Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") }
      } }),
    )
    const main = await harness.createSession({ agent: "cto" })
    await harness.send(main.session.id, "go")
    assert.match(docs.read("tool-output/callbig.txt") ?? "", /line 2999/)
    assert.ok(!docs.list().some((d) => d.path.startsWith("tool-output/")), "hidden from top-level list")
  } finally {
    await cleanup()
  }
})

test("documents: path normalization, children, Vietnamese-safe search", () => {
  const db = new Db(":memory:")
  try {
    const docs = new DocumentStore(db)
    assert.equal(docs.put("\\knowledge\\./Giá.md", "# Giá\nGÓI Cao Cấp"), "knowledge/Giá.md")
    docs.put("drafts/a/b.md", "x")
    assert.throws(() => docs.put("../evil.md", "x"), /invalid path/)
    assert.deepEqual(docs.children("").map((c) => c.name), ["drafts/", "knowledge/"])
    const hits = docs.search("gói cao")
    assert.equal(hits[0]?.path, "knowledge/Giá.md")
    assert.equal(hits[0]?.matches[0]?.line, 2)
    assert.equal(docs.search("gói", { prefix: "drafts" }).length, 0)
  } finally {
    db.close()
  }
})

test("importLegacy: old folder layout moves into the DB once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-legacy-"))
  const db = new Db(join(dir, "data", "x.db"))
  try {
    assert.ok(db.fresh)
    await writeFile(join(dir, "COMPANY.md"), "# Acme\nWe sell rockets.")
    await mkdir(join(dir, "knowledge", "sub"), { recursive: true })
    await writeFile(join(dir, "knowledge", "sub", "faq.md"), "# FAQ")
    await mkdir(join(dir, "staff"))
    await writeFile(join(dir, "staff", "seo.md"), "---\nid: seo\nname: SEO\ndescription: d\n---\nDo SEO.")
    await mkdir(join(dir, "skills", "brief"), { recursive: true })
    await writeFile(join(dir, "skills", "brief", "SKILL.md"), "---\nname: Brief\ndescription: Use for briefs\n---\nSteps.")
    await mkdir(join(dir, ".hahaness", "sessions"), { recursive: true })
    await writeFile(join(dir, ".hahaness", "mcp.json"), JSON.stringify({ servers: { fs: { type: "stdio", command: "x" } } }))
    const session = { id: "ses_old", agent: "cto", model: "m", title: "Old", createdAt: 1 }
    await writeFile(join(dir, ".hahaness", "sessions", "ses_old.jsonl"), JSON.stringify({ kind: "session", session }) + "\n")
    const docs = new DocumentStore(db)
    const imported = await importLegacy(dir, db, docs)
    assert.ok(imported.includes("knowledge/sub/faq.md"))
    assert.match(docs.read("COMPANY.md")!, /rockets/)
    assert.equal(new AgentRegistry().useDb(db).get("seo").system, "Do SEO.")
    assert.equal((await new SkillStore(db).list())[0]?.description, "Use for briefs")
    assert.equal((db.sql.prepare("SELECT count(*) n FROM mcp_servers").get() as { n: number }).n, 1)
    const { SessionStore } = await import("./core/store.ts")
    assert.equal((await new SessionStore(db).listSessions())[0]?.title, "Old")
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
  const again = new Db(":memory:")
  assert.ok(again.fresh)
  again.close()
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
