import { z } from "zod"
import { define } from "../define.ts"

export type QuestionHandler = (question: string, options?: string[]) => Promise<string>

export function question(handler: QuestionHandler) {
  return define({
    name: "question",
    description: "Ask the CEO a question when a decision is needed. Only the primary agent may use this.",
    input: z.object({ question: z.string(), options: z.array(z.string()).optional() }),
    concurrency: "serial",
    timeoutMs: 10 * 60_000,
    async execute({ question, options }) {
      const answer = await handler(question, options)
      return { output: answer }
    },
  })
}
