# 12 — Work that does not depend on the browser and survives restarts

Goal: the system runs on a VPS and the CEO uses it through the web. Closing the tab, turning off the computer, or a server restart
(deploy, reboot, crash) must not lose work in progress, queued work or unread reports.

## Level 1: nothing waits on the browser

- Turns always run on the server (`Harness.wake`); SSE is only for viewing. Closing the web UI stops nothing.
- **`question` does not block the turn.** Previously the tool waited up to 10 minutes for an answer; during that time
  the CTO could not receive reports or run schedules. Now it works like `ask_lead`: it returns `metadata.endTurn`, the turn
  ends, and the question stays in the chat history as a tool call. The CEO's answer is the **next
  message** (answer whenever the web UI is opened, even the next day).
- The UI (`openQuestion` in `Chat.tsx`) shows a pending question: the agent's last turn has a successful
  `question` tool call and the CEO has not sent anything since. Clicking an option = sending a normal message.
- The server no longer holds any promise for `question`. `/api/questions` now only covers **permission asks**
  (rule `effect: "ask"`); the bootstrap default allows everything, so they are rare. Those asks are still in
  memory only: on restart, the turn that was asking is cut off and rerun like any unfinished turn.
- `question` is still hidden during scheduled runs (`unattended`) and while working on an assigned task: there is no one to ask
  at that moment, so the model should decide or raise the issue in its final answer.

## Level 2: persist work state to the DB

Uses the existing event log (`events`, see `08-storage.md`), no new table. New events:

| Event | Written when | Folds into |
|---|---|---|
| `inbox {item, front?}` | `Inbox.push`/`pushFront` | `SessionState.inbox` (in order) |
| `inbox-taken {ids}` | the loop takes items out (`drainAll`/`drainSteer`) | removed from inbox |
| `assign {task}` | `spawn` (written to the employee's session) | `SessionState.assignments` |
| `assign-state {id, started?, waiting?}` | `begin` (started), `settle` (asked back via `ask_lead`) | updated |
| `assign-end {id}` | done / error / stopped / cancelled while still queued | removed |

- Core stays narrow: `Inbox` takes an optional `InboxLog` (`added`, `taken`); the harness wires it to the store
  in `activate`. `Inbox.restore` reloads without writing again.
- An item is logged as `inbox-taken` as soon as it is taken out, before it becomes a message in the transcript. A shutdown between
  the two steps loses that item (very small window, accepted) but never delivers it twice.
- `Assignment` has an `id`. After a restart, recovered tasks have `reported: true`: no tool call is
  still waiting for a foreground result, so every report goes into the assigner's session inbox (like background tasks).
- `activeSubagents` (the parallel task limit) does not count recovered tasks; it only counts tasks assigned
  in the current process.

## `Harness.recover()` at startup

`bootstrap` calls `recover()` after building the harness (skipped when no provider is configured, or with `recover: false` for tests).
For each agent's home session:

| Saved state | Action |
|---|---|
| Turn cut off (`claim` without `release`) | `resume` patches orphaned tool calls, queues `RESUMED_AFTER_CRASH` into the inbox, **runs the turn immediately** |
| Working on an assigned task and the inbox still has input (brief, answer) | run a turn |
| Working on an assigned task, inbox empty, not waiting for an answer | the turn finished but the report was not sent → `settle` sends the report, runs the next task |
| No current task but queued tasks remain | `next` starts the next task |
| Employee waiting for an answer (`waiting`) | do nothing; the answer arrives via `delegate steer` |
| Only an inbox (e.g. a `wakeLead: false` report at the CTO) | do not wake; it is loaded with the next message, as before the restart |

- This changes the old rule "do not continue automatically after a crash" (`01-agent-loop.md`). The CEO
  chose this: redoing the unfinished part costs extra model calls, but work is not abandoned when no one has the web UI open.
- Employee reports wake the CTO as usual (`wakeLead`), so the chain CTO → employee →
  CTO completes after a restart.
- `RESUMED_AFTER_CRASH` is not queued twice if the server shuts down again before the turn picks it up.

## Scheduled runs

A run that is `running` at shutdown is marked `interrupted` (the scheduler cannot reattach `onReport`
after a restart). The work itself is still continued by `recover` and the report still goes to the CTO; only the
run's status on the **Schedules** (Lịch) page is no longer tracked. `unattended` is not restored: if the CTO
continues on its own after a restart, it has `question`, and the question simply waits for the CEO in the chat.

## Remaining for VPS deployment

- The server binds to `127.0.0.1` by default and **has no login yet**. Exposing it to the internet requires a reverse proxy
  (HTTPS + basic auth) or adding auth to the server first.
- Run it under a process manager (systemd, pm2, Docker `restart: always`) so the server comes back up on its own; the SQLite
  DB (`.hahaness/hahaness.db` or `HAHANESS_DB`) must be on durable storage.
