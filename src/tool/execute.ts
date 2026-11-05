import { z } from "zod"
import { PermissionRejected } from "../permission/ask.ts"
import { denied, evaluate } from "../permission/ruleset.ts"
import { formatValidationError, type Tool, type ToolContext, type ToolResult } from "./define.ts"
import { truncate } from "./output.ts"
import { id } from "../core/id.ts"

export interface ExecuteOptions {
  callID: string
  /** Nơi lưu output đầy đủ khi bị cắt; trả path đọc lại được. */
  saveOutput?: (callID: string, output: string) => string
}

/** Pipeline một tool-call. Không bao giờ throw: mọi lỗi thành ToolResult.isError. */
export async function executeTool(tool: Tool, rawInput: unknown, ctx: ToolContext, opts: ExecuteOptions): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(rawInput)
  if (!parsed.success) {
    return { output: formatValidationError(parsed.error as z.ZodError, rawInput), isError: true }
  }
  const input = parsed.data

  if (tool.permission) {
    const resource = tool.permission.resource?.(input) ?? "*"
    try {
      await ctx.ask(tool.permission.action, resource, `${tool.name} ${resource}`)
    } catch (e) {
      if (e instanceof PermissionRejected) return { output: e.message, isError: true }
      throw e
    }
  }

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error(`tool ${tool.name} timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)
  const signal = AbortSignal.any([ctx.signal, timeout.signal])
  try {
    const result = await tool.execute(input, { ...ctx, signal })
    const output = truncate(result.output, {
      save: opts.saveOutput,
      callID: opts.callID,
      tail: result.metadata?.tail === true,
    })
    return { ...result, output }
  } catch (e) {
    const err = e as Error
    if (ctx.signal.aborted) return { output: "interrupted", isError: true }
    return { output: `Error: ${err.message ?? String(e)}`.slice(0, 2048), isError: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Tạo hàm ask gắn với ruleset + gate; saved approvals không vượt được deny config. */
export function makeAsk(ctx: Omit<ToolContext, "ask">, saved: Set<string>): ToolContext["ask"] {
  return async (action, resource, description) => {
    if (denied(ctx.ruleset, action, resource)) throw new PermissionRejected(action, resource, "denied by policy")
    const effect = evaluate(ctx.ruleset, action, resource)
    if (effect === "allow") return
    const key = `${action}:${resource}`
    if (saved.has(key)) return
    const reply = await ctx.askGate.ask(
      { id: id("ask"), sessionID: ctx.sessionID, agent: ctx.agent, action, resource, description },
      ctx.signal,
    )
    if (reply.kind === "reject") throw new PermissionRejected(action, resource, reply.feedback)
    if (reply.kind === "always") saved.add(key)
  }
}
