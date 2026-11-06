import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Harness } from "../harness.ts"
import { AgentRegistry } from "../agent/registry.ts"
import { ToolRegistry } from "../tool/registry.ts"
import { DocumentStore } from "../context/documents.ts"
import { Db } from "../core/db.ts"
import * as workspace from "../context/workspace.ts"
import { ProviderRegistry } from "../provider/registry.ts"
import type { ModelRequest, ProviderClient, StreamEvent } from "../provider/types.ts"
import { question } from "../tool/builtin/question.ts"
import { TelegramChannel } from "./telegram.ts"

const here = dirname(fileURLToPath(import.meta.url))

/** Telegram giả: hàng đợi update cho getUpdates, ghi lại mọi sendMessage. */
function fakeTelegram() {
  const queue: unknown[] = []
  const sent: Array<{ chat_id: number; text: string; reply_markup?: any }> = []
  let waiter: (() => void) | undefined
  let nextID = 1
  const files = new Map<string, string>()
  const f = (async (url: string, init: { body?: string; signal?: AbortSignal }) => {
    const method = url.split("/").at(-1)!
    const body = init.body ? JSON.parse(init.body) : {}
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 })
    if (url.includes("/botBAD/")) return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })
    if (method === "getMe") return ok({ username: "hahaness_bot" })
    if (method === "sendMessage") {
      sent.push(body)
      return ok({ message_id: 1 })
    }
    if (method === "sendChatAction") return ok(true)
    if (method === "getFile") return ok({ file_path: `docs/${body.file_id}` })
    if (url.includes("/file/bot")) return new Response(files.get(url.split("/").at(-1)!) ?? "", { status: 200 })
    if (method === "getUpdates") {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          waiter = r
          init.signal?.addEventListener("abort", () => r(), { once: true })
        })
      }
      if (init.signal?.aborted) throw new Error("aborted")
      return ok(queue.splice(0).filter((u: any) => u.update_id >= (body.offset ?? 0)))
    }
    return ok(true)
  }) as unknown as typeof fetch
  const say = (chatID: number, text: string, name = "Phuc") => {
    queue.push({ update_id: nextID++, message: { message_id: nextID, text, chat: { id: chatID, type: "private", first_name: name } } })
    waiter?.()
  }
  const sendFile = (chatID: number, name: string, content: string, caption?: string) => {
    files.set(`f${nextID}`, content)
    queue.push({ update_id: nextID, message: { message_id: nextID, caption, document: { file_id: `f${nextID++}`, file_name: name, file_size: content.length }, chat: { id: chatID, type: "private", first_name: "Phuc" } } })
    waiter?.()
  }
  return { fetch: f, sent, say, sendFile }
}

const finish = (reason: "stop" | "tool-calls" = "stop"): StreamEvent => ({ type: "finish", reason, usage: { inputTokens: 10, outputTokens: 1 } })

async function setup(provider: ProviderClient) {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-tg-"))
  const db = new Db(join(dir, "test.db"))
  const docs = new DocumentStore(db)
  workspace.ensure(docs)
  const agents = (await new AgentRegistry().load(join(here, "..", "agent", "builtin"))).useDb(db)
  const tools = new ToolRegistry().register(question)
  const tg = fakeTelegram()
  let harness!: Harness
  const channel = new TelegramChannel(db, () => harness, { fetch: tg.fetch, retryMs: 10 })
  harness = new Harness({
    cwd: dir,
    db,
    docs,
    providers: new ProviderRegistry().register("mock", provider),
    defaultModel: "mock/mock",
    agents,
    tools,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    askHandler: async () => ({ kind: "once" }),
    events: { onTurnStart: (id) => channel.turnStarted(id), onTurnEnd: (id, o) => void channel.turnEnded(id, o) },
  })
  return {
    harness,
    channel,
    tg,
    db,
    cleanup: async () => {
      channel.stop()
      db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(cond(), "timed out")
}

test("telegram: bad token is rejected with a clear message", async () => {
  const { channel, cleanup } = await setup({ info: () => ({ id: "m", contextWindow: 1, maxOutput: 1 }), async *stream() {} })
  try {
    await assert.rejects(channel.configure("BAD"), /Token bot Telegram không đúng/)
    assert.equal(channel.status().configured, false)
  } finally {
    await cleanup()
  }
})

test("telegram: pairing links only the CEO; their messages reach the CTO and replies (incl. question options) come back", async () => {
  const requests: ModelRequest[] = []
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream(req) {
      requests.push(req)
      const last = req.messages.at(-1)!.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
      if (last.includes("launch")) {
        yield { type: "text-delta", text: "Sure." }
        yield { type: "tool-call", callID: "q1", name: "question", args: { question: "Which market?", options: ["VN", "US"] } }
        yield finish("tool-calls")
        return
      }
      yield { type: "text-delta", text: `got ${last}` }
      yield finish()
    },
  }
  const { harness, channel, tg, cleanup } = await setup(provider)
  try {
    const st = await channel.configure("123:abc")
    assert.equal(st.bot, "hahaness_bot")
    assert.ok(st.pairCode)

    tg.say(999, "hello", "Stranger")
    await until(() => tg.sent.some((m) => m.chat_id === 999))
    assert.match(tg.sent.find((m) => m.chat_id === 999)!.text, /chưa liên kết/)
    assert.equal(requests.length, 0, "strangers never reach the CTO")

    tg.say(42, `/start ${st.pairCode}`)
    await until(() => channel.status().linked === "Phuc")
    assert.equal(channel.status().pairCode, undefined)

    tg.say(42, "launch a product")
    await until(() => tg.sent.some((m) => m.text.includes("Which market?")))
    const q = tg.sent.find((m) => m.text.includes("Which market?"))!
    assert.deepEqual(q.reply_markup.keyboard, [[{ text: "VN" }], [{ text: "US" }]])
    assert.ok(tg.sent.some((m) => m.chat_id === 42 && m.text === "Sure."))

    tg.say(42, "VN")
    await until(() => tg.sent.some((m) => m.text === "got VN"))
    const cto = await harness.sessionFor("cto")
    assert.ok(cto.messages.some((m) => m.role === "user" && m.from === "ceo" && m.parts.some((p) => p.type === "text" && p.text === "VN")), "Telegram messages are CEO messages in the CTO chat")

    // File gửi qua Telegram → tài liệu uploads/ + nội dung đi kèm tin nhắn.
    tg.sendFile(42, "kpi.csv", "kpi,value\nleads,42", "phân tích file này")
    await until(() => tg.sent.some((m) => m.text.startsWith("got ") && m.text.includes("<attachments>")))
    assert.match(harness.cfg.docs.get("uploads/kpi.csv.md")!.content, /leads,42/)

    // Người khác gửi mã cũ sau khi đã liên kết → bị từ chối.
    tg.say(7, `/start ${st.pairCode}`)
    await until(() => tg.sent.some((m) => m.chat_id === 7))
    assert.match(tg.sent.find((m) => m.chat_id === 7)!.text, /người khác/)
  } finally {
    await cleanup()
  }
})

test("telegram: a CTO turn not started from Telegram (web, schedule, report) is still forwarded", async () => {
  const provider: ProviderClient = {
    info: () => ({ id: "mock", contextWindow: 100_000, maxOutput: 8_000 }),
    async *stream() {
      yield { type: "text-delta", text: "daily summary" }
      yield finish()
    },
  }
  const { harness, channel, tg, db, cleanup } = await setup(provider)
  try {
    const st = await channel.configure("123:abc")
    tg.say(42, st.pairCode!)
    await until(() => !!channel.status().linked)
    const cto = await harness.sessionFor("cto")
    await harness.send(cto.session.id, "from the web")
    await until(() => tg.sent.some((m) => m.text === "daily summary"))
    // Restart: liên kết và offset còn nguyên.
    channel.stop()
    const again = new TelegramChannel(db, () => harness, { fetch: tg.fetch })
    assert.equal(again.status().linked, "Phuc")
    assert.ok((again.settings()?.offset ?? 0) > 0)
  } finally {
    await cleanup()
  }
})
