# 05 — Roadmap

## v0.1 — Skeleton (hiện tại)

- [x] Types: Message/Part/ToolCall/Outcome/InboxItem
- [x] Inbox queue/steer
- [x] Loop: runTurn/runStep với stream, tool song song, Outcome
- [x] Tool.define + registry + truncate
- [x] Permission ruleset last-match-wins + ask qua Deferred
- [x] Provider OpenAI-compatible (stream)
- [x] Context: system tiers, AGENTS.md discovery, budget estimate
- [x] Agent registry từ markdown frontmatter + builtin cto/coder/researcher/reviewer
- [x] delegate foreground/background, ResultEntry
- [x] JSONL store append-only
- [x] CLI tối thiểu (readline)

## v0.2 — Dùng được hằng ngày

- [ ] Compaction đầy đủ (prune → summarize → checkpoint), overflow recovery
- [ ] Doom-loop guard
- [ ] Instruction diff inject khi AGENTS.md đổi
- [ ] Memory tool + MEMORY.md/USER.md + memory flush trước compaction
- [ ] Skills index + tool `skill`
- [ ] Provider Anthropic + fallback model list + retry/backoff
- [ ] Crash resume từ claim
- [ ] Direct mode `@agent`, `/agent`, `/steer`, `/stop`, `/sessions`

## v0.3 — Mở rộng

- [ ] MCP client (stdio/http)
- [ ] Fork context cho reviewer/planner
- [ ] Precompute compaction
- [ ] session_search FTS
- [ ] Worktree per child
- [ ] TUI (Ink) thay readline
- [ ] Hooks: tool.before/after, session.compaction, permission.evaluate

## Sau

- Code Mode `execute({code})`
- Cron / heartbeat
- Gateway chat channel (Telegram/Slack) như openclaw
- Turn taint từ output không tin cậy

## Câu hỏi mở

1. Có nên cho `reviewer` fork **toàn bộ** transcript parent hay chỉ summary + N message gần nhất? (Chọn tạm: summary + 20 message, cap 30k.)
2. Memory ghi giữa session: đóng băng tới session sau (hermes) hay re-inject qua message (opencode-style diff)? (Chọn tạm: đóng băng; tool result đã cho model thấy nội dung mới.)
3. Approval của child background: forward lên CEO hay tự động `deny`? (Chọn tạm: forward với timeout 10 phút.)
