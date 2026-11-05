import type { Message } from "../core/types.ts"

export const ESTIMATE_ERROR = 0.15
export const CHARS_PER_TOKEN = 4

export interface Estimate {
  /** input_tokens của response gần nhất. */
  measured: number
  /** Ước lượng cho phần thêm vào sau response đó. */
  estimated: number
}

export function total(e: Estimate) {
  return Math.ceil(e.measured + e.estimated * (1 + ESTIMATE_ERROR))
}

export function estimateMessage(m: Message): number {
  let chars = 0
  for (const p of m.parts) {
    if (p.type === "text" || p.type === "reasoning") chars += p.text.length
    else if (p.type === "tool-call") chars += JSON.stringify(p.args).length + p.name.length
    else if (p.type === "tool-result") chars += p.output.length
    else if (p.type === "image") chars += 1500 * CHARS_PER_TOKEN
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function estimateText(s: string) {
  return Math.ceil(s.length / CHARS_PER_TOKEN)
}

export function ceiling(contextWindow: number) {
  return contextWindow - Math.max(Math.floor(contextWindow * 0.15), 16_000)
}

export function outputLimit(contextWindow: number, maxOutput: number, used: number) {
  return Math.max(1024, Math.min(maxOutput, contextWindow - used))
}
