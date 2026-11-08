# 04 — Multi-agent: CEO / CTO / employees

## Defining a role

`src/agent/builtin/<id>.md` (built in, part of the code) or a row in the DB's `staff` table (hired/edited by the CTO via tools, or edited by the CEO in the UI). Both use the same markdown format:

```md
---
id: writer
name: Writer
description: Writes long-form content in the company's voice.   # the CTO reads this line when choosing who to assign
mode: subagent            # primary | subagent | all
model: [openai/gpt-4.1]   # optional, list = fallback
steps: 30
context: isolated         # isolated | fork
permissions:
  - { action: read,  resource: "*",        effect: allow }
  - { action: write, resource: "drafts/*", effect: allow }
  - { action: webfetch, resource: "*",     effect: allow }
---
You are … (job description = system prompt)
```

Merge: builtin → `staff` table (`AgentRegistry.useDb`). Same id → the DB row wins; `fired = 1` removes the role. The `primary` role (CTO) cannot be overridden or fired. See `08-storage.md`.

## Built-in roles

| id | mode | context | What it does | Tools |
|---|---|---|---|---|
| `cto` | primary | — | Talks to the CEO; plans, hires, assigns, reviews, saves deliverables, writes memory; manages knowledge, skills, employees, MCP, recurring jobs | `delegate`, `hire`, `memory`, `todo`, `question`, `read`, `list`, `search`, `write`, `webfetch`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule` |
| `researcher` | subagent | isolated | Facts, competitors, figures, sources | `read`, `webfetch`, `websearch` |
| `writer` | subagent | isolated | Articles, emails, scripts | `read`, `write(drafts/*)`, `webfetch` |
| `marketer` | subagent | isolated | Campaigns, positioning, copy | `read`, `write(drafts/*)`, `webfetch` |
| `analyst` | subagent | fork | Critiques deliverables against what the CEO actually wants | `read` |

## Hiring: the `hire` tool

The CTO calls it when nobody fits the task. This is **normal**, and the CTO system prompt says so explicitly.

```ts
hire({ id, name, description, system, capabilities: ("read"|"write"|"webfetch"|"websearch")[] })
```

- The harness translates `capabilities` into a fixed ruleset. The CTO does **not** write permissions itself — this prevents the model from over-granting rights.
- Always hard-coded: `write` only `drafts/*`; every `MANAGEMENT_ACTIONS` entry (delegate, hire, memory, question, knowledge, manage_skill, staff, mcp_manage, schedule) = deny.
- Written to the `staff` table immediately → persists across sessions. Later the CTO edits the job description/capabilities or dismisses the employee with the `staff` tool (`show`/`edit`/`fire`); the CEO can also edit in the UI.
- Cannot overwrite the `primary` role. Duplicate id → error to the model, suggesting `delegate`.
- `id` is slugified.

## Assigning work: the `delegate` tool

```ts
delegate({
  action: "list" | "spawn" | "steer" | "stop",
  agent?, brief?: { goal, context, done_when, output },
  context?: "isolated" | "fork", background?, sessionID?, message?
})
```

- `list` returns the current staff and what each one is doing (idle / working on "…" / waiting for an answer, number of queued tasks). The CTO is instructed to call it before choosing someone.
- `steer`/`stop` target an `agent` (employee id). `sessionID` is still accepted (from a report or an old session); the harness maps it to that employee's current session.
- `spawn` with a nonexistent agent → error suggesting `list`/`hire` (no throw).
- The tool description does not hard-code the staff list (staff changes on `hire` → breaks the cache); `list` is used instead.

### Lifecycle

```
spawn ─▶ sessionFor(agent)   the employee's ONLY session (see 11-one-session-per-agent.md)
      ─▶ employee busy with another task? → queue (tasks[]), handled in order
      ─▶ inbox(employee).push(queue, "New task from <ai>…" + [fork context] + <brief>)
      ─▶ runTurn   limit maxConcurrentSubagents = 4 tasks without a report (running + queued)
      ├─ foreground: CTO waits, receives ResultEntry in the tool result
      └─ background: returns "working"/"queued" immediately; when done → inbox(CTO).push(queue, <subagent …/>) → wake CTO if idle
```

### ResultEntry — the only thing that crosses the boundary

```ts
{ sessionID, agent, status: "completed"|"failed"|"stopped"|"needs_input", exitReason, summary (≤8k), filesTouched, failedWrites?, usage }
```

Rendered for the CTO:

```xml
<subagent sessionID="ses_x" agent="writer" status="completed" steps="6">
…the employee's final report…
files saved: drafts/welcome-email.md
WRITE FAILED (these documents were NOT saved, whatever the summary says): deliverables/x.md — Error: Permission rejected: denied by policy
</subagent>
```

- `filesTouched` comes from `write` tool-call/tool-result pairs and counts only **successful** writes. Paths whose write failed and were not later written successfully go into `failedWrites`. Reason: the employee model can still write "saved" even when every `write` was rejected, and the CTO used to pass that claim straight to the CEO.
- `summary`, `filesTouched`, `steps` only cover the part of the session **from this task's brief onward**, because an employee session contains many tasks.
- Where to save: employees can only write `drafts/*`. The brief starts with a sentence stating where to save (`saveHint`, computed from the employee's ruleset). After review the CTO puts the final version into `deliverables/`. `cto.md` requires the CTO to only say a document exists once `write` or `read` has confirmed it.

### Employee asks back: tool `ask_lead` → `status: "needs_input"`

An employee that lacks information or faces a decision that is not theirs calls `ask_lead({ question, options?, progress? })`.

- The tool **does not wait for the answer inside the tool call**. The assigner may be waiting on that same employee (foreground `delegate`), so waiting would deadlock. Instead the tool returns `metadata.endTurn`, and the loop ends the turn right after the current tool batch without calling the model again.
- `Harness.result` sees that the last turn ended with a successful `ask_lead` → `ResultEntry.status = "needs_input"`, `summary` holds the question, options and progress. This result reaches the CTO like any other report: a tool result if foreground, a `source: "subagent"` message if background. The rendering adds a reminder to answer with `delegate steer`.
- The CTO answers with `delegate(steer, agent, message)`. If only the CEO can decide, the CTO asks the CEO with `question` first. `steer` reloads the employee session automatically if the server has restarted.
- The current task (`Live.task`) holds `{ lead, from, wakeLead, waiting, reported }`. The task stays open on `needs_input`; when the turn after the answer ends, `settle` sends a new `ResultEntry` to the assigner's inbox and wakes them according to `wakeLead`. The employee can ask again, which is another `needs_input`. The next queued task starts only when this one closes.
- Restart while the employee is waiting for an answer: `resume` rebuilds the task from the last brief (`source: agent`) so the answer is still reported back.
- `ask_lead` is only shown while an assigned task is open; `question` is hidden during that time (ask the assigner, not the CEO). Filtered in `toolsFor` each turn, not by a deny rule, because the ruleset is fixed for the whole session and the session is shared between chat with the CEO and assigned work.
- Comms shows this report with the label **asking back** (hỏi lại).

### Employee isolation

- Hard deny (not configurable): every `MANAGEMENT_ACTIONS` entry except `question` and `delegate` — i.e. `memory`, `hire`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule`; plus `delegate` if `role: leaf`. An orchestrator can only `delegate` while working on an assigned task (`spawn` checks), up to `maxDepth`. Test: "employees never get management tools".
- System context: their own Tier A + `COMPANY.md`; **no** `USER.md`/`MEMORY.md` (they do not need to know the boss's preferences, and it reduces leakage).
- `context: fork` (analyst): adds the CTO's latest compaction summary + the 20 latest messages, cap 30k tokens.
- `employeeRules` in `Harness.activate` apply to the session of every non-`primary` agent, including after restart. `question` is not denied because the CEO chats directly in the same session; `toolsFor` hides it while an assigned task is in progress.

### Who said what: `Message.source` + `from`

| source | from | when |
|---|---|---|
| `user` | `ceo` | the CEO types |
| `agent` | agent id / `ceo` | brief on spawn (`from` = the assigner, or `ceo` in direct mode); `delegate steer` (`from` = CTO) |
| `subagent` | employee id | background report delivered to the assigner's session inbox |
| `system` | — | harness (compaction, max steps) |
| `agent` | `scheduler` | `[Scheduled job]` note and the recurring job's brief (`09-schedules.md`) |

Steer used to be tagged `source: user`, so it could not be distinguished from the CEO. Old briefs (`source: system`, starting with "You are a subagent") are still recognized by the UI/timeline. `from` is only UI metadata; the model does not see it.

## How the CTO works (system prompt)

1. Genuinely ambiguous → ask **one** question with options. Otherwise decide and say so.
2. `delegate(list)` → nobody fits → `hire` → `delegate(spawn)`.
3. Independent tasks run with `background: true` in parallel.
4. Receive work → check it against the brief → not good enough → `steer` with specific feedback; do not pass weak work up to the CEO.
5. Done → `write deliverables/<name>.md` → report the document name; the CEO views/downloads it on the **Results** (Kết quả) page.
6. Write long-lived facts about the company/CEO to `memory`; documents the CEO provides → `knowledge`; repeated procedures → `manage_skill`.
7. Executive-style reports: results, decisions made, what is needed from the CEO. No transcripts.

## CEO

- By default types naturally to the CTO.
- `@writer <task>` in the CTO session → minimal brief, background spawn (`wakeLead: false`), goes into the writer's session.
- Private chat: click an employee's name in the sidebar → `POST /api/sessions { agent }` returns that employee's **only session** (created if missing). The CEO and the CTO both talk to the employee in that session; the employee does not assign work or hire.
- The Chat sidebar has one row per person, with status (idle / working on "…" / waiting for an answer / number of pending tasks).

## Limits

| | default |
|---|---|
| `delegate.maxDepth` | 1 |
| `delegate.maxConcurrent` | 4 tasks without a report (company-wide) |
| employee `steps` | 30 (hire) / per file |
| `summaryCap` | 8,000 chars |
