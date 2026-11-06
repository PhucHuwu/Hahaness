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

- `list` trả staff hiện có và việc từng người đang làm (rảnh / đang làm "…" / chờ trả lời, số việc xếp hàng). CTO được dặn gọi trước khi chọn người.
- `steer`/`stop` theo `agent` (id nhân viên). `sessionID` vẫn nhận được (từ báo cáo hoặc phiên cũ), harness quy về phiên hiện tại của nhân viên đó.
- `spawn` với agent không tồn tại → lỗi gợi ý `list`/`hire` (không throw).
- Description tool không liệt kê staff cứng (vì staff thay đổi khi `hire` → vỡ cache); thay bằng `list`.

### Lifecycle

```
spawn ─▶ sessionFor(agent)   phiên DUY NHẤT của nhân viên (xem 11-one-session-per-agent.md)
      ─▶ nhân viên đang làm việc khác? → xếp hàng (tasks[]), làm lần lượt
      ─▶ inbox(nhân viên).push(queue, "New task from <ai>…" + [fork context] + <brief>)
      ─▶ runTurn   giới hạn maxConcurrentSubagents = 4 việc chưa có báo cáo (đang làm + xếp hàng)
      ├─ foreground: CTO chờ, nhận ResultEntry trong tool result
      └─ background: trả "đang làm"/"xếp hàng" ngay; xong → inbox(CTO).push(queue, <subagent …/>) → wake CTO nếu idle
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
- `summary`, `filesTouched`, `steps` chỉ tính phần phiên **từ brief của việc này trở đi**, vì phiên nhân viên chứa nhiều việc.
- Nơi lưu: nhân viên chỉ ghi được `drafts/*`. Brief mở đầu bằng một câu nhắc chỗ lưu (`saveHint`, tính từ ruleset của nhân viên). CTO duyệt xong thì đưa bản cuối vào `deliverables/`. `cto.md` yêu cầu CTO chỉ nói một tài liệu tồn tại khi `write` hoặc `read` đã xác nhận.

### Nhân viên hỏi ngược: tool `ask_lead` → `status: "needs_input"`

Nhân viên thiếu thông tin hoặc gặp quyết định không phải của mình thì gọi `ask_lead({ question, options?, progress? })`.

- Tool **không chờ câu trả lời trong tool call**. Người giao việc có thể đang chờ chính nhân viên đó (`delegate` foreground), nên chờ sẽ deadlock. Thay vào đó tool trả `metadata.endTurn`, và loop kết thúc lượt ngay sau batch tool hiện tại mà không gọi model thêm.
- `Harness.result` thấy lượt cuối kết thúc bằng `ask_lead` thành công → `ResultEntry.status = "needs_input"`, `summary` là câu hỏi, lựa chọn và tiến độ. Kết quả này về CTO như mọi báo cáo khác: tool result nếu foreground, message `source: "subagent"` nếu background. Bản render có thêm câu nhắc trả lời bằng `delegate steer`.
- CTO trả lời bằng `delegate(steer, agent, message)`. Nếu chỉ CEO quyết được, CTO hỏi CEO bằng `question` trước. `steer` tự nạp lại phiên nhân viên nếu server đã restart.
- Việc đang làm (`Live.task`) giữ `{ lead, from, wakeLead, waiting, reported }`. Việc chưa đóng khi `needs_input`; lượt sau câu trả lời kết thúc thì `settle` gửi `ResultEntry` mới vào inbox người giao và đánh thức theo `wakeLead`. Nhân viên có thể hỏi tiếp, khi đó lại là `needs_input`. Việc kế tiếp trong hàng chỉ bắt đầu khi việc này đóng.
- Restart khi nhân viên đang chờ trả lời: `resume` dựng lại việc từ brief cuối (`source: agent`) để câu trả lời vẫn được báo lại.
- `ask_lead` chỉ hiện khi có việc được giao đang mở; `question` ẩn trong lúc đó (hỏi người giao, không hỏi CEO). Lọc trong `toolsFor` mỗi lượt, không bằng rule deny, vì ruleset cố định cả phiên mà phiên dùng chung cho chat với CEO lẫn việc được giao.
- Comms hiện báo cáo này với nhãn "hỏi lại".

### Isolation của nhân viên

- Hard deny (không config được): mọi `MANAGEMENT_ACTIONS` trừ `question` và `delegate` — gồm `memory`, `hire`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule`; thêm `delegate` nếu `role: leaf`. Orchestrator chỉ `delegate` được khi đang làm việc được giao (`spawn` kiểm tra), tối đa `maxDepth`. Test: "employees never get management tools".
- System context: Tier A của chính họ + `COMPANY.md`; **không** có `USER.md`/`MEMORY.md` (không cần biết sếp thích gì, và giảm rò rỉ).
- `context: fork` (analyst): thêm summary compaction gần nhất của CTO + 20 message gần nhất, cap 30k token.
- `employeeRules` trong `Harness.activate` áp cho phiên của mọi agent không phải `primary`, kể cả sau restart. `question` không bị deny vì CEO chat thẳng trong cùng phiên; `toolsFor` ẩn nó khi đang làm việc được giao.

### Ai nói gì: `Message.source` + `from`

| source | from | khi nào |
|---|---|---|
| `user` | `ceo` | CEO gõ |
| `agent` | id agent / `ceo` | brief khi spawn (`from` = người giao, hoặc `ceo` ở direct mode); `delegate steer` (`from` = CTO) |
| `subagent` | id nhân viên | báo cáo nền đổ vào inbox phiên người giao |
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
- `@writer <task>` trong phiên CTO → brief tối thiểu, spawn nền (`wakeLead: false`), vào phiên của writer.
- Chat riêng: bấm tên nhân viên trong sidebar → `POST /api/sessions { agent }` trả **phiên duy nhất** của nhân viên đó (tạo nếu chưa có). CEO và CTO cùng nói chuyện với nhân viên trong phiên đó; nhân viên không giao việc/tuyển người.
- Sidebar Chat mỗi người một dòng, kèm trạng thái (rảnh / đang làm "…" / chờ trả lời / số việc chờ).

## Giới hạn

| | mặc định |
|---|---|
| `delegate.maxDepth` | 1 |
| `delegate.maxConcurrent` | 4 việc chưa có báo cáo (toàn công ty) |
| nhân viên `steps` | 30 (hire) / theo file |
| `summaryCap` | 8.000 chars |
