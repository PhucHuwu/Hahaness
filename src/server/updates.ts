import { randomUUID } from "node:crypto"
import type { Db } from "../core/db.ts"

/**
 * Kiểm tra bản mới: hỏi một URL (mặc định GitHub Releases; sau này là kênh cập nhật của nhà cung cấp)
 * lúc khởi động và mỗi 24 giờ, chỉ để báo "Có bản mới" trên UI. Không tự cập nhật: khách chạy
 * `docker compose pull && up -d` (xem `docs/architecture/19-updates.md`).
 * - Gửi kèm `channel`, `v` (bản đang chạy) và `instance` (mã cài đặt) để server trả đúng kênh và
 *   sau này gắn license.
 * - `HAHANESS_UPDATE_URL=off` tắt hẳn (mạng nội bộ).
 */

export const DEFAULT_UPDATE_URL = "https://api.github.com/repos/PhucHuwu/Hahaness/releases/latest"
const INTERVAL_MS = 24 * 60 * 60 * 1000
const FIRST_DELAY_MS = 15_000
const TIMEOUT_MS = 10_000

export interface Release {
  version: string
  url?: string
  notes?: string
}

export interface UpdateState {
  current: string
  channel: string
  /** false khi tắt bằng HAHANESS_UPDATE_URL=off. */
  enabled: boolean
  latest: Release | null
  /** latest mới hơn current. */
  available: boolean
  checkedAt: string | null
  error: string | null
}

/** Mã cài đặt: sinh một lần, lưu trong settings, giữ nguyên qua các lần nâng cấp. */
export function instanceID(db: Db): string {
  const cur = db.getSetting<{ id: string }>("instance")
  if (cur?.id) return cur.id
  const id = randomUUID()
  db.setSetting("instance", { id, createdAt: new Date().toISOString() })
  return id
}

/** So sánh `1.2.3`, `v1.2.3`, `1.2.3-beta.1`: số từng phần; bản có hậu tố pre-release nhỏ hơn bản không có. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/i, "").split("-", 2)
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (!!x.pre === !!y.pre) return x.pre && y.pre ? x.pre.localeCompare(y.pre) : 0
  return x.pre ? -1 : 1
}

/** Chấp nhận cả dạng GitHub Releases (`tag_name`, `html_url`, `body`) lẫn dạng riêng (`version`, `url`, `notes`). */
export function parseRelease(body: unknown): Release | null {
  if (!body || typeof body !== "object") return null
  const o = body as Record<string, unknown>
  const version = typeof o.version === "string" ? o.version : typeof o.tag_name === "string" ? o.tag_name : undefined
  if (!version) return null
  const url = typeof o.url === "string" ? o.url : typeof o.html_url === "string" ? o.html_url : undefined
  const notes = typeof o.notes === "string" ? o.notes : typeof o.body === "string" ? o.body : undefined
  return { version: version.replace(/^v/i, ""), url, notes: notes?.slice(0, 4000) }
}

export interface UpdateCheckerOptions {
  current: string
  instance: string
  /** Mặc định DEFAULT_UPDATE_URL; `off` tắt. */
  url?: string
  channel?: string
  fetch?: typeof fetch
}

export class UpdateChecker {
  readonly state: UpdateState
  private readonly url: string | null
  private timer?: ReturnType<typeof setTimeout>

  constructor(private opts: UpdateCheckerOptions) {
    const raw = (opts.url ?? DEFAULT_UPDATE_URL).trim()
    this.url = !raw || raw.toLowerCase() === "off" ? null : raw
    this.state = { current: opts.current, channel: opts.channel?.trim() || "stable", enabled: !!this.url, latest: null, available: false, checkedAt: null, error: null }
  }

  /** Kiểm tra lần đầu sau vài giây (không chặn khởi động), rồi mỗi 24 giờ. Timer unref để không giữ process. */
  start() {
    if (!this.url || this.timer) return
    const tick = () => {
      void this.check().catch(() => {})
      this.timer = setTimeout(tick, INTERVAL_MS)
      this.timer.unref?.()
    }
    this.timer = setTimeout(tick, FIRST_DELAY_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  async check(): Promise<UpdateState> {
    if (!this.url) return this.state
    const s = this.state
    try {
      const u = new URL(this.url)
      u.searchParams.set("channel", s.channel)
      u.searchParams.set("v", s.current)
      u.searchParams.set("instance", this.opts.instance)
      const res = await (this.opts.fetch ?? fetch)(u, {
        headers: { accept: "application/json", "user-agent": `hahaness/${s.current}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 404) {
        // Chưa phát hành bản nào (GitHub trả 404 khi repo không có release).
        s.latest = null
        s.available = false
        s.error = null
      } else if (!res.ok) {
        s.error = `HTTP ${res.status}`
      } else {
        const rel = parseRelease(await res.json())
        if (!rel) throw new Error("unexpected response")
        s.latest = rel
        s.available = compareVersions(rel.version, s.current) > 0
        s.error = null
      }
    } catch (e) {
      s.error = (e as Error).message
    }
    s.checkedAt = new Date().toISOString()
    return s
  }
}
