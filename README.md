# Hahaness

Một **công ty ảo** chạy bằng AI cho người không biết lập trình. Bạn là **CEO**. Bạn nói chuyện với **CTO**; CTO giao việc cho nhân viên (researcher, writer, marketer, analyst…) và **tự tuyển người mới** khi cần. Kết quả là tài liệu, kế hoạch, nội dung — lưu trong thư mục của bạn.

Kiến trúc học từ [hermes-agent](docs/research/01-hermes-agent.md), [opencode](docs/research/02-opencode.md), [openclaw](docs/research/03-openclaw.md) ([so sánh](docs/research/04-comparison.md)), bỏ phần coding-agent.

## Chạy

```sh
npm install
copy hahaness.example.json hahaness.json   # khai báo provider/model
set OPENAI_API_KEY=...
npm run dev
```

Lần đầu chạy, harness tạo trong thư mục hiện tại:

```
COMPANY.md      ← mô tả công ty của bạn (CTO và nhân viên đều đọc)
USER.md         ← bạn là ai, muốn được báo cáo thế nào (chỉ CTO đọc)
MEMORY.md       ← CTO tự ghi nhớ
staff/          ← nhân viên CTO đã tuyển (markdown, bạn sửa tay được)
drafts/         ← nhân viên nộp bài
deliverables/   ← kết quả cuối
```

Sửa `COMPANY.md` và `USER.md` trước, rồi:

```
CEO> viết cho tôi chuỗi 3 email chào mừng khách hàng mới
CEO> nghiên cứu 5 đối thủ chính và so sánh giá
CEO> @writer viết lại email số 2 ngắn hơn một nửa
CEO> /staff
```

CTO sẽ tự `hire` (ví dụ `seo-specialist`) nếu không ai hợp việc; vai mới nằm ở `staff/` cho các lần sau.

```sh
npm test          # 9 test với provider giả, không cần API key
npm run typecheck
```

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
