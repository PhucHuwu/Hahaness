# 07 — Web UI and server

## Why

No-code users do not use a terminal. The UI is what turns the harness into a "company": chat with the CTO, see what employees are doing, edit knowledge, add skills, connect external tools — all without opening files by hand.

## Architecture

```
ui/ (React + Vite, build tĩnh)  ──HTTP JSON + SSE──▶  src/server/ (node:http)  ──▶  Harness
                                                        │
                                                        ├─ routes-chat:  sessions, messages, stop, direct, staff
                                                        ├─ routes-admin: config, knowledge, results, skills, mcp
                                                        └─ routes-schedule: việc định kỳ (09-schedules.md)
```

(In the diagram: "build tĩnh" = static build; "việc định kỳ" = recurring jobs.)

- **The server has no framework.** `src/server/http.ts` = router with `:param` patterns, JSON body, SSE bus, static files. ~150 lines.
- **One SSE stream `/api/events` for the whole app.** All `LoopEvents` (text, tool-start/end, notice, usage) + harness-level events (`session`, `turn`, `question`) go through it with a `sessionID`; the UI filters by the session being viewed. No per-session channel → simpler, and the Chat page can see child employees too.
- **`src/bootstrap.ts`** is the standard wiring: open the DB (`dbPath` / `HAHANESS_DB` / `.hahaness/hahaness.db`), create COMPANY/USER/MEMORY templates if missing, read config from the DB, then build documents, roles, tools, skills, MCP, harness. The server calls it; server tests call it too. No CLI: the web is the only interface. `close()` is async (stops MCP, closes the DB).
- **Displayed transcript = messages in the store.** The UI reducer (`ui/src/pages/chat-state.ts`) applies SSE to a `Message` array with exactly the store's structure (assistant has text/tool-call/tool-result parts), so a page reload renders identically to the live stream.
- **Provider errors do not kill the server.** `App.providerError` is kept; `/api/config` returns it, Settings displays it, sending a message returns 409. Saving config → `Harness.reconfigure()` builds new providers; live sessions keep the old model (system prompt/model are frozen per session — consistent with `03`).

## Sessions

- `POST /api/sessions` creates a root session, with the CTO by default; `agent` = employee id → the CEO chats privately with that employee (employee rules, see `04`). `GET /api/sessions` = union of live sessions + sessions in the store (newest first).
- The Chat sidebar has **one row per person** (1 agent = 1 session, see `11-one-session-per-agent.md`): CTO first, then each employee (`/api/staff`), then dismissed employees that still have a session. Employee rows show status from `SessionView.work`. Clicking → `POST /api/sessions { agent }` opens that person's session (creates it if missing). There is no new-session button; the CEO can type `/new` instead (`17-slash-commands.md`). Sessions from before this change are in the "Old history" (Lịch sử cũ) section, read-only (`home: false`; sending a message → 409).
- **Communications** (Giao tiếp) (`#chat/comms`, `GET /api/conversations`): a timeline rebuilt from the `events` table (plus pending inbox), not stored separately. Brief = user message with `source: agent` containing `<brief>` in the employee's session; steer = other user messages with `source: agent` (by `from`); report = `<subagent …>` in the assigner's session (foreground `delegate` tool-result or a message with `source: subagent`, including ones still in the inbox in direct mode). The CEO chatting directly with an employee does not appear here. Old-style child sessions (`parentID`) are still read the old way.
- `Harness.resume(id)`: reloads from the `events` table (messages + last compaction), builds the system prompt **from the current documents** — so editing COMPANY.md and then resuming an old session shows the new version. This is a deliberate exception to "frozen per session": resume is a new-session boundary as far as the cache is concerned.
- `POST …/messages` pushes to the inbox and returns `{ok}` immediately; results come via SSE. The `running` state follows the `turn` event.
- **Direct mode** `@writer <task>` from the UI → `POST …/direct` → `spawn(background, wakeLead: false)`: the job goes into the writer's session; the report lands in the CTO's inbox but does **not wake** the CTO (prevents the CTO from replying to the CEO when the CEO did not ask). The CEO sees the result in the writer's session (sidebar) and the CTO sees it on its next turn. `@` is only usable in a primary agent's session (400 if called from an employee session).
- The `question` tool does not wait: the turn ends, the UI shows the question from the last unanswered tool call, answering = sending a message (`12-durable-work.md`). Permission `ask`: the server holds a promise, emits a `question` event, the UI renders an answer box, `POST /api/questions/:id` resolves it.

## Knowledge (Tri thức)

| Item | Backend | Who sees it |
|---|---|---|
| `COMPANY.md`, `USER.md`, `MEMORY.md` | `/api/knowledge/file` | per `03` |
| `knowledge/**` | same endpoint, only accepts paths in `knowledge/` or the 3 core documents (otherwise → 400); `GET /api/knowledge` returns `tree`, `DELETE /api/knowledge/node` deletes the whole subtree | the tree **index** (each set + first-level branches) goes into Tier B for **every role**; content is read per node via `read` (`10-knowledge-tree.md`) |
| Employees (table `staff`) | `/api/staff` (+ `/markdown`) | the CEO edits frontmatter + job description; cannot edit/dismiss the CTO. Dismiss = `fired = 1` |

Documents the CEO edits from the UI record `author = "ceo"`; CTO edits via tools record the role id. The UI shows "who edited, when".

The knowledge index is capped at 80 lines; beyond that only the set level remains, followed by a hint to `read knowledge`. Content is not put into the prompt — reference documents can be large; the model `read`s them itself when the brief/question is relevant.

## Results (Kết quả)

| Endpoint | Effect |
|---|---|
| `GET /api/results` | `{ deliverables, drafts, uploads }` — path, title (first heading), updatedAt, author |
| `GET /api/results/file?path=` | content; path outside `deliverables/`/`drafts/` → 400 |
| `GET /api/results/download?path=` | download `.md`, `content-disposition` has `filename*=UTF-8''…` for Vietnamese file names |
| `DELETE /api/results/file?path=` | delete |

The **Results** page (`#results/<encodeURIComponent(path)>`, decoded on read because `location.hash` keeps `%XX`) reloads itself when SSE delivers a `tool-end` for `write`. `.docx`/`.pdf` later.

## Skills (Kỹ năng)

Table `skills`: each skill is markdown with `name`, `description` frontmatter; the CTO creates/edits them with `manage_skill`. Only `<available_skills>` (id + description) goes into Tier A; the `skill` tool returns the body. Add/edit/delete via the UI → takes effect in **new sessions**. Test: `harness.test.ts` "skills: index in Tier A…".

## MCP

`src/mcp/client.ts` — minimal JSON-RPC 2.0, no added dependency:

- Transports `stdio` (spawn, newline-delimited) and `http` (streamable HTTP: POST, receives JSON or SSE, `mcp-session-id`).
- Methods used: `initialize` → `notifications/initialized` → `tools/list` (paginated) → `tools/call`. No resources/prompts/sampling (v0.3).

`src/mcp/manager.ts` — configuration in the `mcp_servers` table, connects at startup, registers tools. The CEO adds servers from the UI, or the CTO via `mcp_manage` (`add` requires CEO approval):

- Tool name `<server>_<tool>` (unusual characters → `_`), permission action `mcp:<server>:<tool>` → a role that wants to block them uses the rule `{ action: "mcp:*", effect: deny }` in its role definition. By default every role sees MCP tools (harness-level `allow *`).
- The server's `inputSchema` is passed to the model as is; the harness validates with `z.record` (does not re-parse third-party JSON schema).
- Output: concatenates `content[].text`; images/other → placeholder.
- Enable/disable/remove → `ToolRegistry.unregister`; running sessions lose the tool at the next step (the tool snapshot is taken on every `wake`).

Example stdio server: `examples/mcp/echo-server.ts`. End-to-end test: `server.test.ts` "mcp: add stdio server…" (real spawn via `npx tsx`).

## UI

- React + Vite, no router/state library. Hash router `#chat/<id>`, `#results/<path>`, `#knowledge`, `#skills`, `#mcp`, `#settings`.
- One neutral palette + one accent color, system font, no gradients/glass/emoji in the UI. Every control has real behavior; empty/error/loading states are real (see the `antislop-ui` skill).
- Chat: session list, transcript (tool calls are collapsed `<details>`), child employees with links to their sessions, question/permission box, Stop, `@employee` suggestions.
- Settings: default model, providers (OpenAI-compatible / custom module), API keys masked (`••••`) and kept unchanged if sent back, "Test call" (Gọi thử).
- `npm run ui` = API server (7331) + Vite dev (5173, proxy `/api`). `npm run ui:build` → `ui/dist`, `npm run serve` serves it statically.

## Current limitations

- The server binds `127.0.0.1` by default (`HOST` to change). Every `/api/*` requires login (`16-auth.md`).
- SSE does not replay: opening the page mid-turn shows events from the next one onward; `GET /api/sessions/:id` returns the persisted transcript, so already-streamed text still appears after the turn ends.
- Knowledge accepts text only (create/edit in the editor, or paste it to the CTO). No PDF/DOCX upload yet — see the roadmap.
