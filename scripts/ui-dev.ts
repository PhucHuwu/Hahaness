/**
 * `npm run ui`: chạy API server (7331) + Vite dev server (5173, proxy /api) trong một lệnh.
 * Workspace = thư mục hiện tại khi gọi lệnh.
 */
import { spawn } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "../src/server/index.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { url, app } = await startServer({ cwd: process.cwd(), port: Number(process.env.PORT ?? 7331) })
console.log(`API: ${url}  workspace: ${app.cwd}`)
if (app.providerError) console.log(`Provider: ${app.providerError} — open Settings to configure.`)

const vite = spawn("npx", ["vite", "--config", join(root, "ui", "vite.config.ts"), "--open"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, HAHANESS_API: url },
})
vite.on("exit", (code) => process.exit(code ?? 0))
process.on("SIGINT", () => {
  vite.kill()
  app.mcp.closeAll()
  process.exit(0)
})
