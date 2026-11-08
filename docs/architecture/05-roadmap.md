# 05 — Roadmap

## v0.1 — Skeleton (current)

- [x] Loop: runTurn/runStep, stream, parallel tools, Outcome, basic doom-loop guard
- [x] Inbox queue/steer; event store (JSONL, now SQLite); claim/release
- [x] Tool.define + registry + truncate; permission ruleset + ask gate
- [x] Provider registry `provider/model`, OpenAI-compatible, custom module, config (now in the DB)
- [x] Context: system tiers, workspace COMPANY/USER/MEMORY, budget, basic compaction
- [x] Roles: cto, researcher, writer, marketer, analyst; runtime `hire` → `staff/*.md`
- [x] `delegate` fg/bg, ResultEntry, fork context; `memory`; `websearch`/`webfetch`
- [x] `@employee` assigns work directly (the initial readline CLI was dropped: the system is web-only)

## v0.2 — Usable by the CEO every day (current)

- [x] Web UI (React + Vite) + `node:http` server + SSE — see `07-ui-server.md`
- [x] Resume previous session from the store (`Harness.resume`, `GET /api/sessions`)
- [x] Skills: `skills/<id>/SKILL.md`, Tier A index, `skill` tool, CRUD in the UI
- [x] Knowledge: `knowledge/` Tier B index, COMPANY/USER/MEMORY editor, deliverables viewer
- [x] Manage employees from the UI: hire / edit markdown / dismiss (CTO untouched)
- [x] MCP client stdio + streamable HTTP, `.hahaness/mcp.json`, enable/disable from the UI
- [x] Settings: providers/model in the DB (`settings.config`), test call, reconfigure without restart
- [x] `question` + permission ask answered in the chat
- [x] Storage in a single SQLite file (`node:sqlite`): sessions, documents, employees, skills, config, MCP; one-time import of the old directory layout — see `08-storage.md`
- [x] The CTO manages the company through tools: `knowledge`, `manage_skill`, `staff`, `mcp_manage` (add requires CEO approval); `search` tool
- [x] **Results** (Kết quả) page: view/copy/download `.md` deliverables + drafts
- [ ] Download results as `.docx` / `.pdf`
- [x] Loop robustness: repair orphaned tool calls, notify the model after a crash (no automatic continuation), keep the estimate when the proxy returns no usage, `Retry-After`, stream cut after a tool call, stopping the CTO also stops foreground employees — see `01-agent-loop.md`
- [x] Compaction good enough: overflow recovery (shrink 0.85/0.7/0.5), summary request shrinks itself to fit, retry when headings are missing + hand-built checkpoint, `compaction.model`, memory flush, `[SKILL_PRUNED]`, re-anchor — see `03-context-engineering.md`
- [ ] Compaction: manual `/compact [focus]`, background precompute, drop old images
- [x] Documents changed mid-session (COMPANY/USER/MEMORY/knowledge/skills) → `<workspace-update>` via message, system unchanged, the agent's own changes are not reported back to it — see `03-context-engineering.md`
- [ ] Memory flush before compaction; daily notes
- [ ] Workspace file changed mid-session → inject diff
- [x] Anthropic provider (`type: "anthropic"`, prompt cache, SSE) — see `06-providers.md`
- [x] Fallback models: `agent.model[]` + company `fallbackModels`, switch when retries are exhausted / on non-retryable errors — see `01-agent-loop.md`
- [ ] `websearch` through a keyed provider (Tavily/Brave) when configured
- [x] Employees ask back: `ask_lead` tool → `status: needs_input` → the CTO answers with `delegate steer` (or asks the CEO first) — see `04-multi-agent.md`
- [ ] Upload binary files (PDF/DOCX) into knowledge + text extraction
- [ ] FTS search when `node:sqlite` has FTS5 (currently filtered in JS)

## v0.3 — A "living" company

- [ ] Auth token + bind beyond localhost; desktop packaging (Tauri/Electron wrapping `ui/dist` + server)
- [x] Cron: recurring jobs — the CTO's `schedule` tool, a new CTO session per run, one catch-up run, required tools → `blocked`, **Schedules** (Lịch) page — see `09-schedules.md`
- [ ] Heartbeat / background running when the app is closed; per-schedule timezone; cost cap per run
- [ ] Facebook tool (read feed/groups) — via MCP or builtin; the "browse Facebook" schedule is waiting on this tool
- [ ] Chat channels (Telegram/Zalo/Slack) like the openclaw gateway
- [ ] MCP resources/prompts; OAuth for HTTP servers
- [ ] Precompute compaction; session_search
- [ ] Multi-level organization: CTO → team lead (orchestrator) → employees
- [ ] Per-employee cost/usage shown in the UI

## Later

- Code Mode `execute({code})` for technical roles if the CEO wants it
- Turn taint from untrusted web content
- Per-employee cost/usage for the CEO to see

## Open questions

1. How much of the CTO's context does `analyst` fork? (Tentative: summary + 20 messages, cap 30k.)
2. Memory written mid-session: frozen until the next session or re-injected? (Tentative: frozen; the tool result has already shown it to the model.)
3. May the CTO edit the job description of an existing employee? (Decided: yes, via the `staff` tool — the CEO only gives orders and does not edit directly. The CTO is told to edit/dismiss only when the CEO asks or the role is clearly underperforming, and to report it in one line.)
4. Should employees see `USER.md` when writing content on the CEO's behalf (emails signed by the CEO)? (Tentative: no; the CTO puts the needed information into `brief.context`.)
