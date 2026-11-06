# 12 — Việc không phụ thuộc trình duyệt và chịu được restart

Mục tiêu: hệ thống chạy trên VPS, CEO dùng qua web. Đóng tab, tắt máy, hay server khởi động lại
(deploy, reboot, crash) đều không làm mất việc đang làm dở, việc đang xếp hàng hay báo cáo chưa đọc.

## Mức 1: không có gì chờ trình duyệt

- Lượt chạy luôn nằm trên server (`Harness.wake`); SSE chỉ để xem. Đóng web không dừng gì.
- **`question` không chặn lượt.** Trước đây tool đứng chờ câu trả lời tối đa 10 phút; trong lúc đó
  CTO không nhận được báo cáo hay chạy lịch. Giờ nó giống `ask_lead`: trả `metadata.endTurn`, lượt
  kết thúc, câu hỏi nằm trong lịch sử chat dưới dạng tool-call. Câu trả lời của CEO là **tin nhắn
  kế tiếp** (mở web lúc nào trả lời lúc đó, kể cả hôm sau).
- UI (`openQuestion` trong `Chat.tsx`) hiện câu hỏi còn chờ: lượt cuối của agent có tool-call
  `question` thành công và CEO chưa nhắn gì sau đó. Bấm lựa chọn = gửi tin nhắn bình thường.
- Server không giữ promise nào cho `question` nữa. `/api/questions` chỉ còn **permission ask**
  (rule `effect: "ask"`); mặc định bootstrap cho phép tất cả nên hiếm khi có. Ask đó vẫn chỉ trong
  bộ nhớ: restart thì lượt đang hỏi bị cắt và được chạy lại như mọi lượt dở.
- Vẫn ẩn `question` khi chạy lịch (`unattended`) và khi đang làm việc được giao: không có ai để hỏi
  ngay lúc đó, model nên quyết hoặc báo lên trong câu trả lời cuối.

## Mức 2: lưu trạng thái làm việc vào DB

Dùng event log sẵn có (`events`, xem `08-storage.md`), không thêm bảng. Event mới:

| Event | Ghi khi | Fold ra |
|---|---|---|
| `inbox {item, front?}` | `Inbox.push`/`pushFront` | `SessionState.inbox` (đúng thứ tự) |
| `inbox-taken {ids}` | loop lấy item ra (`drainAll`/`drainSteer`) | bỏ khỏi inbox |
| `assign {task}` | `spawn` (ghi vào phiên nhân viên) | `SessionState.assignments` |
| `assign-state {id, started?, waiting?}` | `begin` (bắt đầu), `settle` (hỏi lại bằng `ask_lead`) | cập nhật |
| `assign-end {id}` | xong / lỗi / dừng / huỷ khi còn xếp hàng | xoá |

- Core giữ hẹp: `Inbox` nhận một `InboxLog` tuỳ chọn (`added`, `taken`); harness nối nó vào store
  trong `activate`. `Inbox.restore` nạp lại mà không ghi lần nữa.
- Item được ghi `inbox-taken` ngay khi lấy ra, trước khi thành message trong transcript. Tắt giữa
  hai bước thì mất item đó (cửa sổ cực nhỏ, chấp nhận) chứ không bao giờ gửi trùng.
- `Assignment` có `id`. Sau restart, việc khôi phục có `reported: true`: không còn tool call nào
  đang chờ kết quả foreground, nên mọi báo cáo vào inbox phiên người giao (giống việc nền).
- `activeSubagents` (giới hạn việc song song) không tính việc khôi phục; nó chỉ đếm việc giao
  trong tiến trình hiện tại.

## `Harness.recover()` lúc khởi động

`bootstrap` gọi `recover()` sau khi dựng harness (bỏ qua khi chưa cấu hình provider, hoặc `recover: false` cho test).
Với phiên chính của mỗi agent:

| Trạng thái đã lưu | Hành động |
|---|---|
| Lượt bị cắt (`claim` chưa `release`) | `resume` vá tool-call mồ côi, xếp `RESUMED_AFTER_CRASH` vào inbox, **chạy lượt luôn** |
| Đang làm việc được giao và inbox còn input (brief, câu trả lời) | chạy lượt |
| Đang làm việc được giao, inbox rỗng, không chờ câu trả lời | lượt đã xong nhưng chưa kịp báo → `settle` gửi báo cáo, chạy việc kế |
| Không có việc đang làm nhưng còn việc xếp hàng | `next` bắt đầu việc kế |
| Nhân viên chờ câu trả lời (`waiting`) | không làm gì; câu trả lời đến qua `delegate steer` |
| Chỉ có inbox (vd báo cáo `wakeLead: false` ở CTO) | không đánh thức; nạp cùng tin nhắn kế tiếp như trước restart |

- Đây là thay đổi so với quy tắc cũ "không tự chạy tiếp sau crash" (`01-agent-loop.md`). CEO đã
  chọn: làm lại phần dở tốn thêm tiền gọi model nhưng việc không bị bỏ dở khi không ai mở web.
- Báo cáo của nhân viên đánh thức CTO như bình thường (`wakeLead`), nên chuỗi CTO → nhân viên →
  CTO tiếp tục trọn vẹn sau restart.
- `RESUMED_AFTER_CRASH` không bị xếp hai lần nếu server tắt lần nữa trước khi lượt kịp lấy nó.

## Lịch định kỳ

Lần chạy đang `running` lúc tắt được đánh dấu `interrupted` (scheduler không gắn lại `onReport`
được sau restart). Phần việc vẫn được `recover` làm tiếp và báo cáo vẫn về CTO; chỉ trạng thái
lần chạy trên trang Lịch là không theo dõi tiếp. `unattended` không được khôi phục: nếu CTO tự
chạy tiếp sau restart, nó có `question`, và câu hỏi chỉ đơn giản nằm chờ CEO trong chat.

## Còn lại khi lên VPS

- Server mặc định bind `127.0.0.1` và **chưa có đăng nhập**. Đưa ra internet cần reverse proxy
  (HTTPS + basic auth) hoặc thêm auth vào server trước.
- Chạy bằng process manager (systemd, pm2, Docker `restart: always`) để server tự lên lại; DB
  SQLite (`.hahaness/hahaness.db` hoặc `HAHANESS_DB`) phải nằm trên ổ bền.
