# 06 — Providers

## Interface

The harness depends only on a small interface (`src/provider/types.ts`):

```ts
interface ProviderClient {
  info(model: string): { id; contextWindow; maxOutput }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent>
}
// StreamEvent: text-delta | reasoning-delta | tool-call | finish | error
```

Everything provider-specific (wire format, SSE parsing, tool-call accumulation, usage) lives in the implementation. The loop does not know whether it is talking to OpenAI or Anthropic.

## Model references

Models are always written as `providerID/modelID` (`openrouter/anthropic/claude-sonnet-4.5` — split only at the first `/`). No prefix → the default provider (the provider of `defaultModel`). `ProviderRegistry.resolve()` checks at session creation, so config errors surface early instead of at model-call time.

An agent declaring `model: [a/x, b/y]` gets a fallback list. The company config also has `fallbackModels: ["b/y", …]`, edited in **Settings** (Cài đặt). When the primary model fails outright, the loop switches to the next model; details in `01-agent-loop.md`, "Fallback models" under "Retry & provider errors".

## Config

Stored in the DB (table `settings`, key `config`; see `08-storage.md`); the CEO edits it on the **Settings** page. This is the only configuration source: no config file is read (`hahaness.json`, `~/.hahaness/config.json` were dropped). Tests seed with `saveConfig(db, …)`. JSON shape:

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

- `{env:NAME}` is replaced with the environment variable in `apiKey` and `headers`. Real keys entered in Settings live in the `.db` file (do not share that file); the API never returns keys to the UI.
- `contextWindow` / `maxOutput` drive the budget and compaction. Precedence: `models.<id>` → provider-level value (applies to every model of the provider; the "Max context" (Context tối đa) / "Max response" (Trả lời tối đa) fields in Settings) → default 128k (openai) / 200k (anthropic) and 16k. The provider-level value is meant for proxies that aggregate many models (e.g. CLIProxyAPI): set one shared ceiling, e.g. `"contextWindow": 200000` → compaction around 170k (ceiling minus max(15%, 16k)). This ceiling must not exceed the model's real context; if it does, the provider reports overflow and the loop compacts and resends.
- No config → use `OPENAI_API_KEY` + `OPENAI_BASE_URL` from env (provider id `openai`); if absent, use `ANTHROPIC_API_KEY` (provider id `anthropic`).

## Three provider types

### `type: "openai"`
Any endpoint that speaks Chat Completions + SSE: OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama, vLLM, LM Studio, LiteLLM proxy, Azure (via baseURL + headers). This is the fastest way to connect an internal gateway.

### `type: "anthropic"` (`src/provider/anthropic.ts`)
Anthropic Messages API (`POST {baseURL}/v1/messages`, SSE). `apiKey` defaults to `ANTHROPIC_API_KEY`; `baseURL` works with or without `/v1`.

- **Prompt cache**: `cache_control: ephemeral` on the last system block, the last tool and the last block of the last message — 3 of the 4 allowed breakpoints. The system prompt is frozen for the session, so from the second turn on the prefix hits the cache.
- **Message mapping**: roles must alternate user/assistant. Mid-session `system` messages (notice, `<workspace-update>`) are merged into the user message. `tool_result` goes in the user message right after `tool_use`, before any text. Reasoning is not sent back, because there is no thinking signature.
- **Usage**: `inputTokens = input_tokens + cache_read + cache_creation`. Anthropic reports the cached part separately, but the loop needs the total prompt size to decide on compaction. `outputTokens` comes from `message_delta`.
- **Errors**: 429/529/5xx and `overloaded_error` in the stream → retryable, with `retry-after`. JSON error bodies are reduced to `type: message`, so "prompt is too long" is recognized by `isOverflow`.
- `contextWindow` defaults to 200k; change it at provider level or in `models.<id>`.

### `type: "custom"`
A user-written TS/JS module that default-exports a factory:

```ts
export default function create(options, { id, cwd }): ProviderClient | Promise<ProviderClient>
```

Use it when the wire format differs (Anthropic Messages, Gemini, Bedrock, internal gRPC) or custom logic is needed (request signing, caching, rate limiting, logging). The module is `import()`ed at startup; relative paths resolve from cwd. Example: `examples/providers/echo.ts`.

Contract the provider must uphold:
1. Yield `tool-call` only once args are complete (JSON parsed); wrap broken args as `{ __raw }` so validation reports the error to the model instead of crashing.
2. `finish.usage.inputTokens` must be the real number from the provider — the loop uses it as `measured` to re-anchor the token estimate.
3. Network errors/429/5xx → `error { retryable: true }`; 401/403/400 → `retryable: false`. Context too long → a message containing "context" or "too long" so the loop recognizes it and compacts.
4. Respect `signal`: abort the fetch, stop yielding.

## Why not the Vercel AI SDK

opencode V2 dropped the Vercel AI SDK and wrote its own `packages/ai`; openclaw also wrote its own `StreamFn`. Shared reasons: control over cache control, tool-call repair, and avoiding a heavy dependency for a 2-function interface. We do the same; if a provider that already exists in the AI SDK is needed later, a custom module wrapping it is enough.

## Later

- Extended thinking for Anthropic (requires sending thinking blocks back with their signatures).
- Per-provider `requestOverrides` (temperature, reasoning effort) — deferred until there is a real need.
