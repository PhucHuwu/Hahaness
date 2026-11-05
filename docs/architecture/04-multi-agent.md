# 04 — Multi-agent: CEO / CTO / nhân viên

## Định nghĩa một vai

`src/agent/builtin/<id>.md` (có sẵn, là code) hoặc một dòng trong bảng `staff` của DB (CTO tuyển/sửa bằng tool, hoặc CEO sửa trên UI). Cả hai cùng một dạng markdown:

```md
---
id: writer
name: Writer
description: Writes long-form content in the company's voice.   # CTO đọc dòng này khi chọn người
mode: subagent            # primary | subagent | all
model: [openai/gpt-4.1]   # tùy chọn, list = fallback
steps: 30
context: isolated         # isolated | fork
permissions:
  - { action: read,  resource: "*",        effect: allow }
  - { action: write, resource: "drafts/*", effect: allow }
  - { action: webfetch, resource: "*",     effect: allow }
---
Bạn là … (job description = system prompt)
```

Merge: builtin → bảng `staff` (`AgentRegistry.useDb`). Cùng id thì dòng DB thắng; `fired = 1` xóa vai. Vai `primary` (CTO) không bị đè/đuổi. Xem `08-storage.md`.

## Vai có sẵn

| id | mode | context | Làm gì | Tool |
|---|---|---|---|---|
| `cto` | primary | — | Nói chuyện với CEO; lập kế hoạch, tuyển, giao việc, duyệt, lưu deliverable, ghi memory; quản lý tri thức, kỹ năng, nhân viên, MCP | `delegate`, `hire`, `memory`, `todo`, `question`, `read`, `list`, `search`, `write`, `webfetch`, `knowledge`, `manage_skill`, `staff`, `mcp_manage` |
| `researcher` | subagent | isolated | Sự thật, đối thủ, số liệu, nguồn | `read`, `webfetch`, `websearch` |
| `writer` | subagent | isolated | Bài viết, email, script | `read`, `write(drafts/*)`, `webfetch` |
| `marketer` | subagent | isolated | Chiến dịch, định vị, copy | `read`, `write(drafts/*)`, `webfetch` |
| `analyst` | subagent | fork | Phản biện deliverable theo ý CEO thật sự | `read` |

## Tuyển nhân viên: tool `hire`

CTO gọi khi không ai hợp việc. Đây là **việc bình thường**, system prompt CTO nói rõ.

```ts
hire({ id, name, description, system, capabilities: ("read"|"write"|"webfetch"|"websearch")[] })
```

- Harness dịch `capabilities` thành ruleset cố định. CTO **không** tự viết permission — tránh việc model cấp quyền quá tay.
- Luôn cứng: `write` chỉ `drafts/*`; mọi `MANAGEMENT_ACTIONS` (delegate, hire, memory, question, knowledge, manage_skill, staff, mcp_manage) = deny.
- Ghi vào bảng `staff` ngay → tồn tại qua các phiên. Sau này CTO sửa job description/capabilities hoặc cho nghỉ bằng tool `staff` (`show`/`edit`/`fire`); CEO cũng sửa được trên UI.
- Không được ghi đè vai `primary`. Trùng id → báo lỗi cho model, gợi ý dùng `delegate`.
- `id` được slug hóa.

## Giao việc: tool `delegate`

```ts
delegate({
  action: "list" | "spawn" | "steer" | "stop",
  agent?, brief?: { goal, context, done_when, output },
  context?: "isolated" | "fork", background?, sessionID?, message?
})
```

- `list` trả staff hiện có + assignment của phiên này. CTO được dặn gọi trước khi chọn người.
- `spawn` với agent không tồn tại → lỗi gợi ý `list`/`hire` (không throw).
- Description tool không liệt kê staff cứng (vì staff thay đổi khi `hire` → vỡ cache); thay bằng `list`.

### Lifecycle

```
spawn ─▶ child session (parentID, agent, model, ruleset = inherit(parent, child ∪ hard-deny))
      ─▶ inbox(child).push(queue, "You are an employee…" + [fork context] + <brief>)
      ─▶ runTurn(child)   giới hạn maxConcurrentSubagents = 4
      ├─ foreground: CTO chờ, nhận ResultEntry trong tool result
      └─ background: trả "đang làm" ngay; xong → inbox(CTO).push(queue, <subagent …/>) → wake CTO nếu idle
```

### ResultEntry — thứ duy nhất qua biên

```ts
{ sessionID, agent, status: "completed"|"failed"|"stopped", exitReason, summary (≤8k), filesTouched, usage }
```

Render cho CTO:

```xml
<subagent sessionID="ses_x" agent="writer" status="completed" steps="6">
…báo cáo cuối của nhân viên…
files: drafts/welcome-email.md
</subagent>
```

### Isolation của nhân viên

- Hard deny (không config được): mọi `MANAGEMENT_ACTIONS` trừ `delegate` — gồm `question` (không hỏi CEO trực tiếp), `memory`, `hire`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`; thêm `delegate` nếu `role: leaf`. Test: "employees never get management tools".
- Ruleset = `inherit(parent, child)`: parent deny → child không bao giờ allow.
- System context: Tier A của chính họ + `COMPANY.md`; **không** có `USER.md`/`MEMORY.md` (không cần biết sếp thích gì, và giảm rò rỉ).
- `context: fork` (analyst): thêm summary compaction gần nhất của CTO + 20 message gần nhất, cap 30k token.

## Cách CTO làm việc (system prompt)

1. Mơ hồ thật sự → hỏi **một** câu kèm lựa chọn. Không thì tự quyết và nói rõ.
2. `delegate(list)` → không ai hợp → `hire` → `delegate(spawn)`.
3. Việc độc lập chạy `background: true` song song.
4. Nhận bài → đối chiếu với brief → chưa đạt thì `steer` với feedback cụ thể, không đẩy bài yếu lên CEO.
5. Xong → `write deliverables/<name>.md` → báo tên tài liệu; CEO xem/tải ở trang **Kết quả**.
6. Ghi `memory` sự thật lâu dài về công ty/CEO; tài liệu CEO đưa → `knowledge`; cách làm lặp lại → `manage_skill`.
7. Báo cáo kiểu executive: kết quả, quyết định đã làm, cần gì từ CEO. Không transcript.

## CEO

- Mặc định gõ tự nhiên với CTO.
- `@writer <task>` → brief tối thiểu, spawn foreground từ session CTO, in thẳng kết quả.
- `/staff` xem nhân viên + assignment đang chạy.

## Giới hạn

| | mặc định |
|---|---|
| `delegate.maxDepth` | 1 |
| `delegate.maxConcurrent` | 4 |
| nhân viên `steps` | 30 (hire) / theo file |
| `summaryCap` | 8.000 chars |
