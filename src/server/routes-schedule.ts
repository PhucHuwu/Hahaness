import type { App } from "../bootstrap.ts"
import type { Schedule, ScheduleInput } from "../schedule/scheduler.ts"
import { timezone, upcoming } from "../schedule/cron.ts"
import { HttpError, type Router } from "./http.ts"

export interface ScheduleView extends Schedule {
  running: boolean
  missingTools: string[]
  upcoming: number[]
}

/** Việc định kỳ: CEO xem, tạm dừng, chạy ngay, sửa; CTO tạo bằng tool `schedule`. */
export function scheduleRoutes(r: Router, app: App) {
  const { scheduler } = app

  const view = (s: Schedule): ScheduleView => {
    let next: number[] = []
    try {
      if (s.enabled) next = upcoming(s.cron, Date.now(), 3)
    } catch {}
    return { ...s, running: scheduler.isRunning(s.id), missingTools: scheduler.missingTools(s), upcoming: next }
  }
  const must = (id: string) => {
    const s = scheduler.get(id)
    if (!s) throw new HttpError(404, `no schedule ${id}`)
    return s
  }
  const guard = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(400, (e as Error).message)
    }
  }

  r.get("/api/schedules", () => ({ timezone: timezone(), schedules: scheduler.list().map(view) }))

  r.get("/api/schedules/:id", (req) => ({ schedule: view(must(req.params.id!)), runs: scheduler.runs(req.params.id!, 30) }))

  r.post("/api/schedules", async (req) => {
    const body = await req.json<Partial<ScheduleInput>>()
    if (!body.title || !body.agent || !body.cron || !body.task?.goal) throw new HttpError(400, "title, agent, cron and task.goal are required")
    const task = { goal: body.task.goal, context: body.task.context ?? "", done_when: body.task.done_when ?? "The goal above is satisfied.", output: body.task.output }
    return view(guard(() => scheduler.create({ ...body, title: body.title!, agent: body.agent!, cron: body.cron!, task }, "ceo")))
  })

  r.put("/api/schedules/:id", async (req) => {
    must(req.params.id!)
    const body = await req.json<Partial<ScheduleInput>>()
    return view(guard(() => scheduler.update(req.params.id!, body)))
  })

  r.post("/api/schedules/:id/run", async (req) => {
    must(req.params.id!)
    const run = await scheduler.runNow(req.params.id!)
    if (run.status !== "running") throw new HttpError(409, run.error ?? run.status)
    return run
  })

  r.delete("/api/schedules/:id", (req) => {
    if (!scheduler.remove(req.params.id!)) throw new HttpError(404, `no schedule ${req.params.id}`)
    return { ok: true }
  })
}
