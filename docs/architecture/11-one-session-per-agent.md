# 11 — One agent = one chat session

## Why

Previously every assignment created a child session (`parentID`), every scheduled run created a new CTO session, and each time the CEO clicked "New" (Mới) or "Message" (Nhắn) another session was added. The sidebar filled up with disconnected sessions, the CEO did not know where to send messages, and employees did not remember what they did yesterday. The CEO does not code, so the model should look like a real company: **one conversation per person**. The CEO, the CTO and the scheduler all talk to a person in the same place.

## Home session (`sessionFor`)

```
Harness.sessionFor(agentId)
  ├─ in-process cache: homes (Promise<Live>), homeIDs (id, read synchronously via homeOf)
  ├─ agent has a newest root session (no parentID) → resume
  └─ none yet → create exactly once
```

- `homeSessions(sessions)` picks the home session: the newest root session per agent. The server and the UI use the same function.
- The harness no longer has `createSession`. `POST /api/sessions { agent }` returns `sessionFor(agent)`.
- Other sessions (older root sessions, old-style child sessions with `parentID`) are **old history**: still viewable (the "Old history" (Lịch sử cũ) section in the sidebar), but sending a message or `/direct` to them returns 409 "Đây là phiên cũ, chỉ để xem…" ("This is an old session, view only…"). Old data is not migrated.
- Exception: the CEO can type `/new` to start a fresh home session for an agent. The previous one becomes old history the same way. See `17-slash-commands.md`.

## Assigning work into the shared session

```
spawn(leadSessionID, { agent, brief, background, wakeLead, from, onReport, signal, context })
  ─▶ worker = sessionFor(agent)
  ─▶ worker.task exists? → worker.tasks.push(task)  (status "queued")
                        : begin → inbox.push(brief) → wake
turn ends, inbox empty
  ─▶ settle: result(task) → needs_input? keep task (waiting) : close task
  ─▶ deliver: first result → resolve (tool result / onReport); later ones → report into the assigner's inbox
  ─▶ next: task closed → start the next task in the queue
```

- `Assignment = { lead, from, wakeLead, brief, depth, waiting, reported, resolve }` lives in `Live.task` (current task) and `Live.tasks` (queue). Each employee does **one task at a time**.
- Brief: `New task from <ai>. Your final message is your report to them.` + `saveHint` + `<brief>`. The message has `source: "agent"`, `from` = the assigner (`cto`, `ceo`, `scheduler`…).
- `result()` only reads messages **from this task's brief onward**. So the summary, written files and step count do not mix with earlier tasks or with the CEO's chat.
- `report` is pushed into the assigner's home session. If that session is live, the push is **synchronous**, so the scheduler sees the report immediately when it calls `onReport` then `wake`.
- Limits:
  - `activeSubagents` counts tasks without a first report yet (running plus queued), up to `maxConcurrentSubagents`.
  - `depth = lead.task.depth + 1`, up to `maxDepth`.
  - An employee can only `delegate` while working on an assigned task. No one can assign work to themselves.
- Foreground: if the assigner is stopped, the running task is aborted; tasks still in the queue are removed with status `stopped`.
- `delegate steer/stop` takes `agent`. A `sessionID` (including an old session's) is mapped to that agent's home session.

## Tools per situation, ruleset unchanged

The ruleset and system prompt are fixed for the whole session (`03`). But one session serves CEO chat, assigned work and scheduled runs. So `toolsFor` filters again on every turn:

| Tool | Shown when |
|---|---|
| `ask_lead` | `live.task` exists (working on an assigned task) |
| `question` | no `live.task` **and** `live.unattended === 0` |

- `employeeRules(agent)` denies all `MANAGEMENT_ACTIONS` except `question`; `delegate` is only denied for `role: leaf`.
- `harness.unattended(live)` increments the counter and returns a function that undoes it. The scheduler calls it while a scheduled run is in progress (`09`).

## Restart

- The queue (`tasks`) and the current task are **not persisted to the DB**. A restart mid-task loses that task; the assigner sees the session cut off (`RESUMED_AFTER_CRASH`) and can assign it again.
- Exception: an employee waiting for an answer (`ask_lead` was the last turn). `resume` rebuilds `Live.task` from the last `source: "agent"` message that has `from`, with `waiting` and `reported` both true. So when the CTO answers via `steer`, the next report still goes to the right assigner.

## UI / API

- Sidebar: one row per agent, with a status taken from `SessionView.work` (Idle (Rảnh) / Working: … (Đang làm: …) / Waiting for an answer (Đang chờ trả lời) / N tasks queued (N việc chờ)). The CTO session opens automatically when the page loads.
- `SessionView` has `home` and `work`; `depth` is removed. `GET /api/sessions/:id` drops `children`.
- `/api/conversations` is built from messages (brief, steer, reports), plus reports still in the inbox (`Inbox.pending()`). Old-style child sessions are still read the old way.
- The CTO's token report (`usageReport`) adds each employee's session (`staffUsage`) and old-style child sessions.

## Trade-offs

- Session context grows over time; compaction handles this (`03`). Employees remember past work, which is intended.
- Tasks assigned to the same person run sequentially, not in parallel. For parallel work, assign to several people.
