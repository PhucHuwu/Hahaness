import { z } from "zod"
import { define } from "../define.ts"

const lists = new Map<string, Array<{ text: string; status: "pending" | "in_progress" | "done" }>>()

export const todo = define({
  name: "todo",
  description: "Maintain a short task list for the current session. Pass the full list each time; it replaces the previous one.",
  input: z.object({
    items: z.array(z.object({ text: z.string(), status: z.enum(["pending", "in_progress", "done"]) })),
  }),
  async execute({ items }, ctx) {
    lists.set(ctx.sessionID, items)
    const mark = { pending: "[ ]", in_progress: "[~]", done: "[x]" }
    return { output: items.map((i) => `${mark[i.status]} ${i.text}`).join("\n") || "(empty)" }
  },
})
