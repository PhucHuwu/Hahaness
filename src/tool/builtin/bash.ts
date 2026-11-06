import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { z } from "zod"
import { define } from "../define.ts"

/**
 * Chạy lệnh shell khi việc cần tính toán hay xử lý file: phân tích Excel/CSV bằng Python, đổi
 * định dạng, vẽ biểu đồ… Người dùng không code; agent thì được code nếu việc cần.
 * - Chạy trong thư mục làm việc riêng của công ty (`<data>/workspace`), không phải thư mục mã nguồn.
 *   File CEO gửi lên có bản gốc ở `uploads/` trong đó.
 * - Biến môi trường chỉ giữ PATH/LANG/…: API key của server không lộ cho code agent viết.
 * - Timeout giết cả process group (lệnh con như `python` cũng dừng).
 * Không phải sandbox: lệnh chạy bằng quyền của server. Xem `docs/architecture/15-bash.md`.
 */

const KEEP_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "SHELL", "USER", "LOGNAME", "PYTHONIOENCODING", "VIRTUAL_ENV", "CONDA_PREFIX"]
const MAX_TIMEOUT = 600

export function bash(workdir: string) {
  return define({
    name: "bash",
    description: `Run a shell command (bash) when the work needs computation or file processing: analysing spreadsheets/CSV with Python, converting formats, generating charts, batch text processing.
The working directory is the company's scratch folder: ${workdir}. Files the CEO uploaded are there in uploads/ as the original files (e.g. uploads/sales.xlsx), next to their text versions in company documents.
Files you create here are NOT company documents: to give a result to the CEO, put it in a document with write (or paste numbers into your report). Prefer python3 for data work; check what is installed (e.g. python3 -c "import pandas") before relying on a library, and install with pip only if needed.
Output is stdout+stderr combined; long output is cut, so print summaries rather than whole tables. Default timeout 120s (max ${MAX_TIMEOUT}).`,
    input: z.object({
      command: z.string().min(1),
      timeout: z.number().int().min(1).max(MAX_TIMEOUT).optional().describe("Seconds, default 120"),
      description: z.string().optional().describe("What this command does, in a few words"),
    }),
    permission: { action: "bash", resource: (i) => i.command.slice(0, 200) },
    concurrency: "serial",
    timeoutMs: (MAX_TIMEOUT + 10) * 1000,
    async execute({ command, timeout = 120 }, ctx) {
      mkdirSync(workdir, { recursive: true })
      return run(command, workdir, timeout * 1000, ctx.signal)
    },
  })
}

export function run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ output: string; isError?: boolean; metadata: Record<string, unknown> }> {
  const env: Record<string, string> = { HOME: cwd, PYTHONIOENCODING: "utf-8" }
  for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let size = 0
    const collect = (b: Buffer) => {
      // Giữ tối đa ~5 MB; phần còn lại vẫn đọc để process không bị nghẽn pipe.
      if (size < 5 * 1024 * 1024) chunks.push(b)
      size += b.length
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    let why: "timeout" | "interrupted" | undefined
    const kill = (reason: typeof why) => {
      why ??= reason
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }
    const timer = setTimeout(() => kill("timeout"), timeoutMs)
    const onAbort = () => kill("interrupted")
    signal.addEventListener("abort", onAbort, { once: true })
    const done = (code: number | null, err?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      let out = Buffer.concat(chunks).toString("utf8").trimEnd()
      if (size > 5 * 1024 * 1024) out += `\n[output cut at 5 MB of ${Math.round(size / 1024 / 1024)} MB]`
      if (err) return resolve({ output: `Could not start bash: ${err.message}`, isError: true, metadata: {} })
      if (why === "timeout") return resolve({ output: `${out}\n[killed after ${timeoutMs / 1000}s timeout; use a larger timeout or a faster approach]`.trim(), isError: true, metadata: { tail: true } })
      if (why === "interrupted") return resolve({ output: "interrupted", isError: true, metadata: {} })
      const tail = `\n[exit code ${code}]`
      resolve({ output: (out || "(no output)") + (code === 0 ? "" : tail), isError: code !== 0, metadata: { exitCode: code, tail: true } })
    }
    child.on("error", (e) => done(null, e))
    child.on("close", (code) => done(code))
  })
}
