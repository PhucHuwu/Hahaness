import type { IncomingMessage, ServerResponse } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export interface Req {
  method: string
  url: URL
  params: Record<string, string>
  raw: IncomingMessage
  json<T = unknown>(): Promise<T>
}

type Handler = (req: Req, res: ServerResponse) => Promise<unknown> | unknown

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

/** Router tối giản: `/api/staff/:id`. Handler trả object → JSON; trả undefined → tự xử lý res. */
export class Router {
  private routes: Route[] = []

  on(method: string, path: string, handler: Handler) {
    const keys: string[] = []
    const pattern = new RegExp(
      "^" + path.replace(/:([A-Za-z_]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
    )
    this.routes.push({ method, pattern, keys, handler })
    return this
  }

  get = (p: string, h: Handler) => this.on("GET", p, h)
  post = (p: string, h: Handler) => this.on("POST", p, h)
  put = (p: string, h: Handler) => this.on("PUT", p, h)
  delete = (p: string, h: Handler) => this.on("DELETE", p, h)

  async handle(raw: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(raw.url ?? "/", "http://localhost")
    for (const r of this.routes) {
      if (r.method !== raw.method) continue
      const m = r.pattern.exec(url.pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)))
      const req: Req = { method: raw.method!, url, params, raw, json: () => readJson(raw) }
      try {
        const out = await r.handler(req, res)
        if (out !== undefined && !res.headersSent) json(res, 200, out)
        else if (!res.headersSent && !res.writableEnded) res.end()
      } catch (e) {
        const err = e as Error
        const status = e instanceof HttpError ? e.status : 500
        if (!res.headersSent) json(res, status, { error: err.message ?? String(e) })
      }
      return true
    }
    return false
  }
}

const MAX_BODY = 110 * 1024 * 1024

async function readJson<T>(raw: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of raw) {
    size += (c as Buffer).length
    // File đính kèm đi trong JSON dạng base64 (~1.33×): 4 file 20 MB vẫn lọt.
    if (size > MAX_BODY) throw new HttpError(413, "Dữ liệu gửi lên quá lớn (tối đa khoảng 100 MB mỗi lần).")
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, "invalid JSON body")
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

/** Server-Sent Events fan-out. Mỗi client là một ServerResponse giữ mở. */
export class SseBus {
  private clients = new Set<ServerResponse>()

  subscribe(res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.write(":ok\n\n")
    this.clients.add(res)
    const ping = setInterval(() => res.write(":ping\n\n"), 25_000)
    res.on("close", () => {
      clearInterval(ping)
      this.clients.delete(res)
    })
  }

  emit(event: Record<string, unknown>) {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const c of this.clients) c.write(line)
  }

  get size() {
    return this.clients.size
  }

  closeAll() {
    for (const c of this.clients) c.end()
    this.clients.clear()
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/** Serve thư mục build của UI; đường dẫn lạ → index.html (SPA). */
export async function serveStatic(root: string, url: URL, res: ServerResponse): Promise<boolean> {
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "")
  let file = join(root, rel === "\\" || rel === "/" ? "index.html" : rel)
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html")
  } catch {
    file = join(root, "index.html")
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" })
    res.end(body)
    return true
  } catch {
    return false
  }
}
