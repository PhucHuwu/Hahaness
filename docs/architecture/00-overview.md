# Hahaness — Tổng quan kiến trúc

## Mục tiêu

Một **công ty ảo** chạy bằng LLM cho người dùng **no-code**. Người dùng là **CEO**; họ nói chuyện với **CTO** (agent điều hành). CTO phân việc cho **nhân viên** (researcher, writer, marketer, analyst…) và **tuyển nhân viên mới** khi cần. Kết quả là tài liệu, kế hoạch, nội dung — không phải code.

Ba trọng tâm kỹ thuật: **context engineering**, **agent loop**, **tool calling**. Cả ba học từ hermes-agent, opencode, openclaw (xem `docs/research/`), nhưng bỏ phần dành cho người lập trình (edit code, git). Agent vẫn có `bash` để tính toán và xử lý file khi việc cần (`15-bash.md`).

## Người dùng là ai

- Không biết lập trình. Không muốn cấu hình. Không muốn bị hỏi permission.
- Họ **không tự làm gì**, chỉ giao lệnh. "Dạy" công ty = nói với CTO ("ghi nhớ bảng giá này"); CTO lưu vào tri thức, kỹ năng, nhân viên bằng tool quản trị (`08-storage.md`).
- Họ xem và tải kết quả ở trang **Kết quả** trên UI, không mở thư mục.

Hệ quả thiết kế:
1. **Không hỏi permission mặc định.** An toàn đến từ giới hạn năng lực của từng vai (nhân viên chỉ đọc tài liệu + web, chỉ ghi vào `drafts/`), không từ việc hỏi CEO từng lần. Ngoại lệ: nối MCP mới (chạy lệnh trên máy) cần CEO duyệt.
2. **Một file SQLite là cả công ty.** Tài liệu là bản ghi trong DB, không phải file trên đĩa → tool tài liệu không chạm được filesystem. Chỉ `bash` chạy trong một thư mục làm việc riêng cạnh DB (`15-bash.md`).
3. **Nội dung vẫn là markdown.** Nhân viên, kỹ năng, memory, deliverable lưu dạng markdown trong DB; UI hiển thị, CEO sửa được khi muốn.

## Mô hình công ty

```
CEO (người dùng)
 └─ CTO (primary, orchestrator)         nói chuyện với CEO, lập kế hoạch, tuyển, giao việc, duyệt, báo cáo
     ├─ researcher   tìm sự thật, đối thủ, số liệu — có web
     ├─ writer       viết bài, email, script — ghi drafts/
     ├─ marketer     chiến dịch, định vị, copy — ghi drafts/
     ├─ analyst      phản biện deliverable theo brief (context: fork)
     └─ <tuyển thêm> CTO gọi `hire` → bảng `staff`, tồn tại qua các phiên; sửa/cho nghỉ bằng `staff`
```

Hai cách CEO làm việc, cùng một runtime:

| Chế độ | Luồng | Khi nào |
|---|---|---|
| **Qua CTO** (mặc định) | CEO nói tự nhiên → CTO quyết định tự làm / giao / tuyển | Hầu hết |
| **Trực tiếp** | `@writer viết email chào mừng` | Việc nhỏ, biết rõ ai làm |

Direct mode vẫn spawn từ session CTO nên CTO thấy kết quả ở lượt sau.

## Nguyên tắc (rút từ 3 harness)

1. **Prompt-cache là kiến trúc.** System prompt chia tầng theo độ biến động, đóng băng trong phiên; thay đổi đi qua message.
2. **Persist trước khi execute.** Crash giữa chừng vẫn resume được.
3. **Mọi input là item trong inbox** (`queue | steer`): CEO gõ, nhân viên nộp bài, notice của harness.
4. **Nhân viên cô lập, chỉ trả báo cáo.** Nhân viên chỉ nhận brief `{goal, context, done_when, output}`; transcript của họ không bao giờ vào context CTO.
5. **Năng lực theo vai, không theo lời hứa.** Permission ruleset `{action, resource, effect}` last-match-wins; nhân viên do CTO tuyển không bao giờ có quyền hơn CTO và luôn bị cấm mọi tool quản trị (`MANAGEMENT_ACTIONS`).
6. **Core hẹp.** Core = loop + inbox + store + context + permission. Vai, tool, provider, memory đều plug vào.
7. **Async/await thuần, event log append-only trong SQLite** (`node:sqlite`, không thêm dependency). Không Effect-TS.

## Bố cục mã nguồn

```
src/
  core/        types, inbox, loop (runTurn/runStep), db (SQLite), store (event log)
  provider/    ProviderClient, registry (provider/model), openai-compatible
  config.ts    config trong DB, {env:VAR}, custom provider module
  tool/        define, registry, execute pipeline, output truncation
    builtin/   read, list, search, write, edit, bash, webfetch, websearch, todo, memory, question, delegate, hire, skill,
               manage (knowledge, manage_skill, staff, mcp_manage), schedule
  context/     system tiers, documents (DocumentStore), workspace (COMPANY/USER/MEMORY), knowledge (cây tri thức), skills, budget, compaction
  permission/  ruleset, ask gate
  agent/       registry (markdown ↔ AgentDef, hire/edit/update/fire, overlay từ DB), builtin/ (cto, researcher, writer, marketer, analyst)
  mcp/         client (JSON-RPC stdio/http), manager (bảng mcp_servers → ToolRegistry)
  upload/      file CEO gửi kèm (PDF/Excel/Word/CSV → tài liệu uploads/, ảnh → model)
  channel/     telegram (CEO chat với CTO qua bot Telegram, long polling)
  schedule/    cron (parse/nextRun), scheduler (bảng schedules → tick 30s → phiên CTO mới)
  harness.ts   sessions, resume, spawn fg/bg, ResultEntry, fork context
  bootstrap.ts wiring chuẩn cho server (và test)
  server/      node:http API + SSE cho UI — giao diện duy nhất, không có CLI
ui/            React + Vite: Chat, Kết quả, Tri thức, Kỹ năng, MCP, Cài đặt

.hahaness/hahaness.db   (hoặc HAHANESS_DB) — toàn bộ công ty
  sessions, events      hội thoại
  documents             COMPANY.md, USER.md, MEMORY.md, knowledge/*, drafts/*, deliverables/*, tool-output/*
  staff, skills         nhân viên đã tuyển/sửa, kỹ năng
  settings, mcp_servers providers/model, server MCP
  schedules, schedule_runs  việc định kỳ và lịch sử chạy
```

Chi tiết: `01-agent-loop.md`, `02-tool-calling.md`, `03-context-engineering.md`, `04-multi-agent.md`, `05-roadmap.md`, `06-providers.md`, `07-ui-server.md`, `08-storage.md`, `09-schedules.md`, `10-knowledge-tree.md`, `11-one-session-per-agent.md`, `12-durable-work.md`, `13-telegram.md`, `14-uploads.md`, `15-bash.md`.
