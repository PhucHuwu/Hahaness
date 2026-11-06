import { z } from "zod"
import { define } from "../define.ts"
import type { AgentRegistry } from "../../agent/registry.ts"

export function hire(agents: AgentRegistry) {
  return define({
    name: "hire",
    description: `Create a new employee role when nobody on staff fits a job. The role persists for future conversations. After hiring, use \`delegate\` to give them work.

Write the job description (system) as you would for a real hire: who they are, what they produce, what good looks like, what they must not do. Keep capabilities minimal: most roles need only read; add webfetch/websearch for research roles, write for roles that produce documents, bash for roles that must compute or process files (data analysis, spreadsheets, charts).`,
    input: z.object({
      id: z.string().describe("Short slug, e.g. seo-specialist"),
      name: z.string(),
      description: z.string().describe("One line: what this role is for. Shown to you when listing staff."),
      system: z.string().describe("Full job description / instructions for the employee"),
      capabilities: z.array(z.enum(["read", "write", "webfetch", "websearch", "bash"])).default(["read"]),
    }),
    permission: { action: "hire", resource: (i) => i.id },
    concurrency: "serial",
    async execute(input) {
      if (agents.has(input.id)) return { output: `An employee with id "${input.id}" already exists. Use delegate to assign work, or pick a different id.`, isError: true }
      const def = await agents.hire(input)
      return { output: `Hired ${def.name} (${def.id}): ${def.description}\nCapabilities: ${input.capabilities.join(", ")}. You can now delegate to "${def.id}".` }
    },
  })
}
