# OpenClaw (openclaw/openclaw, v2026.11.1)

> TypeScript, pnpm monorepo. Gateway daemon nối chat channel (WhatsApp, Telegram, Discord, Slack…) với agent session. Loop fork từ `pi` của Mario Zechner, nay nằm trong `packages/agent-core`. Nghiên cứu 11/2026.

## 1. Agent loop

- Entry: `src/agents/agent-command.ts::agentCommand` → `runEmbeddedAgent` (`embedded-agent-runner/run-orchestrator.ts` → `run-loop.ts`). Event bridge sang Gateway stream (`assistant`, `tool`, `lifecycle` start/finishing/end/error) trong `embedded-agent-subscribe.*.ts`.
- Loop thật: `runAgentLoop` trong `packages/agent-core/src/agent-loop.ts`:

```ts
while (true) {
  let hasMoreToolCalls = firstTurn || !prepareContinuation;
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    if (await stopIfAborted()) return newMessages;
    if (pendingMessages.length > 0) await commitPendingMessages();   // steering
    if (prepareContinuation) { /* refresh systemPrompt + tools */ }
    const streamed = await streamAgentResponse(ctx, config, signal, emit, newMessages,
      async (assistantMessage, toolCalls) => executeToolCalls(...));   // tool chạy NGAY khi stream
    hasMoreToolCalls = streamed.continuationRequired
      || (message.stopReason === "stop" && message.endTurn === false && !batch?.terminate)
      || (batch !== undefined && !batch.terminate);
    pendingMessages = batch?.steeringMessages ?? [];
  }
}
```

- Tool chạy ngay khi tool-call đến trong stream (`agent-stream-response.ts`, `launchParallelToolCalls`). Tool flag `async` có xử lý "unobserved result".
- Continue/stop theo `stopReason`, `endTurn === false`, cờ `terminate`/`terminateRun` của batch. Hook `prepareNextTurn` re-render system prompt + tool list giữa các turn (cách áp dynamic prompt section và đổi tool policy giữa run).
- Loop-recovery (`agent-loop-tool-recovery.ts`): đếm tool error giống nhau lặp; lần 2 "critical loop" → terminate với `REPEATED_TOOL_ERROR_CODE`.
- Error: provider `error`/`aborted` kết thúc sạch; user abort thêm "interrupted turn" message. `src/agents/failover/` fallback model/auth-profile. Timeout run 48h, idle 120s cloud / 300s self-host.
- Queueing: session controller serialize turn per session, rồi global lane `main` (`maxConcurrent`); subagent/cron dùng lane `subagent:<session>`, `cron`, `cron-nested`. SQLite transcript per agent với `activeWriterRunId` fence.
- Steering (`messages.queue.mode`): `steer` (default, inject sau tool batch hiện tại), `followup`, `collect` (debounce 500ms), `interrupt`. Queue cap 20, overflow `drop:"summarize"`.
- `NO_REPLY` token để agent im lặng mà vẫn hoàn tất turn.
- Runtime thay thế: plugin harness (`codex`, `copilot`), CLI backend (`claude-cli`), ACP (`packages/acp-core`) — chung session store.

## 2. Tool calling

- Schema: TypeBox JSON Schema. `packages/tool-call-repair` sửa call hỏng (anyOf/oneOf recovery); model *in* tool call dạng text → 1 lần yêu cầu sửa native.
- Policy (`src/agents/agent-tools.policy.ts`) layered:

```ts
const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
const policies = [profilePolicy, pickSandboxToolPolicy(cfg.tools), pickSandboxToolPolicy(agentTools), ...extraPolicies];
```

  Config: `tools.profile` (`coding`/`messaging`/`minimal`/`full`), `allow/deny/alsoAllow`, `elevated`, `agentToAgent`, per-provider, per-channel, per-agent `agents.entries.<id>.tools`.
- Subagent hard deny:

```ts
const SUBAGENT_TOOL_DENY_ALWAYS = ["gateway","agents_list","openclaw","session_status","progress_card",
  AUTOMATIONS_TOOL_NAME,"message","sessions_send","conversations_list","conversations_send","conversations_turn"];
const SUBAGENT_TOOL_DENY_LEAF = ["subagents","sessions_list","sessions_history","sessions_search","sessions_spawn"];
```

- Exec approvals (~50 file `bash-tools.exec-*.ts`): approval request/followup, host policy (gateway host hoặc paired node device), grant persist, cron grant.
- Sandbox Docker: `sandbox.{mode:"off"|"non-main"|"all", scope:"agent"|"shared"}`.
- MCP qua `agent-bundle-mcp-*.ts`; Code Mode (`code-mode-*.ts`) cho model viết JS gọi tool.
- Hook: `before_tool_call` (`{block:true}`), `after_tool_call`, `tool_result_persist`. **Turn taint** (`turn-taint.ts`) đánh dấu turn bị ảnh hưởng bởi output không tin cậy; compaction strip `toolResult.details` để không tới summarizer.

## 3. Context engineering

- `buildAgentSystemPrompt` (pure) → `buildConfiguredAgentSystemPrompt` (apply config) → runtime adapter. Section theo thứ tự: Tooling, Execution Bias, Promised Work, Care, Runtime Context, Skills (`<available_skills>`), Workspace, Documentation, Sandbox, Runtime, Reasoning.
- **Prompt-cache boundary**: prefix ổn định; thứ biến động (time, session state, active subagents) đẩy xuống dynamic suffix. `promptMode: full | minimal (subagent) | none`. `gpt5-prompt-overlay.ts` overlay per-model.
- Bootstrap files (`bootstrap-files.ts`, `bootstrap-budget.ts`): workspace `~/.openclaw/workspace` với `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` (lần đầu), `MEMORY.md`; mỗi file cap 20.000 chars, tổng 60.000. Subagent chỉ nhận `AGENTS.md`. Mode `always | continuation-skip | never`; marker `openclaw:bootstrap-context:full` trong transcript để continuation bỏ qua re-inject.
- Memory 3 tầng: `MEMORY.md` (curated), `memory/YYYY-MM-DD.md` (daily notes, load khi `/new`), `memory_search` (hybrid vector + keyword SQLite). **Memory flush** trước compaction: một turn nhắc agent ghi lại thứ cần giữ. Job nền "dreaming" consolidate notes vào `MEMORY.md`.
- Compaction: trigger `min(75% window, window − 20k)`; input summarizer cap 160k chars; `keepRecentTokens: 20000`; giữ cặp tool-call/result; instruction bảo toàn identifier:

```ts
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written ... UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";
```

  Mode `safeguard | default`, model riêng, phát hiện refusal, provider-side compaction. Session pruning riêng trim tool result cũ in-memory không rewrite transcript. Lệnh `/compact [focus]`, `/context`, `/new`, `/reset`.

## 4. Multi-agent

- `agents.entries.<id>` mỗi agent có workspace, agentDir, session store. Routing inbound theo `bindings[]` `{channel, accountId, peer, guildId}`. Session key `agent:<id>:main`, `agent:<id>:subagent:<uuid>`. `openclaw agents team create` scaffold coordinator/researcher/writer/reviewer.
- `sessions_spawn({task, agentId, runtime:"subagent"|"acp", mode:"run"|"session", context:"isolated"|"fork", sandbox, worktree, completionTarget:"parent", runTimeoutSeconds})`.
- Lifecycle: spawn → run → **announce** (kết quả post về session của requester như message) → cleanup. Parent có `sessions_yield({waitFor:"message"})`, `subagents list|wait|cancel`, `sessions_send` (steer/followup).
- Giới hạn `subagents.maxConcurrent: 8`, `maxChildrenPerAgent`, depth cap, `delegationMode: "prefer"|"suggest"`. Block "Active Subagents"/"Recently Completed Subagents" inject vào dynamic suffix của parent. Swarm collector `agents_wait`.
- Isolation: child `promptMode: minimal`, chỉ `AGENTS.md`, kế thừa allow/deny, không message user trực tiếp.
- Cron tool trên lane `cron`; heartbeat trên `cron-nested`. `HOOK.md` + internal hook (`command:new/reset/stop`).

## 5. Đánh giá

**Mạnh**: câu chuyện vận hành hoàn chỉnh (SQLite + writer fence, lane, timeout, failover, refusal handling, loop-recovery); memory thực dụng và đọc được; delegation có capability inheritance rõ; hook nhiều (`before_prompt_build`, `tool_result_persist`, `before/after_compaction`).

**Yếu**: sprawl ~1000 file phẳng trong `src/agents/`; bề mặt config khổng lồ, khó suy luận policy hiệu lực; budget bootstrap theo char không theo token; an toàn dựa nhiều vào instruction; patch provider quirks rải rác.

**Rút ra cho Hahaness**: `context: "isolated" | "fork"` cho subagent; announce pattern; memory flush trước compaction; turn taint; lane/concurrency; prompt prefix/suffix boundary; loop-recovery theo tool error lặp; `NO_REPLY`.
