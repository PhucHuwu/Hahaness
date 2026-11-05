import { z } from "zod"
import { define } from "../define.ts"

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export const webfetch = define({
  name: "webfetch",
  description: "Fetch a web page and return its text content.",
  input: z.object({ url: z.string().url() }),
  permission: { action: "webfetch", resource: (i) => new URL(i.url).hostname },
  timeoutMs: 60_000,
  async execute({ url }, ctx) {
    const res = await fetch(url, { signal: ctx.signal, headers: { "user-agent": "Hahaness/0.1" } })
    if (!res.ok) return { output: `HTTP ${res.status} ${res.statusText}`, isError: true }
    const type = res.headers.get("content-type") ?? ""
    const body = await res.text()
    return { output: type.includes("html") ? htmlToText(body) : body }
  },
})

/**
 * Tìm kiếm qua DuckDuckGo HTML (không cần API key). Thay bằng provider khác
 * (Tavily, Brave, SerpAPI) bằng cách sửa hàm này hoặc đăng ký tool cùng tên.
 */
export const websearch = define({
  name: "websearch",
  description: "Search the web. Returns top results as title, URL and snippet. Follow up with webfetch to read a result.",
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(10).default(5) }),
  permission: { action: "websearch" },
  timeoutMs: 60_000,
  async execute({ query, limit }, ctx) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: ctx.signal,
      headers: { "user-agent": "Mozilla/5.0 Hahaness/0.1" },
    })
    if (!res.ok) return { output: `Search failed: HTTP ${res.status}`, isError: true }
    const html = await res.text()
    const results: string[] = []
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < limit) {
      const href = m[1]!
      const real = /uddg=([^&]+)/.exec(href)?.[1]
      const url = real ? decodeURIComponent(real) : href
      results.push(`- ${htmlToText(m[2]!)}\n  ${url}\n  ${htmlToText(m[3]!)}`)
    }
    return { output: results.join("\n") || "No results" }
  },
})
