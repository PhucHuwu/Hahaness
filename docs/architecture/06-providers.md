# 06 — Providers

## Interface

Harness chỉ phụ thuộc vào một interface nhỏ (`src/provider/types.ts`):

```ts
interface ProviderClient {
  info(model: string): { id; contextWindow; maxOutput }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent>
}
// StreamEvent: text-delta | reasoning-delta | tool-call | finish | error
```

Mọi thứ provider-specific (wire format, SSE parse, tool-call accumulate, usage) nằm trong implementation. Loop không biết OpenAI hay Anthropic.

## Tham chiếu model

Model luôn viết dạng `providerID/modelID` (`openrouter/anthropic/claude-sonnet-4.5` — chỉ tách ở `/` đầu). Không có prefix → provider mặc định (provider của `defaultModel`). `ProviderRegistry.resolve()` kiểm tra lúc tạo session nên lỗi config lộ sớm, không đợi tới lúc gọi model.

Agent khai báo `model: [a/x, b/y]` là danh sách fallback (v0.2 mới dùng phần tử sau khi phần tử đầu hết retry).

## Config: `hahaness.json`

Tìm theo thứ tự: `./hahaness.json` → `./.hahaness/config.json` → `~/.hahaness/config.json`. Project thắng user; `providers` merge theo id.

```json
{
  "defaultModel": "openai/gpt-4.1",
  "providers": {
    "openai":     { "type": "openai", "apiKey": "{env:OPENAI_API_KEY}" },
    "openrouter": { "type": "openai", "baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}", "headers": { "X-Title": "Hahaness" } },
    "ollama":     { "type": "openai", "baseURL": "http://localhost:11434/v1", "apiKey": "ollama", "models": { "qwen3:32b": { "contextWindow": 32768 } } },
    "mine":       { "type": "custom", "module": "providers/mine.ts", "options": { "endpoint": "..." } }
  }
}
```

- `{env:NAME}` được thay bằng biến môi trường ở `apiKey` và `headers`. Không bao giờ ghi key thật vào file commit.
- `models.<id>` khai `contextWindow` / `maxOutput` để budget và compaction tính đúng; thiếu thì mặc định 128k / 16k.
- Không có config → fallback `OPENAI_API_KEY` + `OPENAI_BASE_URL` từ env, provider id `openai`.

## Hai loại provider

### `type: "openai"`
Bất kỳ endpoint nào nói Chat Completions + SSE: OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama, vLLM, LM Studio, LiteLLM proxy, Azure (qua baseURL + headers). Đây là cách nhanh nhất để nối gateway nội bộ.

### `type: "custom"`
Module TS/JS do người dùng viết, export default một factory:

```ts
export default function create(options, { id, cwd }): ProviderClient | Promise<ProviderClient>
```

Dùng khi wire format khác (Anthropic Messages, Gemini, Bedrock, gRPC nội bộ) hoặc cần logic riêng (ký request, cache, rate-limit, log). Module được `import()` lúc khởi động; đường dẫn tương đối tính từ cwd. Mẫu: `examples/providers/echo.ts`.

Hợp đồng provider phải giữ:
1. `tool-call` chỉ yield khi args đã hoàn chỉnh (parse JSON xong); args hỏng thì bọc `{ __raw }` để validation báo lỗi cho model thay vì crash.
2. `finish.usage.inputTokens` phải là số thật từ provider — loop dùng nó làm `measured` để re-anchor ước lượng token.
3. Lỗi mạng/429/5xx → `error { retryable: true }`; 401/403/400 → `retryable: false`. Context quá dài → message chứa "context" hoặc "too long" để loop nhận ra và compaction.
4. Tôn trọng `signal`: hủy fetch, dừng yield.

## Vì sao không dùng Vercel AI SDK

opencode V2 đã bỏ Vercel AI SDK để tự viết `packages/ai`; openclaw cũng tự viết `StreamFn`. Lý do chung: kiểm soát cache control, tool-call repair, và tránh phụ thuộc nặng cho một interface 2 hàm. Ta làm tương tự; nếu sau này cần provider đã có trong AI SDK, một custom module bọc nó là đủ.

## Sau

- Builtin `type: "anthropic"` (Messages API, cache_control breakpoints `system_and_3` như hermes).
- Fallback theo danh sách `agent.model`.
- Per-provider `requestOverrides` (temperature, reasoning effort) — để sau khi có nhu cầu thật.
