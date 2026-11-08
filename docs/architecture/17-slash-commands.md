# 17 — Slash commands

The CEO can type a few `/` commands in the web chat and in Telegram. A command runs directly on the harness. It
does not go through the model, is not written to the transcript, and costs no tokens (except `/compact`, which
calls the summarizer). Code is in `src/command/slash.ts`. The web route is `POST /api/sessions/:id/command`, and
Telegram calls the same `runCommand`.

## Which commands, and why

We kept the commands that well-known harnesses share and that make sense for someone who does not code. We left
out developer-only commands like `/undo`, `/models`, `/init` and `/review`.

| Command | Does | Comparable to |
|---|---|---|
| `/help` | Lists the commands | every harness |
| `/stop` | Stops this agent's running turn (same as the Stop (Dừng) button) | Hermes, Telegram before |
| `/status` | Who is working on what, and how many tasks are queued | OpenClaw `/status` |
| `/compact [focus]` | Compacts the conversation now; optional focus text is kept in detail | Claude Code `/compact`, OpenCode `/compact` (`/summarize`), OpenClaw `/compact [focus]` |
| `/usage` (`/cost`) | Model, current context size vs window, tokens used, employees' tokens | Claude Code `/cost`, OpenClaw `/context` |
| `/memory` | Shows `MEMORY.md` entries and how full it is | Claude Code `/memory` |
| `/staff` | Lists employees and what they do | — |
| `/new` (`/clear`) | Starts a fresh conversation with this agent; the old one moves to "Old history" (Lịch sử cũ) | OpenCode `/new` (`/clear`), OpenClaw `/new` |

A command runs in the conversation it is typed in: `/stop` and `/compact` act on that agent. On Telegram that is
always the CTO. Replies are short Vietnamese text.

## Parsing

- `^/name args`, case-insensitive. Telegram's `/name@bot` form is accepted.
- An unknown command gets a reply ("Không có lệnh /x…") and is **not** sent to the model. Without that, a typo like
  `/stpo` would reach the CTO as a normal message.
- Web: a leading `/` with no files attached is treated as a command. Telegram: text without a file. `/start` stays
  with Telegram pairing.

## `/compact`

- `Harness.compact(sessionID, focus)` builds the same `TurnContext` as a turn (`turnContext`) and calls the loop's
  `compact()` with `flush: true`, so the memory flush (`03`) still runs first.
- It keeps fewer recent tokens than automatic compaction (`MANUAL_KEEP_TOKENS` = 4k, capped at 40% of the ceiling),
  because the CEO asked for a smaller context on purpose.
- The focus text is appended to `SUMMARY_PROMPT` (`SUMMARY_FOCUS`).
- While compacting, the session counts as running: `onTurnStart`/`onTurnEnd` fire, new messages queue, and Stop
  aborts it. When it finishes, any queued messages start a turn.
- It refuses while a turn is running. It returns `compacted: false` when there is nothing to compact or the
  summarizer failed.

## `/new` and one session per agent

`11-one-session-per-agent.md` gives each agent one conversation forever. `/new` is a deliberate exception that the
CEO asked for: long conversations get noisy, and compaction is not always enough.

- `Harness.newSession(agentID)` creates a new root session with `createdAt` later than the current home, so
  `homeSessions` picks it. The old session is dropped from the live map and becomes old history: viewable, read-only.
- Unread inbox items (for example an employee report that did not wake the CTO) move to the new session, so nothing
  is lost.
- It refuses while the agent is running or has assigned work (`task`/`tasks`). Reports and `ask_lead` answers are
  tied to the session that did the work.
- What carries over: company documents, `MEMORY.md`, knowledge and skills (all from the workspace). What does not:
  the transcript and the compaction checkpoint.
- Web: the reply comes back with `sessionID`; the UI switches to it and shows the reply there.

## Web UI

- Typing `/` opens a list of commands filtered by the typed text (`GET /api/commands`, the same list the server
  uses). ↑/↓ select, Tab fills in, Enter runs a command that has no argument (or fills in one that has), Esc closes.
- The reply is shown in a dismissable panel above the input box, not in the transcript.
