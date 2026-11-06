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
| `cto` | primary | — | Nói chuyện với CEO; lập kế hoạch, tuyển, giao việc, duyệt, lưu deliverable, ghi memory; quản lý tri thức, kỹ năng, nhân viên, MCP, việc định kỳ | `delegate`, `hire`, `memory`, `todo`, `question`, `read`, `list`, `search`, `write`, `webfetch`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule` |
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
- Luôn cứng: `write` chỉ `drafts/*`; mọi `MANAGEMENT_ACTIONS` (delegate, hire, memory, question, knowledge, manage_skill, staff, mcp_manage, schedule) = deny.
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
{ sessionID, agent, status: "completed"|"failed"|"stopped"|"needs_input", exitReason, summary (≤8k), filesTouched, failedWrites?, usage }
```

Render cho CTO:

```xml
<subagent sessionID="ses_x" agent="writer" status="completed" steps="6">
…báo cáo cuối của nhân viên…
files saved: drafts/welcome-email.md
WRITE FAILED (these documents were NOT saved, whatever the summary says): deliverables/x.md — Error: Permission rejected: denied by policy
</subagent>
```

- `filesTouched` lấy từ cặp tool-call/tool-result của `write`, và chỉ tính các lần ghi **thành công**. Path ghi lỗi, không được ghi lại thành công sau đó, nằm trong `failedWrites`. Lý do: model nhân viên vẫn có thể viết "đã lưu" dù mọi lần `write` bị từ chối, và CTO đã chuyển nguyên lời đó cho CEO.
- Nơi lưu: nhân viên chỉ ghi được `drafts/*`. Brief mở đầu bằng một câu nhắc chỗ lưu (`saveHint`, tính từ ruleset của phiên con). CTO duyệt xong thì đưa bản cuối vào `deliverables/`. `cto.md` yêu cầu CTO chỉ nói một tài liệu tồn tại khi `write` hoặc `read` đã xác nhận.

### Nhân viên hỏi ngược: tool `ask_lead` → `status: "needs_input"`

Nhân viên thiếu thông tin hoặc gặp quyết định không phải của mình thì gọi `ask_lead({ question, options?, progress? })`.

- Tool **không chờ câu trả lời trong tool call**. Người giao việc có thể đang chờ chính nhân viên đó (`delegate` foreground), nên chờ sẽ deadlock. Thay vào đó tool trả `metadata.endTurn`, và loop kết thúc lượt ngay sau batch tool hiện tại mà không gọi model thêm.
- `Harness.result` thấy lượt cuối kết thúc bằng `ask_lead` thành công → `ResultEntry.status = "needs_input"`, `summary` là câu hỏi, lựa chọn và tiến độ. Kết quả này về CTO như mọi báo cáo khác: tool result nếu foreground, message `source: "subagent"` nếu background. Bản render có thêm câu nhắc trả lời bằng `delegate steer`.
- CTO trả lời bằng `delegate(steer, sessionID, message)`. Nếu chỉ CEO quyết được, CTO hỏi CEO bằng `question` trước. `steer` tự `resume` phiên nhân viên nếu server đã restart.
- Phiên nhân viên giữ `lead = { parentID, wakeParent, waiting }`. Khi lượt sau câu trả lời kết thúc, `reportToLead` gửi `ResultEntry` mới lên phiên cha và đánh thức nó, theo cùng quy tắc `wakeParent` như lúc spawn. Nhân viên có thể hỏi tiếp, khi đó lại là `needs_input`.
- `ask_lead` chỉ hiện với phiên có `parentID`. Lọc trong `wake`, không lọc bằng rule deny, vì phiên con thừa kế mọi deny của cha. CEO chat thẳng với nhân viên thì đã có `question`.
- Comms hiện báo cáo này với nhãn "hỏi lại".

### Isolation của nhân viên

- Hard deny (không config được): mọi `MANAGEMENT_ACTIONS` trừ `delegate` — gồm `question` (không hỏi CEO trực tiếp), `memory`, `hire`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule`; thêm `delegate` nếu `role: leaf`. Test: "employees never get management tools".
- Ruleset = `inherit(parent, child)`: parent deny → child không bao giờ allow.
- System context: Tier A của chính họ + `COMPANY.md`; **không** có `USER.md`/`MEMORY.md` (không cần biết sếp thích gì, và giảm rò rỉ).
- `context: fork` (analyst): thêm summary compaction gần nhất của CTO + 20 message gần nhất, cap 30k token.
- `employeeRules` trong `Harness.activate` áp cho **mọi** phiên của agent không phải `primary`, kể cả phiên resume sau restart (lúc đó rule của `spawn` không còn): deny mọi `MANAGEMENT_ACTIONS`. Ngoại lệ: phiên gốc (CEO chat riêng với nhân viên) được `question` vì CEO đang ngồi đó, nhưng không được `delegate`; phiên con chỉ orchestrator mới được `delegate`.

### Ai nói gì: `Message.source` + `from`

| source | from | khi nào |
|---|---|---|
| `user` | `ceo` | CEO gõ |
| `agent` | id agent / `ceo` | brief khi spawn (`from` = agent cha, hoặc `ceo` ở direct mode); `delegate steer` (`from` = CTO) |
| `subagent` | id nhân viên | báo cáo nền đổ vào inbox phiên cha |
| `system` | — | harness (compaction, max steps) |
| `agent` | `scheduler` | ghi chú `[Scheduled job]` và brief của việc định kỳ (`09-schedules.md`) |

Trước đây steer đánh `source: user`, nên không phân biệt được với CEO. Brief cũ (`source: system`, bắt đầu bằng "You are a subagent") vẫn được UI/timeline nhận ra. `from` chỉ là metadata cho UI; model không thấy.

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
- `@writer <task>` trong phiên CTO → brief tối thiểu, spawn nền (`wakeParent: false`).
- Chat riêng: `POST /api/sessions { agent: "<id nhân viên>" }` tạo phiên gốc với nhân viên; nhân viên trả lời thẳng CEO, không giao việc/tuyển người.
- Nhân viên và việc đang chạy hiện ở sidebar Chat và thanh "Nhân viên" trên web.

## Giới hạn

| | mặc định |
|---|---|
| `delegate.maxDepth` | 1 |
| `delegate.maxConcurrent` | 4 |
| nhân viên `steps` | 30 (hire) / theo file |
| `summaryCap` | 8.000 chars |
