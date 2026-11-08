# OpenClaw (openclaw/openclaw, v2026.11.1)

> TypeScript, pnpm monorepo. A Gateway daemon connects chat channels (WhatsApp, Telegram, Discord, Slack…) to agent sessions. The loop is forked from Mario Zechner's `pi`, now living in `packages/agent-core`. Researched 11/2026.

## 1. Agent loop

- Entry: `src/agents/agent-command.ts::agentCommand` → `runEmbeddedAgent` (`embedded-agent-runner/run-orchestrator.ts` → `run-loop.ts`). Event bridge to the Gateway stream (`assistant`, `tool`, `lifecycle` start/finishing/end/error) in `embedded-agent-subscribe.*.ts`.
- The actual loop: `runAgentLoop` in `packages/agent-core/src/agent-loop.ts`:

```ts
while (true) {
  let hasMoreToolCalls = firstTurn || !prepareContinuation;
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    if (await stopIfAborted()) return newMessages;
    if (pendingMessages.length > 0) await commitPendingMessages();   // steering
    if (prepareContinuation) { /* refresh systemPrompt + tools */ }
    const streamed = await streamAgentResponse(ctx, config, signal, emit, newMessages,
      async (assistantMessage, toolCalls) => executeToolCalls(...));   // tools run IMMEDIATELY during the stream
    hasMoreToolCalls = streamed.continuationRequired
      || (message.stopReason === "stop" && message.endTurn === false && !batch?.terminate)
      || (batch !== undefined && !batch.terminate);
    pendingMessages = batch?.steeringMessages ?? [];
  }
}
```

- Tools run as soon as the tool call arrives in the stream (`agent-stream-response.ts`, `launchParallelToolCalls`). Tools flagged `async` have "unobserved result" handling.
- Continue/stop is based on `stopReason`, `endTurn === false`, and the batch's `terminate`/`terminateRun` flags. Hook `prepareNextTurn` re-renders the system prompt + tool list between turns (the mechanism for applying dynamic prompt sections and changing tool policy mid-run).
- Loop recovery (`agent-loop-tool-recovery.ts`): counts repeated identical tool errors; on the 2nd "critical loop" → terminate with `REPEATED_TOOL_ERROR_CODE`.
- Errors: provider `error`/`aborted` ends cleanly; user abort adds an "interrupted turn" message. `src/agents/failover/` falls back across model/auth profile. Run timeout 48h, idle 120s cloud / 300s self-host.
- Queueing: the session controller serializes turns per session, then the global lane `main` (`maxConcurrent`); subagent/cron use lanes `subagent:<session>`, `cron`, `cron-nested`. SQLite transcript per agent with an `activeWriterRunId` fence.
- Steering (`messages.queue.mode`): `steer` (default, injected after the current tool batch), `followup`, `collect` (500ms debounce), `interrupt`. Queue cap 20, overflow `drop:"summarize"`.
- `NO_REPLY` token lets the agent stay silent while still completing the turn.
- Alternative runtimes: plugin harnesses (`codex`, `copilot`), CLI backend (`claude-cli`), ACP (`packages/acp-core`) — sharing the session store.

## 2. Tool calling

- Schema: TypeBox JSON Schema. `packages/tool-call-repair` fixes malformed calls (anyOf/oneOf recovery); if the model *prints* a tool call as text → one request to redo it natively.
- Policy (`src/agents/agent-tools.policy.ts`) is layered:

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

- Exec approvals (~50 files `bash-tools.exec-*.ts`): approval request/followup, host policy (gateway host or paired node device), persisted grants, cron grants.
- Docker sandbox: `sandbox.{mode:"off"|"non-main"|"all", scope:"agent"|"shared"}`.
- MCP via `agent-bundle-mcp-*.ts`; Code Mode (`code-mode-*.ts`) lets the model write JS that calls tools.
- Hooks: `before_tool_call` (`{block:true}`), `after_tool_call`, `tool_result_persist`. **Turn taint** (`turn-taint.ts`) marks turns affected by untrusted output; compaction strips `toolResult.details` so it does not reach the summarizer.

## 3. Context engineering

- `buildAgentSystemPrompt` (pure) → `buildConfiguredAgentSystemPrompt` (applies config) → runtime adapter. Sections in order: Tooling, Execution Bias, Promised Work, Care, Runtime Context, Skills (`<available_skills>`), Workspace, Documentation, Sandbox, Runtime, Reasoning.
- **Prompt-cache boundary**: stable prefix; volatile content (time, session state, active subagents) is pushed into a dynamic suffix. `promptMode: full | minimal (subagent) | none`. `gpt5-prompt-overlay.ts` is a per-model overlay.
- Bootstrap files (`bootstrap-files.ts`, `bootstrap-budget.ts`): workspace `~/.openclaw/workspace` with `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` (first run), `MEMORY.md`; each file capped at 20,000 chars, 60,000 total. Subagents only receive `AGENTS.md`. Modes `always | continuation-skip | never`; marker `openclaw:bootstrap-context:full` in the transcript lets continuations skip re-injection.
- 3-tier memory: `MEMORY.md` (curated), `memory/YYYY-MM-DD.md` (daily notes, loaded on `/new`), `memory_search` (hybrid vector + keyword, SQLite). **Memory flush** before compaction: one turn that reminds the agent to write down what must be kept. A background "dreaming" job consolidates notes into `MEMORY.md`.
- Compaction: trigger `min(75% window, window − 20k)`; summarizer input capped at 160k chars; `keepRecentTokens: 20000`; keeps tool-call/result pairs; instruction to preserve identifiers:

```ts
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written ... UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";
```

  Modes `safeguard | default`, separate model, refusal detection, provider-side compaction. Separate session pruning trims old tool results in memory without rewriting the transcript. Commands `/compact [focus]`, `/context`, `/new`, `/reset`.

## 4. Multi-agent

- `agents.entries.<id>`: each agent has its own workspace, agentDir, session store. Inbound routing by `bindings[]` `{channel, accountId, peer, guildId}`. Session keys `agent:<id>:main`, `agent:<id>:subagent:<uuid>`. `openclaw agents team create` scaffolds coordinator/researcher/writer/reviewer.
- `sessions_spawn({task, agentId, runtime:"subagent"|"acp", mode:"run"|"session", context:"isolated"|"fork", sandbox, worktree, completionTarget:"parent", runTimeoutSeconds})`.
- Lifecycle: spawn → run → **announce** (result posted to the requester's session as a message) → cleanup. The parent has `sessions_yield({waitFor:"message"})`, `subagents list|wait|cancel`, `sessions_send` (steer/followup).
- Limits `subagents.maxConcurrent: 8`, `maxChildrenPerAgent`, depth cap, `delegationMode: "prefer"|"suggest"`. "Active Subagents"/"Recently Completed Subagents" blocks are injected into the parent's dynamic suffix. Swarm collector `agents_wait`.
- Isolation: child `promptMode: minimal`, only `AGENTS.md`, inherits allow/deny, cannot message the user directly.
- Cron tool on lane `cron`; heartbeat on `cron-nested`. `HOOK.md` + internal hooks (`command:new/reset/stop`).

## 5. Assessment

**Strengths**: complete operational story (SQLite + writer fence, lanes, timeouts, failover, refusal handling, loop recovery); practical, human-readable memory; delegation with clear capability inheritance; many hooks (`before_prompt_build`, `tool_result_persist`, `before/after_compaction`).

**Weaknesses**: sprawl of ~1000 flat files in `src/agents/`; huge config surface, hard to reason about the effective policy; bootstrap budget is in chars, not tokens; safety relies heavily on instructions; provider-quirk patches scattered around.

**Takeaways for Hahaness**: `context: "isolated" | "fork"` for subagents; announce pattern; memory flush before compaction; turn taint; lanes/concurrency; prompt prefix/suffix boundary; loop recovery based on repeated tool errors; `NO_REPLY`.
