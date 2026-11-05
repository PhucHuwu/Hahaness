# Hahaness

Multi-agent harness: người dùng là **CEO**, nói chuyện với agent **CTO**, CTO giao việc cho worker (coder, researcher, reviewer, planner). Có thể gọi thẳng worker bằng `@coder …`.

Thiết kế rút từ nghiên cứu [hermes-agent](docs/research/01-hermes-agent.md), [opencode](docs/research/02-opencode.md), [openclaw](docs/research/03-openclaw.md) — xem [bảng so sánh](docs/research/04-comparison.md).

## Chạy

```sh
npm install
set OPENAI_API_KEY=...            # hoặc HAHANESS_API_KEY
set OPENAI_BASE_URL=...           # tùy chọn, gateway OpenAI-compatible
set HAHANESS_MODEL=gpt-4.1        # tùy chọn
npm run dev
```

```
CEO> tìm xem hàm parseFrontmatter dùng ở đâu
CEO> @coder thêm test cho src/tool/output.ts
CEO> /sessions
CEO> /steer ses_xxx ưu tiên file A trước
CEO> /stop ses_xxx
```

```sh
npm test          # 6 test với provider giả, không cần API key
npm run typecheck
```

## Kiến trúc

| Tài liệu | Nội dung |
|---|---|
| [00-overview](docs/architecture/00-overview.md) | Mục tiêu, vai, nguyên tắc, bố cục mã |
| [01-agent-loop](docs/architecture/01-agent-loop.md) | Turn/step, Outcome, inbox queue/steer, tool song song, interrupt, retry, durability |
| [02-tool-calling](docs/architecture/02-tool-calling.md) | `Tool.define`, pipeline validate→permission→execute→truncate, ruleset, MCP |
| [03-context-engineering](docs/architecture/03-context-engineering.md) | System tiers, instruction discovery, budget, compaction 4 pha, memory, skills, context cho subagent |
| [04-multi-agent](docs/architecture/04-multi-agent.md) | Agent markdown, tool `delegate`, ResultEntry, isolation, direct mode |
| [05-roadmap](docs/architecture/05-roadmap.md) | v0.1 → v0.3 và câu hỏi mở |

## Mã nguồn (v0.1)

```
src/
  core/      types, inbox, loop (runTurn/runStep), store (JSONL)
  provider/  ProviderClient interface, OpenAI-compatible streaming
  tool/      define, registry, execute pipeline, output truncation, builtin/
  context/   system tiers, AGENTS.md discovery, token budget, compaction
  permission/ ruleset (last-match-wins), ask gate
  agent/     registry từ markdown, builtin/ (cto, coder, researcher, reviewer, planner)
  harness.ts sessions, spawn/background, ResultEntry, fork context
  cli.ts
```

Định nghĩa agent riêng: tạo `agents/<id>.md` với frontmatter (xem `src/agent/builtin/coder.md`). Cùng id với builtin thì override.
