import { z } from "zod"
import { define } from "../define.ts"
import { readMemory, writeMemory, MEMORY_CAP } from "../../context/workspace.ts"

export const memory = define({
  name: "memory",
  description: `Long-term memory about the company and the CEO, carried into future conversations. Keep entries short and factual (decisions, preferences, recurring facts). Capacity is ${MEMORY_CAP} characters; oldest entries are dropped when full. Changes become part of the system context in the NEXT conversation; within this one, rely on what this tool returns.`,
  input: z.object({
    action: z.enum(["list", "add", "replace", "remove"]),
    text: z.string().optional().describe("Entry text for add/replace"),
    index: z.number().int().min(0).optional().describe("Entry index for replace/remove (from list)"),
  }),
  permission: { action: "memory" },
  concurrency: "serial",
  async execute({ action, text, index }, ctx) {
    const entries = await readMemory(ctx.cwd)
    switch (action) {
      case "list":
        break
      case "add":
        if (!text) return { output: "add requires text", isError: true }
        entries.push(text.trim())
        break
      case "replace":
        if (index === undefined || !text || !entries[index]) return { output: "replace requires a valid index and text", isError: true }
        entries[index] = text.trim()
        break
      case "remove":
        if (index === undefined || !entries[index]) return { output: "remove requires a valid index", isError: true }
        entries.splice(index, 1)
        break
    }
    if (action !== "list") await writeMemory(ctx.cwd, entries)
    const listing = entries.map((e, i) => `${i}. ${e}`).join("\n") || "(empty)"
    return { output: `Memory (${entries.join("").length}/${MEMORY_CAP} chars):\n${listing}` }
  },
})
