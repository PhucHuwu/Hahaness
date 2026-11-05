import type { Ruleset } from "../permission/ruleset.ts"
import { whollyDisabled } from "../permission/ruleset.ts"
import type { ToolDefinition } from "../provider/types.ts"
import type { Tool } from "./define.ts"

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(...tools: Tool[]) {
    for (const t of tools) this.tools.set(t.name, t)
    return this
  }

  get(name: string) {
    return this.tools.get(name)
  }

  /** Tool khả dụng cho một ruleset: bỏ tool bị deny toàn bộ để tiết kiệm token. */
  snapshot(ruleset: Ruleset): { tools: Tool[]; definitions: ToolDefinition[] } {
    const tools = [...this.tools.values()].filter((t) => {
      const action = t.permission?.action ?? t.name
      return !whollyDisabled(ruleset, action) && !whollyDisabled(ruleset, t.name)
    })
    return { tools, definitions: tools.map((t) => t.definition()) }
  }
}
