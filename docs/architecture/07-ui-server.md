# 07 — Giao diện web và server

## Vì sao

Người dùng no-code không dùng terminal. Giao diện là thứ biến harness thành "công ty": chat với CTO, xem nhân viên đang làm gì, sửa tri thức, thêm kỹ năng, nối công cụ ngoài — tất cả không mở file bằng tay.

## Kiến trúc

```
ui/ (React + Vite, build tĩnh)  ──HTTP JSON + SSE──▶  src/server/ (node:http)  ──▶  Harness
                                                        │
                                                        ├─ routes-chat:  sessions, messages, stop, direct, staff
                                                        └─ routes-admin: config, knowledge, skills, mcp, outputs
```

- **Server không có framework.** `src/server/http.ts` = router pattern `:param`, JSON body, SSE bus, static. ~150 dòng.
- **Một luồng SSE `/api/events` cho cả app.** Mọi `LoopEvents` (text, tool-start/end, notice) + harness-level (`session`, `turn`, `question`) phát qua đây kèm `sessionID`; UI lọc theo phiên đang xem. Không có kênh riêng per-session → đơn giản, và trang Chat thấy được cả nhân viên con.
- **`src/bootstrap.ts`** là wiring chuẩn (workspace, vai, tool, skills, MCP, harness). CLI và server cùng gọi; test server cũng gọi.
- **Transcript hiển thị = messages trong store.** UI reducer (`ui/src/pages/chat-state.ts`) áp SSE lên mảng `Message` theo đúng cấu trúc store (assistant có parts text/tool-call/tool-result), nên reload trang render giống hệt lúc stream.
- **Provider lỗi không làm server chết.** `App.providerError` được giữ; `/api/config` trả về, Settings hiển thị, gửi tin nhắn trả 409. Lưu config → `Harness.reconfigure()` dựng provider mới; phiên đang sống giữ model cũ (system prompt/model đóng băng per-session — nhất quán với `03`).

## Phiên

- `POST /api/sessions` tạo phiên CTO. `GET /api/sessions` = union phiên sống + phiên trong store (mới nhất trước).
- `Harness.resume(id)`: nạp lại từ JSONL (messages + compaction cuối), dựng system prompt **từ workspace hiện tại** — nghĩa là sửa COMPANY.md rồi resume phiên cũ sẽ thấy bản mới. Đây là ngoại lệ có chủ ý của "đóng băng per-session": resume là ranh giới phiên mới về mặt cache.
- `POST …/messages` push inbox và trả `{ok}` ngay; kết quả đi qua SSE. Trạng thái `running` theo `turn` event.
- **Direct mode** `@writer <task>` từ UI → `POST …/direct` → `spawn(background, wakeParent: false)`: nhân viên chạy nền, báo cáo rơi vào inbox CTO nhưng **không đánh thức** CTO (tránh CTO tự trả lời CEO khi CEO không hỏi). CEO thấy kết quả ở phiên con (link trong thanh "Nhân viên") và CTO thấy ở lượt sau.
- `question` tool và permission `ask`: server giữ promise, phát `question` event, UI render ô trả lời trong chat, `POST /api/questions/:id` resolve. Tool `question` không nhận sessionID qua handler nên server theo dõi phiên vừa gọi `question` qua `onToolStart` (đủ vì `question` là serial và chỉ CTO có).

## Tri thức (Knowledge)

| Mục | Backend | Ai thấy |
|---|---|---|
| `COMPANY.md`, `USER.md`, `MEMORY.md` | `/api/knowledge/file` | theo `03` |
| `knowledge/**/*.{md,txt,csv,json,html}` | cùng endpoint, jail trong `knowledge/` | **index** (path + dòng đầu) vào Tier B cho **mọi vai**; nội dung đọc qua `read` |
| Nhân viên `staff/*.md` | `/api/staff` (+ `/markdown`) | CEO sửa frontmatter + job description; không sửa/đuổi CTO |
| `deliverables/`, `drafts/` | `/api/outputs/file` chỉ đọc | CEO xem kết quả |

Index knowledge cap 60 file; thêm → gợi ý `list knowledge`. Không đưa nội dung vào prompt — tài liệu tham khảo có thể lớn; model tự `read` khi brief/câu hỏi liên quan.

## Kỹ năng (Skills)

`skills/<id>/SKILL.md` (frontmatter `name`, `description`). Chỉ `<available_skills>` (id + description) vào Tier A; tool `skill` trả thân. Thêm/sửa/xóa qua UI → tác động ở **phiên mới**. Test: `harness.test.ts` "skills: index in Tier A…".

## MCP

`src/mcp/client.ts` — JSON-RPC 2.0 tối thiểu, không thêm dependency:

- Transport `stdio` (spawn, newline-delimited) và `http` (streamable HTTP: POST, nhận JSON hoặc SSE, `mcp-session-id`).
- Method dùng: `initialize` → `notifications/initialized` → `tools/list` (phân trang) → `tools/call`. Không resources/prompts/sampling (v0.3).

`src/mcp/manager.ts` — cấu hình `.hahaness/mcp.json`, kết nối lúc khởi động, đăng ký tool:

- Tên tool `<server>_<tool>` (ký tự lạ → `_`), permission action `mcp:<server>:<tool>` → vai nào muốn chặn thì rule `{ action: "mcp:*", effect: deny }` trong `staff/*.md`. Mặc định mọi vai thấy tool MCP (harness-level `allow *`).
- `inputSchema` của server dùng nguyên cho model; harness validate bằng `z.record` (không parse lại schema JSON của bên thứ ba).
- Output: nối các `content[].text`; image/khác → placeholder.
- Bật/tắt/gỡ → `ToolRegistry.unregister`; phiên đang chạy mất tool ở step kế (snapshot tool lấy mỗi `wake`).

Ví dụ server stdio: `examples/mcp/echo-server.ts`. Test end-to-end: `server.test.ts` "mcp: add stdio server…" (spawn thật qua `npx tsx`).

## UI

- React + Vite, không router/state lib. Hash router `#chat/<id>`, `#knowledge`, `#skills`, `#mcp`, `#settings`.
- Một bảng màu trung tính + một màu nhấn, font hệ thống, không gradient/glass/emoji trong UI. Mọi control có hành vi thật; trạng thái rỗng/lỗi/đang tải là thật (xem skill `antislop-ui`).
- Chat: danh sách phiên, transcript (tool call là `<details>` gập), nhân viên con với link sang phiên của họ, ô hỏi/permission, Dừng, gợi ý `@employee`.
- Settings: model mặc định, providers (OpenAI-compatible / custom module), API key bị che (`••••`) và được giữ nguyên nếu gửi lại, "Gọi thử".
- `npm run ui` = API server (7331) + Vite dev (5173, proxy `/api`). `npm run ui:build` → `ui/dist`, `npm run serve` serve tĩnh.

## Giới hạn hiện tại

- Server bind `127.0.0.1`, không auth — chỉ dùng local. Mở ra LAN/Internet cần token (v0.3 cùng với kênh chat).
- SSE không replay: mở trang giữa lượt thì thấy từ sự kiện kế tiếp; `GET /api/sessions/:id` trả transcript đã persist nên phần text đã stream vẫn hiện sau khi lượt kết thúc.
- Upload file vào `knowledge/` qua UI chỉ hỗ trợ text (tạo/sửa trong editor); file nhị phân thì bỏ vào thư mục bằng tay.
