# 14 — File CEO gửi lên (PDF, Excel, Word, ảnh)

CEO gửi kèm file khi nhắn CTO, trên web (nút 📎, kéo thả hoặc dán) hoặc qua Telegram. Code ở
`src/upload/`.

## Quyết định

- **Chuyển file thành chữ một lần, lúc nhận.** Agent không có tool đọc file nhị phân. File được chuyển
  thành chữ và lưu thành tài liệu `uploads/<tên>.md`, nên `read`, `search` và permission theo path hoạt
  động như mọi tài liệu khác. Nhân viên được CTO giao việc cũng đọc được file đó qua path.
- **Nội dung đi kèm tin nhắn.** Tin của CEO có thêm một text part `<attachments>`. File ngắn
  (≤ 12.000 ký tự) được đưa nguyên văn vào đó. File dài chỉ kèm 2.000 ký tự đầu cùng hướng dẫn đọc
  tiếp bằng `read(path, offset, limit)`, để một bảng Excel lớn không chiếm hết context.
- **Ảnh gửi thẳng cho model** (part `image`; Anthropic `image`, OpenAI `image_url` data URL). Ảnh
  không lưu thành tài liệu. Model không hỗ trợ ảnh sẽ báo lỗi từ provider.
- **Thư viện:** chỉ thêm `unpdf` (pdf.js đóng gói sẵn, không phụ thuộc native) cho PDF. Excel và Word
  là zip + XML, nên được đọc bằng `node:zlib` (`zip.ts`) và regex trên XML.
  - Excel ra CSV theo từng sheet. Ngày tháng giữ dạng số serial; agent được nhắc điều này.
  - Word ra đoạn văn, heading thành `#`, bảng thành `| a | b |`.
- PDF scan (không có lớp chữ) được báo rõ để CEO gửi dạng ảnh. Chưa có OCR.
- **Giới hạn:** 20 MB mỗi file, 5 MB mỗi ảnh; body JSON tối đa ~110 MB (file đi dạng base64 trong JSON,
  không cần multipart). Telegram chỉ cho bot tải file ≤ 20 MB.
- Loại file không hỗ trợ (`.doc`, `.xls` cũ, `.exe`…) bị từ chối với thông báo tiếng Việt. Tin nhắn
  không được gửi đi, nên CEO có thể sửa rồi gửi lại.
- Bản gốc mọi file cũng được lưu vào thư mục làm việc của `bash` (`uploads/<tên>`) để code tính chính xác (`15-bash.md`).
- Trùng tên thì không ghi đè: file mới thành `uploads/bao-cao.pdf (2).md`.
- UI: tin nhắn hiện danh sách file (link sang trang Kết quả → "File bạn gửi") và ảnh thu nhỏ thay vì
  khối `<attachments>`.

## Chưa làm

- OCR cho PDF scan, file `.doc`/`.xls`/`.pptx`.
