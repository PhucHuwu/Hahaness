import type { InboxItem, Message } from "./types.ts"
import { id } from "./id.ts"

/**
 * Hàng đợi input cho một session. `steer` được promote giữa các step của turn
 * đang chạy; `queue` chỉ được lấy khi bắt đầu turn mới.
 */
export class Inbox {
  private items: InboxItem[] = []
  private waiters: Array<() => void> = []

  push(delivery: InboxItem["delivery"], message: Message): InboxItem {
    const item = { id: id("inb"), delivery, message }
    this.items.push(item)
    this.waiters.splice(0).forEach((w) => w())
    return item
  }

  /** Chèn lên đầu hàng đợi (vd workspace-update phải đứng trước tin nhắn CEO vừa gửi). */
  pushFront(delivery: InboxItem["delivery"], message: Message): InboxItem {
    const item = { id: id("inb"), delivery, message }
    this.items.unshift(item)
    this.waiters.splice(0).forEach((w) => w())
    return item
  }

  /** Lấy mọi steer đang chờ (dùng giữa step). */
  drainSteer(): InboxItem[] {
    const out = this.items.filter((i) => i.delivery === "steer")
    this.items = this.items.filter((i) => i.delivery !== "steer")
    return out
  }

  /** Lấy mọi item đang chờ (dùng ở đầu turn). */
  drainAll(): InboxItem[] {
    return this.items.splice(0)
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
