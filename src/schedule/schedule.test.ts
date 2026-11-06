import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { Harness } from "../harness.ts"
import { AgentRegistry } from "../agent/registry.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { define } from "../tool/define.ts"
import { delegate } from "../tool/builtin/delegate.ts"
import { knowledgeTool } from "../tool/builtin/manage.ts"
import { question } from "../tool/builtin/question.ts"
import { scheduleTool } from "../tool/builtin/schedule.ts"
import { DocumentStore } from "../context/documents.ts"
import { Db } from "../core/db.ts"
import * as workspace from "../context/workspace.ts"
import { ProviderRegistry } from "../provider/registry.ts"
import type { ModelRequest, ProviderClient, StreamEvent } from "../provider/types.ts"
import { nextRun, parseCron } from "./cron.ts"
import { Scheduler } from "./scheduler.ts"

const here = dirname(fileURLToPath(import.meta.url))
const finish = (reason: "stop" | "tool-calls" = "stop"): StreamEvent => ({ type: "finish", reason, usage: { inputTokens: 100, outputTokens: 10 } })
const text = (t: string) => [{ type: "text-delta", text: t } as StreamEvent, finish()]
const textOf = (req: ModelRequest) => req.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).join("\n")

/** Provider giả trả lời theo nội dung request (thứ tự giữa CTO và nhân viên không cố định). */
function replying(fn: (req: ModelRequest) => StreamEvent[]): ProviderClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      requests.push(req)
      for (const ev of fn(req)) yield ev
    },
  }
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

async function setup(provider: ProviderClient, opts: { extraTools?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-sched-"))
  const db = new Db(join(dir, "test.db"))
  const docs = new DocumentStore(db)
  workspace.ensure(docs)
  const agents = (await new AgentRegistry().load(join(here, "..", "agent", "builtin"))).useDb(db)
  const tools = new ToolRegistry()
  let now = at(2026, 11, 6, 10, 0)
  const scheduler = new Scheduler({ db, agents, tools, now: () => now })
  tools.register(delegate(agents), knowledgeTool(docs), scheduleTool(scheduler), question(async () => "never asked"))
  for (const name of opts.extraTools ?? []) tools.register(define({ name, description: name, input: z.object({}), async execute() { return { output: "ok" } } }))
  const harness = new Harness({
    cwd: dir,
    db,
    docs,
    providers: new ProviderRegistry().register("mock", provider),
    defaultModel: "mock/mock",
    agents,
    tools,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    askHandler: async () => ({ kind: "once" }),
    events: {},
  })
  scheduler.attach(harness)
  return {
    harness,
    scheduler,
    docs,
    db,
    agents,
    setNow: (t: number) => (now = t),
    cleanup: async () => {
      scheduler.stop()
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("cron: fields, steps, ranges, names, aliases, dom/dow OR, errors", () => {
  const from = at(2026, 11, 6, 10, 0) // thứ Sáu
  assert.equal(nextRun("0 2 * * *", from), at(2026, 11, 7, 2, 0))
  assert.equal(nextRun("0 2 * * *", at(2026, 11, 7, 1, 59)), at(2026, 11, 7, 2, 0))
  assert.equal(nextRun("0 2 * * *", at(2026, 11, 7, 2, 0)), at(2026, 11, 8, 2, 0), "strictly after")
  assert.equal(nextRun("*/15 * * * *", at(2026, 11, 6, 10, 7)), at(2026, 11, 6, 10, 15))
  assert.equal(nextRun("30 8 * * 1-5", from), at(2026, 11, 9, 8, 30), "Friday 10:00 → Monday 08:30")
  assert.equal(nextRun("0 9 * * MON", from), at(2026, 11, 9, 9, 0))
  assert.equal(nextRun("0 0 * * 7", from), at(2026, 11, 8, 0, 0), "7 = Sunday")
  assert.equal(nextRun("@monthly", from), at(2026, 12, 1, 0, 0))
  assert.equal(nextRun("0 0 1 jan *", from), at(2027, 1, 1, 0, 0))
  assert.equal(nextRun("0 0 31 * *", at(2026, 11, 6)), at(2026, 12, 31), "skips November (30 days)")
  // Ngày 13 HOẶC thứ Hai.
  assert.equal(nextRun("0 0 13 * 1", from), at(2026, 11, 9))
  assert.equal(nextRun("0 0 29 2 *", from), at(2028, 2, 29), "leap day")
  assert.throws(() => parseCron("0 2 * *"), /5 fields/)
  assert.throws(() => parseCron("60 * * * *"), /out of range/)
  assert.throws(() => parseCron("*/0 * * * *"), /step/)
  assert.throws(() => parseCron("0 2 * * funday"), /invalid/)
  assert.throws(() => nextRun("0 0 31 2 *", from), /never matches/)
})

test("schedule: CTO creates a nightly job; at 02:00 a new CTO session hands it to the researcher, then stores the report in knowledge", async () => {
  const provider = replying((req) => {
    const all = textOf(req)
    // Phiên CEO: CTO tạo lịch.
    if (all.includes("every night at 2")) {
      if (req.messages.at(-1)!.parts.some((p) => p.type === "tool-result")) return text("Scheduled.")
      return [
        {
          type: "tool-call",
          callID: "c1",
          name: "schedule",
          args: { action: "create", title: "Nightly reading", agent: "researcher", cron: "0 2 * * *", task: { goal: "Read what is new in our market", context: "Focus on English courses", done_when: "5 new facts with sources" } },
        },
        finish("tool-calls"),
      ]
    }
    // Phiên nhân viên.
    if (req.system[0]!.includes("research analyst")) return text("- Fact A (source x)\n- Fact B (source y)")
    // Phiên CTO do scheduler mở: nhận ghi chú + báo cáo → lưu tri thức.
    assert.ok(!req.tools.some((t) => t.name === "question"), "nobody can answer questions during a scheduled run")
    assert.match(all, /\[Scheduled job\] "Nightly reading"/)
    assert.match(all, /<subagent [^>]*agent="researcher" status="completed"[\s\S]*Fact A/)
    if (!req.messages.at(-1)!.parts.some((p) => p.type === "tool-result"))
      return [{ type: "tool-call", callID: "k1", name: "knowledge", args: { action: "save", path: "market-notes", content: "# Market notes\n- Fact A" } }, finish("tool-calls")]
    return text("Learned 2 facts, saved to knowledge/market-notes.md.")
  })
  const { harness, scheduler, docs, setNow, cleanup } = await setup(provider)
  try {
    const ceo = await harness.createSession({ agent: "cto" })
    assert.equal((await harness.send(ceo.session.id, "have the researcher read the news every night at 2")).tag, "completed")
    const [s] = scheduler.list()
    assert.ok(s)
    assert.equal(s.agent, "researcher")
    assert.equal(s.createdBy, "cto")
    assert.equal(s.nextRunAt, at(2026, 11, 7, 2, 0))

    setNow(at(2026, 11, 7, 1, 59))
    assert.deepEqual(await scheduler.tick(), [], "not yet")

    setNow(at(2026, 11, 7, 2, 0, ))
    const [run] = await scheduler.tick()
    assert.equal(run!.status, "running")
    assert.ok(run!.sessionID && run!.workerSessionID)
    await scheduler.idle()

    const done = scheduler.runs(s.id)[0]!
    assert.equal(done.status, "completed")
    assert.equal(done.reason, "due")
    const after = scheduler.get(s.id)!
    assert.equal(after.lastStatus, "completed")
    assert.equal(after.lastSessionID, run!.sessionID)
    assert.equal(after.nextRunAt, at(2026, 11, 8, 2, 0))
    assert.match(docs.read("knowledge/market-notes.md")!, /Fact A/)

    const lead = harness.get(run!.sessionID!)
    assert.equal(lead.session.parentID, undefined, "scheduled CTO session is a root session the CEO can open")
    assert.match(lead.session.title, /Nightly reading/)
    const worker = harness.get(run!.workerSessionID!)
    assert.equal(worker.session.parentID, lead.session.id)
    assert.equal(worker.messages[0]!.from, "scheduler")
  } finally {
    await cleanup()
  }
})

test("schedule: a job that needs a tool the company does not have is blocked without calling the model", async () => {
  const provider = replying(() => text("should not run"))
  const { scheduler, setNow, cleanup } = await setup(provider)
  try {
    const s = scheduler.create({ title: "Browse Facebook", agent: "researcher", cron: "0 2 * * *", task: { goal: "g", context: "c", done_when: "d" }, tools: ["facebook_*"] }, "cto")
    assert.deepEqual(scheduler.missingTools(s), ["facebook_*"])
    setNow(at(2026, 11, 7, 2, 0))
    const [run] = await scheduler.tick()
    assert.equal(run!.status, "blocked")
    assert.match(run!.error!, /facebook_\*/)
    assert.equal(provider.requests.length, 0)
    assert.equal(scheduler.get(s.id)!.nextRunAt, at(2026, 11, 8, 2, 0), "keeps the timetable")
  } finally {
    await cleanup()
  }
  const ok = await setup(replying(() => text("done")), { extraTools: ["facebook_feed"] })
  try {
    const s = ok.scheduler.create({ title: "Browse Facebook", agent: "researcher", cron: "0 2 * * *", task: { goal: "g", context: "c", done_when: "d" }, tools: ["facebook_*"] }, "cto")
    assert.deepEqual(ok.scheduler.missingTools(s), [])
  } finally {
    await ok.cleanup()
  }
})

test("schedule: missed runs catch up once, overlapping runs are skipped, runs cut by a restart are marked interrupted", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream() {
      await gate
      yield* text("ok")
    },
  }
  const { scheduler, setNow, db, agents, cleanup } = await setup(provider)
  try {
    const s = scheduler.create({ title: "Hourly", agent: "cto", cron: "0 * * * *", task: { goal: "g", context: "c", done_when: "d" } }, "ceo")
    // App tắt 3 tiếng: chỉ chạy bù một lần, lần kế tính từ bây giờ.
    setNow(at(2026, 11, 6, 13, 20))
    const runs = await scheduler.tick()
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!.dueAt, at(2026, 11, 6, 11, 0))
    assert.equal(scheduler.get(s.id)!.nextRunAt, at(2026, 11, 6, 14, 0))
    assert.ok(scheduler.isRunning(s.id))

    const second = await scheduler.runNow(s.id)
    assert.equal(second.status, "skipped")

    // Giả lập app tắt giữa chừng: scheduler mới trên cùng DB thấy lần chạy dở.
    const fresh = new Scheduler({ db, agents, now: () => at(2026, 11, 6, 13, 30) })
    fresh.start()
    fresh.stop()
    assert.equal(fresh.runs(s.id).find((r) => r.id === runs[0]!.id)!.status, "interrupted")

    release()
    await scheduler.idle()
    assert.equal(scheduler.runs(s.id).find((r) => r.id === runs[0]!.id)!.status, "completed")

    const paused = scheduler.setEnabled(s.id, false)
    assert.equal(paused.nextRunAt, undefined)
    setNow(at(2026, 11, 6, 20, 0))
    assert.deepEqual(await scheduler.tick(), [])
    assert.equal(scheduler.setEnabled(s.id, true).nextRunAt, at(2026, 11, 6, 21, 0), "resuming does not replay the paused hours")
    assert.throws(() => scheduler.update(s.id, { cron: "bad" }), /5 fields/)
    assert.throws(() => scheduler.update(s.id, { agent: "nobody" }), /No employee/)
  } finally {
    release()
    await cleanup()
  }
})
