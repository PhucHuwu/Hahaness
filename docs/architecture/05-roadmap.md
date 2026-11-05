# 05 — Roadmap

## v0.1 — Skeleton (hiện tại)

- [x] Loop: runTurn/runStep, stream, tool song song, Outcome, doom-loop guard cơ bản
- [x] Inbox queue/steer; JSONL store; claim/release
- [x] Tool.define + registry + truncate; permission ruleset + ask gate
- [x] Provider registry `provider/model`, OpenAI-compatible, custom module, `hahaness.json`
- [x] Context: system tiers, workspace COMPANY/USER/MEMORY, budget, compaction cơ bản
- [x] Vai: cto, researcher, writer, marketer, analyst; `hire` runtime → `staff/*.md`
- [x] `delegate` fg/bg, ResultEntry, fork context; `memory`; `websearch`/`webfetch`
- [x] CLI readline, `@employee`, `/staff`

## v0.2 — CEO dùng được hằng ngày

- [ ] Resume phiên trước (`/continue`), crash resume từ claim
- [ ] Memory flush trước compaction; daily notes
- [ ] Workspace file đổi giữa phiên → inject diff
- [ ] Provider Anthropic; fallback theo list `agent.model`
- [ ] `websearch` qua provider có key (Tavily/Brave) khi cấu hình
- [ ] Deliverable viewer: CLI in path + mở file; `/open <path>`
- [ ] Nhân viên hỏi ngược: `status: needs_input` → CTO hỏi CEO
- [ ] `/fire <id>`, `/edit-staff <id>` cho CEO

## v0.3 — Công ty "sống"

- [ ] Giao diện web/desktop đơn giản thay CLI (no-code thật sự)
- [ ] Cron/heartbeat: việc định kỳ (báo cáo tuần, theo dõi đối thủ)
- [ ] Kênh chat (Telegram/Zalo/Slack) như openclaw gateway
- [ ] MCP client để nối Google Docs/Sheets/Notion/email
- [ ] Precompute compaction; session_search
- [ ] Tổ chức nhiều tầng: CTO → trưởng nhóm (orchestrator) → nhân viên

## Sau

- Code Mode `execute({code})` cho vai kỹ thuật nếu CEO muốn
- Turn taint từ nội dung web không tin cậy
- Chi phí/usage per nhân viên cho CEO xem

## Câu hỏi mở

1. `analyst` fork bao nhiêu context của CTO? (Chọn tạm: summary + 20 message, cap 30k.)
2. Memory ghi giữa phiên: đóng băng tới phiên sau hay re-inject? (Chọn tạm: đóng băng; tool result đã cho model thấy.)
3. CTO có được tự sửa job description của nhân viên cũ (`hire` với id trùng → update) không, hay chỉ CEO sửa tay? (Chọn tạm: chỉ CEO, tránh CTO "cải tổ" công ty mà CEO không biết.)
4. Nhân viên có nên thấy `USER.md` khi viết nội dung nhân danh CEO (email ký tên CEO)? (Chọn tạm: không; CTO đưa thông tin cần thiết vào `brief.context`.)
