# 09 — Recurring jobs (schedules)

## Why

The CEO wants the company to work on its own when nobody is chatting: "every day at 2 a.m. have the researcher read the news to take in new knowledge", "write the weekly report on Monday morning". The CEO **configures nothing**: they tell the CTO, and the CTO creates the schedule with the `schedule` tool. The **Schedules** (Lịch) page is mainly for viewing, pausing, running now and editing.

## Model

```
schedules (bảng)          tick 30s (Scheduler, trong process server)
 id, title, agent, cron ──▶ tới giờ? ──▶ phiên DUY NHẤT của CTO (sessionFor, ẩn `question` tới khi xong)
 task (Brief), followUp      │            ├─ ghi chú [Scheduled job] vào inbox (không đánh thức)
 tools?, enabled             │            ├─ agent là nhân viên → spawn background vào phiên của họ (from: "scheduler")
 nextRunAt, last*            │            │    └─ báo cáo vào inbox CTO → CTO thức, xử lý theo followUp
                             │            └─ agent là CTO → CTO tự làm task
                             └──▶ schedule_runs: một dòng mỗi lần chạy (status, sessionID, error)
```

Diagram glossary: "bảng" = table; "trong process server" = in the server process; "tới giờ?" = due?; "phiên DUY NHẤT của CTO (…, ẩn `question` tới khi xong)" = the CTO's SINGLE session (…, `question` hidden until done); "ghi chú [Scheduled job] vào inbox (không đánh thức)" = `[Scheduled job]` note into the inbox (no wake); "agent là nhân viên → spawn background vào phiên của họ" = agent is an employee → background spawn into their session; "báo cáo vào inbox CTO → CTO thức, xử lý theo followUp" = report into the CTO inbox → the CTO wakes and handles it per `followUp`; "agent là CTO → CTO tự làm task" = agent is the CTO → the CTO does the task itself; "một dòng mỗi lần chạy" = one row per run.

- **Runs in the CTO's single session** (1 agent = 1 session, see `11`); no new session is opened. The `[Scheduled job]` note and the report appear directly in the conversation the CEO already uses; "View session" (Xem phiên) on the Schedules page points there. Work assigned to an employee goes into the employee's session; if they are busy, the work queues. Context growth is handled by compaction (`03`). Previously each run was a new CTO session; those sessions are now in "Old history" (Lịch sử cũ), read-only.
- **Goes through the CTO; employees do not save on their own.** Employees are still denied `knowledge`/`memory` as always (`04`); the CTO checks the report against the brief before saving. Default `followUp`: save new findings with `knowledge` (append to the document on the same topic, skip what is already there) and summarize for the CEO.
- The `[Scheduled job]` note is pushed **before** the spawn and does not wake the CTO, so the CTO reads the note + report in the same turn (one model call instead of two). The message has `source: "agent"`, `from: "scheduler"`; the UI shows "Automatic schedule" (Lịch tự động). The employee's brief is also `from: "scheduler"`.
- During the run, `harness.unattended(lead)` hides `question` on the CTO's turns (nobody will answer right away; the CTO should decide or escalate). No deny rule is used because the ruleset is fixed for the whole session; `question` returns when the run ends. The note tells the CTO to put items needing a CEO decision at the top of its final answer.
- A run ends when **the CTO has finished handling the report** (`spawn` has an `onReport` hook), not when the employee submits. Run status = the employee's status (`completed`, `needs_input`, …), or `failed` if the CTO's turn errors.

## Cron

`src/schedule/cron.ts`, no added library. 5 fields `minute hour day month weekday`, **server time** (the timezone is printed in the tool description and in the UI). Supports `*`, `a-b`, `*/n`, `a-b/n`, `a,b`, names `jan`/`mon`, `7` = Sunday, `@hourly/@daily/@weekly/@monthly/@yearly`. If both day-of-month and weekday are restricted → matches either one (like Vixie cron). Invalid cron → an error with examples returned to the model / UI (400).

There is no separate "run every N minutes from creation": `*/N` covers the CEO's needs and makes run times easy to predict.

## Run rules

| Situation | Behavior |
|---|---|
| Due | `nextRunAt` is recomputed **before** starting (a mid-run error does not cause repeated runs) |
| App off / machine asleep at the due time | The first tick after startup runs a catch-up **once** (`dueAt` keeps the original time, the UI shows "catch-up" (bù lịch)), then computes the next run from now. Each missed run is not caught up individually: it costs money, and old results have no value |
| Previous run not finished | `skipped`, no overlapping runs |
| App shut down mid-run | `Scheduler.start()` marks that run `interrupted`. The CTO session still resumes normally (`01`) |
| Provider not configured | `failed` with the provider error, the model is not called |
| Employee dismissed | `failed` ("employee … no longer exists") |
| Required tool missing | `blocked`, **the model is not called** (see below) |
| Paused then re-enabled / cron changed | `nextRunAt` computed from now, the paused interval is not caught up |
| `run_now` / "Run now" (Chạy ngay) button | Runs once (`reason: manual`), does not change `nextRunAt` |

The scheduler only runs in the server process (`bootstrap` → `scheduler.start()`; tests disable it with `scheduler: false`). There is no separate daemon: when the app is not running, nothing runs, and the next startup does one catch-up run. Desktop packaging/always-on background running is v0.3 work.

## Required tools (`tools`)

Jobs like "browse Facebook" need a tool the company **does not have yet** (not built, or MCP not connected). If it ran anyway, the employee would guess with `webfetch` (Facebook blocks it), spend money every night and report nothing. So the schedule declares `tools: ["facebook_*"]` (names or globs over tool names in `ToolRegistry`, including MCP tools `<server>_<tool>`):

- Missing → the run is `blocked` with error `missing tool: facebook_*`; the `schedule` tool returns a warning at creation time so the CTO can tell the CEO; the Schedules page shows a yellow warning.
- Once the tool exists (MCP connected, or a new builtin tool registered), the schedule runs on its own at the next due time, with no edits needed.
- The check is against the registry, not per-role permissions: MCP tools are visible to every role by default (`07`).

## How the CTO uses it

```
CEO> mỗi 2h sáng cho researcher lướt facebook để nạp thêm kiến thức mới
CTO → schedule({ action: "create", title: "Lướt Facebook nạp kiến thức", agent: "researcher", cron: "0 2 * * *",
                 task: { goal, context, done_when }, tools: ["facebook_*"] })
    ← "Created … Next runs: 2026-11-07 02:00, … WARNING: tool facebook_* is not available yet …"
CTO → CEO: "Đã lên lịch 2:00 mỗi đêm cho Researcher. Công ty chưa có công cụ Facebook nên lịch sẽ chờ tới khi nối công cụ đó."
```

Gloss: the CEO says "every day at 2 a.m. have the researcher browse Facebook to take in new knowledge"; the title means "Browse Facebook for knowledge"; the CTO replies "Scheduled for 2:00 every night for Researcher. The company does not have a Facebook tool yet, so the schedule will wait until that tool is connected."

`schedule` is in `MANAGEMENT_ACTIONS` → always denied to employees. Actions: `list`, `create`, `update`, `enable`, `disable`, `remove`, `run_now`, `history`.

## Storage

Tables `schedules (id, data JSON, created_at)` and `schedule_runs (id, schedule_id, started_at, data JSON)`, schema v2 (`08`). Stored as JSON so fields can be added without migration; queries are only by id / schedule_id.

## API

| Endpoint | |
|---|---|
| `GET /api/schedules` | `{ timezone, schedules: ScheduleView[] }` (with `running`, `missingTools`, `upcoming` next 3 runs) |
| `GET /api/schedules/:id` | `{ schedule, runs }` (30 most recent) |
| `POST /api/schedules` | create (`createdBy: "ceo"`); invalid cron/agent → 400 |
| `PUT /api/schedules/:id` | partial update, including `enabled` |
| `POST /api/schedules/:id/run` | run now; cannot run (`skipped`/`blocked`/`failed`) → 409 |
| `DELETE /api/schedules/:id` | delete (run history is kept) |

SSE `{ type: "schedule", id }` whenever a schedule changes (create, edit, run start/end) → the Schedules page reloads.

## Not done yet

- Per-schedule timezone (currently server time).
- External notifications (Telegram/Zalo/email) when a run needs a CEO decision — together with "chat channels" in v0.3.
- Cost limit per run / per day.
- Facebook tool: not built; connect via MCP when available, and the schedule will run on its own.
