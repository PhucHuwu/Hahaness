import type { InboxItem, Message } from "./types.ts"
import { id } from "./id.ts"

/** Ghi lại thay đổi của inbox (harness lưu xuống store để restart không mất tin chưa xử lý). */
export interface InboxLog {
  added(item: InboxItem, front: boolean): void
  taken(ids: string[]): void
}

/**
 * Hàng đợi input cho một session. `steer` được promote giữa các step của turn
 * đang chạy; `queue` chỉ được lấy khi bắt đầu turn mới.
 */
export class Inbox {
  private items: InboxItem[] = []
  private waiters: Array<() => void> = []

  constructor(private log?: InboxLog) {}

  push(delivery: InboxItem["delivery"], message: Message): InboxItem {
    const item = { id: id("inb"), delivery, message }
    this.items.push(item)
    this.log?.added(item, false)
    this.waiters.splice(0).forEach((w) => w())
    return item
  }

  /** Chèn lên đầu hàng đợi (vd workspace-update phải đứng trước tin nhắn CEO vừa gửi). */
  pushFront(delivery: InboxItem["delivery"], message: Message): InboxItem {
    const item = { id: id("inb"), delivery, message }
    this.items.unshift(item)
    this.log?.added(item, true)
    this.waiters.splice(0).forEach((w) => w())
    return item
  }

  /** Nạp lại item đã lưu (sau restart); không ghi lại lần nữa. */
  restore(items: InboxItem[]) {
    this.items.push(...items)
  }

  /** Lấy mọi steer đang chờ (dùng giữa step). */
  drainSteer(): InboxItem[] {
    const out = this.items.filter((i) => i.delivery === "steer")
    this.items = this.items.filter((i) => i.delivery !== "steer")
    return this.took(out)
  }

  /** Lấy mọi item đang chờ (dùng ở đầu turn). */
  drainAll(): InboxItem[] {
    return this.took(this.items.splice(0))
  }

  private took(out: InboxItem[]) {
    if (out.length) this.log?.taken(out.map((i) => i.id))
    return out
  }

  /** Xem mà không lấy ra (UI hiện báo cáo còn chờ trong inbox). */
  pending(): readonly InboxItem[] {
    return this.items
  }

  get size() {
    return this.items.length
  }

  /** Chờ tới khi có item hoặc signal bị abort. */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.items.length > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done)
        resolve()
      }
      this.waiters.push(done)
      signal?.addEventListener("abort", done, { once: true })
    })
  }
}
