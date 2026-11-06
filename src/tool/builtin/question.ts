import { z } from "zod"
import { define } from "../define.ts"

/**
 * Hỏi CEO. Không chờ trong tool (CEO có thể mở web lúc nào cũng được, kể cả hôm sau; trong lúc
 * chờ CTO vẫn phải nhận báo cáo và chạy lịch): tool kết thúc lượt, câu hỏi nằm trong lịch sử chat
 * dưới dạng tool-call; UI hiện nút trả lời, câu trả lời đến như tin nhắn kế tiếp của CEO.
 */
export const question = define({
  name: "question",
  description: `Ask the CEO a question when a decision is really theirs. Your turn ends right after this call; the CEO may answer much later, and their answer arrives as their next message.
Ask once, with everything you need. Offer options when it is a choice.`,
  input: z.object({
    question: z.string().describe("The question, self-contained"),
    options: z.array(z.string()).optional().describe("Possible answers, if it is a choice"),
  }),
  concurrency: "serial",
  async execute() {
    return { output: "Question shown to the CEO. Stop here; their answer will arrive as their next message.", metadata: { endTurn: true } }
  },
})
