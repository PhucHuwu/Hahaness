import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

/**
 * MCP client tối thiểu: JSON-RPC 2.0, hai transport (stdio, streamable HTTP),
 * ba method cần cho harness: initialize, tools/list, tools/call.
 */
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

interface Rpc {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): void
}

const PROTOCOL = "2025-03-26"

export class McpClient {
  private constructor(private rpc: Rpc, readonly serverInfo: { name?: string; version?: string }) {}

  static async connect(cfg: McpServerConfig, timeoutMs = 20_000): Promise<McpClient> {
    const rpc = cfg.type === "stdio" ? stdioRpc(cfg) : httpRpc(cfg)
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const init = (await rpc.request(
        "initialize",
        { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hahaness", version: "0.1" } },
        signal,
      )) as { serverInfo?: { name?: string; version?: string } }
      await rpc.notify("notifications/initialized")
      return new McpClient(rpc, init.serverInfo ?? {})
    } catch (e) {
      rpc.close()
      throw e
    }
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = (await this.rpc.request("tools/list", cursor ? { cursor } : {}, AbortSignal.timeout(20_000))) as { tools?: McpTool[]; nextCursor?: string }
      out.push(...(page.tools ?? []))
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.rpc.request("tools/call", { name, arguments: args ?? {} }, signal)) as McpCallResult
  }

  close() {
    this.rpc.close()
  }
}

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
  }
}

function pending() {
  const map = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const settle = (msg: any) => {
    if (msg?.id === undefined || msg.id === null) return false
    const p = map.get(msg.id)
    if (!p) return false
    map.delete(msg.id)
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message ?? "rpc error", msg.error.data))
    else p.resolve(msg.result)
    return true
  }
  const rejectAll = (e: Error) => {
    for (const p of map.values()) p.reject(e)
    map.clear()
  }
  return { map, settle, rejectAll }
}

function stdioRpc(cfg: Extract<McpServerConfig, { type: "stdio" }>): Rpc {
  let child: ChildProcess
  try {
    child = spawn(cfg.command, cfg.args ?? [], {
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    })
  } catch (e) {
    throw new Error(`mcp: cannot start "${cfg.command}": ${(e as Error).message}`)
  }
  const { map, settle, rejectAll } = pending()
  let seq = 0
  let stderr = ""
  let exited: Error | undefined
  child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)))
  child.on("error", (e) => {
    exited = new Error(`mcp: ${e.message}`)
    rejectAll(exited)
  })
  child.on("exit", (code) => {
    exited = new Error(`mcp: server exited (code ${code})${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)
    rejectAll(exited)
  })
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.trim()) return
    try {
      settle(JSON.parse(line))
    } catch {
      /* server log noise on stdout */
    }
  })
  const write = (msg: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (exited) return reject(exited)
      child.stdin!.write(JSON.stringify(msg) + "\n", (e) => (e ? reject(e) : resolve()))
    })
  return {
    async request(method, params, signal) {
      const id = ++seq
      const result = new Promise<unknown>((resolve, reject) => {
        map.set(id, { resolve, reject })
        signal?.addEventListener("abort", () => {
          map.delete(id)
          reject(new Error(`mcp: ${method} aborted`))
        }, { once: true })
      })
      await write({ jsonrpc: "2.0", id, method, params })
      return result
    },
    notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
    close() {
      rejectAll(new Error("mcp: closed"))
      child.kill()
    },
  }
}

function httpRpc(cfg: Extract<McpServerConfig, { type: "http" }>): Rpc {
  let seq = 0
  let sessionID: string | undefined
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionID ? { "mcp-session-id": sessionID } : {}),
    ...cfg.headers,
  })
  const post = async (body: unknown, signal?: AbortSignal) => {
    const res = await fetch(cfg.url, { method: "POST", headers: headers(), body: JSON.stringify(body), signal })
    const sid = res.headers.get("mcp-session-id")
    if (sid) sessionID = sid
    if (!res.ok) throw new Error(`mcp: HTTP ${res.status} ${res.statusText} from ${cfg.url}`)
    return res
  }
  return {
    async request(method, params, signal) {
      const id = ++seq
      const res = await post({ jsonrpc: "2.0", id, method, params }, signal)
      const type = res.headers.get("content-type") ?? ""
      const msg = type.includes("text/event-stream") ? await readSseUntil(res, id) : await res.json()
      if (msg?.error) throw new RpcError(msg.error.code, msg.error.message ?? "rpc error", msg.error.data)
      return msg?.result
    },
    async notify(method, params) {
      await post({ jsonrpc: "2.0", method, params })
    },
    close() {
      if (sessionID) void fetch(cfg.url, { method: "DELETE", headers: headers() }).catch(() => {})
    },
  }
}

async function readSseUntil(res: Response, id: number): Promise<any> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error("mcp: stream ended before response")
    buf += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n")
      if (!data) continue
      try {
        const msg = JSON.parse(data)
        if (msg?.id === id) {
          void reader.cancel()
          return msg
        }
      } catch {
        /* ignore non-JSON events */
      }
    }
  }
}
