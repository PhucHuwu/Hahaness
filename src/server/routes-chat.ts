import type { App } from "../bootstrap.ts"
import type { Message, Part, Session } from "../core/types.ts"
import { attach, UploadError } from "../upload/attachments.ts"
import { HttpError, type Router } from "./http.ts"
import { homeSessions } from "../harness.ts"
import { COMMANDS, runCommand } from "../command/slash.ts"

export interface SessionView {
  session: Session
  running: boolean
  live: boolean
  /** Phiên chính của agent (nhận tin nhắn). false = lịch sử cũ trước khi chuyển sang 1 phiên/agent, chỉ xem. */
  home: boolean
  /** Nhân viên: đang làm gì. */
  work?: { status: "working" | "waiting" | "idle"; goal?: string; from?: string; queued: number }
  /** Lỗi của lượt gần nhất, nếu có. */
  error?: string
}

export function sessionView(app: App, s: Session, home?: boolean): SessionView {
  const live = app.harness.has(s.id) ? app.harness.get(s.id) : undefined
  return {
    session: live?.session ?? s,
    running: !!live?.running,
    live: !!live,
    home: home ?? app.harness.homeOf(s.agent) === s.id,
    work: live && live.agent.mode !== "primary" ? app.harness.work(live) : undefined,
    error: live?.lastError,
  }
}

export interface CommItem {
  at: number
  kind: "brief" | "steer" | "ceo" | "report"
  /** `ceo` hoặc id agent. */
  from: string
  to: string
  /** Phiên của nhân viên liên quan. */
  sessionID: string
  text: string
  status?: string
}

const textOf = (m: Message) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")

/** Brief được render dạng XML cho model; UI chỉ cần mục tiêu, bối cảnh, tiêu chí xong. */
function briefText(text: string) {
  const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1]?.trim()
  const goal = tag("goal")
  if (!goal) return text
  return [goal, tag("context") && `Bối cảnh: ${tag("context")}`, tag("done_when") && `Xong khi: ${tag("done_when")}`].filter(Boolean).join("\n")
}

export function chatRoutes(r: Router, app: App) {
  const { harness, agents } = app

  /** Mọi phiên đã lưu, mới nhất trước; `home` đánh dấu phiên chính của từng agent. */
  r.get("/api/sessions", async () => {
    const stored = await harness.store.listSessions()
    const ids = new Set(stored.map((s) => s.id))
    const all = [...harness.list().map((l) => l.session).filter((s) => !ids.has(s.id)), ...stored].sort((a, b) => b.createdAt - a.createdAt)
    const homes = new Set([...homeSessions(all).values()].map((s) => s.id))
    return all.map((s) => sessionView(app, s, homes.has(s.id)))
  })

  /** Phiên duy nhất của agent: mở lại phiên đã có, chưa có thì tạo (1 nhân viên = 1 phiên chat). */
  r.post("/api/sessions", async (req) => {
    const body = await req.json<{ agent?: string }>()
    if (app.providerError) throw new HttpError(409, app.providerError)
    const agent = body.agent ?? agents.list("primary")[0]?.id ?? "cto"
    if (!agents.has(agent)) throw new HttpError(404, `unknown agent ${agent}`)
    const live = await harness.sessionFor(agent)
    return sessionView(app, live.session, true)
  })

  r.get("/api/sessions/:id", async (req) => {
    const id = req.params.id!
    let messages: Message[]
    let session: Session
    if (harness.has(id)) {
      const live = harness.get(id)
      messages = live.messages
      session = live.session
    } else {
      const state = await harness.store.load(id)
      if (!state) throw new HttpError(404, `no session ${id}`)
      messages = state.messages
      session = state.session
    }
    const home = homeSessions([...(await harness.store.listSessions()), session]).get(session.agent)?.id === id
    return { ...sessionView(app, session, home), messages }
  })

  r.get("/api/sessions/:id/usage", async (req) => {
    try {
      return await harness.usageReport(req.params.id!)
    } catch (e) {
      throw new HttpError(404, (e as Error).message)
    }
  })

  r.post("/api/sessions/:id/resume", async (req) => {
    if (app.providerError) throw new HttpError(409, app.providerError)
    const live = await harness.resume(req.params.id!)
    return sessionView(app, live.session)
  })

  r.post("/api/sessions/:id/messages", async (req) => {
    const id = req.params.id!
    const body = await req.json<{ text?: string; delivery?: "queue" | "steer"; files?: Array<{ name?: string; mime?: string; data?: string }> }>()
    const files = body.files ?? []
    if (!body.text?.trim() && files.length === 0) throw new HttpError(400, "text is required")
    if (app.providerError) throw new HttpError(409, app.providerError)
    await homeOnly(id)
    let parts: Part[] = []
    try {
      parts = await attach(
        harness.cfg.docs,
        files.map((f) => ({ name: f.name ?? "file", mime: f.mime, data: Buffer.from(f.data ?? "", "base64") })),
        "ceo",
        app.workdir,
      )
    } catch (e) {
      if (e instanceof UploadError) throw new HttpError(400, e.message)
      throw e
    }
    void harness.send(id, body.text?.trim() ?? "", body.delivery ?? "steer", "ceo", parts)
    return { ok: true }
  })

  r.get("/api/commands", () => COMMANDS)

  /** Lệnh slash (`/help`, `/compact`…): chạy ngay, không vào transcript. `sessionID` có khi `/new` tạo phiên mới. */
  r.post("/api/sessions/:id/command", async (req) => {
    const id = req.params.id!
    const body = await req.json<{ text?: string }>()
    if (!body.text?.trim().startsWith("/")) throw new HttpError(400, "text must start with /")
    if (app.providerError) throw new HttpError(409, app.providerError)
    await homeOnly(id)
    return runCommand(harness, id, body.text)
  })

  r.post("/api/sessions/:id/stop", (req) => {
    const id = req.params.id!
    if (!harness.has(id)) throw new HttpError(404, `session ${id} is not live`)
    harness.interrupt(id)
    return { ok: true }
  })

  /** Phiên cũ (trước khi mỗi agent chỉ có một phiên) chỉ để xem; nhắn tiếp phải vào phiên chính. */
  async function homeOnly(id: string) {
    const all = await harness.store.listSessions()
    const s = all.find((x) => x.id === id) ?? (harness.has(id) ? harness.get(id).session : undefined)
    if (!s) throw new HttpError(404, `no session ${id}`)
    if (homeSessions([...all, s]).get(s.agent)?.id !== id) throw new HttpError(409, "Đây là phiên cũ, chỉ để xem. Hãy nhắn trong phiên hiện tại của agent này.")
    await harness.sessionFor(s.agent)
  }

  /** Direct mode: CEO giao việc thẳng cho một nhân viên; chạy nền, kết quả về inbox CTO nhưng không đánh thức. */
  r.post("/api/sessions/:id/direct", async (req) => {
    const id = req.params.id!
    const body = await req.json<{ agent?: string; task?: string }>()
    if (!body.agent || !body.task?.trim()) throw new HttpError(400, "agent and task are required")
    if (!agents.has(body.agent)) throw new HttpError(404, `no employee ${body.agent}`)
    if (app.providerError) throw new HttpError(409, app.providerError)
    await homeOnly(id)
    if (harness.get(id).agent.mode !== "primary") throw new HttpError(400, "giao việc bằng @ chỉ dùng trong phiên của CTO")
    const r = await harness.spawn(id, {
      agent: body.agent,
      brief: { goal: body.task, context: "Direct request from the CEO.", done_when: "The goal above is satisfied." },
      background: true,
      wakeLead: false,
      from: "ceo",
    })
    return r
  })

  /**
   * Dòng thời gian giao tiếp giữa các agent: brief/steer trong phiên nhân viên, báo cáo trong
   * phiên người giao. Đọc cả phiên con kiểu cũ (trước khi mỗi agent chỉ có một phiên).
   */
  r.get("/api/conversations", async () => {
    const stored = await harness.store.listSessions()
    const byID = new Map(stored.map((s) => [s.id, s]))
    for (const l of harness.list()) byID.set(l.session.id, l.session)
    // Kèm cả message còn chờ trong inbox: báo cáo direct mode không đánh thức CTO nên nằm đó tới lượt sau.
    const messagesOf = async (id: string) =>
      harness.has(id) ? [...harness.get(id).messages, ...harness.get(id).inbox.pending().map((i) => i.message)] : ((await harness.store.load(id))?.messages ?? [])
    const primary = (agent: string) => agents.has(agent) && agents.get(agent).mode === "primary"

    const items: CommItem[] = []
    const reported = new Set<string>()
    for (const s of byID.values()) {
      const legacy = !!s.parentID
      const parent = legacy ? byID.get(s.parentID!) : undefined
      let first = true
      for (const m of await messagesOf(s.id)) {
        if (m.role === "user" && !primary(s.agent)) {
          const text = textOf(m)
          const legacyBrief = m.source === "system" && text.startsWith("You are a subagent")
          // CEO chat thẳng với nhân viên trong phiên của họ không phải "giao tiếp giữa các agent".
          if (m.source !== "agent" && !(legacy && m.source === "user") && !legacyBrief) continue
          const from = m.from ?? (m.source === "user" ? "ceo" : (parent?.agent ?? "?"))
          const brief = text.includes("<brief>") || (legacy && first)
          items.push({ at: m.createdAt, kind: brief ? "brief" : from === "ceo" ? "ceo" : "steer", from, to: s.agent, sessionID: s.id, text: brief ? briefText(text) : text })
          first = false
        }
        for (const p of m.parts) {
          const raw = p.type === "text" && m.source === "subagent" ? p.text : p.type === "tool-result" && p.name === "delegate" ? p.output : undefined
          const r = raw && /<subagent sessionID="([^"]+)" agent="([^"]+)" status="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/subagent>/.exec(raw)
          if (!r) continue
          reported.add(r[1]!)
          items.push({ at: m.createdAt, kind: "report", from: r[2]!, to: s.agent, sessionID: r[1]!, text: r[4]!, status: r[3] })
        }
      }
    }
    // Phiên con kiểu cũ mà báo cáo còn nằm trong inbox phiên cha (direct mode không đánh thức CTO).
    for (const s of byID.values()) {
      if (!s.parentID || reported.has(s.id) || (harness.has(s.id) && harness.get(s.id).running)) continue
      const last = [...(await messagesOf(s.id))].reverse().find((m) => m.role === "assistant" && textOf(m).trim())
      if (!last) continue
      items.push({ at: last.createdAt, kind: "report", from: s.agent, to: byID.get(s.parentID)?.agent ?? "?", sessionID: s.id, text: textOf(last) })
    }
    return items.sort((a, b) => a.at - b.at)
  })

  r.get("/api/staff", () =>
    agents.list().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      mode: a.mode,
      model: a.model,
      steps: a.steps,
      context: a.context,
      permissions: a.permissions,
      system: a.system,
    })),
  )

  r.post("/api/staff", async (req) => {
    const body = await req.json<{ id?: string; name?: string; description?: string; system?: string; capabilities?: Array<"read" | "write" | "webfetch" | "websearch" | "bash"> }>()
    if (!body.id || !body.name || !body.system) throw new HttpError(400, "id, name and system are required")
    if (agents.has(body.id)) throw new HttpError(409, `employee ${body.id} already exists`)
    const def = await agents.hire({
      id: body.id,
      name: body.name,
      description: body.description ?? "",
      system: body.system,
      capabilities: body.capabilities ?? ["read"],
    })
    return { id: def.id }
  })

  r.put("/api/staff/:id", async (req) => {
    const body = await req.json<{ markdown?: string }>()
    if (!body.markdown) throw new HttpError(400, "markdown is required")
    const def = await agents.update(req.params.id!, body.markdown)
    return { id: def.id }
  })

  r.delete("/api/staff/:id", async (req) => {
    await agents.fire(req.params.id!)
    return { ok: true }
  })
}
