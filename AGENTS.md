# AGENTS.md

Hahaness is a multi-agent harness run as a virtual company for no-code users: the user (CEO) chats with a CTO agent, which delegates to employee agents. Web UI only; there is no CLI.

## Commands
- `npm run typecheck` (also checks `ui/tsconfig.json`) and `npm test` must pass before reporting work as done. After changing `ui/src`, also run `npm run ui:build`: `ui/dist` is committed and `npm run serve` serves it directly.
- Focused test run: `npx tsx --test --test-name-pattern="<name>" src/harness.test.ts`.
- Tests need no API key. They use scripted fake providers (`scripted()` in `src/harness.test.ts`, `examples/providers/scripted.ts`).
- `npm run ui` starts the API server (7331) and Vite (5173, proxies `/api`). The server does not hot-reload; restart it after backend changes.

## Conventions
- TypeScript ESM run by `tsx` on Node 22. `target`/`lib` are ES2022, so `findLast`, `toSorted` and other ES2023 APIs fail typecheck. Internal imports use the `.ts` extension.
- Keep the core (`src/core`, `src/context`, `src/permission`) narrow. New capabilities go in `src/tool/builtin` or `src/agent/builtin`; built-in tools are registered in `src/bootstrap.ts`.
- Do not add a dependency when `node:*` plus `zod` can do the job. SQLite is `node:sqlite`.
- Record architecture decisions in `docs/architecture/` (indexed in `README.md`), not only in code comments. Docs are in English. Code comments are currently in Vietnamese, and UI strings shown to the CEO are Vietnamese; keep them that way.
- The system prompt is frozen for a session. Anything that changes mid-session goes in as a message (see `docs/architecture/03-context-engineering.md`).
- Server types are mirrored by hand in `ui/src/api.ts`. When an API or SSE shape changes, update both.

## Data and configuration
- All state lives in one SQLite file: `.hahaness/hahaness.db` under the cwd (override with `HAHANESS_DB`). There is no JSON config file. Read config with `storedConfig(db)` and write it with `saveConfig(db, …)`. Server tests seed config with `saveConfig` before calling `startServer`.
- Transcripts are an append-only event log (`events` table, JSON `data` column) folded by `SessionStore`. A new event kind needs no new table.
- The schema uses only `CREATE TABLE IF NOT EXISTS` and re-runs when `SCHEMA_VERSION` in `src/core/db.ts` increases. Adding a table means bumping the version. Adding a column to an existing table requires an explicit `ALTER TABLE` migration.
- Never print or commit API keys. The UI receives masked keys (`••••`); sending `••••` back keeps the stored key (`src/server/routes-admin.ts`).
