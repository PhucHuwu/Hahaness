# OpenCode V2 (anomalyco/opencode, nhánh `dev`)

> TypeScript/Bun, Effect-TS, event-sourced. Core nằm ở `packages/core/src/`, model I/O trong `packages/ai` (`LLMClient.stream`). Nghiên cứu 11/2026.

## 1. Agent loop

Files: `session/execution.ts` → `session/runner/llm.ts` → `session/runner/step.ts` → `runner/publish-llm-event.ts`, cùng `runner/retry.ts`, `runner/max-steps.ts`.

- `SessionExecution` giữ một `SessionRunCoordinator` mỗi session. Bắt đầu turn ghi **durable claim** (`store.claim(sessionID)`) cùng transaction với `Execution.Started`; claim còn sót mà không có terminal event = dấu hiệu crash → resume.
- `drain()` = một turn:

```ts
while (true) {
  const next = yield* advanceToStep()   // lấy từ inbox: input / steer / compaction
  if (next._tag !== "Ready") return next
  continuing = yield* runStep(next.context, step)
  step++
}
```

- Input là **inbox** (`session/inbox.ts`) với `delivery: "queue" | "steer"`. Steer được promote giữa các step; queue chỉ ở biên turn.
- `runStep`: load context → auto-compaction check → build request → `steps.attempt()` stream qua `llm.stream`, mỗi event publish lên bus (bus là write-ahead log; `projector.ts` fold thành messages). Mỗi `tool-call` event **fork fiber ngay** → tool chạy song song khi stream vẫn tiếp tục; bọc `Effect.uninterruptibleMask` để terminal event luôn được ghi.
- Continue/stop: `needsContinuation = some(tool => !tool.providerExecuted && (called || settled))`. `Outcome = Completed | Retry | Continue | RecoverFull | Compacted | OutputLimit`.
- Step cap `agent.steps`: step cuối chèn `MAX_STEPS_PROMPT` và `toolChoice: "none"` nhưng **giữ nguyên tool definitions** để không vỡ cache prefix.
- Abort: `interrupt(sessionID, {resume})` → `Fiber.interruptAll(toolRuns)`. Shutdown giữ claim để resume khi boot lại; user interrupt thả claim. `settleStaleToolCalls` fail các tool `running` mồ côi khi wake.
- Retry: `ModelRetry.policy` + hook `session.retry`. Stream đứt khi đã có output → `Continue` với user message tổng hợp `CONTINUE_AFTER_INCOMPLETE_STREAM`. `finish === "length"` → `OutputLimit`; 3 lần liên tiếp → fail. Overflow trước khi có output → compaction → rebuild.
- **Không còn doom-loop detection** trong V2 (V1 có detector 3 call giống nhau).

## 2. Tool calling

- `Tool.Info = { name, description, input, output?, execute(input, ctx), options?: { namespace, codemode, permission } }` (`packages/schema/src/tool.ts`). `input` nhận Effect Schema, Standard-Schema (Zod v4), hoặc JSON Schema thô (MCP).
- `runtime.ts::definition()` flatten `allOf`, inline `$defs`, strip `MIN/MAX_SAFE_INTEGER` để schema **byte-stable cho cache**. Validation fail trả `Tool.Error` cho model (tối đa 5 issue + args đã gửi).
- Registry `core/src/tool.ts`: `Tool.Service` + `Editor` (add/update/remove/namespace), plugin mutate qua `ctx.tool.transform`. Built-in trong `tool/plugin/*.ts`: read, edit, write, patch, glob, grep, shell, webfetch, websearch, question, todo, skill, subagent, schedule, artifact, mcp-resource.
- `snapshot(permissions)` lọc tool bị `deny *`, tách **direct tools** và **Code Mode tools** (chỉ gọi được qua tool `execute` chạy JS; mặc định cho hầu hết tool trừ `codemode: false`).
- Result: `{ output?, content: (text | file data-URI)[], metadata? }`. Hook `tool.execute.before/after`.
- Truncation (`tool-output.ts`): `MAX_LINES = 2000`, `MAX_BYTES = 50 KiB`; phần dư ghi ra `~/.local/share/opencode/tool-output/tool_<id>` (giữ 7 ngày), content kết bằng `[showing lines 1-N of M; full output saved to <path>]`.
- Permission (`permission.ts`): ruleset có thứ tự `{action, resource, effect: allow|ask|deny}`, `evaluate() = findLast` wildcard match, mặc định `ask`. Saved "always" approvals **không bao giờ override deny** đã config. `assert()` block trên `Deferred` tới khi `reply()`. Reject-with-feedback giữ typed `CorrectedError` để model thấy; decline thường tunnel như defect để tool không nuốt được. `Unattended` → `ask` thành `deny`. Actions: `read`, `edit`, `shell`, `subagent`, `skill`, `webfetch`, `<server>_<tool>`, `external_directory`, `execute`.
- MCP (`tool/mcp.ts`): namespace `<server>` → tên `<server>_<tool>`; catalog change debounce 100ms. Tắt tool per-agent = rule `{action: "<tool>", resource: "*", effect: "deny"}`.

## 3. Context engineering

- System prompt (`session/model-request.ts::baseTranscript`): 2 phần — `agent.system` hoặc `system.txt` (~750 bytes generic), rồi instruction sources đã join. **Không còn prompt per-provider**.
- Instruction sources (`session/context.ts::select`) xếp **shared-most-first** cho cache:

```ts
Instructions.combine([CodeModeInstructions, mcp, references, skills, discovery, builtins, entries])
```

  - `instruction-discovery.ts` → `AGENTS.md` / config `instructions`, render `Instructions from: <path>\n<content>`.
  - `instructions/builtins.ts` → `core/date`, `core/environment` (`<env>`: cwd, git, platform, tmp).
  - `skill/instructions.ts` → `<available_skills>` (id/name/description); tool `skill` load `SKILL.md` on demand.
- Mỗi source hash canonical JSON. Khi source đổi giữa session → inject **unified diff** như `system` message thay vì rewrite prefix.
- Token (`util/token.ts`): `Estimate = { measured, estimated }` — usage thật của response trước + ~4 chars/token cho phần sau, `ESTIMATE_ERROR = 0.15`.
- Compaction (`session/compaction.ts`, ~1.270 dòng):
  - Trigger khi `total >= context − max(15%, 16k)`.
  - `summarize()` gửi **toàn bộ request hiện có + summary prompt** (tận dụng cache) theo template Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context. Retry 1 lần nếu thiếu heading.
  - Lưu thành `compaction` message; request sau mở bằng `<conversation-checkpoint><summary>…</summary><recent-context>…</recent-context>`. `keep` 15k token gần nhất giữ nguyên.
  - **Precompute**: chạy nền summary trước ceiling 60k token, chỉ khi cache còn ấm (5 phút − 30s), swap vào khi cần.
  - Overflow recovery: `SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]`; `flattenAndDropOldest` giảm dần `OUTPUTS_CLIPPED → OUTPUTS_REMOVED → USER_ONLY → OMITTED`.
  - Native compaction cho provider có checkpoint server-side (OpenAI Responses).
- Không prune tool output giữa compaction; chỉ bound ảnh (`boundImages`: >25 MiB thì drop cũ nhất xuống 15 MiB).

## 4. Multi-agent

- Agent schema: `{ id, name, model?, system?, description?, mode: "primary"|"subagent"|"all", hidden, steps?, permissions: Ruleset }`. Định nghĩa `.opencode/agents/*.md` (frontmatter + body = system) hoặc `agents.<id>` trong JSON. Built-in: `build`, `plan`, `general`, `explore`, hidden `compaction`/`title`/`summary`.
- Tool `subagent` (`tool/plugin/subagent.ts`): input `{ agent, description, prompt, model?, sessionID?, background? }`.
  - Guard: depth `experimental.subagent_depth` (default 1), `mode !== "primary"`, `permission.assert({action: "subagent", resources: [agent.id]})`.
  - Child: `sessions.create({ parentID, title, agent, model })`. **Không chia sẻ context**: child chỉ nhận `"You are a subagent spawned by another session.\n" + prompt`.
  - Foreground: `jobs.block` chờ; trả text assistant cuối trong `<subagent sessionID state="completed">…</subagent>`.
  - Background: trả ngay; `SubagentJob.notify` chờ xong rồi inject **synthetic user message** vào parent inbox.
  - Follow-up: gửi lại `sessionID`, đổi agent/model trên child cũ được.
  - Description tool mở rộng động với danh sách subagent được phép (hook `session.context`).

## 5. Đánh giá

**Mạnh**: durability by construction (event bus + projector + claim); cache obsession (instruction order, diff update, giữ tools ở step cuối, summary-over-full-request, precompute theo TTL cache); permission model thống nhất; tool chạy song song với interruption semantic rõ; hook phong phú.

**Yếu**: Effect-TS + event sourcing khó đọc; không có doom-loop detection; subagent không nhận context parent; không prune tool output giữa compaction; prompt generic cho mọi model.

**Rút ra cho Hahaness**: inbox queue/steer; Outcome tagged union; permission `action/resource/effect` last-match-wins; truncate + spill tool output; instruction diff thay vì rewrite; `<conversation-checkpoint>`; background subagent inject synthetic user message.
