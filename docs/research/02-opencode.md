# OpenCode V2 (anomalyco/opencode, branch `dev`)

> TypeScript/Bun, Effect-TS, event-sourced. Core lives in `packages/core/src/`, model I/O in `packages/ai` (`LLMClient.stream`). Researched 11/2026.

## 1. Agent loop

Files: `session/execution.ts` → `session/runner/llm.ts` → `session/runner/step.ts` → `runner/publish-llm-event.ts`, plus `runner/retry.ts`, `runner/max-steps.ts`.

- `SessionExecution` holds one `SessionRunCoordinator` per session. Starting a turn writes a **durable claim** (`store.claim(sessionID)`) in the same transaction as `Execution.Started`; a leftover claim with no terminal event = crash signal → resume.
- `drain()` = one turn:

```ts
while (true) {
  const next = yield* advanceToStep()   // take from inbox: input / steer / compaction
  if (next._tag !== "Ready") return next
  continuing = yield* runStep(next.context, step)
  step++
}
```

- Input is an **inbox** (`session/inbox.ts`) with `delivery: "queue" | "steer"`. Steer is promoted between steps; queue only at turn boundaries.
- `runStep`: load context → auto-compaction check → build request → `steps.attempt()` streams via `llm.stream`, each event is published to the bus (the bus is a write-ahead log; `projector.ts` folds it into messages). Each `tool-call` event **forks a fiber immediately** → tools run in parallel while the stream continues; wrapped in `Effect.uninterruptibleMask` so the terminal event is always written.
- Continue/stop: `needsContinuation = some(tool => !tool.providerExecuted && (called || settled))`. `Outcome = Completed | Retry | Continue | RecoverFull | Compacted | OutputLimit`.
- Step cap `agent.steps`: the last step inserts `MAX_STEPS_PROMPT` and `toolChoice: "none"` but **keeps the tool definitions unchanged** so the cache prefix is not broken.
- Abort: `interrupt(sessionID, {resume})` → `Fiber.interruptAll(toolRuns)`. Shutdown keeps the claim so the run resumes on next boot; user interrupt releases the claim. `settleStaleToolCalls` fails orphaned `running` tools on wake.
- Retry: `ModelRetry.policy` + hook `session.retry`. Stream cut after some output → `Continue` with a synthetic user message `CONTINUE_AFTER_INCOMPLETE_STREAM`. `finish === "length"` → `OutputLimit`; 3 in a row → fail. Overflow before any output → compaction → rebuild.
- **No doom-loop detection anymore** in V2 (V1 had a detector for 3 identical calls).

## 2. Tool calling

- `Tool.Info = { name, description, input, output?, execute(input, ctx), options?: { namespace, codemode, permission } }` (`packages/schema/src/tool.ts`). `input` accepts Effect Schema, Standard-Schema (Zod v4), or raw JSON Schema (MCP).
- `runtime.ts::definition()` flattens `allOf`, inlines `$defs`, strips `MIN/MAX_SAFE_INTEGER` so the schema is **byte-stable for caching**. Validation failure returns `Tool.Error` to the model (at most 5 issues + the args sent).
- Registry `core/src/tool.ts`: `Tool.Service` + `Editor` (add/update/remove/namespace); plugins mutate via `ctx.tool.transform`. Built-ins in `tool/plugin/*.ts`: read, edit, write, patch, glob, grep, shell, webfetch, websearch, question, todo, skill, subagent, schedule, artifact, mcp-resource.
- `snapshot(permissions)` filters out tools under `deny *`, and splits **direct tools** from **Code Mode tools** (callable only through the `execute` tool, which runs JS; default for most tools except `codemode: false`).
- Result: `{ output?, content: (text | file data-URI)[], metadata? }`. Hooks `tool.execute.before/after`.
- Truncation (`tool-output.ts`): `MAX_LINES = 2000`, `MAX_BYTES = 50 KiB`; the excess is written to `~/.local/share/opencode/tool-output/tool_<id>` (kept 7 days), content ends with `[showing lines 1-N of M; full output saved to <path>]`.
- Permission (`permission.ts`): ordered ruleset `{action, resource, effect: allow|ask|deny}`, `evaluate() = findLast` wildcard match, default `ask`. Saved "always" approvals **never override a configured deny**. `assert()` blocks on a `Deferred` until `reply()`. Reject-with-feedback keeps a typed `CorrectedError` so the model sees it; a plain decline is tunneled as a defect so the tool cannot swallow it. `Unattended` → `ask` becomes `deny`. Actions: `read`, `edit`, `shell`, `subagent`, `skill`, `webfetch`, `<server>_<tool>`, `external_directory`, `execute`.
- MCP (`tool/mcp.ts`): namespace `<server>` → name `<server>_<tool>`; catalog changes debounced 100ms. Disabling a tool per agent = rule `{action: "<tool>", resource: "*", effect: "deny"}`.

## 3. Context engineering

- System prompt (`session/model-request.ts::baseTranscript`): 2 parts — `agent.system` or `system.txt` (~750 bytes, generic), then the joined instruction sources. **No per-provider prompt anymore**.
- Instruction sources (`session/context.ts::select`) are ordered **shared-most-first** for caching:

```ts
Instructions.combine([CodeModeInstructions, mcp, references, skills, discovery, builtins, entries])
```

  - `instruction-discovery.ts` → `AGENTS.md` / config `instructions`, rendered as `Instructions from: <path>\n<content>`.
  - `instructions/builtins.ts` → `core/date`, `core/environment` (`<env>`: cwd, git, platform, tmp).
  - `skill/instructions.ts` → `<available_skills>` (id/name/description); the `skill` tool loads `SKILL.md` on demand.
- Each source hashes its canonical JSON. When a source changes mid-session → a **unified diff** is injected as a `system` message instead of rewriting the prefix.
- Token (`util/token.ts`): `Estimate = { measured, estimated }` — real usage of the previous response + ~4 chars/token for what follows, `ESTIMATE_ERROR = 0.15`.
- Compaction (`session/compaction.ts`, ~1,270 lines):
  - Triggers when `total >= context − max(15%, 16k)`.
  - `summarize()` sends the **entire existing request + a summary prompt** (reusing the cache) using the template Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context. Retries once if a heading is missing.
  - Stored as a `compaction` message; the next request opens with `<conversation-checkpoint><summary>…</summary><recent-context>…</recent-context>`. `keep`: the most recent 15k tokens are kept verbatim.
  - **Precompute**: runs the summary in the background before a 60k-token ceiling, only while the cache is still warm (5 minutes − 30s), swapped in when needed.
  - Overflow recovery: `SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]`; `flattenAndDropOldest` degrades progressively `OUTPUTS_CLIPPED → OUTPUTS_REMOVED → USER_ONLY → OMITTED`.
  - Native compaction for providers with server-side checkpoints (OpenAI Responses).
- No tool output pruning between compactions; only images are bounded (`boundImages`: above 25 MiB, drops the oldest down to 15 MiB).

## 4. Multi-agent

- Agent schema: `{ id, name, model?, system?, description?, mode: "primary"|"subagent"|"all", hidden, steps?, permissions: Ruleset }`. Defined in `.opencode/agents/*.md` (frontmatter + body = system) or `agents.<id>` in JSON. Built-ins: `build`, `plan`, `general`, `explore`, hidden `compaction`/`title`/`summary`.
- `subagent` tool (`tool/plugin/subagent.ts`): input `{ agent, description, prompt, model?, sessionID?, background? }`.
  - Guards: depth `experimental.subagent_depth` (default 1), `mode !== "primary"`, `permission.assert({action: "subagent", resources: [agent.id]})`.
  - Child: `sessions.create({ parentID, title, agent, model })`. **No shared context**: the child only receives `"You are a subagent spawned by another session.\n" + prompt`.
  - Foreground: `jobs.block` waits; returns the last assistant text in `<subagent sessionID state="completed">…</subagent>`.
  - Background: returns immediately; `SubagentJob.notify` waits for completion, then injects a **synthetic user message** into the parent inbox.
  - Follow-up: resend `sessionID`; agent/model can be changed on the existing child.
  - The tool description is extended dynamically with the list of allowed subagents (hook `session.context`).

## 5. Assessment

**Strengths**: durability by construction (event bus + projector + claim); cache obsession (instruction order, diff updates, keeping tools on the last step, summary-over-full-request, precompute tied to cache TTL); unified permission model; tools run in parallel with clear interruption semantics; rich hooks.

**Weaknesses**: Effect-TS + event sourcing is hard to read; no doom-loop detection; subagents do not receive parent context; no tool output pruning between compactions; one generic prompt for every model.

**Takeaways for Hahaness**: inbox queue/steer; `Outcome` tagged union; permission `action/resource/effect` last-match-wins; truncate + spill tool output; instruction diff instead of rewrite; `<conversation-checkpoint>`; background subagent injects a synthetic user message.
