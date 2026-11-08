# 08 — Storage: a single SQLite file

## Why

The user is a no-code CEO: they **do nothing themselves**, they only give orders to the CTO. A directory-based workspace (COMPANY.md, `staff/`, `skills/`, `.hahaness/*.jsonl`, `hahaness.json`) forces them to know where files live, and sync/backup is fragmented. From this version on **the whole company is one file** `.db`:

- Default `<cwd>/.hahaness/hahaness.db`; change with env `HAHANESS_DB` or option `dbPath` (`:memory:` for tests).
- Backup/move = copy one file. There is no directory the CEO needs to open.
- The CTO manages everything through tools (see below); the UI is mainly for **viewing**, but can still edit when needed.

## Engine

`node:sqlite` (`DatabaseSync`, built into Node 22) — no added dependency.

- Node 22 prints an `ExperimentalWarning` on load; `src/core/db.ts` filters **exactly that warning** during `createRequire("node:sqlite")`, then restores the original `process.emitWarning`.
- Synchronous API: fits a small workload (one company, a few thousand documents). `SessionStore`/`SkillStore` keep `async` signatures so callers do not change.
- The current build has **no FTS5** → `DocumentStore.search` filters in JS with `toLocaleLowerCase` (correct for Vietnamese; SQLite's `LIKE`/`lower()` only handle ASCII).
- Schema version via `PRAGMA user_version`. Every table is `CREATE … IF NOT EXISTS`, so bumping the version only requires re-running `SCHEMA` (v1 → v2 added `schedules`, `schedule_runs`).

## Schema (v1)

| Table | Main columns | Replaces |
|---|---|---|
| `sessions` | id, parent_id, agent, model, title, created_at | first line of the `.jsonl` |
| `events` | seq (autoinc), session_id, kind, data (JSON `StoreEvent`) | `.hahaness/sessions/<id>.jsonl` — still append-only, read back with `fold` |
| `documents` | path (PK), content, created_at, updated_at, author | COMPANY/USER/MEMORY.md, `knowledge/`, `drafts/`, `deliverables/`, `.hahaness/tool-output/` |
| `staff` | id, markdown, fired, updated_at | `staff/<id>.md` |
| `skills` | id, content (markdown + frontmatter), updated_at | `skills/<id>/SKILL.md` |
| `settings` | key, value (JSON) | `hahaness.json` (key `config`) |
| `mcp_servers` | id, config (JSON) | `.hahaness/mcp.json` |
| `schedules` | id, data (JSON `Schedule`), created_at | — (v2, see `09-schedules.md`) |
| `schedule_runs` | id, schedule_id, started_at, data (JSON `ScheduleRun`) | — (v2) |

### Documents keep path form

Documents are keyed by virtual path (`knowledge/pricing.md`, `drafts/post.md`). Reason: prefix-based permissions (`write drafts/*` for employees) and the model's habits (`read`, `list`, `write`) stay the same. `normalizePath` converts `\` → `/`, drops `.`, **rejects `..`**. `tool-output/` is hidden from the root `list` but can be `read` (the footer of truncated output points to it). `author` records who edited last (`ceo` from the UI, role id from tools).

### Staff overlay

Builtin roles are still files in `src/agent/builtin/*.md` (they are code, not data). `AgentRegistry.useDb(db)` overlays them: a `staff` row overrides the role with the same id, `fired = 1` removes the role. The `primary` role (CTO) is never overridden/dismissed.

### Config

`settings.config` is the only configuration source; no config file is read. API keys are never returned to the UI (`••••`; sending `••••` back = keep the old key).

## No more file layout

The first version stored the workspace as files (the "Replaces" column above). The one-time import step (`importLegacy`) and the `hahaness.json` file were dropped: the DB is the single source of truth. New DB → `workspace.ensure()` creates COMPANY/USER/MEMORY templates in the `documents` table.

## The CTO manages the company through tools

| Tool | Action | Effect |
|---|---|---|
| `knowledge` | outline, save, append, move, delete, company, ceo | tree-shaped knowledge sets `knowledge/*` (`10-knowledge-tree.md`), COMPANY.md, USER.md |
| `manage_skill` | list, show, save, delete | skills (description = when to use; instructions = procedure) |
| `staff` | show, edit, fire | edit job description/capabilities, dismiss; cannot edit/dismiss the CTO |
| `mcp_manage` | list, add, enable, disable, reconnect, remove | connect external tools; **`add` is `ask`** in the CTO ruleset → the CEO approves in the UI (stdio runs commands on the machine) |
| `memory` | list, add, replace, remove | short facts (≤ 4k characters) |
| `schedule` | list, create, update, enable, disable, remove, run_now, history | recurring jobs (`09-schedules.md`) |
| `hire` | — | hire a new role |
| `search` | — | search documents (every role that has `read`) |

`MANAGEMENT_ACTIONS` (delegate, hire, memory, question, knowledge, manage_skill, staff, mcp_manage, schedule) are always denied to employees: `Harness.spawn` denies all of them except `delegate` (also denied for leaf roles), and the `capabilityRules` of hired roles deny them as well. Test: "employees never get management tools".

Changes take effect in **new sessions** (the system prompt is frozen per session, see `03`); the tool returns this reminder to the model.

## Results for the CEO

`deliverables/*` (submitted by the CTO) and `drafts/*` (employees) are shown on the **Results** (Kết quả) page: view, copy, download `.md` (`/api/results/download`, `content-disposition` with UTF-8 `filename*`), delete. `.docx`/`.pdf` later (roadmap).
