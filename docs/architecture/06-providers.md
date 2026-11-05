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

Agent khai báo `model: [a/x, b/y]` là danh sách dự phòng. Config công ty có thêm `fallbackModels: ["b/y", …]`, chỉnh ở Cài đặt. Model chính lỗi hẳn thì loop chuyển sang model kế tiếp; chi tiết ở `01-agent-loop.md` mục "Model dự phòng".

## Config

Lưu trong DB (bảng `settings`, key `config`; xem `08-storage.md`), CEO sửa ở trang **Cài đặt**. Đây là nguồn cấu hình duy nhất: không đọc file cấu hình nào (`hahaness.json`, `~/.hahaness/config.json` đã bỏ). Test seed bằng `saveConfig(db, …)`. Hình dạng JSON:

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

- `{env:NAME}` được thay bằng biến môi trường ở `apiKey` và `headers`. Key thật nhập ở Cài đặt nằm trong file `.db` (đừng chia sẻ file đó); API không bao giờ trả key ra UI.
- `contextWindow` / `maxOutput` quyết định budget và compaction. Thứ tự: `models.<id>` → khai ở cấp provider (áp cho mọi model của provider, ô "Context tối đa" / "Trả lời tối đa" trong Cài đặt) → mặc định 128k (openai) / 200k (anthropic) và 16k. Mức cấp provider dành cho proxy gom nhiều model (vd CLIProxyAPI): đặt một trần chung, vd `"contextWindow": 200000` → compact quanh 170k (trần trừ max(15%, 16k)). Trần này không được vượt context thật của model; nếu vượt, provider báo overflow và loop compact rồi gửi lại.
- Không có config → dùng `OPENAI_API_KEY` + `OPENAI_BASE_URL` từ env (provider id `openai`); không có thì dùng `ANTHROPIC_API_KEY` (provider id `anthropic`).

## Ba loại provider

### `type: "openai"`
Bất kỳ endpoint nào nói Chat Completions + SSE: OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama, vLLM, LM Studio, LiteLLM proxy, Azure (qua baseURL + headers). Đây là cách nhanh nhất để nối gateway nội bộ.

### `type: "anthropic"` (`src/provider/anthropic.ts`)
Anthropic Messages API (`POST {baseURL}/v1/messages`, SSE). `apiKey` mặc định `ANTHROPIC_API_KEY`; `baseURL` có hay không có `/v1` đều được.

- **Prompt cache**: `cache_control: ephemeral` ở block system cuối, tool cuối và block cuối của message cuối, tổng 3 trên 4 breakpoint cho phép. System đóng băng trong phiên nên từ lượt thứ hai prefix trúng cache.
- **Map message**: role phải luân phiên user/assistant. Message `system` giữa phiên (notice, `<workspace-update>`) được gộp vào user. `tool_result` nằm trong message user ngay sau `tool_use` và đứng trước text. Reasoning không gửi lại, vì không có chữ ký thinking.
- **Usage**: `inputTokens = input_tokens + cache_read + cache_creation`. Anthropic tách phần trúng cache ra, mà loop cần tổng prompt để quyết định compaction. `outputTokens` lấy từ `message_delta`.
- **Lỗi**: 429/529/5xx và `overloaded_error` trong stream → retryable, kèm `retry-after`. Body lỗi JSON được rút gọn thành `type: message`, nên "prompt is too long" được `isOverflow` nhận ra.
- `contextWindow` mặc định 200k; đổi ở cấp provider hoặc `models.<id>`.

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

- Extended thinking cho Anthropic (cần gửi lại block thinking kèm chữ ký).
- Per-provider `requestOverrides` (temperature, reasoning effort) — để sau khi có nhu cầu thật.
