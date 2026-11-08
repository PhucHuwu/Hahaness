# 01 — Agent loop

## Terminology

- **Turn**: from when the inbox has input until the assistant replies without a tool call (or stops for another reason).
- **Step**: one model call + execution of its batch of tool calls. A turn consists of many steps.
- **Outcome**: tagged-union result of a step that decides what the loop does next (from opencode).

## Core data types

```ts
type Outcome =
  | { tag: "completed"; text: string }            // no tool-call → end turn
  | { tag: "continue" }                           // local tools ran → next step
  | { tag: "retry"; delay: number; reason: string }
  | { tag: "compacted" }                          // overflow → compacted → rebuild request
  | { tag: "output-limit" }                       // finish=length → continue output
  | { tag: "interrupted" }
  | { tag: "failed"; error: Error }

interface InboxItem {
  id: string
  delivery: "queue" | "steer"
  message: UserMessage | SystemNotice
  source: "user" | "subagent" | "cron" | "system"
}
```

## The loop

```ts
async function runTurn(session, signal) {
  await store.claim(session.id)                       // durable claim, crash → resume
  let step = 0
  try {
    while (true) {
      const next = await inbox.next(session.id)        // promote steer between steps, queue at turn start
      if (next.tag === "idle") break
      const outcome = await runStep(session, next.context, step++, signal)
      switch (outcome.tag) {
        case "continue":      continue
        case "compacted":     continue                  // rebuild request from the new checkpoint
        case "output-limit":  inbox.push(steer(CONTINUE_AFTER_OUTPUT_LIMIT)); continue
        case "retry":         await sleep(outcome.delay); continue
        case "completed":
        case "interrupted":
        case "failed":        return outcome
      }
    }
  } finally {
    await store.release(session.id, { keepOnShutdown: signal.reason === "shutdown" })
  }
}
```

### `runStep`

1. **Budget check**: if `step >= agent.steps` → insert `MAX_STEPS_PROMPT`, `toolChoice: "none"`, **keep the tool definitions unchanged** (cache). The first time `step >= 0.8 * agent.steps` → push steer `WRAPUP_NOTICE` (from hermes).
2. **Context assembly** (`context/system.ts` + `context/compaction.ts`): if `estimate.total >= ceiling` → compact before calling the model.
3. **Build request**: system parts + messages from the latest checkpoint + tool definitions (after permission filtering).
4. **Stream**: `provider.stream(request, signal)` → `AsyncIterable<StreamEvent>`.
   - `text-delta` → append to the assistant part, emit to the UI.
   - `tool-call` (complete args) → **persist the assistant message with the tool-call part immediately** (`store.append`), then start the `executeTool()` promise right away, without waiting for the stream to end (from opencode/openclaw).
   - `finish` → write `usage` into `budget.measured`.
5. **Settle tools**: `await Promise.allSettled(toolRuns)`; results are reinserted in tool-call order; each result goes through `output.truncate()`.
6. **Doom-loop check** (`loop/guard.ts`): if 3 consecutive tool calls are identical (name + args hash) or the same tool errors 3 times in a row → push steer `REPEATED_TOOL_NOTICE`; second time → `failed`. (opencode V2 dropped this and it was considered a weakness, so we keep it.)
7. **Outcome**: a local tool ran → `continue`; `finish === "length"` → `output-limit` (3 in a row → `failed`); no tool → `completed`.

### Parallel tools

- By default all tool calls in a step run in parallel.
- Tools declaring `concurrency: "serial"` (e.g. `question`, foreground `delegate`) wait for preceding tools to finish.
- Approval prompts go through a sequential gate: if several tools need `ask` at the same time, they are asked one by one (from hermes `_ConcurrentToolAuthorizationGate`).
- Default batch deadline 300s; the `delegate` tool is exempt.

### Interrupt & steer

- `AbortSignal` runs through everything: provider stream, tool execute, subagent block.
- User `Esc` → `abort("user")`: cancel the stream, cancel running tools, write tool result `{error: "interrupted"}` for unfinished calls, release the claim.
- User types mid-turn → `steer` by default: the item is promoted **after the current tool batch settles**, before the next step. The model sees it as a new user message after the tool results.
- `/queue <msg>` → `queue`: processed only after the turn ends.

### Retry & provider errors

- 429 / 5xx / network → `retry` with backoff 1s→2s→4s→8s, at most 5 times; 401/403 → `failed` immediately.
- Provider sends `retry-after-ms` / `retry-after` → wait exactly that long instead of the backoff. Wait longer than 60s (e.g. daily quota exhausted) → `failed` immediately with error "provider asked to wait Ns"; the turn does not hang.
- Stream breaks (provider throws or returns `error`) after a tool call was emitted → the tool still finishes, the result is still recorded, the turn does `continue`. Break before a tool call → `retry` like a network error.
- Stopped mid-stream: the OpenAI provider does not emit tool calls with partial args; the loop does not start new tools after abort; already-streamed text is kept.
- `usage.inputTokens = 0` (proxy returns no usage) → do **not** reset `measured`; keep accumulating the chars/4 estimate. Previously it reset to 0, so compaction never triggered.
- Stopping the CTO while it waits for an employee (foreground `delegate`) → the tool call's signal propagates to `spawn` and the employee is aborted too. Background employees are not stopped with it (stop them with `delegate stop` or the Stop button in their session).
- Provider reports context too long → `compaction.recoverOverflow()` tries shrinking `[0.85, 0.7, 0.5]` → `compacted`.
- **Fallback models** (`Harness.modelChain` + `TurnContext.fallbacks`):
  - Order: session model → rest of `agent.model` → `fallbackModels` in the company config → `defaultModel`. Duplicates and unresolvable refs are dropped.
  - Switch model when: (a) 5 retries are exhausted; (b) the provider asks to wait more than 60s; (c) non-retryable provider error (401/403/400, model does not exist). These errors carry class `ProviderError`. Errors caused by the agent (doom loop, output limit, overflow that cannot be compacted) do **not** switch model.
  - The current turn continues on the new model from the exact step that failed; the transcript is unchanged. A notice `model X failed (…); switching to Y` is emitted.
  - `Live.activeModel` remembers the model in use: later turns start from that model and do not retry the broken model every turn. In memory only: after a restart the primary model is tried again. `session.model` is unchanged (it is the original choice).
  - The system prompt does not change when switching model (the new provider's cache starts over; acceptable).

### Durability

- The store is an append-only event log in SQLite: table `events` (seq, session_id, kind, data JSON), read back with `fold`; metadata in table `sessions` (see `08-storage.md`). Each row = `MessageAppended | PartUpdated | ToolResult | Compaction | Claim | Release`, plus inbox and assigned work (`inbox`, `inbox-taken`, `assign*`, see `12-durable-work.md`).
- **Orphaned tool calls** (a `tool-call` with no `tool-result`, because the server shut down while a tool was running): `repairDangling` writes result `interrupted: …` (isError) to the store. Runs in `Harness.resume` and at the start of every `runTurn`. Reason: OpenAI-style APIs return 400 for any request with `tool_calls` missing a tool message → without the repair the session is permanently broken.
- If `resume` sees a `staleClaim` (Claim without Release) or has just repaired tool calls → queue `RESUMED_AFTER_CRASH` (system message) in the inbox; the model sees it on the next turn. At startup, `Harness.recover` **runs that turn immediately** (a change from before: work must not stop just because nobody opened the web UI; the CEO accepts the extra cost of redone work). See `12-durable-work.md`.

## Intentionally NOT done in v1

- No opencode-style event bus / projector. Reading the store sequentially is enough.
- No openclaw-style lanes / global concurrency cap. Only the per-session `maxConcurrentSubagents` limit.
- No provider-side compaction.
