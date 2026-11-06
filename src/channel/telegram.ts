import { randomBytes } from "node:crypto"
import type { Db } from "../core/db.ts"
import type { Message, Outcome, Part } from "../core/types.ts"
import { attach, UploadError } from "../upload/attachments.ts"
import type { Harness } from "../harness.ts"

/**
 * Kênh Telegram: CEO chat với CTO qua bot Telegram, ngoài giao diện web.
 * - Nhận tin bằng long polling (`getUpdates`): không cần URL công khai hay HTTPS.
 * - Ảnh và file (PDF/Excel/Word/CSV) được tải về và đính kèm như trên web (`upload/attachments.ts`).
 * - Chỉ MỘT chat được liên kết (CEO). Liên kết bằng mã ghép nối hiện trên trang Cài đặt
 *   (`/start <mã>`); chat khác bị từ chối.
 * - Tin của CEO → `harness.send` vào phiên duy nhất của CTO, như gõ trên web.
 * - Lượt của CTO kết thúc → gửi câu trả lời cuối (và câu hỏi `question` kèm nút lựa chọn) về Telegram,
 *   bất kể tin đến từ web, Telegram hay lịch định kỳ.
 * Xem `docs/architecture/13-telegram.md`.
 */

export const TELEGRAM_KEY = "telegram"

export interface TelegramSettings {
  token: string
  /** Chat đã liên kết (CEO). */
  chatID?: number
  chatName?: string
  /** Mã ghép nối còn hiệu lực khi chưa liên kết. */
  pairCode?: string
  /** update_id kế tiếp cần lấy; lưu để restart không xử lý lại tin cũ. */
  offset?: number
}

export interface TelegramStatus {
  configured: boolean
  bot?: string
  linked?: string
  pairCode?: string
  running: boolean
  error?: string
}

type Fetch = typeof fetch

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    caption?: string
    photo?: Array<{ file_id: string; file_size?: number; width: number }>
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
    chat: { id: number; type: string; first_name?: string; last_name?: string; username?: string; title?: string }
  }
}

/** Telegram giới hạn 4096 ký tự mỗi tin. */
const MAX_LEN = 4000
const POLL_TIMEOUT = 25
const RETRY_MS = 5_000
/** Bot API chỉ cho tải file ≤ 20 MB. */
const TG_MAX_DOWNLOAD = 20 * 1024 * 1024

export class TelegramChannel {
  private abort?: AbortController
  private bot?: string
  private error?: string
  /** Số message của phiên CTO lúc lượt bắt đầu → lúc kết thúc chỉ gửi phần mới. */
  private cursor = new Map<string, number>()

  constructor(
    private db: Db,
    private harness: () => Harness | undefined,
    private opts: { fetch?: Fetch; apiBase?: string; retryMs?: number } = {},
  ) {}

  settings(): TelegramSettings | undefined {
    return this.db.getSetting<TelegramSettings>(TELEGRAM_KEY)
  }

  private save(s: TelegramSettings | undefined) {
    if (s) this.db.setSetting(TELEGRAM_KEY, s)
    else this.db.sql.prepare("DELETE FROM settings WHERE key = ?").run(TELEGRAM_KEY)
  }

  status(): TelegramStatus {
    const s = this.settings()
    return {
      configured: !!s,
      bot: this.bot,
      linked: s?.chatID ? (s.chatName ?? String(s.chatID)) : undefined,
      pairCode: s && !s.chatID ? s.pairCode : undefined,
      running: !!this.abort,
      error: this.error,
    }
  }

  /** Lưu token mới (kiểm tra bằng getMe), tạo mã ghép nối, chạy lại polling. */
  async configure(token: string): Promise<TelegramStatus> {
    token = token.trim()
    const me = await this.call<{ username: string }>(token, "getMe", {})
    const old = this.settings()
    const same = old?.token === token
    this.stop()
    this.save(same ? old : { token, pairCode: pairCode() })
    this.bot = me.username
    this.start()
    return this.status()
  }

  /** Bỏ liên kết chat hiện tại; tạo mã ghép nối mới. */
  unlink(): TelegramStatus {
    const s = this.settings()
    if (s) this.save({ token: s.token, offset: s.offset, pairCode: pairCode() })
    return this.status()
  }

  remove() {
    this.stop()
    this.save(undefined)
    this.bot = undefined
    this.error = undefined
  }

  start() {
    const s = this.settings()
    if (!s || this.abort) return
    const abort = new AbortController()
    this.abort = abort
    void this.poll(abort.signal)
  }

  stop() {
    this.abort?.abort()
    this.abort = undefined
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted) {
      const s = this.settings()
      if (!s) return
      try {
        if (!this.bot) this.bot = (await this.call<{ username: string }>(s.token, "getMe", {}, signal)).username
        const updates = await this.call<TgUpdate[]>(s.token, "getUpdates", { offset: s.offset, timeout: POLL_TIMEOUT, allowed_updates: ["message"] }, signal)
        this.error = undefined
        for (const u of updates) {
          // Ghi offset trước khi xử lý: restart giữa chừng thì bỏ tin đó, không xử lý hai lần.
          const cur = this.settings()
          if (!cur) return
          this.save({ ...cur, offset: u.update_id + 1 })
          await this.handle(u).catch((e) => (this.error = (e as Error).message))
        }
      } catch (e) {
        if (signal.aborted) return
        this.error = (e as Error).message
        await sleep(this.opts.retryMs ?? RETRY_MS, signal)
      }
    }
  }

  private async handle(u: TgUpdate) {
    const msg = u.message
    if (!msg) return
    const s = this.settings()!
    const chat = msg.chat
    const text = (msg.text ?? msg.caption ?? "").trim()
    if (s.chatID !== chat.id) {
      const code = /^\/start\s+(\S+)/.exec(text)?.[1] ?? text
      if (!s.chatID && s.pairCode && code === s.pairCode && chat.type === "private") {
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id)
        this.save({ token: s.token, offset: this.settings()?.offset, chatID: chat.id, chatName: name })
        await this.send(chat.id, "Đã liên kết. Từ giờ bạn nhắn ở đây là nói chuyện với CTO; CTO trả lời và hỏi bạn cũng qua đây.\nLệnh: /stop dừng việc CTO đang làm, /status xem CTO đang làm gì.")
        return
      }
      await this.send(chat.id, s.chatID ? "Bot này đã được liên kết với người khác." : "Bot chưa liên kết. Gửi mã ghép nối hiện ở trang Cài đặt của Hahaness.")
      return
    }
    const file = msg.document
      ? { id: msg.document.file_id, name: msg.document.file_name ?? "file", mime: msg.document.mime_type, size: msg.document.file_size }
      : msg.photo?.length
        ? (() => {
            const p = msg.photo!.reduce((a, b) => (b.width > a.width ? b : a))
            return { id: p.file_id, name: `anh-${msg.message_id}.jpg`, mime: "image/jpeg", size: p.file_size }
          })()
        : undefined
    if (!text && !file) {
      await this.send(chat.id, "Hiện chỉ đọc được chữ, ảnh và file (PDF, Excel, Word, CSV).")
      return
    }
    const harness = this.harness()
    if (!harness) return this.send(chat.id, "Hệ thống chưa sẵn sàng.")
    const cto = await harness.sessionFor(primaryAgent(harness))
    if (text === "/start") return this.send(chat.id, "Đã liên kết rồi. Cứ nhắn cho CTO.")
    if (text === "/stop") {
      if (cto.running) harness.interrupt(cto.session.id)
      return this.send(chat.id, cto.running ? "Đã dừng việc CTO đang làm." : "CTO đang rảnh.")
    }
    if (text === "/status") {
      const busy = harness.list().filter((l) => l.running || l.task).map((l) => l.agent.name)
      return this.send(chat.id, busy.length ? `Đang làm việc: ${busy.join(", ")}.` : "Mọi người đang rảnh.")
    }
    let parts: Part[] = []
    if (file) {
      if ((file.size ?? 0) > TG_MAX_DOWNLOAD) return this.send(chat.id, "Telegram chỉ cho bot tải file tối đa 20 MB. File lớn hơn thì gửi qua web.")
      try {
        parts = await attach(harness.cfg.docs, [{ name: file.name, mime: file.mime, data: await this.download(s.token, file.id) }])
      } catch (e) {
        return this.send(chat.id, e instanceof UploadError ? e.message : `Không tải được file: ${(e as Error).message}`)
      }
    }
    void harness.send(cto.session.id, text, "steer", "ceo", parts)
  }

  private async download(token: string, fileID: string): Promise<Buffer> {
    const f = await this.call<{ file_path?: string }>(token, "getFile", { file_id: fileID })
    if (!f.file_path) throw new Error("Telegram không trả đường dẫn file")
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.apiBase ?? "https://api.telegram.org"}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Nối vào LoopEvents.onTurnStart. */
  turnStarted(sessionID: string) {
    const s = this.settings()
    const harness = this.harness()
    if (!s?.chatID || !harness || !this.isCto(harness, sessionID)) return
    if (!this.cursor.has(sessionID)) this.cursor.set(sessionID, harness.get(sessionID).messages.length)
    void this.call(s.token, "sendChatAction", { chat_id: s.chatID, action: "typing" }).catch(() => {})
  }

  /** Nối vào LoopEvents.onTurnEnd: gửi câu trả lời cuối của CTO (và câu hỏi nếu có). */
  turnEnded(sessionID: string, outcome: Outcome): Promise<void> | undefined {
    const s = this.settings()
    const harness = this.harness()
    if (!s?.chatID || !harness || !this.isCto(harness, sessionID)) return
    const messages = harness.get(sessionID).messages
    const from = this.cursor.get(sessionID) ?? Math.max(0, messages.length - 1)
    this.cursor.delete(sessionID)
    const out = replyOf(messages.slice(from))
    const chatID = s.chatID
    if (outcome.tag === "failed") return this.send(chatID, `CTO gặp lỗi: ${outcome.error.message.slice(0, 500)}`).catch(() => {})
    if (outcome.tag === "interrupted") return
    const sends: Promise<unknown>[] = []
    if (out.text) sends.push(this.send(chatID, out.text))
    if (out.question) {
      const keyboard = out.question.options?.length ? { keyboard: out.question.options.map((o) => [{ text: o }]), one_time_keyboard: true, resize_keyboard: true } : undefined
      sends.push(this.send(chatID, `❓ ${out.question.text}`, keyboard))
    }
    return Promise.all(sends).then(() => {}, (e) => void (this.error = (e as Error).message))
  }

  private isCto(harness: Harness, sessionID: string) {
    return harness.has(sessionID) && harness.homeOf(primaryAgent(harness)) === sessionID
  }

  async send(chatID: number, text: string, keyboard?: unknown) {
    const s = this.settings()
    if (!s) return
    const chunks = split(text)
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1
      await this.call(s.token, "sendMessage", {
        chat_id: chatID,
        text: chunks[i],
        ...(last && keyboard ? { reply_markup: keyboard } : last ? { reply_markup: { remove_keyboard: true } } : {}),
      })
    }
  }

  private async call<T>(token: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const f = this.opts.fetch ?? fetch
    const timeout = AbortSignal.timeout((POLL_TIMEOUT + 15) * 1000)
    const res = await f(`${this.opts.apiBase ?? "https://api.telegram.org"}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
    if (!data.ok) {
      if (res.status === 401 || res.status === 404) throw new Error("Token bot Telegram không đúng.")
      if (res.status === 409) throw new Error("Bot đang được một chương trình khác dùng (webhook hoặc server khác). Tắt chỗ đó rồi thử lại.")
      throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`)
    }
    return data.result as T
  }
}

function primaryAgent(harness: Harness) {
  return harness.cfg.agents.list("primary")[0]?.id ?? "cto"
}

/** Câu trả lời cuối của lượt (assistant message cuối có chữ) và câu hỏi `question` nếu lượt kết thúc bằng nó. */
export function replyOf(messages: Message[]): { text: string; question?: { text: string; options?: string[] } } {
  let text = ""
  let question: { text: string; options?: string[] } | undefined
  for (const m of messages) {
    if (m.role !== "assistant") continue
    const t = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim()
    if (t) text = t
    const done = new Set(m.parts.flatMap((p) => (p.type === "tool-result" && !p.isError ? [p.callID] : [])))
    for (const p of m.parts) {
      if (p.type === "tool-call" && p.name === "question" && done.has(p.callID)) {
        const a = (p.args ?? {}) as { question?: string; options?: string[] }
        if (a.question) question = { text: a.question, options: a.options }
      }
    }
  }
  return { text, question }
}

function split(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_LEN)
    if (cut < MAX_LEN / 2) cut = MAX_LEN
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, "")
  }
  if (rest) out.push(rest)
  return out
}

function pairCode() {
  return randomBytes(4).toString("hex")
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })
}
