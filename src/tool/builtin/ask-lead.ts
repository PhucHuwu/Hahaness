import { z } from "zod"
import { define } from "../define.ts"

/**
 * Nhân viên hỏi ngược người giao việc. Không chờ trong tool (người giao có thể đang chờ chính
 * nhân viên này → deadlock): tool kết thúc lượt, harness gửi báo cáo `status="needs_input"` lên
 * phiên cha; câu trả lời đến như message kế tiếp và nhân viên làm tiếp.
 */
export const askLead = define({
  name: "ask_lead",
  description: `Ask whoever assigned you this task a question, when you are blocked by missing information or by a decision that is not yours to make. Your turn ends right after this call; their answer arrives as the next message and you continue from there.
Check the brief and the workspace first. Ask once, with everything you need, and say what you have done so far.`,
  input: z.object({
    question: z.string().describe("What you need to know, self-contained"),
    options: z.array(z.string()).optional().describe("Possible answers, if it is a choice"),
    progress: z.string().optional().describe("What is already done, so the lead knows where you stand"),
  }),
  concurrency: "serial",
  async execute() {
    return { output: "Question sent to your lead. Stop here; their answer will arrive as the next message.", metadata: { endTurn: true } }
  },
})
