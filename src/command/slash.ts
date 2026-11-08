import type { Harness } from "../harness.ts"
import { readMemory, MEMORY_CAP } from "../context/workspace.ts"

/**
 * Lệnh slash dùng chung cho web và Telegram (`/help`, `/stop`, `/compact`…). Lệnh chạy ngay trên
 * harness, không đi qua model và không vào transcript; kết quả là một đoạn chữ trả cho CEO.
 * Xem `docs/architecture/17-slash-commands.md`.
 */

export interface CommandSpec {
  name: string
  aliases: string[]
  /** Gợi ý tham số, vd `[trọng tâm]`. */
  args?: string
  description: string
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", aliases: [], description: "Xem các lệnh" },
  { name: "stop", aliases: [], description: "Dừng việc đang làm" },
  { name: "status", aliases: [], description: "Ai đang làm gì" },
  { name: "compact", aliases: [], args: "[trọng tâm]", description: "Tóm gọn cuộc trò chuyện để đỡ tốn token" },
  { name: "usage", aliases: ["cost"], description: "Token và context đã dùng" },
  { name: "memory", aliases: [], description: "Những điều công ty đang ghi nhớ lâu dài" },
  { name: "staff", aliases: [], description: "Danh sách nhân viên" },
  { name: "new", aliases: ["clear"], description: "Bắt đầu cuộc trò chuyện mới; cuộc cũ vào Lịch sử cũ" },
]

export interface CommandResult {
  /** Lệnh đã nhận ra (tên chính), undefined nếu không có lệnh đó. */
  command?: string
  text: string
  /** `/new`: phiên mới để chuyển sang. */
  sessionID?: string
}

/** `/name args` (Telegram có thể thêm `@tên_bot`). Không phải dạng lệnh → undefined (gửi như tin nhắn thường). */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([a-z][\w-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return undefined
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() }
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name))
}

export function helpText(): string {
  const lines = COMMANDS.map((c) => {
    const alias = c.aliases.length ? ` (hoặc ${c.aliases.map((a) => `/${a}`).join(", ")})` : ""
    return `/${c.name}${c.args ? ` ${c.args}` : ""}${alias}: ${c.description}`
  })
  return `Các lệnh:\n${lines.join("\n")}`
}

const fmt = (n: number) => n.toLocaleString("vi-VN")

/** Chạy lệnh trong phiên chính `sessionID` (phải đang sống). */
export async function runCommand(harness: Harness, sessionID: string, text: string): Promise<CommandResult> {
  const parsed = parseCommand(text)
  const spec = parsed && findCommand(parsed.name)
  if (!parsed || !spec) return { text: `Không có lệnh ${parsed ? `/${parsed.name}` : text.trim()}. Gõ /help để xem các lệnh.` }
  const live = harness.get(sessionID)
  const reply = (text: string, sessionID?: string): CommandResult => ({ command: spec.name, text, ...(sessionID ? { sessionID } : {}) })
  const agents = harness.cfg.agents
  const nameOf = (id: string) => (agents.has(id) ? agents.get(id).name : id)

  switch (spec.name) {
    case "help":
      return reply(helpText())

    case "stop":
      if (!live.running) return reply(`${live.agent.name} đang rảnh.`)
      harness.interrupt(sessionID)
      return reply(`Đã dừng việc ${live.agent.name} đang làm.`)

    case "status": {
      const lines = harness
        .list()
        .filter((l) => l.session.id === harness.homeOf(l.agent.id))
        .flatMap((l) => {
          const w = harness.work(l)
          const queued = w.queued ? ` (${w.queued} việc chờ)` : ""
          if (w.status === "waiting") return [`${l.agent.name}: đang chờ trả lời${w.goal ? ` · ${w.goal}` : ""}${queued}`]
          if (w.status === "working") return [`${l.agent.name}: đang làm${w.goal ? `: ${w.goal}` : ""}${queued}`]
          return []
        })
      return reply(lines.length ? `Đang làm việc:\n${lines.join("\n")}` : "Mọi người đang rảnh.")
    }

    case "usage": {
      const r = await harness.usageReport(sessionID)
      const staff = r.children.reduce((n, c) => n + c.total.inputTokens + c.total.outputTokens, 0)
      return reply(
        [
          `Model: ${r.model}`,
          `Context hiện tại: ~${fmt(r.estimatedContext)}${r.contextWindow ? ` / ${fmt(r.contextWindow)}` : ""} token${r.ceiling ? ` (tự tóm gọn ở ~${fmt(r.ceiling)})` : ""}`,
          `Đã dùng: ${fmt(r.total.calls)} lần gọi model, ${fmt(r.total.inputTokens)} token vào, ${fmt(r.total.outputTokens)} token ra${r.total.cacheReadTokens ? `, ${fmt(r.total.cacheReadTokens)} token đọc từ cache` : ""}`,
          staff ? `Nhân viên: ${fmt(staff)} token (${r.children.map((c) => nameOf(c.agent)).filter((v, i, a) => a.indexOf(v) === i).join(", ")})` : "",
          "Chi tiết: nút token ở đầu cuộc trò chuyện trên web.",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    case "memory": {
      const entries = readMemory(harness.cfg.docs)
      if (!entries.length) return reply("Chưa ghi nhớ điều gì. Cứ dặn CTO \"nhớ giúp…\" là được.")
      const used = entries.join("\n§\n").length
      return reply(`Đang ghi nhớ (${fmt(used)}/${fmt(MEMORY_CAP)} ký tự):\n${entries.map((e, i) => `${i + 1}. ${e}`).join("\n")}`)
    }

    case "staff": {
      const list = agents.list()
      return reply(`Nhân sự (${list.length}):\n${list.map((a) => `${a.name} (${a.id})${a.mode === "primary" ? " · trợ lý chính" : ""}${a.description ? `: ${a.description}` : ""}`).join("\n")}`)
    }

    case "compact": {
      if (live.running) return reply(`${live.agent.name} đang làm việc. Chờ xong (hoặc /stop) rồi /compact.`)
      try {
        const r = await harness.compact(sessionID, parsed.args)
        if (r.aborted) return reply("Đã hủy tóm gọn.")
        if (!r.compacted) return reply("Chưa tóm gọn được: cuộc trò chuyện còn ngắn, hoặc model tóm tắt đang lỗi (thử lại sau).")
        return reply(`Đã tóm gọn cuộc trò chuyện: context ~${fmt(r.before)} → ~${fmt(r.after)} token.${parsed.args ? ` Giữ chi tiết về: ${parsed.args}` : ""}`)
      } catch (e) {
        return reply(`Không tóm gọn được: ${(e as Error).message}`)
      }
    }

    case "new": {
      if (live.running) return reply(`${live.agent.name} đang làm việc. Chờ xong (hoặc /stop) rồi /new.`)
      if (live.task || live.tasks.length) return reply(`${live.agent.name} đang có việc được giao chưa xong; không thể bắt đầu cuộc trò chuyện mới lúc này.`)
      const fresh = await harness.newSession(live.agent.id)
      return reply(`Đã bắt đầu cuộc trò chuyện mới với ${live.agent.name}. Cuộc cũ nằm trong "Lịch sử cũ". Những gì công ty ghi nhớ (/memory) và tài liệu vẫn giữ nguyên.`, fresh.session.id)
    }
  }
  return reply(helpText())
}
