# 16 — Đăng nhập giao diện web

Server chạy trên VPS và agent chạy được lệnh (`15-bash.md`), nên ai mở được trang web là điều khiển
được server. Từ giờ mọi `/api/*` cần đăng nhập. Code ở `src/server/auth.ts`; UI ở `ui/src/pages/Login.tsx`.

## Quyết định

- **Một người, một mật khẩu.** Không có tài khoản hay vai trò: hệ thống có một CEO. Mật khẩu được băm bằng
  `scrypt` với salt riêng và lưu trong `settings` (key `auth`). Không thêm thư viện.
- **Đặt mật khẩu lần đầu cần mã cài đặt** in ra log server (`Mã cài đặt: …`, tạo mới mỗi lần khởi động
  khi chưa có mật khẩu). Nếu không có mã này, ai tìm được IP của VPS trước chủ sẽ đặt mật khẩu và chiếm
  hệ thống. Người cài VPS đọc mã từ log (`journalctl`, `docker logs`, terminal).
- **Phiên đăng nhập là cookie** `hh_session`: token 32 byte ngẫu nhiên, cờ `HttpOnly`, `SameSite=Lax`,
  thêm `Secure` khi chạy sau HTTPS (`X-Forwarded-Proto: https`). Phiên có hạn 30 ngày kể từ lần dùng
  cuối. DB chỉ lưu sha256 của token. Mỗi lần giữ tối đa 20 phiên.
  - Vì dùng cookie nên SSE (`EventSource`) được bảo vệ mà không cần header riêng.
- **Chặn CSRF:** request không phải GET có header `Origin` khác host thì bị từ chối với mã 403, kể cả khi
  đã đăng nhập. Cookie `SameSite=Lax` chặn phần còn lại. Vite dev proxy giữ nguyên `Host`
  (`changeOrigin: false`) để kiểm tra này đúng khi dev.
- **Chống dò mật khẩu:** 5 lần sai (mật khẩu, mã cài đặt hay mật khẩu hiện tại khi đổi) từ một IP thì
  khoá IP đó 15 phút. Trạng thái khoá nằm trong bộ nhớ. Sau reverse proxy trên cùng máy thì IP lấy từ
  `X-Forwarded-For`.
- **Đổi mật khẩu thì đăng xuất mọi thiết bị khác.** Có thêm nút "Đăng xuất thiết bị khác" (trang Cài đặt
  → Tài khoản).
- Route mở không cần đăng nhập: `GET /api/auth`, `POST /api/auth/{setup,login,logout,password,logout-others}`.
  `password` và `logout-others` tự kiểm tra phiên hoặc mật khẩu. File tĩnh của UI cũng mở, vì UI tự hỏi
  `/api/auth` rồi hiện màn hình đăng nhập.
- Khi API trả 401 giữa chừng (phiên hết hạn), UI tải lại trang và quay về màn hình đăng nhập.
- Test tắt đăng nhập bằng `startServer({ auth: false })`.

## Quên mật khẩu

Xoá key `auth` trong bảng `settings` rồi khởi động lại; server sẽ in mã cài đặt mới:

```sh
sqlite3 .hahaness/hahaness.db "DELETE FROM settings WHERE key = 'auth'"
```

## Triển khai trên VPS

- Server mặc định chỉ nghe `127.0.0.1`. Đặt `HOST=0.0.0.0` để mở ra ngoài, nhưng nên dùng reverse proxy có
  HTTPS (Caddy hoặc nginx) phía trước, vì không có HTTPS thì mật khẩu và cookie đi dạng chữ thường.
- Telegram không bị ảnh hưởng: kênh này dùng mã ghép nối riêng (`13-telegram.md`).
