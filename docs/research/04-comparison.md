# Comparison of the 3 harnesses

| Criterion | hermes-agent | opencode V2 | openclaw |
|---|---|---|---|
| Language / model | Python, sync + threads | TS, Effect-TS, event-sourced | TS, async, pi fork |
| Loop stop condition | no more tool_calls, or budget exhausted | `needsContinuation` (local tool present) + `Outcome` enum | `stopReason` + `endTurn` + `batch.terminate` |
| Step cap | 500 (sub 250), wrap-up notice at 80% | `agent.steps`, last step `toolChoice:none` keeps tools | 48h timeout, idle timeout |
| Doom-loop | `repetition_guard.py` | **none** (dropped in V2) | `agent-loop-tool-recovery.ts` (repeated tool errors) |
| Mid-run steering | `/steer` inserted after tool result | inbox `steer` promoted between steps | `steer/followup/collect/interrupt`, cap 20 |
| Parallel tool execution | ThreadPool 8, reinsert in order | fork fiber as soon as tool-call event arrives | run immediately during stream, batch |
| Persist before execute | **yes** (SQLite) | **yes** (claim + event bus WAL) | SQLite + writer fence |
| Tool schema | OpenAI dict | Effect/Zod/JSON Schema, normalized byte-stable | TypeBox + tool-call-repair |
| Large output | spill to disk + pointer | 2000 lines / 50 KiB, spill file kept 7 days | truncation + in-memory prune |
| Permission | approval callback + dangerous cmd detection + YOLO | ruleset `action/resource/effect` last-match, `ask` default | profile × allow/deny/alsoAllow × elevated × sandbox |
| MCP | `mcp_<server>_<tool>`, lazy, sanitize | `<server>_<tool>`, per-tool permission | bundle MCP + code mode |
| Code Mode | `execute_code` (budget refund) | default for most tools via `execute` | `code-mode-*.ts` |
| System prompt | 3 tiers by volatility, **frozen** | `system.txt` + instruction sources shared-first, diff on change | stable prefix + dynamic suffix, `promptMode` |
| Project rules | `.hermes.md` > `AGENTS.md` > `CLAUDE.md` | `AGENTS.md` + config `instructions` | workspace bootstrap files (cap 20k/60k chars) |
| Skills | index + `skill_view` on demand | `<available_skills>` + `skill` tool | `<available_skills>` + `formatSkillsForPrompt` |
| Memory | `MEMORY.md` 2.2k + `USER.md` 1.4k + FTS5 session_search | not built in (plugin) | `MEMORY.md` + daily notes + vector search + flush + dreaming |
| Compaction trigger | 50% window | `ctx − max(15%, 16k)`, precompute before 60k | `min(75%, ctx − 20k)` |
| Compaction method | prune → protect 3/20 → summary schema → reassemble | summary-over-full-request, keep 15k, checkpoint tag, shrink steps | summarizer cap 160k chars, keep 20k, preserve identifiers, refusal detection |
| Token estimate | heuristic + usage anchor | `{measured, estimated}` ±15% | char-based for bootstrap, tokens for compaction |
| Subagent spawn | `delegate_task` tasks[] | `subagent` tool `{agent, prompt, background, sessionID}` | `sessions_spawn` `{task, context: isolated|fork}` |
| Child context | goal + context string only | prompt only | `isolated` or `fork` transcript |
| Result to parent | result entry (status/summary) via queue | last text, or synthetic user message (background) | announce message into the parent session |
| Depth / concurrency | depth 2, 3 concurrent | depth 1 | 8 concurrent, depth cap |
| Child tool restriction | leaf loses delegate/clarify/memory | `subagent` permission action | `SUBAGENT_TOOL_DENY_ALWAYS/LEAF` |
| Child follow-up | `steer`, `stop` | resend `sessionID` | `sessions_send`, `subagents wait/cancel` |

## What all 3 have in common

1. Prompt cache is an architectural priority: stable content goes first, volatile content is pushed to the end or goes through messages.
2. Skills: only the index goes into the prompt; content is loaded on demand.
3. A tool-call/result pair is never split during compaction.
4. Summaries follow a fixed schema (Goal / Decisions / Files / Next steps…).
5. Subagents have isolated context, receive only a brief, and return only a compact result.
6. Background subagent results return to the parent as a **message** (not a late tool result).
7. Large tool output must be truncated/spilled, not dumped wholesale into context.

## Differences worth choosing from

- **Steering**: opencode's inbox (queue/steer) is the cleanest model; openclaw has the richest set of modes.
- **Permission**: opencode's last-match-wins ruleset is easier to reason about than openclaw's layered profiles.
- **Memory**: openclaw is the most complete (flush before compaction is a good idea); hermes is the most compact.
- **Durability**: opencode's claim + WAL is the strongest but complex; hermes's persist-before-execute is good enough and simple.
- **Child context**: openclaw's `fork` is the only option that lets the child see the parent transcript — useful for a reviewer.
