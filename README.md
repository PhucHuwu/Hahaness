# Hahaness

Một **công ty ảo** chạy bằng AI cho người không biết lập trình. Bạn là **CEO**: bạn chỉ ra lệnh. **CTO** giao việc cho nhân viên (researcher, writer, marketer, analyst…), **tự tuyển người mới** khi cần, và tự quản lý tri thức, quy trình, công cụ của công ty. Kết quả là tài liệu, kế hoạch, nội dung — xem và tải ở trang **Kết quả**.

Kiến trúc học từ [hermes-agent](docs/research/01-hermes-agent.md), [opencode](docs/research/02-opencode.md), [openclaw](docs/research/03-openclaw.md) ([so sánh](docs/research/04-comparison.md)), bỏ phần coding-agent.

## Chạy

```sh
npm install
npm run ui        # mở giao diện web tại http://localhost:5173
```

Vào **Cài đặt** để khai báo provider/model (hoặc đặt `OPENAI_API_KEY` trước khi chạy).

Toàn bộ công ty — hội thoại, nhân viên, tri thức, kỹ năng, kết quả, cấu hình — nằm trong **một file** `.hahaness/hahaness.db` (SQLite) trong thư mục bạn đứng khi chạy lệnh. Backup hay chuyển máy chỉ cần copy file đó. Muốn đặt chỗ khác: `HAHANESS_DB=D:\cong-ty.db npm run ui`.

Nếu thư mục có workspace kiểu cũ (`COMPANY.md`, `staff/`, `skills/`, `hahaness.json`…), lần đầu chạy sẽ nhập vào DB; file gốc giữ nguyên.

Bạn không cần sửa file nào. Cứ nói với CTO:

```
CEO> công ty mình bán khóa học tiếng Anh online cho người đi làm, ghi nhớ giúp
CEO> đây là bảng giá 2026: …  lưu lại cho mọi người dùng
CEO> báo cáo tuần luôn làm theo 3 phần: số liệu, việc xong, việc tuần sau
CEO> viết cho tôi chuỗi 3 email chào mừng khách hàng mới
CEO> @writer viết lại email số 2 ngắn hơn một nửa
```

CTO lưu mô tả công ty và tài liệu vào **Tri thức**, biến cách làm lặp lại thành **Kỹ năng**, tự `hire` vai mới (ví dụ `seo-specialist`) khi không ai hợp việc, và nộp kết quả cuối vào **Kết quả**. Nối công cụ ngoài (MCP) thì CTO hỏi bạn duyệt trước.

Giao diện có 6 trang: **Chat**, **Kết quả** (xem, chép, tải `.md`), **Tri thức** (công ty, về bạn, ghi nhớ, tài liệu, nhân viên), **Kỹ năng**, **MCP**, **Cài đặt**. Các trang ngoài Chat chủ yếu để xem; vẫn sửa tay được.

Các lệnh khác:

```sh
npm run ui:build  # build ui/dist, rồi
npm run serve     # server tự serve UI tĩnh tại http://127.0.0.1:7331
npm test          # 23 test với provider giả + MCP server giả, không cần API key
npm run typecheck
```

Server chỉ bind `127.0.0.1`, không có xác thực — dùng trên máy mình.

## Tài liệu

| | |
|---|---|
| [00-overview](docs/architecture/00-overview.md) | Mục tiêu, người dùng no-code, mô hình công ty, nguyên tắc |
| [01-agent-loop](docs/architecture/01-agent-loop.md) | Turn/step, Outcome, inbox queue/steer, tool song song, interrupt, retry |
| [02-tool-calling](docs/architecture/02-tool-calling.md) | `Tool.define`, pipeline, ruleset, tool có sẵn, permission cho no-code |
| [03-context-engineering](docs/architecture/03-context-engineering.md) | System tiers, tài liệu công ty, budget, compaction, memory, context cho nhân viên |
| [04-multi-agent](docs/architecture/04-multi-agent.md) | Vai, `hire`, `delegate`, ResultEntry, isolation |
| [05-roadmap](docs/architecture/05-roadmap.md) | Lộ trình |
| [06-providers](docs/architecture/06-providers.md) | Cấu hình provider, OpenAI-compatible, custom provider module |
| [07-ui-server](docs/architecture/07-ui-server.md) | Giao diện web, API + SSE, knowledge/skills/results, MCP client, giới hạn |
| [08-storage](docs/architecture/08-storage.md) | Một file SQLite, schema, nhập bố cục cũ, tool quản trị của CTO |
