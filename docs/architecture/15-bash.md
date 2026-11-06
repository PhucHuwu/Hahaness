# 15 — Tool `bash`: agent chạy code khi việc cần

Người dùng là CEO không code, nhưng **agent thì được code** nếu đó là cách làm xong việc: cộng doanh
thu trên file Excel 5.000 dòng, thống kê, vẽ biểu đồ, đổi định dạng file. Ước lượng bằng mắt trên CSV là
sai. Quyết định cũ "không có shell" (00/02) được thay bằng tài liệu này. Code ở `src/tool/builtin/bash.ts`.

## Quyết định

- **Một tool `bash`** (`command`, `timeout?` tối đa 600 giây). Output stdout và stderr được gộp lại;
  output dài thì giữ phần cuối (`tail`) và lưu bản đầy đủ vào `tool-output/`. Mã thoát khác 0 thì
  trả về lỗi kèm `[exit code N]`.
- **Thư mục làm việc riêng** `<thư mục DB>/workspace` (đổi được bằng `HAHANESS_WORKDIR`), không phải
  thư mục mã nguồn. `HOME` cũng trỏ vào đó, nên `pip install --user` và cache nằm gọn trong thư mục này.
- **File CEO gửi có bản gốc ở `workspace/uploads/`** (`attach(..., workdir)`). Khối `<attachments>` ghi
  `original="uploads/x.xlsx"`, nên agent đọc bằng pandas hay openpyxl để tính chính xác, thay vì tính
  trên bản chữ.
- **Tài liệu công ty vẫn nằm trong DB.** File tạo ra trong `workspace` không phải tài liệu: muốn đưa cho
  CEO thì `write` vào `deliverables/` hoặc ghi số liệu vào báo cáo. Prompt của tool và của CTO nói rõ
  điều này.
- **Không lộ secret:** process con chỉ nhận PATH, LANG, TZ và vài biến tương tự. API key nằm trong DB và
  biến môi trường của server, nên code agent viết không đọc được qua env.
- **Timeout hoặc dừng thì giết cả process group** (`detached` + `kill(-pid)`), nên `python` chạy nền
  cũng dừng theo.
- `concurrency: serial`: lệnh trong cùng một lượt chạy lần lượt.

## Ai được dùng

- **CTO** có sẵn (`bash * allow` trong `cto.md`).
- **Nhân viên** chỉ dùng được khi có capability `bash` (trang Nhân sự, hoặc `hire` với
  `capabilities: [..., "bash"]`). Nếu không có, `employeeRules` deny `bash`. Vai builtin hiện không có
  `bash`; CTO tự chạy hoặc tuyển một vai phân tích dữ liệu.

## Rủi ro (đã chấp nhận)

Đây **không phải sandbox**: lệnh chạy bằng quyền của tiến trình server. Code agent viết có thể đọc file
DB, gọi mạng, xoá file mà user hệ thống được phép xoá. Rủi ro chính là prompt injection: trang web hay
file độc hại dụ agent chạy lệnh. Giảm nhẹ hiện có:

- Không truyền env (key không nằm sẵn trong biến môi trường của lệnh).
- Thư mục làm việc tách khỏi mã nguồn.
- Nhân viên phải được cấp quyền rõ ràng.

Khi chạy trên VPS, nên chạy server bằng một user riêng ít quyền, hoặc trong container. Bước sau, nếu
cần: chạy lệnh trong Docker (`--network none`, mount mỗi `workspace`), giữ nguyên interface của tool.
