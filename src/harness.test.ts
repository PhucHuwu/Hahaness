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
import { memory } from "./tool/builtin/memory.ts"
import { fitForSummary, isOverflow, prune } from "./context/compaction.ts"
import type { Message } from "./core/types.ts"
import { updateNotice } from "./context/instructions.ts"
import { askLead } from "./tool/builtin/ask-lead.ts"
import { AnthropicProvider, requestBody, toAnthropicMessages } from "./provider/anthropic.ts"

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
    tools,
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

test("crash resume: dangling tool-call gets an interrupted result, model is told, transcript stays valid", async () => {
  const provider = scripted([
    (req) => {
      const calls = req.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool-call").map((p) => (p as { callID: string }).callID))
      const results = new Set(req.messages.flatMap((m) => m.parts.filter((p) => p.type === "tool-result").map((p) => (p as { callID: string }).callID)))
      assert.deepEqual(calls.filter((c) => !results.has(c)), [], "every tool-call must have a result")
      const all = req.messages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-result" ? p.output : "")).join("")).join("\n")
      assert.match(all, /interrupted: the turn stopped/)
      assert.match(all, /was cut off \(the app was restarted\)/)
      return [{ type: "text-delta", text: "recovered" }, finish()]
    },
  ])
  const { harness, agents, cleanup } = await setup(provider)
  try {
    const s = await harness.createSession({ agent: "cto" })
    const id = s.session.id
    // Mô phỏng server tắt giữa lúc tool chạy: claim, user msg, assistant + tool-call, không result, không release.
    await harness.store.claim(id)
    await harness.store.addMessage(id, { id: "m1", role: "user", source: "user", from: "ceo", createdAt: 1, parts: [{ type: "text", text: "do it" }] })
    await harness.store.addMessage(id, { id: "m2", role: "assistant", createdAt: 2, parts: [] })
    await harness.store.addPart(id, "m2", { type: "tool-call", callID: "c1", name: "echo", args: { text: "x" } })
    const fresh = new Harness({ ...harness.cfg, agents })
    await fresh.resume(id)
    const outcome = await fresh.send(id, "continue")
    assert.equal(outcome.tag, "completed")
    // Bản vá được ghi vào store: lần nạp sau không cần vá nữa.
    const state = (await fresh.store.load(id))!
    assert.equal(state.staleClaim, false)
    assert.ok(state.messages.find((m) => m.id === "m2")!.parts.some((p) => p.type === "tool-result" && p.callID === "c1"))
  } finally {
    await cleanup()
  }
})

test("budget: provider without usage keeps the running estimate instead of resetting to 0", async () => {
  const noUsage: StreamEvent = { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }
  const provider = scripted([() => [{ type: "text-delta", text: "x".repeat(4000) }, noUsage]])
  const { harness, cleanup } = await setup(provider)
  try {
    const s = await harness.createSession({ agent: "cto" })
    const before = s.estimate.estimated
    await harness.send(s.session.id, "y".repeat(4000))
    assert.ok(s.estimate.estimated >= before + 2000, `estimate ${s.estimate.estimated} should include both messages`)
  } finally {
    await cleanup()
  }
})

test("retry: honours Retry-After; too long a wait fails fast with a clear error", async () => {
  const short = scripted([
    () => [{ type: "error", error: new Error("429 slow down"), retryable: true, retryAfterMs: 20 }],
    () => [{ type: "text-delta", text: "ok" }, finish()],
  ])
  const a = await setup(short)
  try {
    const s = await a.harness.createSession({ agent: "cto" })
    const t0 = Date.now()
    const outcome = await a.harness.send(s.session.id, "hi")
    assert.equal(outcome.tag, "completed")
    assert.ok(Date.now() - t0 < 900, "should wait ~20ms, not the 1s default backoff")
  } finally {
    await a.cleanup()
  }
  const long = scripted([() => [{ type: "error", error: new Error("429 quota"), retryable: true, retryAfterMs: 3_600_000 }]])
  const b = await setup(long)
  try {
    const s = await b.harness.createSession({ agent: "cto" })
    const outcome = await b.harness.send(s.session.id, "hi")
    assert.equal(outcome.tag, "failed")
    assert.match(outcome.tag === "failed" ? outcome.error.message : "", /wait 3600s/)
  } finally {
    await b.cleanup()
  }
})

test("stream breaks after a tool call: tool result is still recorded and the turn continues", async () => {
  let n = 0
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      n++
      if (n === 1) {
        yield { type: "tool-call", callID: "c1", name: "echo", args: { text: "a" } }
        throw new Error("socket hang up")
      }
      const r = req.messages.at(-1)!.parts.find((p) => p.type === "tool-result")
      assert.equal(r?.type === "tool-result" && r.output, "echo:a")
      yield { type: "text-delta", text: "done" }
      yield finish()
    },
  }
  const { harness, cleanup } = await setup(provider)
  try {
    const s = await harness.createSession({ agent: "cto" })
    assert.equal((await harness.send(s.session.id, "go")).tag, "completed")
    assert.equal(n, 2)
  } finally {
    await cleanup()
  }
})

test("stop: interrupting the CTO also stops an employee it is waiting on (foreground delegate)", async () => {
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req, signal) {
      const first = req.messages[0]?.parts[0]
      if (first?.type === "text" && first.text.includes("<brief>")) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        return
      }
      yield { type: "tool-call", callID: "d1", name: "delegate", args: { action: "spawn", agent: "researcher", brief: { goal: "g", context: "c", done_when: "d" } } }
      yield finish("tool-calls")
    },
  }
  const { harness, cleanup } = await setup(provider)
  try {
    const main = await harness.createSession({ agent: "cto" })
    const run = harness.send(main.session.id, "go")
    let child: ReturnType<typeof harness.list>[number] | undefined
    for (let i = 0; i < 100 && !child; i++) {
      await new Promise((r) => setTimeout(r, 10))
      child = harness.list().find((l) => l.session.parentID === main.session.id)
    }
    assert.ok(child, "child spawned")
    harness.interrupt(main.session.id)
    assert.equal((await run).tag, "interrupted")
    await child.running
    assert.equal(child.abort.signal.aborted, true)
    assert.equal(child.running, undefined)
  } finally {
    await cleanup()
  }
})

// ---- Compaction ---------------------------------------------------------------

const GOOD_SUMMARY = "## Objective\nship the report\n## Work State\nhalf done\n## Next Move\nfinish section 3"
const noUsage = (): StreamEvent => ({ type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } })
const allText = (req: ModelRequest) => req.messages.flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-result" ? p.output : ""))).join("\n")
const isSummaryReq = (req: ModelRequest) => allText(req).includes("Context is about to be compacted")
const isFlushReq = (req: ModelRequest) => allText(req).includes("Context will be compacted now")

/** Provider với context window tuỳ chọn; usage = 0 để loop dùng ước lượng chars/4. */
function windowed(contextWindow: number, handler: (req: ModelRequest) => StreamEvent[]): ProviderClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    info: () => ({ id: "mock", contextWindow, maxOutput: 8_000 }),
    async *stream(req) {
      requests.push(req)
      for (const ev of handler(req)) yield ev
    },
  }
}

const reply = (text: string): StreamEvent[] => [{ type: "text-delta", text }, noUsage()]

/** 5 tin nhắn ~5k token mỗi tin vào window 40k (ceiling 24k) → tin thứ 5 kích hoạt compaction. */
async function longChat(harness: Harness, n = 5) {
  const s = await harness.createSession({ agent: "cto" })
  for (let i = 1; i <= n; i++) await harness.send(s.session.id, `request ${i}: ` + "x".repeat(20_000))
  return s
}

test("compaction: long conversation compacts, summary request fits the window, next request starts from the checkpoint", async () => {
  const provider = windowed(40_000, (req) => (isSummaryReq(req) ? reply(GOOD_SUMMARY) : reply("ok")))
  const { harness, cleanup } = await setup(provider)
  try {
    const s = await longChat(harness)
    const summaries = provider.requests.filter(isSummaryReq)
    assert.equal(summaries.length, 1)
    const sumReq = summaries[0]!
    const sumTokens = sumReq.messages.reduce((n, m) => n + m.parts.reduce((k, p) => k + (p.type === "text" ? p.text.length : 0), 0), 0) / 4
    assert.ok(sumTokens < 24_000 - 8_000, `summary input ${sumTokens} tokens must leave room in a 40k window`)
    assert.match(allText(sumReq), /\[clipped\]/)
    const last = provider.requests.at(-1)!
    assert.ok(!isSummaryReq(last))
    const first = last.messages[0]!.parts[0]!
    assert.ok(first.type === "text" && first.text.includes("<conversation-checkpoint>") && first.text.includes("finish section 3"))
    assert.match(allText(last), /request 5:/)
    assert.doesNotMatch(allText(last), /request 1:/)
    const state = (await harness.store.load(s.session.id))!
    assert.equal(state.compactions.length, 1)
    assert.ok(s.estimate.measured + s.estimate.estimated < 24_000, "estimate re-anchored below the ceiling")
  } finally {
    await cleanup()
  }
})

test("compaction: summary missing headings is retried once with a nudge; still wrong → transcript fallback", async () => {
  let n = 0
  const retried = windowed(40_000, (req) => (isSummaryReq(req) ? reply(n++ === 0 ? "Sure! Here is what happened." : GOOD_SUMMARY) : reply("ok")))
  const a = await setup(retried)
  try {
    const s = await longChat(a.harness)
    const sums = retried.requests.filter(isSummaryReq)
    assert.equal(sums.length, 2)
    assert.match(allText(sums[1]!), /missing required headings: ## Objective/)
    assert.equal((await a.harness.store.load(s.session.id))!.compactions[0]!.summary, GOOD_SUMMARY)
  } finally {
    await a.cleanup()
  }

  const stubborn = windowed(40_000, (req) => (isSummaryReq(req) ? reply("no.") : reply("ok")))
  const b = await setup(stubborn)
  try {
    const s = await longChat(b.harness)
    assert.equal(stubborn.requests.filter(isSummaryReq).length, 2)
    const summary = (await b.harness.store.load(s.session.id))!.compactions[0]!.summary
    assert.match(summary, /reconstructed from the transcript/)
    assert.match(summary, /request 1:/, "CEO requests kept verbatim (clipped)")
    assert.match(summary, /## Next Move/)
  } finally {
    await b.cleanup()
  }
})

test("compaction: compaction.model writes the summary; main model never sees the summary prompt", async () => {
  const main = windowed(40_000, (req) => (isSummaryReq(req) ? reply("main should not summarize") : reply("ok")))
  const cheap = windowed(200_000, () => reply(GOOD_SUMMARY))
  const { harness, agents, cleanup } = await setup(main)
  try {
    const h = new Harness({
      ...harness.cfg,
      agents,
      providers: new ProviderRegistry().register("mock", main).register("cheap", cheap),
      compaction: { model: "cheap/summarizer" },
    })
    const s = await longChat(h)
    assert.equal(main.requests.filter(isSummaryReq).length, 0)
    assert.equal(cheap.requests.length, 1)
    assert.equal(cheap.requests[0]!.model, "summarizer")
    assert.equal((await h.store.load(s.session.id))!.compactions[0]!.summary, GOOD_SUMMARY)
  } finally {
    await cleanup()
  }
})

test("overflow recovery: provider says context too long → compact and retry; persistent overflow fails instead of looping", async () => {
  let overflowOnce = true
  const provider = windowed(100_000, (req) => {
    if (isSummaryReq(req)) return reply(GOOD_SUMMARY)
    if (allText(req).includes("request 5:") && overflowOnce) {
      overflowOnce = false
      return [{ type: "error", error: new Error("400 This model's maximum context length is 8192 tokens"), retryable: false }]
    }
    return reply("ok")
  })
  const a = await setup(provider)
  try {
    const s = await a.harness.createSession({ agent: "cto" })
    for (let i = 1; i <= 4; i++) await a.harness.send(s.session.id, `request ${i}: ` + "x".repeat(20_000))
    const outcome = await a.harness.send(s.session.id, "request 5: " + "x".repeat(20_000))
    assert.equal(outcome.tag, "completed")
    assert.equal(provider.requests.filter(isSummaryReq).length, 1)
    assert.ok(provider.requests.at(-1)!.messages[0]!.parts.some((p) => p.type === "text" && p.text.includes("<conversation-checkpoint>")))
  } finally {
    await a.cleanup()
  }

  const always = windowed(100_000, (req) =>
    isSummaryReq(req) ? reply(GOOD_SUMMARY) : allText(req).includes("request 5:") ? [{ type: "error", error: new Error("context_length_exceeded"), retryable: false }] : reply("ok"),
  )
  const b = await setup(always)
  try {
    const s = await b.harness.createSession({ agent: "cto" })
    for (let i = 1; i <= 4; i++) await b.harness.send(s.session.id, `request ${i}: ` + "x".repeat(20_000))
    const outcome = await b.harness.send(s.session.id, "request 5: " + "x".repeat(20_000))
    assert.equal(outcome.tag, "failed")
    assert.match(outcome.tag === "failed" ? outcome.error.message : "", /context/)
    assert.ok(always.requests.length < 20, "bounded number of attempts")
  } finally {
    await b.cleanup()
  }
})

test("memory flush: before compacting, an agent with `memory` saves long-term notes; the flush exchange is not stored", async () => {
  const provider = windowed(40_000, (req) => {
    if (isSummaryReq(req)) return reply(GOOD_SUMMARY)
    if (isFlushReq(req)) {
      const saved = req.messages.at(-1)!.parts.some((p) => p.type === "tool-result" && p.name === "memory")
      return saved ? reply("NO_REPLY") : [{ type: "tool-call", callID: "mf1", name: "memory", args: { action: "add", text: "CEO wants reports under one page" } }, noUsage()]
    }
    return reply("ok")
  })
  const { harness, docs, cleanup } = await setup(provider)
  try {
    harness.cfg.tools.register(memory(docs))
    const s = await longChat(harness)
    assert.ok(workspace.readMemory(docs).some((e) => e.includes("under one page")))
    assert.equal(provider.requests.filter(isFlushReq).length, 2)
    const flushAt = provider.requests.findIndex(isFlushReq)
    assert.ok(flushAt < provider.requests.findIndex(isSummaryReq), "flush runs before summarize")
    const stored = (await harness.store.load(s.session.id))!.messages
    assert.ok(!stored.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("Context will be compacted now"))))
  } finally {
    await cleanup()
  }
})

test("compaction helpers: skill outputs become SKILL_PRUNED, overflow messages recognised, summary input fits budget", () => {
  const big = "y".repeat(8_000)
  const msgs: Message[] = [
    { id: "u0", role: "user", createdAt: 0, parts: [{ type: "text", text: "goal" }] },
    { id: "a0", role: "assistant", createdAt: 0, parts: [{ type: "tool-call", callID: "k", name: "skill", args: { id: "pricing" } }, { type: "tool-result", callID: "k", name: "skill", output: "short skill", isError: false }] },
    ...Array.from({ length: 30 }, (_, i): Message => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", createdAt: 0, parts: [{ type: "text", text: big }] })),
  ]
  const pruned = prune(msgs)
  const r = pruned[1]!.parts[1]!
  assert.ok(r.type === "tool-result" && r.output.startsWith("[SKILL_PRUNED: pricing]"))
  for (const m of ["context_length_exceeded", "This model's maximum context length is 128000 tokens", "prompt is too long: 210000 tokens > 200000 maximum", "Input exceeds the context window"]) assert.ok(isOverflow(m), m)
  assert.ok(!isOverflow("429 rate limited"))
  const fitted = fitForSummary(pruned, 10_000)
  const tokens = fitted.reduce((n, m) => n + m.parts.reduce((k, p) => k + (p.type === "text" ? p.text.length : p.type === "tool-result" ? p.output.length : 0), 0), 0) / 4
  assert.ok(tokens <= 10_000, `fitted ${tokens}`)
  assert.equal(fitted[0]!.id, "u0", "first messages kept")
  assert.equal(fitted.at(-1)!.parts[0]!.type === "text" && (fitted.at(-1)!.parts[0] as { text: string }).text.length, 8_000, "latest message intact")
})

// ---- Tài liệu đổi giữa phiên ----------------------------------------------------

const updateText = (req: ModelRequest) =>
  req.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" && p.text.includes("<workspace-update>") ? [p.text] : [])))

test("mid-session change: CEO edits COMPANY.md → next turn gets one <workspace-update>, system prompt unchanged", async () => {
  const provider = scripted([])
  const { harness, docs, cleanup } = await setup(provider)
  try {
    docs.put("COMPANY.md", "# Company\nWe sell coffee.\nPrices in VND.", "ceo")
    const s = await harness.createSession({ agent: "cto" })
    await harness.send(s.session.id, "hi")
    const system0 = provider.requests[0]!.system
    assert.equal(updateText(provider.requests[0]!).length, 0)

    docs.put("COMPANY.md", "# Company\nWe sell tea.\nPrices in VND.", "ceo")
    await harness.send(s.session.id, "what do we sell?")
    const r1 = provider.requests[1]!
    assert.deepEqual(r1.system, system0, "system prompt frozen (prompt cache)")
    const updates = updateText(r1)
    assert.equal(updates.length, 1)
    assert.match(updates[0]!, /COMPANY\.md/)
    assert.match(updates[0]!, /We sell tea/)
    // Notice đứng trước câu hỏi của CEO để model đọc bối cảnh mới trước.
    const texts = r1.messages.map((m) => (m.parts[0]?.type === "text" ? m.parts[0].text : ""))
    assert.ok(texts.findIndex((t) => t.includes("<workspace-update>")) < texts.findIndex((t) => t === "what do we sell?"))

    await harness.send(s.session.id, "thanks")
    assert.equal(updateText(provider.requests[2]!).length, 1, "not repeated on later turns")
  } finally {
    await cleanup()
  }
})

test("mid-session change: new skill and knowledge reach employees; the agent's own edits are not echoed back", async () => {
  const provider = scripted([
    () => [{ type: "tool-call", callID: "w1", name: "knowledge", args: { action: "save", path: "pricing.md", content: "# Pricing\nTea 30k" } }, finish("tool-calls")],
  ])
  const { harness, skills, cleanup } = await setup(provider)
  try {
    const cto = await harness.createSession({ agent: "cto" })
    const writer = await harness.createSession({ agent: "writer" })
    await harness.send(cto.session.id, "save pricing")
    await skills.write("press-release", "---\nname: Press release\ndescription: How we write press releases\n---\nSteps.")

    const before = provider.requests.length
    await harness.send(cto.session.id, "next")
    const ctoUpdate = updateText(provider.requests[before]!).join("\n")
    assert.match(ctoUpdate, /press-release/, "CTO told about the skill the CEO added")
    assert.doesNotMatch(ctoUpdate, /pricing\.md/, "CTO wrote pricing.md itself; no echo")

    const n = provider.requests.length
    await harness.send(writer.session.id, "write something")
    const writerUpdate = updateText(provider.requests[n]!).join("\n")
    assert.match(writerUpdate, /knowledge\/pricing\.md/)
    assert.match(writerUpdate, /press-release/)
  } finally {
    await cleanup()
  }
})

test("workspace update helpers: line diff for long docs, removal notice, nothing when unchanged", () => {
  const long = Array.from({ length: 80 }, (_, i) => `Line ${i} of the company handbook with some words.`).join("\n")
  const src = (content: string) => ({ id: "workspace/company", content, hash: content.length + ":" + content.slice(-20) })
  const edited = long.replace("Line 40 of", "Line 40 (revised) of")
  const notice = updateNotice([src(long)], [src(edited)])!
  assert.match(notice, /- Line 40 of/)
  assert.match(notice, /\+ Line 40 \(revised\) of/)
  assert.ok(notice.length < 1_000, "diff, not the whole document")
  assert.match(updateNotice([src(long)], [])!, /removed or emptied/)
  assert.equal(updateNotice([src(long)], [src(long)]), undefined)
})

// ---- Nhân viên hỏi ngược (needs_input) ------------------------------------------

test("ask_lead: employee asks, CTO gets status=needs_input, answers via steer, then gets the final report", async () => {
  const childTurns: string[] = []
  const requests: ModelRequest[] = []
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      requests.push(req)
      const isChild = allText(req).includes("<brief>")
      const last = req.messages.at(-1)!
      const lastText = last.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool-result" ? p.output : "")).join("")
      if (isChild) {
        childTurns.push(lastText)
        assert.ok(req.tools.some((t) => t.name === "ask_lead"), "employee has ask_lead")
        if (lastText.includes("<brief>")) {
          yield { type: "tool-call", callID: "q1", name: "ask_lead", args: { question: "Which city?", options: ["Hanoi", "Saigon"], progress: "outline done" } }
          yield finish("tool-calls")
          return
        }
        assert.match(lastText, /Saigon/)
        yield { type: "text-delta", text: "report for Saigon" }
        yield finish()
        return
      }
      assert.ok(!req.tools.some((t) => t.name === "ask_lead"), "CTO (no lead) does not get ask_lead")
      if (lastText.includes("do research")) {
        yield { type: "tool-call", callID: "d1", name: "delegate", args: { action: "spawn", agent: "researcher", brief: { goal: "g", context: "c", done_when: "d" } } }
        yield finish("tool-calls")
        return
      }
      const asked = /<subagent sessionID="(ses_\w+)"[^>]*status="needs_input"[\s\S]*Which city\?[\s\S]*Hanoi/.exec(lastText)
      if (asked) {
        yield { type: "tool-call", callID: "s1", name: "delegate", args: { action: "steer", sessionID: asked[1], message: "Saigon" } }
        yield finish("tool-calls")
        return
      }
      yield { type: "text-delta", text: "ok" }
      yield finish()
    },
  }
  const { harness, tools, cleanup } = await setup(provider)
  tools.register(askLead)
  try {
    const main = await harness.createSession({ agent: "cto" })
    await harness.send(main.session.id, "do research")
    const child = harness.list().find((l) => l.session.parentID === main.session.id)!
    for (let i = 0; i < 300; i++) {
      const done = childTurns.length >= 2 && !child.running && !main.running && main.messages.some((m) => m.source === "subagent")
      if (done) break
      await new Promise((r) => setTimeout(r, 10))
    }
    await main.running
    assert.equal(childTurns.length, 2, "employee stopped after asking, then resumed with the answer")
    const reports = main.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" && m.source === "subagent" ? [p.text] : [])))
    assert.equal(reports.length, 1)
    assert.match(reports[0]!, /status="completed"[\s\S]*report for Saigon/)
  } finally {
    await cleanup()
  }
})

// ---- Model dự phòng ------------------------------------------------------------

test("fallback: non-retryable error on the main model switches to the next model for this and later turns", async () => {
  const bad = scripted([() => [{ type: "error", error: new Error("401 invalid key"), retryable: false }]])
  const good = scripted([])
  const { harness, agents, cleanup } = await setup(bad)
  try {
    const notices: string[] = []
    const h = new Harness({
      ...harness.cfg,
      agents,
      providers: new ProviderRegistry().register("mock", bad).register("backup", good),
      fallbackModels: ["backup/b1"],
      events: { onNotice: (_, t) => notices.push(t) },
    })
    const s = await h.createSession({ agent: "cto" })
    const outcome = await h.send(s.session.id, "hi")
    assert.equal(outcome.tag, "completed")
    assert.equal(good.requests[0]!.model, "b1")
    assert.ok(notices.some((n) => /switching to backup\/b1/.test(n)))
    await h.send(s.session.id, "again")
    assert.equal(bad.requests.length, 1, "broken model not retried every turn")
    assert.equal(good.requests.length, 2)
  } finally {
    await cleanup()
  }
})

test("fallback: no fallback configured → the original error is reported", async () => {
  const bad = scripted([() => [{ type: "error", error: new Error("400 model not found"), retryable: false }]])
  const { harness, cleanup } = await setup(bad)
  try {
    const s = await harness.createSession({ agent: "cto" })
    const outcome = await harness.send(s.session.id, "hi")
    assert.equal(outcome.tag, "failed")
    assert.match(outcome.tag === "failed" ? outcome.error.message : "", /model not found/)
  } finally {
    await cleanup()
  }
})

// ---- Anthropic provider ----------------------------------------------------------

test("anthropic: request mapping (system cache, tool_use/tool_result pairing) and SSE parsing", async () => {
  const messages: Message[] = [
    { id: "1", role: "user", createdAt: 0, parts: [{ type: "text", text: "hi" }] },
    { id: "2", role: "user", source: "system", createdAt: 0, parts: [{ type: "text", text: "<workspace-update>x</workspace-update>" }] },
    { id: "3", role: "assistant", createdAt: 0, parts: [{ type: "text", text: "let me check" }, { type: "tool-call", callID: "t1", name: "read", args: { path: "a.md" } }, { type: "tool-result", callID: "t1", name: "read", output: "content", isError: false }] },
    { id: "4", role: "user", createdAt: 0, parts: [{ type: "text", text: "and?" }] },
  ]
  const mapped = toAnthropicMessages(messages)
  assert.deepEqual(mapped.map((m) => m.role), ["user", "assistant", "user"], "roles alternate; system notice merged into user")
  assert.equal(mapped[0]!.content.length, 2)
  assert.deepEqual(mapped[1]!.content[1], { type: "tool_use", id: "t1", name: "read", input: { path: "a.md" } })
  assert.equal(mapped[2]!.content[0]!.type, "tool_result", "tool_result first in the following user message")

  const body = requestBody({ model: "claude-x", system: ["A", "B"], messages, tools: [{ name: "read", description: "r", parameters: { type: "object" } }] }, 8000) as any
  assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" })
  assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral" })
  assert.equal(body.max_tokens, 8000)

  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"b.md"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]
  const sseBody = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
  const realFetch = globalThis.fetch
  let sent: any
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) }
    return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch
  try {
    const p = new AnthropicProvider({ apiKey: "k", baseURL: "https://example.test/v1" })
    const out: StreamEvent[] = []
    for await (const ev of p.stream({ model: "claude-x", system: ["S"], messages: messages.slice(0, 1), tools: [] }, new AbortController().signal)) out.push(ev)
    assert.equal(sent.url, "https://example.test/v1/messages")
    assert.equal(sent.headers["x-api-key"], "k")
    assert.deepEqual(out[0], { type: "text-delta", text: "Hello" })
    assert.deepEqual(out[1], { type: "tool-call", callID: "tu1", name: "read", args: { path: "b.md" } })
    assert.deepEqual(out[2], { type: "finish", reason: "tool-calls", usage: { inputTokens: 100, outputTokens: 42, cacheReadTokens: 90 } })

    globalThis.fetch = (async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }), { status: 400 })) as unknown as typeof fetch
    const errs: StreamEvent[] = []
    for await (const ev of p.stream({ model: "claude-x", system: [], messages: messages.slice(0, 1), tools: [] }, new AbortController().signal)) errs.push(ev)
    assert.ok(errs[0]!.type === "error" && isOverflow(errs[0]!.error.message) && !errs[0]!.retryable)

    globalThis.fetch = (async () => new Response("overloaded", { status: 529, headers: { "retry-after": "2" } })) as unknown as typeof fetch
    const busy: StreamEvent[] = []
    for await (const ev of p.stream({ model: "claude-x", system: [], messages: messages.slice(0, 1), tools: [] }, new AbortController().signal)) busy.push(ev)
    assert.ok(busy[0]!.type === "error" && busy[0]!.retryable && busy[0]!.retryAfterMs === 2000)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(ConfigSchema.parse({ providers: { a: { type: "anthropic", apiKey: "sk-ant-x" } } }).providers.a!.type, "anthropic")
})
