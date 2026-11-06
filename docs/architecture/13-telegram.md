# 13 — Chat với CTO qua Telegram

CEO nhắn với CTO qua bot Telegram như trên web. CTO trả lời, hỏi lại và báo việc xong cũng qua đó,
kể cả khi không ai mở web (đi cùng `12-durable-work.md`). Code: `src/channel/telegram.ts`.

## Quyết định

- **Long polling (`getUpdates`), không dùng webhook.** Không cần domain, HTTPS hay cổng mở trên VPS;
  chạy được cả trên máy cá nhân. Offset (`update_id` kế tiếp) lưu trong `settings` và được ghi
  **trước** khi xử lý từng tin: restart giữa chừng thì bỏ tin đó chứ không xử lý hai lần.
- **Không thêm thư viện**: gọi Bot API bằng `fetch`.
- **Một bot, một người.** Bot liên kết với đúng một chat riêng (CEO). Liên kết bằng mã ghép nối
  ngẫu nhiên hiện ở trang Cài đặt: gửi `/start <mã>` (link `t.me/<bot>?start=<mã>` làm việc đó khi
  bấm Start). Mọi chat khác bị từ chối. Token bot nằm trong bảng `settings` (key `telegram`) và
  không trả về UI. "Đổi người dùng" bỏ liên kết và tạo mã mới.
- **Telegram chỉ là một cửa vào phiên của CTO.** Tin của CEO đi qua `harness.send(cto, text, "steer", "ceo")`
  y như gõ trên web, nên mọi thứ khác (inbox lưu DB, chạy tiếp sau restart, câu hỏi không chặn) tự
  áp dụng. Web và Telegram dùng chung một cuộc trò chuyện.
- **Gửi ra theo lượt, không theo nguồn.** Bootstrap nối `onTurnStart`/`onTurnEnd` của phiên CTO vào kênh.
  Lượt bắt đầu thì nhớ số message hiện có và gửi trạng thái "đang soạn". Lượt kết thúc thì gửi câu trả
  lời cuối (assistant message cuối có chữ) và câu hỏi `question` kèm bàn phím lựa chọn. Vì thế CEO nhận
  được cả các lượt **không** bắt đầu từ Telegram: tin gõ trên web, báo cáo nhân viên đánh thức CTO, việc
  định kỳ.
  - Lượt lỗi thì báo lỗi; lượt bị dừng (`interrupted`) thì không gửi gì.
- Câu trả lời cho `question` là tin nhắn bình thường. Bấm nút trên bàn phím Telegram gửi đúng chữ của lựa chọn.
- Lệnh: `/stop` dừng lượt đang chạy của CTO, `/status` xem ai đang làm việc.
- Ảnh và file (document) được tải qua `getFile` rồi đính kèm như trên web (`14-uploads.md`); chú thích là nội dung tin.
- Tin dài cắt thành nhiều tin ≤ 4000 ký tự (Telegram giới hạn 4096), ưu tiên cắt ở chỗ xuống dòng.
  Gửi chữ thô, không dùng Markdown của Telegram: Markdown của model hay làm Telegram từ chối tin.

## Không làm

- **Zalo**: Bot API của Zalo còn mới, `getUpdates` được khuyên chỉ dùng thử nghiệm và có báo cáo lỗi
  không nhận tin; bản production cần webhook HTTPS. Tạm bỏ, làm khi đã có domain + HTTPS trên VPS.
- Chat với nhân viên qua Telegram: CEO nói với CTO; muốn xem nhân viên thì dùng web.
- Nhiều người dùng / nhóm chat.

## API

| Route | Việc |
|---|---|
| `GET /api/telegram` | Trạng thái: đã cấu hình, tên bot, đã liên kết với ai, mã ghép nối, lỗi gần nhất |
| `PUT /api/telegram {token}` | Kiểm tra token bằng `getMe`, lưu, tạo mã ghép nối, chạy polling |
| `POST /api/telegram/unlink` | Bỏ liên kết, tạo mã mới |
| `DELETE /api/telegram` | Ngắt hẳn, xoá token |

Lỗi 409 từ Telegram nghĩa là bot đang được nơi khác dùng (webhook hoặc server thứ hai chạy cùng
token): chỉ một tiến trình được poll một bot.
