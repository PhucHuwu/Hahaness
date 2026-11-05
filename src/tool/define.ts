import { z } from "zod"
import type { AskGate } from "../permission/ask.ts"
import type { Ruleset } from "../permission/ruleset.ts"
import type { ToolDefinition } from "../provider/types.ts"

export interface ToolContext {
  sessionID: string
  agent: string
  cwd: string
  signal: AbortSignal
  ruleset: Ruleset
  askGate: AskGate
  /** Tool có thể yêu cầu quyền bổ sung ngoài permission khai báo (vd shell với lệnh cụ thể). */
  ask(action: string, resource: string, description: string): Promise<void>
  /** Chỉ dành cho tool delegate; harness inject. */
  harness: unknown
}

export interface ToolResult {
  output: string
  metadata?: Record<string, unknown>
  isError?: boolean
}

export interface ToolSpec<I extends z.ZodType> {
  name: string
  description: string
  input: I
  permission?: { action: string; resource?: (input: z.infer<I>) => string }
  concurrency?: "parallel" | "serial"
  timeoutMs?: number
  execute(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult>
}

export interface Tool {
  name: string
  description: string
  schema: z.ZodType
  permission?: { action: string; resource?: (input: any) => string }
  concurrency: "parallel" | "serial"
  timeoutMs: number
  definition(): ToolDefinition
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export function define<I extends z.ZodType>(spec: ToolSpec<I>): Tool {
  const parameters = normalizeSchema(z.toJSONSchema(spec.input, { target: "draft-7" }))
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.input,
    permission: spec.permission,
    concurrency: spec.concurrency ?? "parallel",
    timeoutMs: spec.timeoutMs ?? 120_000,
    definition: () => ({ name: spec.name, description: spec.description, parameters }),
    execute: (input, ctx) => spec.execute(input as z.infer<I>, ctx),
  }
}

/** Làm schema byte-stable và gọn để không vỡ prompt cache. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema") continue
    if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) === Number.MAX_SAFE_INTEGER) continue
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? normalizeSchema(v as Record<string, unknown>) : v
  }
  return out
}

/** Lỗi validation → thông điệp cho model, không throw. */
export function formatValidationError(error: z.ZodError, input: unknown): string {
  const issues = error.issues.slice(0, 5).map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
  return `Invalid arguments:\n${issues.join("\n")}\n\nYou supplied:\n${JSON.stringify(input, null, 2)}`
}
