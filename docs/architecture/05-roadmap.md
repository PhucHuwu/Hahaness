# 05 — Roadmap

## v0.1 — Skeleton (hiện tại)

- [x] Loop: runTurn/runStep, stream, tool song song, Outcome, doom-loop guard cơ bản
- [x] Inbox queue/steer; event store (JSONL, nay là SQLite); claim/release
- [x] Tool.define + registry + truncate; permission ruleset + ask gate
- [x] Provider registry `provider/model`, OpenAI-compatible, custom module, config (nay trong DB)
- [x] Context: system tiers, workspace COMPANY/USER/MEMORY, budget, compaction cơ bản
- [x] Vai: cto, researcher, writer, marketer, analyst; `hire` runtime → `staff/*.md`
- [x] `delegate` fg/bg, ResultEntry, fork context; `memory`; `websearch`/`webfetch`
- [x] `@employee` giao việc thẳng (CLI readline ban đầu đã bỏ: hệ thống chỉ có bản web)

## v0.2 — CEO dùng được hằng ngày (hiện tại)

- [x] Giao diện web (React + Vite) + server `node:http` + SSE — xem `07-ui-server.md`
- [x] Resume phiên trước từ store (`Harness.resume`, `GET /api/sessions`)
- [x] Skills: `skills/<id>/SKILL.md`, index Tier A, tool `skill`, CRUD trong UI
- [x] Knowledge: `knowledge/` index Tier B, editor COMPANY/USER/MEMORY, xem deliverables
- [x] Quản lý nhân viên từ UI: tuyển / sửa markdown / cho nghỉ (không đụng CTO)
- [x] MCP client stdio + streamable HTTP, `.hahaness/mcp.json`, bật/tắt từ UI
- [x] Settings: providers/model trong DB (`settings.config`), gọi thử, reconfigure không restart
- [x] `question` + permission ask trả lời trong chat
- [x] Lưu trữ một file SQLite (`node:sqlite`): phiên, tài liệu, nhân viên, kỹ năng, config, MCP; nhập bố cục thư mục cũ một lần — xem `08-storage.md`
- [x] CTO tự quản lý công ty bằng tool: `knowledge`, `manage_skill`, `staff`, `mcp_manage` (add cần CEO duyệt); tool `search`
- [x] Trang Kết quả: xem/chép/tải `.md` deliverables + drafts
- [ ] Tải kết quả dạng `.docx` / `.pdf`
- [x] Độ bền loop: vá tool-call mồ côi, báo model sau crash (không tự chạy tiếp), giữ ước lượng khi proxy không trả usage, `Retry-After`, stream đứt sau tool-call, dừng CTO dừng luôn nhân viên foreground — xem `01-agent-loop.md`
- [x] Compaction đủ dùng: overflow recovery (shrink 0.85/0.7/0.5), request tóm tắt tự co cho vừa, retry khi thiếu heading + checkpoint dựng tay, `compaction.model`, memory flush, `[SKILL_PRUNED]`, re-anchor — xem `03-context-engineering.md`
- [ ] Compaction: `/compact [focus]` thủ công, precompute nền, bỏ ảnh cũ
- [x] Tài liệu đổi giữa phiên (COMPANY/USER/MEMORY/knowledge/skills) → `<workspace-update>` qua message, system giữ nguyên, không báo lại thay đổi của chính agent — xem `03-context-engineering.md`
- [ ] Memory flush trước compaction; daily notes
- [ ] Workspace file đổi giữa phiên → inject diff
- [x] Provider Anthropic (`type: "anthropic"`, prompt cache, SSE) — xem `06-providers.md`
- [x] Model dự phòng: `agent.model[]` + `fallbackModels` công ty, đổi khi hết retry / lỗi không retry được — xem `01-agent-loop.md`
- [ ] `websearch` qua provider có key (Tavily/Brave) khi cấu hình
- [x] Nhân viên hỏi ngược: tool `ask_lead` → `status: needs_input` → CTO trả lời bằng `delegate steer` (hoặc hỏi CEO trước) — xem `04-multi-agent.md`
- [ ] Upload file nhị phân (PDF/DOCX) vào tri thức + trích text
- [ ] Tìm kiếm FTS khi `node:sqlite` có FTS5 (hiện lọc trong JS)

## v0.3 — Công ty "sống"

- [ ] Auth token + bind ngoài localhost; đóng gói desktop (Tauri/Electron bọc `ui/dist` + server)
- [x] Cron: việc định kỳ — tool `schedule` của CTO, phiên CTO mới mỗi lần chạy, chạy bù một lần, tool bắt buộc → `blocked`, trang Lịch — xem `09-schedules.md`
- [ ] Heartbeat / chạy nền khi app đóng; timezone riêng mỗi lịch; trần chi phí mỗi lần chạy
- [ ] Tool Facebook (đọc feed/nhóm) — qua MCP hoặc builtin; lịch "lướt Facebook" đang chờ tool này
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
3. CTO có được tự sửa job description của nhân viên cũ không? (Đã chốt: có, qua tool `staff` — CEO chỉ ra lệnh, không tự sửa. CTO được dặn chỉ sửa/cho nghỉ khi CEO yêu cầu hoặc vai rõ ràng kém, và báo lại một dòng.)
4. Nhân viên có nên thấy `USER.md` khi viết nội dung nhân danh CEO (email ký tên CEO)? (Chọn tạm: không; CTO đưa thông tin cần thiết vào `brief.context`.)
