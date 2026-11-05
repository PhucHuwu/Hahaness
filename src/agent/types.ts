import type { Ruleset } from "../permission/ruleset.ts"

export interface AgentDef {
  id: string
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  /** Danh sách = fallback theo thứ tự. */
  model: string[]
  steps: number
  context: "isolated" | "fork"
  role: "leaf" | "orchestrator"
  permissions: Ruleset
  system: string
}

export const DEFAULTS: Omit<AgentDef, "id" | "name" | "description" | "system"> = {
  mode: "subagent",
  model: [],
  steps: 60,
  context: "isolated",
  role: "leaf",
  permissions: [],
}
