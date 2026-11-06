import { z } from "zod"
import { define } from "../define.ts"
import type { Schedule, ScheduleRun, Scheduler } from "../../schedule/scheduler.ts"
import { formatLocal, timezone, upcoming } from "../../schedule/cron.ts"

const STATUS: Record<string, string> = { running: "running", completed: "completed", failed: "failed", stopped: "stopped", needs_input: "needs input", skipped: "skipped (previous run still going)", blocked: "blocked", interrupted: "interrupted (app stopped)" }

function render(s: Schedule, scheduler: Scheduler) {
  const missing = scheduler.missingTools(s)
  return [
    `- ${s.id} "${s.title}" — ${s.agent}, cron "${s.cron}", ${s.enabled ? `next ${s.nextRunAt ? formatLocal(s.nextRunAt) : "?"}` : "paused"}`,
    s.lastRunAt ? `  last run ${formatLocal(s.lastRunAt)}: ${STATUS[s.lastStatus ?? ""] ?? s.lastStatus}${s.lastError ? ` (${s.lastError})` : ""}` : "  never run",
    s.tools?.length ? `  needs tools: ${s.tools.join(", ")}${missing.length ? ` — MISSING: ${missing.join(", ")} (runs are blocked until available)` : ""}` : "",
    `  goal: ${s.task.goal}`,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderRun(r: ScheduleRun) {
  return `- ${formatLocal(r.startedAt)} ${r.reason === "manual" ? "(manual) " : ""}${STATUS[r.status] ?? r.status}${r.error ? ` — ${r.error}` : ""}${r.sessionID ? ` [session ${r.sessionID}]` : ""}`
}

/**
 * Việc định kỳ của công ty. CEO nói "mỗi 2h sáng cho researcher đọc tin…" → CTO tạo lịch;
 * tới giờ harness tự mở phiên CTO mới, giao việc, CTO xử lý báo cáo theo `follow_up`.
 */
export function scheduleTool(scheduler: Scheduler) {
  return define({
    name: "schedule",
    description: `Recurring jobs: at set times the company wakes up by itself, gives a task to an employee (or to you), and you handle their report in a new conversation the CEO can read later.
- list: all schedules with next run and last result.
- create: title, agent (employee id, or your own id to do it yourself), cron, task (a brief like delegate's), optional follow_up (what you do with the report; default: store what is new with \`knowledge\` and summarise), optional tools (tool names the job cannot work without, e.g. ["facebook_*"]; runs are blocked, not wasted, until they exist).
- update: change any field (id + fields). enable / disable: resume or pause. remove: delete.
- run_now: run once immediately (does not change the timetable). history: recent runs of a schedule.
Cron has 5 fields "minute hour day-of-month month day-of-week" in server local time (${timezone()}): "0 2 * * *" = every day 02:00, "30 8 * * 1-5" = weekdays 08:30, "0 */6 * * *" = every 6 hours, "0 9 * * mon" = Mondays 09:00.
Write the task so it stands alone: the employee sees only the brief, every time. Confirm to the CEO in one line: what runs, when (next run), who does it.`,
    input: z.object({
      action: z.enum(["list", "create", "update", "enable", "disable", "remove", "run_now", "history"]),
      id: z.string().optional().describe("Schedule id (sch_…), for everything except list/create"),
      title: z.string().optional(),
      agent: z.string().optional().describe("Who does the work: employee id, or your own id"),
      cron: z.string().optional(),
      task: z
        .object({
          goal: z.string(),
          context: z.string(),
          done_when: z.string(),
          output: z.string().default("report"),
        })
        .optional(),
      follow_up: z.string().optional().describe("What you do when the report arrives"),
      tools: z.array(z.string()).optional().describe("Required tool names or globs"),
    }),
    permission: { action: "schedule", resource: (i) => i.action },
    concurrency: "serial",
    async execute(input, ctx) {
      const next = (s: Schedule) => (s.enabled ? `Next runs: ${upcoming(s.cron, Date.now(), 3).map(formatLocal).join(", ")} (${timezone()}).` : "Paused.")
      const warn = (s: Schedule) => {
        const missing = scheduler.missingTools(s)
        return missing.length ? `\nWARNING: tool ${missing.join(", ")} is not available yet, so runs will be marked blocked until it is added (e.g. via mcp_manage). Tell the CEO.` : ""
      }
      try {
        if (input.action === "list") return { output: scheduler.list().map((s) => render(s, scheduler)).join("\n") || "(no schedules)" }
        if (input.action === "create") {
          if (!input.title || !input.agent || !input.cron || !input.task) return { output: "create requires title, agent, cron and task", isError: true }
          const s = scheduler.create({ title: input.title, agent: input.agent, cron: input.cron, task: input.task, followUp: input.follow_up, tools: input.tools }, ctx.agent)
          return { output: `Created schedule ${s.id} "${s.title}" (${s.agent}, cron "${s.cron}"). ${next(s)}${warn(s)}` }
        }
        if (!input.id) return { output: `${input.action} requires id`, isError: true }
        if (!scheduler.get(input.id)) return { output: `No schedule "${input.id}". Use schedule(action: "list").`, isError: true }
        switch (input.action) {
          case "update": {
            const s = scheduler.update(input.id, { title: input.title, agent: input.agent, cron: input.cron, task: input.task, followUp: input.follow_up, tools: input.tools })
            return { output: `Updated ${s.id} "${s.title}". ${next(s)}${warn(s)}` }
          }
          case "enable":
          case "disable": {
            const s = scheduler.setEnabled(input.id, input.action === "enable")
            return { output: `${s.enabled ? "Enabled" : "Paused"} ${s.id} "${s.title}". ${next(s)}${s.enabled ? warn(s) : ""}` }
          }
          case "remove":
            scheduler.remove(input.id)
            return { output: `Removed schedule ${input.id}.` }
          case "run_now": {
            const r = await scheduler.runNow(input.id)
            if (r.status !== "running") return { output: `Could not start: ${STATUS[r.status] ?? r.status}${r.error ? ` — ${r.error}` : ""}`, isError: true }
            return { output: `Started in a separate conversation (${r.sessionID}). The result shows up there and in the schedule's history; do not wait for it here.` }
          }
          case "history":
            return { output: scheduler.runs(input.id, 10).map(renderRun).join("\n") || "(no runs yet)" }
        }
      } catch (e) {
        return { output: (e as Error).message, isError: true }
      }
      return { output: "unknown action", isError: true }
    },
  })
}
