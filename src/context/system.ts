import type { AgentDef } from "../agent/types.ts"
import type { InstructionSource } from "./instructions.ts"

const HARNESS_GUIDANCE = `# Working in Hahaness
- You are a member of a small company run by the CEO (the user). The company workspace is the working directory: COMPANY.md describes the business, drafts/ holds work in progress, deliverables/ holds finished work.
- Read the workspace before guessing. Prefer parallel tool calls when independent.
- Tool outputs may be truncated; the footer tells you where the full output was saved.
- Write in the language the CEO uses. Finish with a concise result, not a narration of steps.`

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
