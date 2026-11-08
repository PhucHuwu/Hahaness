# 03 — Context engineering

## Structure of the request sent to the model

```
[system part 1]  Tier A — STABLE (cache prefix)
   ├─ identity          : agent.system (from agents/<id>.md body) or SOUL.md
   ├─ harness guidance  : tool usage rules, output style (~500 tokens, generic)
   └─ skills index      : <available_skills> id/name/description

[system part 2]  Tier B — COMPANY (stable within the session)
   ├─ <company>         : COMPANY.md — visible to every role
   ├─ <ceo>             : USER.md    — primary (CTO) only
   ├─ <memory>          : MEMORY.md  — primary only, snapshot at session start
   └─ <env>             : cwd, platform, date (day — no time)

[messages]
   ├─ <conversation-checkpoint> summary + recent-context   (if compacted)
   ├─ ... messages since the checkpoint ...
   └─ Tier C — VOLATILE goes through messages, NOT the system prompt:
        ├─ <workspace-update> (COMPANY/USER/MEMORY/knowledge/skills changed mid-session) → message source "system"
        ├─ subagent result   → user-role message `<subagent …>`
        ├─ wrap-up / steer   → user-role message
        └─ skill content     → tool result of `skill`
```

Reason: all 3 harnesses converge on "immutable prefix, volatile content via messages". Hermes freezes the system prompt completely; opencode injects diffs; openclaw splits off a dynamic suffix. Our choice: **system prompt frozen for the session, every change goes through messages**.

## Company workspace (`context/workspace.ts`)

Company documents are records in the `documents` table (virtual paths, see `08-storage.md`). The CEO "teaches" the company by telling the CTO; the CTO writes with `knowledge` / `memory` / `manage_skill`. The harness creates the COMPANY/USER templates the first time; an unedited template (headings/comments only) does **not** go into the prompt.

| Document | Who sees it | Content | Cap |
|---|---|---|---|
| `COMPANY.md` | all roles | what the company does, products, customers, voice | 20k chars |
| `USER.md` | CTO | who the CEO is, how they want reports, what they dislike | 20k |
| `MEMORY.md` | CTO | written by the CTO via the `memory` tool, entries separated by `§` | 4k, oldest dropped when full |
| `knowledge/**` | all roles | tree-shaped knowledge sets: the **index** `<knowledge>` contains each set and its first-level branches (id, title, summary); `read <node>` returns the node content and its children list (see `10-knowledge-tree.md`) | 80 lines in the index |
| skills (`skills` table) | all roles | only the **index** `<available_skills>` in Tier A; the body is loaded with the `skill` tool | — |

- Employees do not see `USER.md`/`MEMORY.md`: they do not need to know about the boss, and this reduces leaking personal preferences into written content.
- Each source (COMPANY, USER, MEMORY, knowledge index, `<env>`, skills index) has a SHA-256 hash.

### Documents changed mid-session (`Harness.refreshContext` + `instructions.updateNotice`)

The system prompt is **never** rebuilt within a session (keeps the prompt cache). Instead:

- Each session keeps `known`: the sources the model currently knows, i.e. the system prompt plus every update already sent.
- At the start of each turn with real input (non-empty inbox), the harness rebuilds the sources from the DB and compares them with `known`. If anything differs, it inserts a `source: "system"` message **at the front of the queue**:
  ```xml
  <workspace-update>
  The company workspace changed since this conversation started. These updates replace the matching parts of your system context.
  COMPANY.md (<company>) now reads: …            ← new content ≤1,500 chars: sent verbatim
  COMPANY.md (<company>) changed (- removed, + added): …   ← longer: line diff
  The skills list (<available_skills>) was added: …
  MEMORY.md (<memory>) was removed or emptied; …
  </workspace-update>
  ```
  Each block is cut at 6,000 chars, with a reminder to use `read` to see the rest.
- **No turn is started just because a document changed**: the update goes with the next message, because running on its own would cost money and the CEO may not need it yet. Once reported, it is not reported again in later turns.
- **Changes written by the agent itself are not reported back**: its tool already returned the new content. Example: the CTO uses `memory` or `knowledge`. How this is detected:
  - For COMPANY, USER, MEMORY: based on `documents.author`.
  - For the knowledge index: every node (`knowledge/` document) changed since the previous comparison was written by this agent.
  - Changes by the CEO (the UI writes `author = "ceo"`) or by another agent are always reported.
- **After compaction**, `known` reverts to the original system prompt, because old updates may survive only in the summary. The next turn resends the differences relative to the system prompt.
- `resume` rebuilds the system prompt from the current workspace, so nothing needs reporting until documents change again.
- The diff is a multiset line diff, not LCS. That is enough for human-written text, and needs no extra library.
- AGENTS.md discovery by directory is dropped entirely — that is a coding-agent concept.

## Token budget (`context/budget.ts`)

```ts
interface Estimate { measured: number; estimated: number }
// measured  = usage.input_tokens of the latest response
// estimated = chars/4 of every part added after it
// total = measured + estimated * 1.15
```

- `contextWindow` and `maxOutput` come from the model catalog.
- `ceiling = contextWindow − max(0.15 * contextWindow, 16_000)`.
- `outputLimit = min(maxOutput, contextWindow − total)`.

## Token tracking (`context/usage.ts`)

The CEO views per-session tokens via the button at the top of the chat pane (`GET /api/sessions/:id/usage`). Two kinds of numbers, kept separate:

1. **Real numbers from the provider.** Each model call where the provider returns `usage` makes the loop write an event `{ kind: "usage", usage: { at, model, purpose, inputTokens, outputTokens, cacheReadTokens? } }` to the store (`SessionStore.addUsage`) and emit SSE `usage`. `purpose`: `turn` (work turn), `compaction` (summary call, including `compaction.model`), `memory` (memory flush). If the provider returns 0/0, nothing is written, because zero rows skew the statistics. The report sums by purpose, by model, and recursively over employee sessions (`children`). `lastInput` = input of the latest `turn` call = the real context size.
2. **Estimates by content type** (chars/4, same heuristic as the budget) for the next request: role & guidance (Tier A), company documents (Tier B), tool definitions, checkpoint summary, CEO messages, inter-agent messages, harness notices, agent replies, tool calls, tool results; plus a per-tool table (call count, args tokens, result tokens). The provider only returns one total input number, so the per-type split is always an estimate. A session that is not live has no system/tools (the system prompt is rebuilt on resume), so only the messages are split.

No DB table added: the `usage` event lives in the `events` table like other events; `SessionStore.usage()` filters by `kind` to total child sessions without folding the whole transcript.

## Compaction (`context/compaction.ts`)

Triggered when `total >= ceiling` (checked at the start of each step), or when the provider reports overflow. (Manual `/compact [focus]`: not done yet.)

Configuration (`settings` table, key `config`; edited on the **Settings** (Cài đặt) page):

```json
{ "compaction": { "model": "proxy/gemini-2.5-flash", "memoryFlush": true } }
```

Code: `compact()` / `flushMemory()` / `summarizeFitted()` in `core/loop.ts`; pure functions in `context/compaction.ts`.

### Phase 0 — Memory flush (from openclaw)
Only when triggered by the estimate (not on overflow, because the flush request would overflow too) and the agent has the `memory` tool (in practice: the CTO). Sends the current transcript + `MEMORY_FLUSH_PROMPT`, with the full tool definitions to keep the cache prefix, but **only executes `memory`** (other tools return an error), at most 3 rounds, stopping when the model returns `NO_REPLY` or calls no tool.

The flush exchange is **not written to the transcript**: only its effect on MEMORY.md remains. Reason: avoid polluting recent-context with a "virtual" conversation turn. Errors during the flush only emit a notice and do not block compaction. Disable with `compaction.memoryFlush = false`.

### Phase 1 — Prune
Tool results older than `PROTECT_LAST = 20` messages and longer than 200 chars → `[tool output pruned: <tool>]`. Output of `skill` → `[SKILL_PRUNED: <id>] Call skill again if you need it.` Not done yet: dropping old images.

### Phase 2 — Choose the boundary
- `PROTECT_FIRST = 2` (first user message + first reply — usually contain the objective).
- `keepRecentTokens = min(15_000, 40% ceiling)` counted from the end (so small-context models do not keep more verbatim text than the ceiling).
- The boundary moves back until it no longer splits a tool-call/tool-result pair.
- The boundary must **move forward** relative to the previous checkpoint; otherwise compaction returns false (nothing can be freed).
- The step right after a compaction does not compact again based on the estimate (avoids a continuous compaction loop when the kept part is still large).

### Phase 3 — Summarize
Send the current messages (from the previous checkpoint, pruned; same system prompt → cache reuse) + a summary prompt with a fixed schema:

```
## Objective
## Constraints & Requirements
## Decisions Made (and why)
## Work State (done / in progress / not started)
## Relevant Files (path + role)
## Active Subagents (id, task, status)
## Next Move
## Important Context (identifiers, URLs, errors encountered — keep verbatim)
```

- The instruction preserves identifiers verbatim (UUID, hash, path, port, URL) — from openclaw.
- `maxOutputTokens = 8_000` for the summary.
- **The summarize request must not overflow itself** (`fitForSummary`): the input must fit `ceiling(window of the summary model) − system − 8k`. Escalating: clip text/output >2k chars → drop all tool output → drop the oldest messages (after the first 2 messages, inserting a note `[N earlier messages omitted…]`). The last 4 messages are not clipped at the first two levels. If the summary model still reports overflow → shrink the budget by `0.7`, `0.5`.
- Required headings are checked (`## Objective`, `## Work State`, `## Next Move`). Missing → **retry once** with a nudge listing the missing headings (the wrong reply stays in the conversation so the model can fix it).
- Model order: `compaction.model` (if set and resolvable) → the session model. A misconfigured compaction model → notice + skipped; the turn is not broken.
- All models return a wrong format → `fallbackSummary`: a checkpoint built by hand from the transcript (the CEO's requests verbatim, truncated; tools used; last reply; previous checkpoint). Details are lost but the session can continue.
- All models fail with network/other errors → compaction returns false; the loop handles the error as usual (retry).
- Not done yet: refusal detection, summary budget as a % of content.

### Phase 4 — Checkpoint
Append `Compaction { summary, keepFromID }` to the store. The next request is built from the checkpoint:

```xml
<conversation-checkpoint>
  <summary>…</summary>
  <recent-context>(messages from keepFromID)</recent-context>
</conversation-checkpoint>
```

Skills loaded before the checkpoint (and not reloaded in the verbatim part) are listed at the end of the summary as `[SKILL_PRUNED: <id>]` — the model calls `skill` again if needed.

**Re-anchor**: after compaction, `measured = 0`, `estimated = system + messages since the checkpoint` (chars/4). The provider's old measurement no longer matches the new transcript; the next response measures again.

### Overflow recovery
The provider returns an error matching `isOverflow` (e.g. `context_length_exceeded`, "maximum context length", "prompt is too long", "exceeds the context window") before any output → compact with `keepRecentTokens × [0.85, 0.7, 0.5]`, one level per overflow within the same turn. All 3 levels used or compaction not possible → `failed` with a clear error, no infinite loop. "Drop oldest exchanges" lives in `fitForSummary` (applies to the summary request); the main request only contains the checkpoint + the shrunk verbatim part.

### Precompute (v1.1)
When `total >= ceiling − 40k`, run summarize in the background (non-blocking). If, on reaching the ceiling, the precomputed summary is no older than 5 minutes and there are not too many new messages → use it.

## Memory (`tool/builtin/memory.ts` + `context/workspace.ts`)

Small and readable, from hermes + openclaw:

- `MEMORY.md` — cap 4,000 chars, entries separated by `§`. Tool `memory` with `list | add | replace | remove`, CTO only.
- Snapshotted into the system prompt at session start; edits mid-session → only appear in the next session (in exchange for a stable cache). The tool returns the full memory after each write, so the model still "sees" it immediately.
- Memory flush before compaction: done (see Phase 0).
- Later: `memory/YYYY-MM-DD.md` daily notes; `session_search` over the `events` table.

## Skills (`context/skills.ts`)

- Skills (`skills` table) are markdown with frontmatter `name`, `description`; the CTO creates/edits them with `manage_skill`. Only `<available_skills>` (id + description) goes into Tier A.
- Tool `skill({ id })` returns the full content + resource paths. Permission action `skill`.
- An agent can declare `skills: [...]` to preload into the system prompt (rare, for specialized agents).

## Subagent context

| `context` | Child receives | Used for |
|---|---|---|
| `isolated` (default) | the role's Tier A + `<company>` + `<env>` (**no** USER/MEMORY) + brief | researcher, writer, marketer, hired employees |
| `fork` | same as isolated + `<parent-summary>` (the CTO's latest compaction) + `<parent-recent-context>` 20 messages, cap 30k tokens | analyst |

The brief from the CTO must be structured (enforced by the `delegate` tool's schema):

```
goal:        1–2 sentences, the desired outcome
context:     what the child needs to know (files, decisions, constraints)
done_when:   verifiable completion criteria
output:      "report" | "diff" | "json:<schema>"
```

From hermes `output_schema`: if `output: json:<schema>`, the result is validated and `schema_valid: false` is reported back to the CTO.
