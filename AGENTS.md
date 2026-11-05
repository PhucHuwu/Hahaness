# Hahaness — hướng dẫn cho agent làm việc trong repo này

- TypeScript ESM, chạy bằng `tsx` (Node 22). Import nội bộ dùng đuôi `.ts`.
- `npm run typecheck` và `npm test` phải sạch trước khi báo xong.
- Core (`src/core`, `src/context`, `src/permission`) giữ hẹp; capability mới đi vào `src/tool/builtin` hoặc `src/agent/builtin`.
- Không thêm thư viện mới nếu `node:*` + `zod` làm được.
- Mọi quyết định kiến trúc ghi vào `docs/architecture/`, không chỉ trong code comment.
- Không thay đổi system prompt giữa session; thứ cần thay đổi đi qua message (xem `docs/architecture/03-context-engineering.md`).
