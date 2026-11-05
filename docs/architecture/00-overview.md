# Hahaness — Tổng quan kiến trúc

## Mục tiêu

Một **công ty ảo** chạy bằng LLM cho người dùng **no-code**. Người dùng là **CEO**; họ nói chuyện với **CTO** (agent điều hành). CTO phân việc cho **nhân viên** (researcher, writer, marketer, analyst…) và **tuyển nhân viên mới** khi cần. Kết quả là tài liệu, kế hoạch, nội dung — không phải code.

Ba trọng tâm kỹ thuật: **context engineering**, **agent loop**, **tool calling**. Cả ba học từ hermes-agent, opencode, openclaw (xem `docs/research/`), nhưng bỏ hết phần coding-agent (shell, edit code, git).

## Người dùng là ai

- Không biết lập trình. Không muốn cấu hình. Không muốn bị hỏi permission.
- Họ "dạy" công ty bằng cách sửa 2 file markdown: `COMPANY.md` (công ty làm gì) và `USER.md` (họ là ai, muốn được báo cáo thế nào).
- Họ muốn kết quả nằm trong một thư mục (`deliverables/`) để mở ra dùng.

Hệ quả thiết kế:
1. **Không hỏi permission mặc định.** An toàn đến từ giới hạn năng lực của từng vai (nhân viên chỉ đọc workspace + web, chỉ ghi vào `drafts/`), không từ việc hỏi CEO từng lần.
2. **Workspace là sandbox.** Mọi tool file bị chặn ở thư mục làm việc. Không có shell.
3. **Mọi thứ là markdown.** Nhân viên, memory, deliverable — CEO mở bằng Notepad là hiểu.

## Mô hình công ty

```
CEO (người dùng)
 └─ CTO (primary, orchestrator)         nói chuyện với CEO, lập kế hoạch, tuyển, giao việc, duyệt, báo cáo
     ├─ researcher   tìm sự thật, đối thủ, số liệu — có web
     ├─ writer       viết bài, email, script — ghi drafts/
     ├─ marketer     chiến dịch, định vị, copy — ghi drafts/
     ├─ analyst      phản biện deliverable theo brief (context: fork)
     └─ <tuyển thêm> CTO gọi `hire` → staff/<id>.md, tồn tại qua các phiên
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
5. **Năng lực theo vai, không theo lời hứa.** Permission ruleset `{action, resource, effect}` last-match-wins; nhân viên do CTO tuyển không bao giờ có quyền hơn CTO và luôn bị cấm `hire`/`delegate`/`memory`.
6. **Core hẹp.** Core = loop + inbox + store + context + permission. Vai, tool, provider, memory đều plug vào.
7. **Async/await thuần, JSONL store.** Không Effect-TS, không event sourcing ở giai đoạn này.

## Bố cục mã nguồn

```
src/
  core/        types, inbox, loop (runTurn/runStep), store (JSONL)
  provider/    ProviderClient, registry (provider/model), openai-compatible
  config.ts    hahaness.json, {env:VAR}, custom provider module
  tool/        define, registry, execute pipeline, output truncation
    builtin/   read, list, write, webfetch, websearch, todo, memory, question, delegate, hire
  context/     system tiers, workspace (COMPANY/USER/MEMORY), budget, compaction
  permission/  ruleset, ask gate
  agent/       registry (markdown ↔ AgentDef, hire), builtin/ (cto, researcher, writer, marketer, analyst)
  harness.ts   sessions, spawn fg/bg, ResultEntry, fork context
  cli.ts

<workspace của CEO>/
  COMPANY.md  USER.md  MEMORY.md
  staff/         nhân viên CTO đã tuyển (markdown, sửa tay được)
  drafts/        nhân viên nộp bài
  deliverables/  CTO lưu kết quả cuối
  .hahaness/     sessions, tool-output (không cần mở)
  hahaness.json  providers (tùy chọn)
```

Chi tiết: `01-agent-loop.md`, `02-tool-calling.md`, `03-context-engineering.md`, `04-multi-agent.md`, `05-roadmap.md`, `06-providers.md`.
