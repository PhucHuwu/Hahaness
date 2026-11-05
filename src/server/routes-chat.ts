import type { App } from "../bootstrap.ts"
import type { Message, Session } from "../core/types.ts"
import { HttpError, type Router } from "./http.ts"

export interface SessionView {
  session: Session
  running: boolean
  live: boolean
  depth: number
  /** Lỗi của lượt gần nhất, nếu có. */
  error?: string
}

export function sessionView(app: App, s: Session): SessionView {
  const live = app.harness.has(s.id) ? app.harness.get(s.id) : undefined
  return { session: live?.session ?? s, running: !!live?.running, live: !!live, depth: live?.depth ?? (s.parentID ? 1 : 0), error: live?.lastError }
}

export interface CommItem {
  at: number
  kind: "brief" | "steer" | "ceo" | "report"
  /** `ceo` hoặc id agent. */
  from: string
  to: string
  /** Phiên con (nhân viên) liên quan. */
  sessionID: string
  parentID: string
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

  r.get("/api/sessions", async () => {
    const stored = await harness.store.listSessions()
    const ids = new Set(stored.map((s) => s.id))
    const extra = harness.list().map((l) => l.session).filter((s) => !ids.has(s.id))
    return [...extra, ...stored].sort((a, b) => b.createdAt - a.createdAt).map((s) => sessionView(app, s))
  })

  r.post("/api/sessions", async (req) => {
    const body = await req.json<{ agent?: string; title?: string }>()
    if (app.providerError) throw new HttpError(409, app.providerError)
    const agent = body.agent ?? "cto"
    if (!agents.has(agent)) throw new HttpError(404, `unknown agent ${agent}`)
    const live = await harness.createSession({ agent, title: body.title })
    return sessionView(app, live.session)
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
    const children = harness
      .list()
      .filter((l) => l.session.parentID === id)
      .map((l) => sessionView(app, l.session))
    return { ...sessionView(app, session), messages, children }
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
    const body = await req.json<{ text?: string; delivery?: "queue" | "steer" }>()
    if (!body.text?.trim()) throw new HttpError(400, "text is required")
    if (app.providerError) throw new HttpError(409, app.providerError)
    if (!harness.has(id)) await harness.resume(id)
    void harness.send(id, body.text, body.delivery ?? "steer")
    return { ok: true }
  })

  r.post("/api/sessions/:id/stop", (req) => {
    const id = req.params.id!
    if (!harness.has(id)) throw new HttpError(404, `session ${id} is not live`)
    harness.interrupt(id)
    return { ok: true }
  })

  /** Direct mode: CEO giao việc thẳng cho một nhân viên; chạy nền, kết quả về inbox CTO nhưng không đánh thức. */
  r.post("/api/sessions/:id/direct", async (req) => {
    const id = req.params.id!
    const body = await req.json<{ agent?: string; task?: string }>()
    if (!body.agent || !body.task?.trim()) throw new HttpError(400, "agent and task are required")
    if (!agents.has(body.agent)) throw new HttpError(404, `no employee ${body.agent}`)
    if (app.providerError) throw new HttpError(409, app.providerError)
    if (!harness.has(id)) await harness.resume(id)
    if (harness.get(id).agent.mode !== "primary") throw new HttpError(400, "giao việc bằng @ chỉ dùng trong phiên của CTO")
    const r = await harness.spawn(id, {
      agent: body.agent,
      brief: { goal: body.task, context: "Direct request from the CEO.", done_when: "The goal above is satisfied." },
      background: true,
      wakeParent: false,
      from: "ceo",
    })
    return r
  })

  /**
   * Dòng thời gian giao tiếp giữa các agent: brief/steer gửi xuống phiên con, báo cáo
   * gửi lên phiên cha. `?root=<id>` lọc theo cây phiên của một phiên gốc.
   */
  r.get("/api/conversations", async (req) => {
    const root = req.url.searchParams.get("root") ?? undefined
    const stored = await harness.store.listSessions()
    const byID = new Map(stored.map((s) => [s.id, s]))
    for (const l of harness.list()) byID.set(l.session.id, l.session)
    const rootOf = (s: Session): string => (s.parentID && byID.has(s.parentID) ? rootOf(byID.get(s.parentID)!) : s.id)
    const children = [...byID.values()].filter((s) => s.parentID && (!root || rootOf(s) === root))
    const messagesOf = async (id: string) => (harness.has(id) ? harness.get(id).messages : ((await harness.store.load(id))?.messages ?? []))

    const items: CommItem[] = []
    const parents = new Set<string>()
    for (const child of children) {
      const parent = byID.get(child.parentID!)
      parents.add(child.parentID!)
      let first = true
      for (const m of await messagesOf(child.id)) {
        if (m.role !== "user") continue
        const text = textOf(m)
        const legacyBrief = m.source === "system" && text.startsWith("You are a subagent")
        if (m.source !== "agent" && m.source !== "user" && !legacyBrief) continue
        const from = m.from ?? (m.source === "user" ? "ceo" : (parent?.agent ?? "?"))
        items.push({ at: m.createdAt, kind: first ? "brief" : from === "ceo" ? "ceo" : "steer", from, to: child.agent, sessionID: child.id, parentID: child.parentID!, text: first ? briefText(text) : text })
        first = false
      }
    }
    for (const pid of parents) {
      const parent = byID.get(pid)
      for (const m of await messagesOf(pid)) {
        for (const p of m.parts) {
          const raw = p.type === "text" && m.source === "subagent" ? p.text : p.type === "tool-result" && p.name === "delegate" ? p.output : undefined
          const r = raw && /<subagent sessionID="([^"]+)" agent="([^"]+)" status="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/subagent>/.exec(raw)
          if (!r) continue
          const child = byID.get(r[1]!)
          if (!child || (root && rootOf(child) !== root)) continue
          items.push({ at: m.createdAt, kind: "report", from: r[2]!, to: parent?.agent ?? "?", sessionID: r[1]!, parentID: pid, text: r[4]!, status: r[3] })
        }
      }
    }
    // Báo cáo còn nằm trong inbox phiên cha (direct mode không đánh thức CTO) → lấy câu trả lời cuối của nhân viên.
    const reported = new Set(items.filter((i) => i.kind === "report").map((i) => i.sessionID))
    for (const child of children) {
      if (reported.has(child.id) || (harness.has(child.id) && harness.get(child.id).running)) continue
      const last = [...(await messagesOf(child.id))].reverse().find((m) => m.role === "assistant" && textOf(m).trim())
      if (!last) continue
      const parent = byID.get(child.parentID!)
      items.push({ at: last.createdAt, kind: "report", from: child.agent, to: parent?.agent ?? "?", sessionID: child.id, parentID: child.parentID!, text: textOf(last) })
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
    const body = await req.json<{ id?: string; name?: string; description?: string; system?: string; capabilities?: Array<"read" | "write" | "webfetch" | "websearch"> }>()
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
