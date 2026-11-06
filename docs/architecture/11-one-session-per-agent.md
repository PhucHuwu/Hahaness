# 11 — Một agent = một phiên chat

## Vì sao

Trước đây mỗi lần giao việc tạo một phiên con (`parentID`), mỗi lần chạy định kỳ tạo một phiên CTO mới, và CEO bấm "Mới"/"Nhắn" là thêm một phiên. Sidebar đầy những phiên rời rạc, CEO không biết nhắn vào đâu, và nhân viên không nhớ việc đã làm hôm qua. CEO là người không biết code, nên mô hình cần giống một công ty thật: **mỗi người một cuộc trò chuyện**. CEO, CTO và lịch tự động đều nói chuyện với một người trong cùng một chỗ.

## Phiên chính (`sessionFor`)

```
Harness.sessionFor(agentId)
  ├─ cache trong process: homes (Promise<Live>), homeIDs (id, đọc đồng bộ qua homeOf)
  ├─ có phiên gốc (không parentID) mới nhất của agent → resume
  └─ chưa có → tạo đúng một lần
```

- `homeSessions(sessions)` chọn phiên chính: phiên gốc mới nhất theo agent. Server và UI dùng cùng hàm này.
- Không còn `createSession` ở harness. `POST /api/sessions { agent }` trả về `sessionFor(agent)`.
- Phiên khác (phiên gốc cũ hơn, phiên con kiểu cũ có `parentID`) là **lịch sử cũ**: vẫn xem được (mục "Lịch sử cũ" ở sidebar), nhưng gửi tin nhắn hay `/direct` vào đó thì trả 409 "Đây là phiên cũ, chỉ để xem…". Không migrate dữ liệu cũ.

## Giao việc vào phiên dùng chung

```
spawn(leadSessionID, { agent, brief, background, wakeLead, from, onReport, signal, context })
  ─▶ worker = sessionFor(agent)
  ─▶ worker.task đang có? → worker.tasks.push(task)  (status "queued")
                       : begin → inbox.push(brief) → wake
lượt kết thúc, inbox rỗng
  ─▶ settle: result(task) → needs_input? giữ task (waiting) : đóng task
  ─▶ deliver: kết quả đầu → resolve (tool result / onReport); các lần sau → report vào inbox người giao
  ─▶ next: task đã đóng → bắt đầu việc kế tiếp trong hàng
```

- `Assignment = { lead, from, wakeLead, brief, depth, waiting, reported, resolve }` nằm trong `Live.task` (việc đang làm) và `Live.tasks` (hàng chờ). Mỗi nhân viên làm **một việc một lúc**.
- Brief: `New task from <ai>. Your final message is your report to them.` + `saveHint` + `<brief>`. Message có `source: "agent"`, `from` = người giao (`cto`, `ceo`, `scheduler`…).
- `result()` chỉ đọc message **từ brief của việc này trở đi**. Nhờ vậy summary, file đã ghi và số bước không lẫn với việc trước hay với chat của CEO.
- `report` đẩy vào phiên chính của người giao. Nếu phiên đó đang sống thì đẩy **đồng bộ**, để scheduler gọi `onReport` rồi `wake` là thấy báo cáo ngay.
- Giới hạn:
  - `activeSubagents` đếm việc chưa có báo cáo đầu tiên (đang làm cộng xếp hàng), tối đa `maxConcurrentSubagents`.
  - `depth = lead.task.depth + 1`, tối đa `maxDepth`.
  - Nhân viên chỉ `delegate` được khi đang làm việc được giao. Không ai giao việc cho chính mình.
- Foreground: người giao bị dừng thì việc đang làm bị abort; việc còn trong hàng bị bỏ ra với status `stopped`.
- `delegate steer/stop` nhận `agent`. Một `sessionID` (kể cả của phiên cũ) được quy về phiên chính của agent đó.

## Tool theo tình huống, ruleset không đổi

Ruleset và system prompt cố định suốt phiên (`03`). Một phiên lại vừa để CEO chat, vừa để làm việc được giao, vừa để chạy lịch. Vì vậy `toolsFor` lọc lại mỗi lượt:

| Tool | Hiện khi |
|---|---|
| `ask_lead` | có `live.task` (đang làm việc được giao) |
| `question` | không có `live.task` **và** `live.unattended === 0` |

- `employeeRules(agent)` deny mọi `MANAGEMENT_ACTIONS` trừ `question`; `delegate` chỉ bị deny với `role: leaf`.
- `harness.unattended(live)` tăng bộ đếm và trả về hàm để gỡ. Scheduler gọi nó trong lúc một lần chạy định kỳ đang diễn ra (`09`).

## Restart

- Hàng chờ (`tasks`) và việc đang làm **không lưu xuống DB**. Restart giữa chừng thì việc đó mất; người giao thấy phiên bị cắt (`RESUMED_AFTER_CRASH`) và có thể giao lại.
- Ngoại lệ: nhân viên đang chờ câu trả lời (`ask_lead` là lượt cuối). `resume` dựng lại `Live.task` từ message `source: "agent"` cuối cùng có `from`, với `waiting` và `reported` đều true. Nhờ vậy khi CTO `steer` trả lời, báo cáo tiếp theo vẫn về đúng người giao.

## UI / API

- Sidebar: mỗi agent một dòng, kèm trạng thái lấy từ `SessionView.work` (Rảnh / Đang làm: … / Đang chờ trả lời / N việc chờ). Phiên CTO tự mở khi vào trang.
- `SessionView` có `home` và `work`; bỏ `depth`. `GET /api/sessions/:id` bỏ `children`.
- `/api/conversations` dựng từ message (brief, steer, báo cáo), kèm báo cáo còn nằm trong inbox (`Inbox.pending()`). Phiên con kiểu cũ vẫn đọc theo cách cũ.
- Báo cáo token của CTO (`usageReport`) cộng phiên của từng nhân viên (`staffUsage`) và phiên con kiểu cũ.

## Đánh đổi

- Context của phiên dài ra theo thời gian; compaction lo phần này (`03`). Nhân viên nhớ việc cũ, đó là điều mong muốn.
- Việc giao cho cùng một người chạy tuần tự, không song song. Muốn song song thì giao cho nhiều người.
