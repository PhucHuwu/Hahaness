import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import type { McpManager } from "../mcp/manager.ts"
import type { McpServerConfig } from "../mcp/client.ts"

/**
 * Chợ ứng dụng: danh mục tĩnh `catalog.json` do nhà cung cấp phát hành, instance tải về và cài
 * bằng một nút. Hiện chỉ có loại `mcp` (cấu hình server MCP ghi thẳng vào `mcp_servers`).
 * - Nguồn: HAHANESS_CATALOG_URL (mặc định file trong repo trên GitHub; `file://` cho catalog nội bộ),
 *   cache 1 giờ; tải lỗi thì dùng bản đóng gói sẵn `catalog.json` cạnh package.json (mạng nội bộ vẫn có chợ).
 * - Cài = `McpManager.add(id, config)`; gỡ dùng route MCP sẵn có. Xem `docs/architecture/20-marketplace.md`.
 */

export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/PhucHuwu/Hahaness/main/catalog.json"
const CACHE_MS = 60 * 60 * 1000
const TIMEOUT_MS = 10_000

const ItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  kind: z.literal("mcp"),
  title: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  publisher: z.string().optional(),
  homepage: z.string().url().optional(),
  /** Mục trả phí: chỉ cài được khi giấy phép còn hạn. Mục đã cài không bị ảnh hưởng. */
  requiresLicense: z.boolean().default(false),
  config: z.discriminatedUnion("type", [
    z.object({ type: z.literal("http"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
    z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  ]),
})
export const CatalogSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().optional(),
  items: z.array(ItemSchema),
})
export type CatalogItem = z.infer<typeof ItemSchema>
export type Catalog = z.infer<typeof CatalogSchema>

export interface MarketplaceView {
  /** `remote` khi tải được từ URL, `bundled` khi dùng file trong gói, `off` khi tắt. */
  source: "remote" | "bundled" | "off"
  url: string | null
  updatedAt: string | null
  fetchedAt: string | null
  error: string | null
  /** Giấy phép còn hạn → mục `requiresLicense` cài được. */
  licensed: boolean
  items: Array<CatalogItem & { installed: boolean; state: "disabled" | "connecting" | "connected" | "error" | null }>
}

export interface MarketplaceOptions {
  mcp: McpManager
  /** Đường dẫn catalog.json đóng gói sẵn. */
  bundledPath: string
  /** Mặc định DEFAULT_CATALOG_URL; `off` chỉ dùng bản đóng gói. */
  url?: string
  /** Giấy phép còn hạn không. Mặc định: không. */
  licensed?: () => boolean
  fetch?: typeof fetch
}

export class Marketplace {
  private readonly url: string | null
  private catalog: Catalog | null = null
  private source: MarketplaceView["source"]
  private fetchedAt: number | null = null
  private error: string | null = null

  constructor(private opts: MarketplaceOptions) {
    const raw = (opts.url ?? DEFAULT_CATALOG_URL).trim()
    this.url = !raw || raw.toLowerCase() === "off" ? null : raw
    this.source = this.url ? "bundled" : "off"
  }

  /** Danh mục kèm trạng thái đã cài; `refresh` bỏ qua cache. */
  async view(refresh = false): Promise<MarketplaceView> {
    await this.load(refresh)
    const items = (this.catalog?.items ?? []).map((it) => {
      const st = this.opts.mcp.get(it.id)
      return { ...it, installed: !!st, state: st?.state ?? null }
    })
    return {
      source: this.source,
      url: this.url,
      updatedAt: this.catalog?.updatedAt ?? null,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      error: this.error,
      licensed: this.licensed(),
      items,
    }
  }

  async install(id: string) {
    await this.load(false)
    const it = this.catalog?.items.find((i) => i.id === id)
    if (!it) throw new Error(`Chợ ứng dụng không có mục "${id}".`)
    if (it.requiresLicense && !this.licensed()) throw new Error("Mục này cần giấy phép còn hạn. Nhập mã giấy phép ở Cài đặt.")
    return this.opts.mcp.add(it.id, it.config as McpServerConfig)
  }

  private licensed() {
    return this.opts.licensed?.() ?? false
  }

  private async load(refresh: boolean) {
    const stale = !this.fetchedAt || Date.now() - this.fetchedAt > CACHE_MS
    if (this.url && (refresh || stale)) {
      try {
        this.catalog = CatalogSchema.parse(await this.fetchJson(this.url))
        this.source = "remote"
        this.error = null
      } catch (e) {
        this.error = (e as Error).message
      }
      this.fetchedAt = Date.now()
    }
    if (!this.catalog) {
      try {
        this.catalog = CatalogSchema.parse(JSON.parse(await readFile(this.opts.bundledPath, "utf8")))
        if (this.source !== "off") this.source = "bundled"
      } catch (e) {
        this.catalog = { version: 1, items: [] }
        this.error = this.error ?? (e as Error).message
      }
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (url.startsWith("file:")) return JSON.parse(await readFile(fileURLToPath(url), "utf8"))
    const res = await (this.opts.fetch ?? fetch)(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
}
