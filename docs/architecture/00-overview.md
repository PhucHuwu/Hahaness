# Hahaness — Architecture overview

## Goal

An LLM-run **virtual company** for **no-code** users. The user is the **CEO**; they talk to the **CTO** (the managing agent). The CTO assigns work to **employees** (researcher, writer, marketer, analyst…) and **hires new employees** when needed. The output is documents, plans and content, not code.

Three technical focal points: **context engineering**, **agent loop**, **tool calling**. All three draw on hermes-agent, opencode and openclaw (see `docs/research/`), minus the parts meant for programmers (code editing, git). Agents still have `bash` for computation and file processing when the work needs it (`15-bash.md`).

## Who the user is

- Cannot program. Does not want to configure anything. Does not want permission prompts.
- They **do nothing themselves**, they only give instructions. "Teaching" the company = telling the CTO ("remember this price list"); the CTO saves it into knowledge, skills or staff using management tools (`08-storage.md`).
- They view and download results on the **Results** (Kết quả) page in the UI, never in a folder.

Design consequences:
1. **No permission prompts by default.** Safety comes from limiting each role's capabilities (employees can only read documents + the web, and only write to `drafts/`), not from asking the CEO each time. Exception: connecting a new MCP server (runs commands on the machine) needs CEO approval.
2. **One SQLite file is the whole company.** Documents are DB records, not files on disk → document tools cannot touch the filesystem. Only `bash` runs in a separate working directory next to the DB (`15-bash.md`).
3. **Content is still markdown.** Employees, skills, memory and deliverables are stored as markdown in the DB; the UI displays them and the CEO can edit them if they want.

## Company model

```
CEO (the user)
 └─ CTO (primary, orchestrator)         talks to the CEO, plans, hires, assigns, reviews, reports
     ├─ researcher   finds facts, competitors, figures — has web
     ├─ writer       writes articles, emails, scripts — writes drafts/
     ├─ marketer     campaigns, positioning, copy — writes drafts/
     ├─ analyst      critiques deliverables against the brief (context: fork)
     └─ <new hires>  CTO calls `hire` → `staff` table, persists across sessions; edit/dismiss with `staff`
```

Two ways the CEO works, same runtime:

| Mode | Flow | When |
|---|---|---|
| **Via the CTO** (default) | CEO speaks naturally → CTO decides to do it, delegate it, or hire | Most of the time |
| **Direct** | `@writer viết email chào mừng` ("write a welcome email") | Small tasks where the CEO knows who should do it |

Direct mode still spawns from the CTO session, so the CTO sees the result on the next turn.

## Principles (taken from the 3 harnesses)

1. **Prompt cache is architecture.** The system prompt is split into tiers by volatility and frozen for the session; changes go through messages.
2. **Persist before execute.** A crash mid-way can still resume.
3. **Every input is an inbox item** (`queue | steer`): CEO typing, employees submitting work, harness notices.
4. **Employees are isolated and only return a report.** Employees only receive a brief `{goal, context, done_when, output}`; their transcript never enters the CTO's context.
5. **Capability by role, not by promise.** Permission ruleset `{action, resource, effect}`, last-match-wins; employees hired by the CTO never have more rights than the CTO and are always denied every management tool (`MANAGEMENT_ACTIONS`).
6. **Narrow core.** Core = loop + inbox + store + context + permission. Roles, tools, providers and memory all plug in.
7. **Plain async/await, append-only event log in SQLite** (`node:sqlite`, no added dependency). No Effect-TS.

## Source layout

```
src/
  core/        types, inbox, loop (runTurn/runStep), db (SQLite), store (event log)
  provider/    ProviderClient, registry (provider/model), openai-compatible
  config.ts    config in the DB, {env:VAR}, custom provider module
  tool/        define, registry, execute pipeline, output truncation
    builtin/   read, list, search, write, edit, bash, webfetch, websearch, todo, memory, question, delegate, hire, skill,
               manage (knowledge, manage_skill, staff, mcp_manage), schedule
  context/     system tiers, documents (DocumentStore), workspace (COMPANY/USER/MEMORY), knowledge (knowledge tree), skills, budget, compaction
  permission/  ruleset, ask gate
  agent/       registry (markdown ↔ AgentDef, hire/edit/update/fire, overlay from DB), builtin/ (cto, researcher, writer, marketer, analyst)
  mcp/         client (JSON-RPC stdio/http), manager (mcp_servers table → ToolRegistry)
  upload/      files the CEO attaches (PDF/Excel/Word/CSV → uploads/ documents, images → model)
  channel/     telegram (CEO chats with the CTO via a Telegram bot, long polling)
  schedule/    cron (parse/nextRun), scheduler (schedules table → 30s tick → new CTO session)
  harness.ts   sessions, resume, spawn fg/bg, ResultEntry, fork context
  bootstrap.ts standard wiring for the server (and tests)
  server/      node:http API + SSE for the UI — the only interface, no CLI
ui/            React + Vite: Chat, Kết quả (Results), Tri thức (Knowledge), Kỹ năng (Skills), MCP, Cài đặt (Settings)

.hahaness/hahaness.db   (or HAHANESS_DB) — the entire company
  sessions, events      conversations
  documents             COMPANY.md, USER.md, MEMORY.md, knowledge/*, drafts/*, deliverables/*, tool-output/*
  staff, skills         hired/edited employees, skills
  settings, mcp_servers providers/model, MCP servers
  schedules, schedule_runs  recurring jobs and run history
```

Details: `01-agent-loop.md`, `02-tool-calling.md`, `03-context-engineering.md`, `04-multi-agent.md`, `05-roadmap.md`, `06-providers.md`, `07-ui-server.md`, `08-storage.md`, `09-schedules.md`, `10-knowledge-tree.md`, `11-one-session-per-agent.md`, `12-durable-work.md`, `13-telegram.md`, `14-uploads.md`, `15-bash.md`, `16-auth.md`, `17-slash-commands.md`.
