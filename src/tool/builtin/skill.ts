import { z } from "zod"
import { define } from "../define.ts"
import type { SkillStore } from "../../context/skills.ts"

export function skill(store: SkillStore) {
  return define({
    name: "skill",
    description: "Load the full instructions of a skill listed in <available_skills>. Call it before doing a task the skill covers.",
    input: z.object({ id: z.string() }),
    permission: { action: "skill", resource: (i) => i.id },
    async execute({ id }) {
      const content = await store.read(id)
      if (!content) {
        const ids = (await store.list()).map((s) => s.id)
        return { output: `No skill "${id}". Available: ${ids.join(", ") || "(none)"}`, isError: true }
      }
      return { output: content }
    },
  })
}
