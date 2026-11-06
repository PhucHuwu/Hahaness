import { z } from "zod"
import { define } from "../define.ts"
import type { Harness } from "../../harness.ts"
import { renderResult, type ResultEntry } from "../../harness.ts"
import type { AgentRegistry } from "../../agent/registry.ts"

export function delegate(agents: AgentRegistry) {
  return define({
    name: "delegate",
    description: `Assign work to an employee. Each employee has one ongoing conversation of their own; your brief goes into it. They see only your brief (plus a summary of this conversation when context=fork) and what they did before, and only their final report comes back to you. If they are busy, the task waits in their queue.

Actions:
- list: show staff, their roles and what each is doing now. Call this first if unsure who to use.
- spawn: give an employee a task. background=true returns immediately and the result arrives later as a message; use it to run several employees in parallel.
- steer: send feedback or a follow-up to an employee (agent + message). Also how you answer an employee whose report has status="needs_input".
- stop: cancel what an employee is doing now (agent).

If no employee fits, use \`hire\` first.`,
    input: z.object({
      action: z.enum(["list", "spawn", "steer", "stop"]).default("spawn"),
      agent: z.string().optional().describe("Employee id"),
      brief: z
        .object({
          goal: z.string().describe("1-2 sentences, the outcome wanted"),
          context: z.string().describe("What they need to know: audience, facts, files in the workspace, constraints"),
          done_when: z.string().describe("How you will judge the result is complete"),
          output: z.string().default("report").describe("Expected form: report | document | list | json"),
        })
        .optional(),
      context: z.enum(["isolated", "fork"]).optional(),
      background: z.boolean().default(false),
      sessionID: z.string().optional().describe("Alternative to agent for steer/stop: the employee's session id from a report"),
      message: z.string().optional(),
    }),
    permission: { action: "delegate", resource: (i) => i.agent ?? "*" },
    concurrency: "parallel",
    timeoutMs: 30 * 60_000,
    async execute(input, ctx) {
      const harness = ctx.harness as Harness
      // steer/stop: theo id nhân viên; sessionID (từ báo cáo) cũng được.
      const target = async () => {
        if (input.agent) {
          if (!agents.has(input.agent)) return undefined
          return harness.sessionFor(input.agent)
        }
        if (!input.sessionID) return undefined
        // Id phiên (kể cả phiên cũ) → phiên hiện tại của nhân viên đó.
        const agent = harness.has(input.sessionID) ? harness.get(input.sessionID).agent.id : (await harness.store.listSessions()).find((s) => s.id === input.sessionID)?.agent
        return agent && agents.has(agent) ? harness.sessionFor(agent) : undefined
      }
      switch (input.action) {
        case "list": {
          const staff = agents.subagents().map((a) => {
            const home = harness.homeOf(a.id)
            const w = home && harness.has(home) ? harness.work(harness.get(home)) : undefined
            const now = !w || w.status === "idle" ? "free" : `${w.status === "waiting" ? "waiting for an answer" : "working"}${w.goal ? ` on "${w.goal.slice(0, 80)}"` : ""}${w.from ? ` (from ${w.from})` : ""}`
            return `- ${a.id} (${a.name}): ${a.description} — ${now}${w?.queued ? `, ${w.queued} queued` : ""}`
          })
          return { output: `Staff:\n${staff.join("\n") || "(none)"}` }
        }
        case "spawn": {
          if (!input.agent || !input.brief) return { output: "spawn requires agent and brief", isError: true }
          if (!agents.has(input.agent)) return { output: `No employee "${input.agent}". Use delegate(action: "list") to see staff, or hire one.`, isError: true }
          const r = await harness.spawn(ctx.sessionID, {
            agent: input.agent,
            brief: input.brief,
            context: input.context,
            background: input.background,
            signal: ctx.signal,
          })
          if ("status" in r && (r.status === "running" || r.status === "queued"))
            return { output: `${input.agent} ${r.status === "queued" ? "is busy; the task is queued and starts when they finish" : "is working on it"}. Their report will arrive as a message; continue with other work, do not poll.` }
          return { output: renderResult(r as ResultEntry) }
        }
        case "steer": {
          if (!input.message) return { output: "steer requires agent and message", isError: true }
          const live = await target()
          if (!live) return { output: `No employee ${input.agent ?? input.sessionID}`, isError: true }
          void harness.send(live.session.id, input.message, "steer", ctx.agent)
          return { output: `Message sent to ${live.agent.id}` }
        }
        case "stop": {
          const live = await target()
          if (!live) return { output: `No employee ${input.agent ?? input.sessionID}`, isError: true }
          harness.interrupt(live.session.id)
          return { output: `Stopped ${live.agent.id}` }
        }
      }
    },
  })
}
