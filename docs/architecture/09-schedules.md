# 09 — Việc định kỳ (schedules)

## Vì sao

CEO muốn công ty tự làm việc khi không ai ngồi chat: "mỗi 2h sáng cho researcher đọc tin để nạp kiến thức mới", "sáng thứ Hai viết báo cáo tuần". CEO **không cấu hình gì**: họ nói với CTO, CTO tạo lịch bằng tool `schedule`. Trang **Lịch** chủ yếu để xem, tạm dừng, chạy ngay, sửa.

## Mô hình

```
schedules (bảng)          tick 30s (Scheduler, trong process server)
 id, title, agent, cron ──▶ tới giờ? ──▶ phiên CTO MỚI (phiên gốc, tiêu đề "Định kỳ · <title>")
 task (Brief), followUp      │            ├─ ghi chú [Scheduled job] vào inbox (không đánh thức)
 tools?, enabled             │            ├─ agent là nhân viên → spawn background (from: "scheduler")
 nextRunAt, last*            │            │    └─ báo cáo vào inbox CTO → CTO thức, xử lý theo followUp
                             │            └─ agent là CTO → CTO tự làm task
                             └──▶ schedule_runs: một dòng mỗi lần chạy (status, sessionID, error)
```

- **Mỗi lần chạy là một phiên CTO mới**, không phải phiên CEO đang mở. Lý do: không chen vào cuộc nói chuyện của CEO, không làm phình context của phiên dài; CEO mở phiên đó (link "Xem phiên" ở trang Lịch, hoặc sidebar Chat) để đọc kết quả. Tri thức thu được đi qua `knowledge` nên phiên sau của CEO tự thấy (`<workspace-update>`, xem `03`).
- **Đi qua CTO, không cho nhân viên tự lưu.** Nhân viên vẫn bị deny `knowledge`/`memory` như mọi khi (`04`); CTO đối chiếu báo cáo với brief rồi mới lưu. `followUp` mặc định: lưu điều mới bằng `knowledge` (append vào tài liệu cùng chủ đề, bỏ điều đã có) và tóm tắt cho CEO.
- Ghi chú `[Scheduled job]` được push **trước** spawn và không đánh thức CTO, nên CTO đọc ghi chú + báo cáo trong cùng một lượt (một lần gọi model thay vì hai). Message có `source: "agent"`, `from: "scheduler"`; UI hiện "Lịch tự động". Brief của nhân viên cũng `from: "scheduler"`.
- Phiên định kỳ bị deny `question` (không ai trả lời; tool sẽ treo tới timeout). Ghi chú dặn CTO đưa việc cần CEO quyết lên đầu câu trả lời cuối.
- Lần chạy kết thúc khi **CTO xử lý xong báo cáo** (`spawn` có hook `onReport`), không phải khi nhân viên nộp bài. Status của lần chạy = status của nhân viên (`completed`, `needs_input`, …), hoặc `failed` nếu lượt của CTO lỗi.

## Cron

`src/schedule/cron.ts`, không thêm thư viện. 5 trường `phút giờ ngày tháng thứ`, **giờ máy chủ** (timezone in ra trong description tool và trên UI). Hỗ trợ `*`, `a-b`, `*/n`, `a-b/n`, `a,b`, tên `jan`/`mon`, `7` = Chủ nhật, `@hourly/@daily/@weekly/@monthly/@yearly`. Ngày-trong-tháng và thứ cùng bị giới hạn → khớp một trong hai (như Vixie cron). Cron sai → lỗi có ví dụ trả cho model / UI (400).

Không có "chạy mỗi N phút kể từ lúc tạo" riêng: `*/N` đủ cho nhu cầu của CEO và dễ đoán giờ chạy.

## Quy tắc chạy

| Tình huống | Hành vi |
|---|---|
| Tới giờ | `nextRunAt` tính lại **trước** khi bắt đầu (lỗi giữa chừng không làm chạy lặp) |
| App tắt / máy ngủ lúc tới giờ | Lần tick đầu sau khi mở chạy bù **một** lần (`dueAt` giữ giờ gốc, UI hiện "bù lịch"), rồi tính lần kế từ bây giờ. Không chạy bù từng lần đã lỡ: tốn tiền, và kết quả cũ không có giá trị |
| Lần trước chưa xong | `skipped`, không chạy chồng |
| App tắt giữa lần chạy | `Scheduler.start()` đánh dấu lần đó `interrupted`. Phiên CTO dở vẫn resume được bình thường (`01`) |
| Provider chưa cấu hình | `failed` với lỗi provider, không gọi model |
| Nhân viên đã nghỉ | `failed` ("employee … no longer exists") |
| Thiếu tool bắt buộc | `blocked`, **không gọi model** (xem dưới) |
| Tạm dừng rồi bật lại / đổi cron | `nextRunAt` tính từ bây giờ, không chạy bù khoảng tạm dừng |
| `run_now` / nút "Chạy ngay" | Chạy một lần (`reason: manual`), không đổi `nextRunAt` |

Scheduler chỉ chạy trong process server (`bootstrap` → `scheduler.start()`; test tắt bằng `scheduler: false`). Không có daemon riêng: app không chạy thì không có gì chạy, và lần mở sau chạy bù một lần. Đóng gói desktop/chạy nền thường trực là việc của v0.3.

## Tool bắt buộc (`tools`)

Việc như "lướt Facebook" cần một tool công ty **chưa có** (chưa làm, hoặc MCP chưa nối). Nếu cứ chạy, nhân viên sẽ đoán mò bằng `webfetch` (Facebook chặn), tốn tiền mỗi đêm và báo cáo rỗng. Vì vậy lịch khai báo `tools: ["facebook_*"]` (tên hoặc glob trên tên tool trong `ToolRegistry`, gồm tool MCP `<server>_<tool>`):

- Thiếu → lần chạy `blocked` với lỗi `missing tool: facebook_*`; tool `schedule` trả cảnh báo ngay lúc tạo để CTO báo CEO; trang Lịch hiện cảnh báo vàng.
- Khi tool có (MCP được nối, hoặc tool builtin mới đăng ký) lịch tự chạy ở lần tới, không cần sửa gì.
- Kiểm tra theo registry, không theo quyền của từng vai: tool MCP mặc định mọi vai thấy (`07`).

## CTO dùng thế nào

```
CEO> mỗi 2h sáng cho researcher lướt facebook để nạp thêm kiến thức mới
CTO → schedule({ action: "create", title: "Lướt Facebook nạp kiến thức", agent: "researcher", cron: "0 2 * * *",
                 task: { goal, context, done_when }, tools: ["facebook_*"] })
    ← "Created … Next runs: 2026-11-07 02:00, … WARNING: tool facebook_* is not available yet …"
CTO → CEO: "Đã lên lịch 2:00 mỗi đêm cho Researcher. Công ty chưa có công cụ Facebook nên lịch sẽ chờ tới khi nối công cụ đó."
```

`schedule` thuộc `MANAGEMENT_ACTIONS` → nhân viên luôn bị deny. Action: `list`, `create`, `update`, `enable`, `disable`, `remove`, `run_now`, `history`.

## Lưu trữ

Bảng `schedules (id, data JSON, created_at)` và `schedule_runs (id, schedule_id, started_at, data JSON)`, schema v2 (`08`). Lưu JSON để thêm trường không cần migration; truy vấn chỉ theo id / schedule_id.

## API

| Endpoint | |
|---|---|
| `GET /api/schedules` | `{ timezone, schedules: ScheduleView[] }` (kèm `running`, `missingTools`, `upcoming` 3 lần tới) |
| `GET /api/schedules/:id` | `{ schedule, runs }` (30 lần gần nhất) |
| `POST /api/schedules` | tạo (`createdBy: "ceo"`); cron/agent sai → 400 |
| `PUT /api/schedules/:id` | sửa từng phần, gồm `enabled` |
| `POST /api/schedules/:id/run` | chạy ngay; không chạy được (`skipped`/`blocked`/`failed`) → 409 |
| `DELETE /api/schedules/:id` | xóa (lịch sử chạy giữ lại) |

SSE `{ type: "schedule", id }` mỗi khi lịch đổi (tạo, sửa, bắt đầu/kết thúc lần chạy) → trang Lịch tải lại.

## Chưa làm

- Timezone riêng cho từng lịch (hiện giờ máy chủ).
- Thông báo ra ngoài (Telegram/Zalo/email) khi lần chạy cần CEO quyết — đi cùng "kênh chat" ở v0.3.
- Giới hạn chi phí mỗi lần chạy / mỗi ngày.
- Tool Facebook: chưa làm; nối bằng MCP khi có, lịch sẽ tự chạy.
