import type { Message, Usage } from "../core/types.ts"

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  system: string[]
  messages: Message[]
  tools: ToolDefinition[]
  toolChoice?: "auto" | "none"
  maxOutputTokens?: number
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callID: string; name: string; args: unknown }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" | "error"; usage: Usage }
  | { type: "error"; error: Error; retryable: boolean }

export interface ModelInfo {
  id: string
  contextWindow: number
  maxOutput: number
}

export interface ProviderClient {
  info(model: string): ModelInfo
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent>
}
