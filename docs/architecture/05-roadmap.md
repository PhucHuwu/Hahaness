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

## v0.2 — CEO dùng được hằng ngày (hiện tại)

- [x] Giao diện web (React + Vite) + server `node:http` + SSE — xem `07-ui-server.md`
- [x] Resume phiên trước từ store (`Harness.resume`, `GET /api/sessions`)
- [x] Skills: `skills/<id>/SKILL.md`, index Tier A, tool `skill`, CRUD trong UI
- [x] Knowledge: `knowledge/` index Tier B, editor COMPANY/USER/MEMORY, xem deliverables
- [x] Quản lý nhân viên từ UI: tuyển / sửa markdown / cho nghỉ (không đụng CTO)
- [x] MCP client stdio + streamable HTTP, `.hahaness/mcp.json`, bật/tắt từ UI
- [x] Settings: providers/model trong `hahaness.json`, gọi thử, reconfigure không restart
- [x] `question` + permission ask trả lời trong chat
- [ ] Crash resume từ claim (hiện `resume` chỉ nạp transcript, không tự chạy tiếp)
- [ ] Memory flush trước compaction; daily notes
- [ ] Workspace file đổi giữa phiên → inject diff
- [ ] Provider Anthropic; fallback theo list `agent.model`
- [ ] `websearch` qua provider có key (Tavily/Brave) khi cấu hình
- [ ] Nhân viên hỏi ngược: `status: needs_input` → CTO hỏi CEO
- [ ] Upload file nhị phân (PDF/DOCX) vào `knowledge/` + trích text

## v0.3 — Công ty "sống"

- [ ] Auth token + bind ngoài localhost; đóng gói desktop (Tauri/Electron bọc `ui/dist` + server)
- [ ] Cron/heartbeat: việc định kỳ (báo cáo tuần, theo dõi đối thủ)
- [ ] Kênh chat (Telegram/Zalo/Slack) như openclaw gateway
- [ ] MCP resources/prompts; OAuth cho server HTTP
- [ ] Precompute compaction; session_search
- [ ] Tổ chức nhiều tầng: CTO → trưởng nhóm (orchestrator) → nhân viên
- [ ] Chi phí/usage per nhân viên hiển thị trong UI

## Sau

- Code Mode `execute({code})` cho vai kỹ thuật nếu CEO muốn
- Turn taint từ nội dung web không tin cậy
- Chi phí/usage per nhân viên cho CEO xem

## Câu hỏi mở

1. `analyst` fork bao nhiêu context của CTO? (Chọn tạm: summary + 20 message, cap 30k.)
2. Memory ghi giữa phiên: đóng băng tới phiên sau hay re-inject? (Chọn tạm: đóng băng; tool result đã cho model thấy.)
3. CTO có được tự sửa job description của nhân viên cũ (`hire` với id trùng → update) không, hay chỉ CEO sửa tay? (Chọn tạm: chỉ CEO, tránh CTO "cải tổ" công ty mà CEO không biết.)
4. Nhân viên có nên thấy `USER.md` khi viết nội dung nhân danh CEO (email ký tên CEO)? (Chọn tạm: không; CTO đưa thông tin cần thiết vào `brief.context`.)
