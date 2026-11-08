# Hermes Agent (NousResearch/hermes-agent)

> Python, synchronous loop, parallelism via threads. Researched 11/2026.

## 1. Agent loop

- Entry: `run_agent.py::AIAgent` (facade) → `agent/agent_init.py::init_agent` (~60 parameters) → `agent/conversation_loop.py::run_conversation` (~1,950 lines).
- Each phase of a turn is split into a module `agent/turn_<phase>.py`: `iteration_prep`, `api_call`, `api_error`, `overflow`, `truncation`, `recovery`, `tool_round`, `stop_gates`, `finalizer`.
- Core loop (from `agent/AGENTS.md`):

```python
while (api_call_count < self.max_iterations
       and self.iteration_budget.remaining > 0) or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(...)
    if response.tool_calls:
        execute tools, append results, api_call_count += 1
    else:
        return content
```

- Budget: `max_iterations` = 500 (`IterationBudget`), subagent 250. A round containing only `execute_code` gets its budget **refunded**. At 80% of budget, `RUN_BUDGET_WRAPUP_NOTICE` is injected so the model wraps up cleanly on its own. `_MAX_OUTER_LOOP_ERRORS = 8`.
- Interrupt: `_interruptible_api_call()` runs HTTP in a background thread; the main thread watches an event. `/steer` inserts a user message after the current tool result, tagged with `_INTERRUPT_SCAFFOLD_MARKER`. `agent/repetition_guard.py` detects repeated tool calls.
- Provider: 3 API modes (`chat_completions`, `codex_responses`, `anthropic_messages`) all normalize to an OpenAI-style message list; reasoning is stored in `assistant_msg["reasoning"]`. `fallback_providers` retries on 429/5xx/401/403.

## 2. Tool calling

- `tools/registry.py::ToolRegistry`. Tools self-register at import time:

```python
registry.register(name="web_search", toolset="web", schema={...},
    handler=fn, check_fn=has_api_key, requires_env=[...],
    max_result_size_chars=..., execution_timeout=...)
```

- Discovery: AST-scans `tools/*.py` for `registry.register(` instead of eager import → cached in `cache/tool_discovery_cache.json`. `check_fn` is cached with a 30s TTL.
- Handlers return a JSON string or a multimodal envelope `{"_multimodal": True, "content": [...], "text_summary": str}`. Tool errors are truncated at 2048 characters.
- Toolsets (`toolsets.py`, ~28 groups): `browser`, `code_execution`, `delegation`, `file`, `memory`, `skills`, `terminal`, `todo`, `web`... Core tools are always enabled.
- Pipeline for 1 round (`agent/turn_tool_round.py`): validate → dedupe → **persist the assistant tool call to SQLite before execute** → execute → `compress_after_tool_results`. A crash mid-round is still recoverable.
- Dispatch (`agent/tool_executor.py`): `pre_tool_call` hook → guardrails → approval (`tools/approval.py`, dangerous command detection, YOLO mode) → handler → `post_tool_call`.
- Parallelism: `ThreadPoolExecutor(8)`, results reinserted in the original order. `_NEVER_PARALLEL_TOOLS` (e.g. `clarify`). Batch deadline 420s. `_ConcurrentToolAuthorizationGate` serializes approval prompts so the user does not get 8 popups at once.
- Large output spills to disk (`tools/tool_result_storage.py`), leaving a pointer in context.
- MCP (`tools/mcp_tool.py`): stdio/HTTP/OAuth, tools named `mcp_<server>_<tool>`, lazy start, refresh on `tools/list_changed`, strips TAG chars from descriptions against prompt injection.

## 3. Context engineering

3-tier system prompt ordered by **volatility** to maximize prefix cache (`agent/prompt_builder.py`, `agent/system_prompt.py`):

1. **Stable**: identity (`SOUL.md`), tool guidance, `<available_skills>` index.
2. **Context**: operator `system_message`, project file first-match (`.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`), git snapshot, platform hints.
3. **Volatile**: `MEMORY.md`/`USER.md` snapshot, timestamp, cwd.

- The prompt is **frozen byte-stable for the whole conversation** and persisted in the session DB. Anything that must change mid-conversation goes through a user message/tool result (skill slash command, subdirectory `AGENTS.md` hints capped at 32k chars).
- Memory is intentionally small: `MEMORY.md` 2,200 chars, `USER.md` 1,375 chars, edited via the `memory` tool (add/patch/remove). Because the prompt is frozen, new memory is only visible in the next session. Long-range recall = `session_search` (FTS5 over `state.db`).
- Skills: only the index is in the prompt; `skill_view(name)` loads on demand. After compaction, loaded skills are replaced with `[SKILL_PRUNED: ...]`.
- Compression (`agent/context_compressor.py`, ABC `context_engine.py`): triggers at 50% of the window. 4 phases:
  1. Prune old tool results >200 chars → `[Old tool output cleared]`.
  2. Pick boundaries: `protect_first_n=3`, `protect_last_n=20`, aligned backward so a tool-call/result pair is never split.
  3. Summarize the middle with an auxiliary model using a fixed schema (Goal / Constraints / Progress / Key Decisions / Relevant Files / Next Steps / Critical Context), budget 20% of content tokens, clamped to 2k–12k.
  4. Reassemble in place.
- `agent/usage_anchor.py` re-anchors the token estimate to the provider's real usage. `agent/prompt_caching.py` uses the `system_and_3` strategy for Anthropic.

## 4. Multi-agent

- `tools/delegate_tool.py::delegate_task`: `tasks[{goal, context, output_schema, images, group}]`, `action ∈ {spawn, list, steer, stop}`.
- Child = a completely new agent: `skip_context_files=True, skip_memory=True, clarify_callback=None, platform="subagent"`. **Knows nothing about the parent** beyond `_build_child_system_prompt(goal, context, workspace, role)`.
- Role by depth: `leaf` loses `delegate_task`, `clarify`, `memory`, `send_message`, `cronjob`; `orchestrator` (`max_spawn_depth=2`) may delegate further. `max_concurrent_children=3`.
- Return path: interactive → returns a delegation id immediately, the child runs in the background, and its result reaches the parent via an async queue as a new message between turns. Only `_build_result_entry` (status, exit_reason, summary, schema_valid) crosses the boundary — **never the transcript**.
- Heartbeat 30s, stale detection, interrupt fan-out via `_active_children`.

## 5. Assessment

**Strengths**: cache discipline is architectural (frozen prompt, tiers by volatility); persist-before-execute; context engine / memory provider / delegation provider are all pluggable via ABCs; good hardening (fallback provider, wrap-up notice, approval gate).

**Weaknesses**: huge files, 60-parameter constructor; threads instead of async, global state (`_last_resolved_tool_names`) must be saved/restored manually; sends all tool definitions on every call; memory frozen within a session; docs drift from code.

**Takeaways for Hahaness**: tier the prompt by volatility; persist-before-execute; fixed summary schema; subagent returns only a result entry; wrap-up notice at 80% of budget.
