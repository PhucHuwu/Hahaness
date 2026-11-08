import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { Readable } from "node:stream"
import { z } from "zod"
import { parseLicense, publicKeyFrom, VENDOR_PUBLIC_KEY, type LicensePayload } from "../server/license.ts"

/**
 * MCP gateway của nhà cung cấp: instance khách gọi `POST /mcp/<tên>` với `Authorization: Bearer <giấy phép>`;
 * gateway kiểm chữ ký + hạn + gói (offline, không cần DB) rồi chuyển tiếp nguyên JSON-RPC tới MCP thật kèm
 * API key của nhà cung cấp. Khách không bao giờ thấy key gốc; thu hồi = để giấy phép hết hạn.
 * Chạy riêng (`npm run gateway`, entry `src/gateway/index.ts`, `gateway/Dockerfile`), không nằm trong image của khách.
 * Xem `docs/architecture/22-gateway.md`.
 */

const UpstreamSchema = z.object({
  url: z.string().url(),
  /** Giá trị `${TÊN}` được thay bằng biến môi trường lúc nạp (API key không nằm trong file). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Gói được dùng; bỏ trống = mọi giấy phép còn hạn. */
  plans: z.array(z.string()).optional(),
})
export const UpstreamsSchema = z.object({ upstreams: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), UpstreamSchema) })
export type Upstream = z.infer<typeof UpstreamSchema>

export interface GatewayOptions {
  upstreams: Record<string, Upstream>
  /** Base64 SPKI; mặc định VENDOR_PUBLIC_KEY. */
  publicKey?: string
  now?: () => Date
  fetch?: typeof fetch
  /** Mỗi request đã xác thực: để đếm dùng theo khách. Mặc định in ra stdout. */
  log?: (entry: { instance: string; plan: string; upstream: string; method: string; status: number }) => void
}

/** Nạp file upstreams.json, thay `${ENV}` trong header; thiếu biến thì báo ngay lúc khởi động. */
export function loadUpstreams(path: string, env: NodeJS.ProcessEnv = process.env): Record<string, Upstream> {
  const raw = UpstreamsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  for (const [name, up] of Object.entries(raw.upstreams)) {
    for (const [k, v] of Object.entries(up.headers)) {
      up.headers[k] = v.replace(/\$\{(\w+)\}/g, (_, key: string) => {
        const val = env[key]
        if (!val) throw new Error(`gateway: upstream "${name}" header ${k} needs env ${key}`)
        return val
      })
    }
  }
  return raw.upstreams
}

class GatewayError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function createGateway(opts: GatewayOptions) {
  const pub = publicKeyFrom(opts.publicKey ?? VENDOR_PUBLIC_KEY)
  const now = opts.now ?? (() => new Date())
  const doFetch = opts.fetch ?? fetch
  const log = opts.log ?? ((e) => console.log(`${new Date().toISOString()} ${e.instance} ${e.plan} ${e.upstream} ${e.method} ${e.status}`))

  /** Giấy phép từ header; lỗi trả tiếng Việt vì instance hiện nguyên câu cho CEO. */
  const authenticate = (req: IncomingMessage): LicensePayload => {
    const h = req.headers.authorization ?? ""
    const key = h.startsWith("Bearer ") ? h.slice(7).trim() : ""
    if (!key) throw new GatewayError(401, "Thiếu giấy phép. Nhập mã giấy phép ở Cài đặt rồi Kết nối lại.")
    let p: LicensePayload
    try {
      p = parseLicense(key, pub)
    } catch (e) {
      throw new GatewayError(401, (e as Error).message)
    }
    if (Date.parse(p.expiresAt) < now().getTime()) throw new GatewayError(401, `Giấy phép đã hết hạn ngày ${p.expiresAt}. Liên hệ nhà cung cấp để gia hạn.`)
    return p
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://gateway")
    if (req.method === "GET" && url.pathname === "/") return json(res, 200, { ok: true, upstreams: Object.keys(opts.upstreams) })
    const m = /^\/mcp\/([a-z0-9][a-z0-9_-]*)\/?$/.exec(url.pathname)
    if (!m) return json(res, 404, { error: "not found" })
    const name = m[1]!
    const up = opts.upstreams[name]
    if (!up) return json(res, 404, { error: `Gateway không có dịch vụ "${name}".` })
    if (req.method !== "POST" && req.method !== "DELETE") return json(res, 405, { error: "method not allowed" })

    let lic: LicensePayload
    try {
      lic = authenticate(req)
    } catch (e) {
      const ge = e as GatewayError
      return json(res, ge.status ?? 401, { error: ge.message })
    }
    if (up.plans && !up.plans.includes(lic.plan)) return json(res, 403, { error: `Dịch vụ "${name}" không có trong gói ${lic.plan}.` })

    const body = req.method === "POST" ? await readBody(req) : undefined
    let method = req.method === "DELETE" ? "close" : "?"
    if (body) {
      try {
        method = String(JSON.parse(body.toString("utf8"))?.method ?? "?")
      } catch {
        /* upstream sẽ báo lỗi JSON */
      }
    }
    const headers: Record<string, string> = {
      ...(req.headers["content-type"] ? { "content-type": String(req.headers["content-type"]) } : {}),
      accept: String(req.headers.accept ?? "application/json, text/event-stream"),
      ...(req.headers["mcp-session-id"] ? { "mcp-session-id": String(req.headers["mcp-session-id"]) } : {}),
      ...up.headers,
    }
    let upstream: Response
    try {
      upstream = await doFetch(up.url, { method: req.method, headers, body, signal: AbortSignal.timeout(120_000) })
    } catch (e) {
      log({ instance: lic.instance, plan: lic.plan, upstream: name, method, status: 502 })
      return json(res, 502, { error: `Không gọi được dịch vụ "${name}": ${(e as Error).message}` })
    }
    log({ instance: lic.instance, plan: lic.plan, upstream: name, method, status: upstream.status })
    const out: Record<string, string> = {}
    for (const k of ["content-type", "mcp-session-id", "cache-control"]) {
      const v = upstream.headers.get(k)
      if (v) out[k] = v
    }
    res.writeHead(upstream.status, out)
    if (!upstream.body) return res.end()
    const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)
    req.on("close", () => stream.destroy())
    stream.on("error", () => res.end())
    stream.pipe(res)
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message })
      else res.end()
    })
  }
}

export interface StartGatewayOptions extends GatewayOptions {
  host?: string
  port?: number
}

export async function startGateway(opts: StartGatewayOptions) {
  const server = createServer(createGateway(opts))
  await new Promise<void>((resolve) => server.listen(opts.port ?? 7332, opts.host ?? "127.0.0.1", resolve))
  const addr = server.address() as { address: string; port: number }
  return {
    url: `http://${addr.address}:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 4 * 1024 * 1024) throw new GatewayError(413, "request too large")
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}
