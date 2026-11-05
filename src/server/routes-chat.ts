import type { App } from "../bootstrap.ts"
import type { Message, Session } from "../core/types.ts"
import { HttpError, type Router } from "./http.ts"

export interface SessionView {
  session: Session
  running: boolean
  live: boolean
  depth: number
}

export function sessionView(app: App, s: Session): SessionView {
  const live = app.harness.has(s.id) ? app.harness.get(s.id) : undefined
  return { session: live?.session ?? s, running: !!live?.running, live: !!live, depth: live?.depth ?? (s.parentID ? 1 : 0) }
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
    const r = await harness.spawn(id, {
      agent: body.agent,
      brief: { goal: body.task, context: "Direct request from the CEO.", done_when: "The goal above is satisfied." },
      background: true,
      wakeParent: false,
    })
    return r
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
