# Hahaness

[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![React](https://img.shields.io/badge/UI-React%2019-61DAFB?logo=react&logoColor=black)](ui/)
[![Storage](https://img.shields.io/badge/storage-SQLite%20(node%3Asqlite)-003B57?logo=sqlite&logoColor=white)](docs/architecture/08-storage.md)

**A virtual company run by AI agents, for people who don't write code.**

You are the **CEO**: you give instructions in plain language. The **CTO** agent breaks the work down, delegates it to employee agents (researcher, writer, marketer, analyst…), hires new roles when nobody fits, and maintains the company's knowledge, skills and tools. The output is documents, plans and content you read and download from the web interface.

<!-- Screenshot: save a capture of the Chat page as docs/assets/chat.png, then uncomment.
![Hahaness chat](docs/assets/chat.png)
--> 

## Features

- **Multi-agent delegation.** The CTO delegates through structured briefs, runs employees in parallel or in the background, and receives structured reports. Employees can ask their lead questions mid-task.
- **Self-managing company.** The CTO hires new roles at runtime, turns recurring procedures into reusable skills, and files reference material into a knowledge tree.
- **Long-running sessions.** Token budgeting anchored on real provider usage, automatic compaction with structured checkpoints, overflow recovery, and per-session token tracking broken down by content type.
- **Durable work.** Inboxes and assignments live in the database; after a restart the server resumes unfinished work.
- **Scheduled jobs.** "Every day at 2 AM, have the researcher check market news" becomes a cron schedule that runs inside the CTO's session.
- **Any model.** OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, vLLM, LiteLLM, CLIProxyAPI…), Anthropic with prompt caching, or a custom provider module. Fallback models per agent and per company.
- **Extensible.** MCP servers (stdio and streamable HTTP), file uploads (PDF, Excel, Word, images), sandboxed `bash`, and a Telegram channel for chatting with the CTO from your phone.
- **Single-file state.** Conversations, staff, knowledge, skills, results and configuration all live in one SQLite file.

## Quick start

Requires **Node.js 22.5+** (for the built-in `node:sqlite`).

```sh
npm install
npm run ui        # API server on :7331 + web UI on http://localhost:5173
```

1. On first launch the server prints a **setup code** in its log. Open the web UI and use it to set a password.
2. Open **Settings** and add a provider and default model. Alternatively, set `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) before starting.
3. Go to **Chat** and talk to the CTO:

```
CEO> We sell online English courses for working professionals. Remember that.
CEO> Here is the 2026 price list: …  save it for everyone.
CEO> Write a 3-email welcome sequence for new customers.
CEO> @writer make email 2 half as long
```

The UI is in Vietnamese and has eight pages: Chat, Results, Knowledge, Skills, Schedules, MCP, Marketplace and Settings.

## Running in production

### Docker (recommended)

```sh
cp .env.example .env     # optional: API keys, time zone
docker compose up -d --build
docker compose logs      # read the setup code, then open http://localhost:7331
```

All company data lives in the `hahaness-data` volume (`/data` in the container). The port is bound to `127.0.0.1`; put Caddy or nginx with HTTPS in front. Details, backup and upgrade steps are in [18-deployment](docs/architecture/18-deployment.md).

### Without Docker

```sh
npm run ui:build   # build the static UI into ui/dist
npm run serve      # serve API + UI on http://127.0.0.1:7331
```

The server listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` to expose it, preferably behind an HTTPS reverse proxy. See [16-auth](docs/architecture/16-auth.md).

### Environment variables

| Variable | Purpose |
|---|---|
| `HAHANESS_DB` | Path of the SQLite file. Default: `.hahaness/hahaness.db` in the current directory. |
| `HAHANESS_WORKDIR` | Working directory for the `bash` tool. Default: `workspace/` next to the database. |
| `HAHANESS_MODEL` | Overrides the default model (`provider/model`). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Fallback OpenAI-compatible provider when none is configured in Settings. |
| `ANTHROPIC_API_KEY` | Fallback Anthropic provider. |
| `HOST`, `PORT` | Bind address and port of the server (default `127.0.0.1:7331`; the Docker image sets `HOST=0.0.0.0`). |
| `TZ` | Time zone for schedules (`docker-compose.yml` defaults to `Asia/Ho_Chi_Minh`). |
| `HAHANESS_UPDATE_URL`, `HAHANESS_UPDATE_CHANNEL` | Where the daily "new version" check asks (default: GitHub Releases; `off` disables it) and the channel (`stable`). |
| `HAHANESS_CATALOG_URL` | Marketplace catalog (default: `catalog.json` from this repository; `file://` or `off` for intranet installs, which then use the bundled copy). |

Back up or move a company by copying its database file.

## Development

```sh
npm test           # all tests; scripted fake providers and MCP server, no API key needed
npm run typecheck  # server and UI
npx tsx --test --test-name-pattern="compaction" src/harness.test.ts   # focused run
```

Contributor and agent guidelines are in [AGENTS.md](AGENTS.md).

## Architecture

The design borrows from [hermes-agent](docs/research/01-hermes-agent.md), [opencode](docs/research/02-opencode.md) and [openclaw](docs/research/03-openclaw.md) ([comparison](docs/research/04-comparison.md)), without the coding-agent parts.

| Document | Topic |
|---|---|
| [00-overview](docs/architecture/00-overview.md) | Goals, no-code users, the company model, principles |
| [01-agent-loop](docs/architecture/01-agent-loop.md) | Turns and steps, outcomes, queue/steer inbox, parallel tools, interrupts, retries |
| [02-tool-calling](docs/architecture/02-tool-calling.md) | `Tool.define`, execution pipeline, rulesets, built-in tools, permissions |
| [03-context-engineering](docs/architecture/03-context-engineering.md) | System tiers, company documents, token budget and tracking, compaction, memory |
| [04-multi-agent](docs/architecture/04-multi-agent.md) | Roles, `hire`, `delegate`, result entries, isolation |
| [05-roadmap](docs/architecture/05-roadmap.md) | Roadmap |
| [06-providers](docs/architecture/06-providers.md) | Provider configuration, OpenAI-compatible, Anthropic, custom modules |
| [07-ui-server](docs/architecture/07-ui-server.md) | Web UI, API and SSE, MCP client, limits |
| [08-storage](docs/architecture/08-storage.md) | Single SQLite file, schema, CTO admin tools |
| [09-schedules](docs/architecture/09-schedules.md) | Cron jobs inside the CTO session, catch-up runs, required tools |
| [10-knowledge-tree](docs/architecture/10-knowledge-tree.md) | Knowledge as trees, per-branch index, node reads |
| [11-one-session-per-agent](docs/architecture/11-one-session-per-agent.md) | One chat per agent, queued assignments, read-only history |
| [12-durable-work](docs/architecture/12-durable-work.md) | Work that survives browser close and server restarts |
| [13-telegram](docs/architecture/13-telegram.md) | Chatting with the CTO through a Telegram bot |
| [14-uploads](docs/architecture/14-uploads.md) | Attachments: documents become `uploads/`, images go to the model |
| [15-bash](docs/architecture/15-bash.md) | Running code in a private working directory without leaking secrets |
| [16-auth](docs/architecture/16-auth.md) | Single-password login, setup code, session cookie, CSRF and brute-force protection |
| [17-slash-commands](docs/architecture/17-slash-commands.md) | `/help`, `/stop`, `/compact`, `/new` and other chat commands on web and Telegram |
| [18-deployment](docs/architecture/18-deployment.md) | Docker image and compose file, data volume, reverse proxy, backup and upgrades |
| [19-updates](docs/architecture/19-updates.md) | Instance ID, version reporting, daily "new version" check and notice |
| [20-marketplace](docs/architecture/20-marketplace.md) | "Chợ ứng dụng": static `catalog.json`, one-click install of hosted MCP servers |
