# 07 — Giao diện web và server

## Vì sao

Người dùng no-code không dùng terminal. Giao diện là thứ biến harness thành "công ty": chat với CTO, xem nhân viên đang làm gì, sửa tri thức, thêm kỹ năng, nối công cụ ngoài — tất cả không mở file bằng tay.

## Kiến trúc

```
ui/ (React + Vite, build tĩnh)  ──HTTP JSON + SSE──▶  src/server/ (node:http)  ──▶  Harness
                                                        │
                                                        ├─ routes-chat:  sessions, messages, stop, direct, staff
                                                        ├─ routes-admin: config, knowledge, results, skills, mcp
                                                        └─ routes-schedule: việc định kỳ (09-schedules.md)
```

- **Server không có framework.** `src/server/http.ts` = router pattern `:param`, JSON body, SSE bus, static. ~150 dòng.
- **Một luồng SSE `/api/events` cho cả app.** Mọi `LoopEvents` (text, tool-start/end, notice, usage) + harness-level (`session`, `turn`, `question`) phát qua đây kèm `sessionID`; UI lọc theo phiên đang xem. Không có kênh riêng per-session → đơn giản, và trang Chat thấy được cả nhân viên con.
- **`src/bootstrap.ts`** là wiring chuẩn: mở DB (`dbPath` / `HAHANESS_DB` / `.hahaness/hahaness.db`), tạo mẫu COMPANY/USER/MEMORY nếu thiếu, đọc config từ DB, rồi dựng documents, vai, tool, skills, MCP, harness. Server gọi; test server cũng gọi. Không có CLI: web là giao diện duy nhất. `close()` là async (dừng MCP, đóng DB).
- **Transcript hiển thị = messages trong store.** UI reducer (`ui/src/pages/chat-state.ts`) áp SSE lên mảng `Message` theo đúng cấu trúc store (assistant có parts text/tool-call/tool-result), nên reload trang render giống hệt lúc stream.
- **Provider lỗi không làm server chết.** `App.providerError` được giữ; `/api/config` trả về, Settings hiển thị, gửi tin nhắn trả 409. Lưu config → `Harness.reconfigure()` dựng provider mới; phiên đang sống giữ model cũ (system prompt/model đóng băng per-session — nhất quán với `03`).

## Phiên

- `POST /api/sessions` tạo phiên gốc, mặc định với CTO; `agent` = id nhân viên → CEO chat riêng với nhân viên đó (rule nhân viên, xem `04`). `GET /api/sessions` = union phiên sống + phiên trong store (mới nhất trước).
- Sidebar Chat **mỗi người một dòng** (1 agent = 1 phiên, xem `11-one-session-per-agent.md`): CTO trước, rồi từng nhân viên (`/api/staff`), rồi nhân viên đã nghỉ nhưng còn phiên. Dòng nhân viên hiện trạng thái từ `SessionView.work`. Bấm vào → `POST /api/sessions { agent }` mở phiên của người đó (tạo nếu chưa có). Không có nút tạo phiên mới. Phiên từ trước thay đổi này nằm trong mục "Lịch sử cũ", chỉ xem (`home: false`; gửi tin nhắn → 409).
- **Giao tiếp** (`#chat/comms`, `GET /api/conversations`): dòng thời gian dựng lại từ bảng `events` (cộng inbox đang chờ), không lưu riêng. Brief = user message `source: agent` có `<brief>` trong phiên nhân viên; steer = user message `source: agent` khác (theo `from`); báo cáo = `<subagent …>` trong phiên người giao (tool-result `delegate` foreground hoặc message `source: subagent`, kể cả còn nằm trong inbox ở direct mode). CEO chat thẳng với nhân viên không hiện ở đây. Phiên con kiểu cũ (`parentID`) vẫn đọc theo cách cũ.
- `Harness.resume(id)`: nạp lại từ bảng `events` (messages + compaction cuối), dựng system prompt **từ tài liệu hiện tại** — nghĩa là sửa COMPANY.md rồi resume phiên cũ sẽ thấy bản mới. Đây là ngoại lệ có chủ ý của "đóng băng per-session": resume là ranh giới phiên mới về mặt cache.
- `POST …/messages` push inbox và trả `{ok}` ngay; kết quả đi qua SSE. Trạng thái `running` theo `turn` event.
- **Direct mode** `@writer <task>` từ UI → `POST …/direct` → `spawn(background, wakeLead: false)`: việc vào phiên của writer, báo cáo rơi vào inbox CTO nhưng **không đánh thức** CTO (tránh CTO tự trả lời CEO khi CEO không hỏi). CEO thấy kết quả ở phiên của writer (sidebar) và CTO thấy ở lượt sau. `@` chỉ dùng trong phiên agent primary (400 nếu gọi từ phiên nhân viên).
- Tool `question` không chờ: lượt kết thúc, UI hiện câu hỏi từ tool-call cuối chưa được trả lời, trả lời = gửi tin nhắn (`12-durable-work.md`). Permission `ask`: server giữ promise, phát `question` event, UI render ô trả lời, `POST /api/questions/:id` resolve.

## Tri thức (Knowledge)

| Mục | Backend | Ai thấy |
|---|---|---|
| `COMPANY.md`, `USER.md`, `MEMORY.md` | `/api/knowledge/file` | theo `03` |
| `knowledge/**` | cùng endpoint, chỉ nhận path trong `knowledge/` hoặc 3 tài liệu lõi (khác → 400); `GET /api/knowledge` trả `tree`, `DELETE /api/knowledge/node` xóa cả cây con | **index** cây (mỗi bộ + nhánh cấp 1) vào Tier B cho **mọi vai**; nội dung đọc theo node qua `read` (`10-knowledge-tree.md`) |
| Nhân viên (bảng `staff`) | `/api/staff` (+ `/markdown`) | CEO sửa frontmatter + job description; không sửa/đuổi CTO. Cho nghỉ = `fired = 1` |

Tài liệu CEO sửa từ UI ghi `author = "ceo"`; CTO sửa qua tool ghi id vai. UI hiện "ai sửa, lúc nào".

Index knowledge cap 80 dòng; vượt thì chỉ còn cấp bộ, rồi gợi ý `read knowledge`. Không đưa nội dung vào prompt — tài liệu tham khảo có thể lớn; model tự `read` khi brief/câu hỏi liên quan.

## Kết quả (Results)

| Endpoint | Tác dụng |
|---|---|
| `GET /api/results` | `{ deliverables, drafts }` — path, title (heading đầu), updatedAt, author |
| `GET /api/results/file?path=` | nội dung; path ngoài `deliverables/`/`drafts/` → 400 |
| `GET /api/results/download?path=` | tải `.md`, `content-disposition` có `filename*=UTF-8''…` cho tên tiếng Việt |
| `DELETE /api/results/file?path=` | xóa |

Trang **Kết quả** (`#results/<encodeURIComponent(path)>`, decode khi đọc vì `location.hash` giữ `%XX`) tự tải lại khi SSE có `tool-end` của `write`. `.docx`/`.pdf` để sau.

## Kỹ năng (Skills)

Bảng `skills`: mỗi kỹ năng là markdown có frontmatter `name`, `description`; CTO tạo/sửa bằng `manage_skill`. Chỉ `<available_skills>` (id + description) vào Tier A; tool `skill` trả thân. Thêm/sửa/xóa qua UI → tác động ở **phiên mới**. Test: `harness.test.ts` "skills: index in Tier A…".

## MCP

`src/mcp/client.ts` — JSON-RPC 2.0 tối thiểu, không thêm dependency:

- Transport `stdio` (spawn, newline-delimited) và `http` (streamable HTTP: POST, nhận JSON hoặc SSE, `mcp-session-id`).
- Method dùng: `initialize` → `notifications/initialized` → `tools/list` (phân trang) → `tools/call`. Không resources/prompts/sampling (v0.3).

`src/mcp/manager.ts` — cấu hình trong bảng `mcp_servers`, kết nối lúc khởi động, đăng ký tool. CEO thêm từ UI, hoặc CTO qua `mcp_manage` (`add` cần CEO duyệt):

- Tên tool `<server>_<tool>` (ký tự lạ → `_`), permission action `mcp:<server>:<tool>` → vai nào muốn chặn thì rule `{ action: "mcp:*", effect: deny }` trong định nghĩa vai. Mặc định mọi vai thấy tool MCP (harness-level `allow *`).
- `inputSchema` của server dùng nguyên cho model; harness validate bằng `z.record` (không parse lại schema JSON của bên thứ ba).
- Output: nối các `content[].text`; image/khác → placeholder.
- Bật/tắt/gỡ → `ToolRegistry.unregister`; phiên đang chạy mất tool ở step kế (snapshot tool lấy mỗi `wake`).

Ví dụ server stdio: `examples/mcp/echo-server.ts`. Test end-to-end: `server.test.ts` "mcp: add stdio server…" (spawn thật qua `npx tsx`).

## UI

- React + Vite, không router/state lib. Hash router `#chat/<id>`, `#results/<path>`, `#knowledge`, `#skills`, `#mcp`, `#settings`.
- Một bảng màu trung tính + một màu nhấn, font hệ thống, không gradient/glass/emoji trong UI. Mọi control có hành vi thật; trạng thái rỗng/lỗi/đang tải là thật (xem skill `antislop-ui`).
- Chat: danh sách phiên, transcript (tool call là `<details>` gập), nhân viên con với link sang phiên của họ, ô hỏi/permission, Dừng, gợi ý `@employee`.
- Settings: model mặc định, providers (OpenAI-compatible / custom module), API key bị che (`••••`) và được giữ nguyên nếu gửi lại, "Gọi thử".
- `npm run ui` = API server (7331) + Vite dev (5173, proxy `/api`). `npm run ui:build` → `ui/dist`, `npm run serve` serve tĩnh.

## Giới hạn hiện tại

- Server bind `127.0.0.1`, không auth — chỉ dùng local. Mở ra LAN/Internet cần token (v0.3 cùng với kênh chat).
- SSE không replay: mở trang giữa lượt thì thấy từ sự kiện kế tiếp; `GET /api/sessions/:id` trả transcript đã persist nên phần text đã stream vẫn hiện sau khi lượt kết thúc.
- Tri thức chỉ nhận text (tạo/sửa trong editor, hoặc dán cho CTO). Chưa upload PDF/DOCX — xem roadmap.
