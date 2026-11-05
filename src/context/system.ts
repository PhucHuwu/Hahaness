import type { AgentDef } from "../agent/types.ts"
import type { InstructionSource } from "./instructions.ts"

const HARNESS_GUIDANCE = `# Harness
- You are running inside Hahaness, a multi-agent harness. The user is the CEO.
- Use tools to inspect before acting. Prefer parallel tool calls when independent.
- Tool outputs may be truncated; the footer tells you where the full output was saved.
- When finished, reply with a concise result. Do not narrate every step.`

export interface SystemInput {
  agent: AgentDef
  instructions: InstructionSource[]
  skillsIndex?: string
  workspaceMemory?: string
}

/**
 * Tier A (identity + guidance + skills) và Tier B (project instructions + env + memory).
 * Cả hai đóng băng trong session; thay đổi đi qua messages.
 */
export function build(input: SystemInput): string[] {
  const tierA = [input.agent.system.trim(), HARNESS_GUIDANCE, input.skillsIndex].filter(Boolean).join("\n\n")
  const tierB = [...input.instructions.map((s) => s.content), input.workspaceMemory].filter(Boolean).join("\n\n")
  return tierB ? [tierA, tierB] : [tierA]
}
