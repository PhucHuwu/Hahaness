import { z } from "zod"
import { spawn } from "node:child_process"
import { define } from "../define.ts"

export const shell = define({
  name: "shell",
  description: "Run a shell command in the working directory. Output is truncated keeping the tail. Use timeoutMs for long commands.",
  input: z.object({
    command: z.string(),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  }),
  permission: { action: "shell", resource: (i) => i.command },
  timeoutMs: 600_000,
  async execute({ command, timeoutMs }, ctx) {
    const isWin = process.platform === "win32"
    const child = spawn(isWin ? "powershell" : "sh", isWin ? ["-NoProfile", "-Command", command] : ["-c", command], {
      cwd: ctx.cwd,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      env: process.env,
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve)
      child.on("error", () => resolve(null))
    })
    const status = code === 0 ? "" : `\n[exit code ${code ?? "aborted"}]`
    return { output: (out || "(no output)") + status, isError: code !== 0, metadata: { tail: true, exitCode: code } }
  },
})
