# Hahaness

Một **công ty ảo** chạy bằng AI cho người không biết lập trình. Bạn là **CEO**. Bạn nói chuyện với **CTO**; CTO giao việc cho nhân viên (researcher, writer, marketer, analyst…) và **tự tuyển người mới** khi cần. Kết quả là tài liệu, kế hoạch, nội dung — lưu trong thư mục của bạn.

Kiến trúc học từ [hermes-agent](docs/research/01-hermes-agent.md), [opencode](docs/research/02-opencode.md), [openclaw](docs/research/03-openclaw.md) ([so sánh](docs/research/04-comparison.md)), bỏ phần coding-agent.

## Chạy

```sh
npm install
npm run ui        # mở giao diện web tại http://localhost:5173
```

Vào **Cài đặt** để khai báo provider/model (hoặc đặt `OPENAI_API_KEY` trước khi chạy). Thư mục bạn đứng khi gõ lệnh là workspace của công ty; lần đầu chạy harness tạo:

```
COMPANY.md      ← mô tả công ty của bạn (CTO và nhân viên đều đọc)
USER.md         ← bạn là ai, muốn được báo cáo thế nào (chỉ CTO đọc)
MEMORY.md       ← CTO tự ghi nhớ
knowledge/      ← tài liệu tham khảo (brand voice, bảng giá, FAQ…)
skills/         ← quy trình viết sẵn, mỗi cái một SKILL.md
staff/          ← nhân viên CTO đã tuyển (markdown, bạn sửa tay được)
drafts/         ← nhân viên nộp bài
deliverables/   ← kết quả cuối
.hahaness/      ← phiên chat, cấu hình MCP (không cần mở)
hahaness.json   ← provider/model (UI ghi hộ)
```

Giao diện có 5 trang: **Chat** (nói chuyện với CTO, xem nhân viên đang làm gì, `@writer <việc>` để giao thẳng), **Tri thức** (sửa COMPANY/USER/MEMORY, tài liệu, nhân viên, xem kết quả), **Kỹ năng**, **MCP** (nối công cụ ngoài), **Cài đặt**.

```
CEO> viết cho tôi chuỗi 3 email chào mừng khách hàng mới
CEO> nghiên cứu 5 đối thủ chính và so sánh giá
CEO> @writer viết lại email số 2 ngắn hơn một nửa
```

CTO sẽ tự `hire` (ví dụ `seo-specialist`) nếu không ai hợp việc; vai mới nằm ở `staff/` cho các lần sau.

Các lệnh khác:

```sh
npm run dev       # CLI trong terminal thay vì web (/staff, /quit)
npm run ui:build  # build ui/dist, rồi
npm run serve     # server tự serve UI tĩnh tại http://127.0.0.1:7331
npm test          # 17 test với provider giả + MCP server giả, không cần API key
npm run typecheck
```

Server chỉ bind `127.0.0.1`, không có xác thực — dùng trên máy mình.

## Tài liệu

| | |
|---|---|
| [00-overview](docs/architecture/00-overview.md) | Mục tiêu, người dùng no-code, mô hình công ty, nguyên tắc |
| [01-agent-loop](docs/architecture/01-agent-loop.md) | Turn/step, Outcome, inbox queue/steer, tool song song, interrupt, retry |
| [02-tool-calling](docs/architecture/02-tool-calling.md) | `Tool.define`, pipeline, ruleset, tool có sẵn, permission cho no-code |
| [03-context-engineering](docs/architecture/03-context-engineering.md) | System tiers, workspace files, budget, compaction, memory, context cho nhân viên |
| [04-multi-agent](docs/architecture/04-multi-agent.md) | Vai, `hire`, `delegate`, ResultEntry, isolation |
| [05-roadmap](docs/architecture/05-roadmap.md) | Lộ trình |
| [06-providers](docs/architecture/06-providers.md) | `hahaness.json`, OpenAI-compatible, custom provider module |
| [07-ui-server](docs/architecture/07-ui-server.md) | Giao diện web, API + SSE, knowledge/skills, MCP client, giới hạn |
