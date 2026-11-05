/**
 * MCP server stdio tối giản để thử nghiệm: một tool `echo`.
 * Chạy: npx tsx examples/mcp/echo-server.ts  (thường do harness spawn)
 */
import { createInterface } from "node:readline"

const tools = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
]

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n")

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  switch (msg.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "echo-server", version: "0.1" } } })
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools } })
    case "tools/call":
      if (msg.params?.name !== "echo") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } })
      return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params.arguments?.text ?? ""}` }] } })
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
})
