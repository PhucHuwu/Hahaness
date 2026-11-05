import { z } from "zod"
import { define } from "../define.ts"
import type { Harness } from "../../harness.ts"
import { renderResult } from "../../harness.ts"
import type { AgentDef } from "../../agent/types.ts"

export function delegate(agents: AgentDef[]) {
  const list = agents.map((a) => `- ${a.id}: ${a.description}`).join("\n")
  return define({
    name: "delegate",
    description: `Delegate a task to a specialist subagent in its own session. The subagent only sees your brief (plus a summary of this conversation when context=fork), and only its final report comes back.

Available subagents:
${list}

Actions:
- spawn: start a task. background=true returns immediately; the result arrives later as a message.
- steer: send a follow-up message to a running subagent (sessionID + message).
- stop: abort a running subagent.
- list: show subagents of this session.`,
    input: z.object({
      action: z.enum(["spawn", "steer", "stop", "list"]).default("spawn"),
      agent: z.string().optional(),
      brief: z
        .object({
          goal: z.string().describe("1-2 sentences, the outcome wanted"),
          context: z.string().describe("What the subagent needs to know: files, decisions, constraints"),
          done_when: z.string().describe("Verifiable completion criteria"),
          output: z.string().default("report"),
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
        case "spawn": {
          if (!input.agent || !input.brief) return { output: "spawn requires agent and brief", isError: true }
          const r = await harness.spawn(ctx.sessionID, {
            agent: input.agent,
            brief: input.brief,
            context: input.context,
            background: input.background,
          })
          if ("status" in r && r.status === "running") return { output: `Spawned ${input.agent} as ${r.sessionID} in background. Its result will arrive as a message; do not poll.` }
          return { output: renderResult(r as any) }
        }
        case "steer": {
          if (!input.sessionID || !input.message) return { output: "steer requires sessionID and message", isError: true }
          void harness.send(input.sessionID, input.message, "steer")
          return { output: `Steered ${input.sessionID}` }
        }
        case "stop": {
          if (!input.sessionID) return { output: "stop requires sessionID", isError: true }
          harness.interrupt(input.sessionID)
          return { output: `Stopped ${input.sessionID}` }
        }
        case "list": {
          const rows = harness
            .list()
            .filter((l) => l.session.parentID === ctx.sessionID)
            .map((l) => `${l.session.id} ${l.agent.id} ${l.running ? "running" : "idle"} — ${l.session.title}`)
          return { output: rows.join("\n") || "No subagents" }
        }
      }
    },
  })
}
