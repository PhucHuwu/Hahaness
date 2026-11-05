import { z } from "zod"
import { define } from "../define.ts"
import type { Harness } from "../../harness.ts"
import { renderResult } from "../../harness.ts"
import type { AgentRegistry } from "../../agent/registry.ts"

export function delegate(agents: AgentRegistry) {
  return define({
    name: "delegate",
    description: `Assign work to an employee. They run in their own session, see only your brief (plus a summary of this conversation when context=fork), and only their final report comes back to you.

Actions:
- list: show current staff with their roles. Call this first if unsure who to use.
- spawn: give an employee a task. background=true returns immediately and the result arrives later as a message; use it to run several employees in parallel.
- steer: send feedback or a follow-up to an employee (sessionID + message). Also how you answer an employee whose report has status="needs_input".
- stop: cancel a running employee.

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
      sessionID: z.string().optional(),
      message: z.string().optional(),
    }),
    permission: { action: "delegate", resource: (i) => i.agent ?? "*" },
    concurrency: "parallel",
    timeoutMs: 30 * 60_000,
    async execute(input, ctx) {
      const harness = ctx.harness as Harness
      switch (input.action) {
        case "list": {
          const staff = agents.subagents().map((a) => `- ${a.id} (${a.name}): ${a.description}`).join("\n")
          const running = harness
            .list()
            .filter((l) => l.session.parentID === ctx.sessionID)
            .map((l) => `- ${l.session.id} ${l.agent.id} ${l.running ? "working" : "done"} — ${l.session.title}`)
          return { output: `Staff:\n${staff || "(none)"}\n\nAssignments from this session:\n${running.join("\n") || "(none)"}` }
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
          if ("status" in r && r.status === "running") return { output: `${input.agent} is working on it (session ${r.sessionID}). Their report will arrive as a message; continue with other work, do not poll.` }
          return { output: renderResult(r as any) }
        }
        case "steer": {
          if (!input.sessionID || !input.message) return { output: "steer requires sessionID and message", isError: true }
          if (!harness.has(input.sessionID)) {
            // Sau restart nhân viên đang chờ câu trả lời không còn trong bộ nhớ → nạp lại.
            const ok = await harness.resume(input.sessionID).then(() => true, () => false)
            if (!ok) return { output: `No session ${input.sessionID}`, isError: true }
          }
          void harness.send(input.sessionID, input.message, "steer", ctx.agent)
          return { output: `Message sent to ${input.sessionID}` }
        }
        case "stop": {
          if (!input.sessionID) return { output: "stop requires sessionID", isError: true }
          harness.interrupt(input.sessionID)
          return { output: `Stopped ${input.sessionID}` }
        }
      }
    },
  })
}
