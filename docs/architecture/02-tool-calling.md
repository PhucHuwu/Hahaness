# 02 — Tool calling

## Định nghĩa tool

```ts
import { z } from "zod"

export const read = Tool.define({
  name: "read",
  description: "Read a file...",
  input: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
  permission: { action: "read", resource: (i) => i.path },
  concurrency: "parallel",            // "parallel" | "serial"
  async execute(input, ctx) {
    // ctx: { sessionID, agent, signal, ask(), emit(), cwd }
    return { output: text, metadata: { lines } }
  },
})
```

- `input` là zod schema → `z.toJSONSchema()` → normalize (inline `$defs`, flatten `allOf`, bỏ `MIN/MAX_SAFE_INTEGER`) để definition **byte-stable** giữa các request (cache).
- Validation lỗi → không throw, trả `ToolResult.error` cho model với tối đa 5 issue + args đã gửi (học opencode). Model tự sửa.
- `execute` trả `{ output: string; content?: Content[]; metadata?: object }`. `content` cho ảnh/file (data-URI).

## Result pipeline

```
model emits tool-call
  → validate(input)                     lỗi → ToolResult.error, không chạy
  → permission.evaluate(action, resource)
       deny  → ToolResult.error("denied")
       ask   → ctx.ask() block trên Deferred; reject có feedback → error typed cho model
       allow → tiếp
  → hooks.before(tool, input)           có thể sửa input / block
  → execute(input, ctx) với timeout + signal
  → hooks.after(tool, result)
  → output.truncate(result)             2000 dòng / 50 KiB → spill file, chèn footer
  → store.append(ToolResult)
```

### Truncation & spill (`tool/output.ts`)

- `MAX_LINES = 2000`, `MAX_BYTES = 50 * 1024`.
- Vượt → lưu bản đầy đủ vào tài liệu ẩn `tool-output/<callID>.txt` (qua callback `saveOutput` của harness), output kết thúc bằng `[showing lines 1-N of M; full output saved to <path>, read it with offset/limit]`. Model `read` lại với offset.
- Tool `bash` dùng `tail` mode (`metadata.tail`): giữ phần cuối thay vì phần đầu (lỗi và kết quả thường ở cuối).

## Permission (`permission/ruleset.ts`)

```ts
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
// evaluate = findLast(rule matches action && glob(resource)) ?? { effect: "ask" }
```

- Thứ tự merge: `config.permissions` → `agent.permissions` → `session.permissions` (saved "always" của user). Saved rule **không override** rule `deny` có sẵn: check `denied()` trước.
- Actions chuẩn: `read`, `write`, `webfetch`, `websearch`, `mcp:<server>:<tool>` và nhóm quản trị `MANAGEMENT_ACTIONS` = `delegate`, `hire`, `memory`, `question`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule` (chỉ CTO).
- `write` có resource = path → nhân viên có `{ write, "*", deny }` **rồi** `{ write, "drafts/*", allow }`: deny rộng trước, ngoại lệ hẹp sau.
- `denied()` (chặn cứng, saved approval không vượt): một rule deny match thì bị chặn, **trừ khi** có một rule allow đứng sau nó, cùng action, resource hẹp hơn hẳn (`drafts/*` so với `*`) và cũng match. Allow đứng trước deny, hay allow rộng bằng hoặc rộng hơn deny (vd. `shell * allow` sau `shell git push* deny`), không gỡ được deny. Deny kế thừa từ phiên cha (`inherit`) nối vào cuối ruleset của con nên con không có ngoại lệ nào đứng sau nó.
- Bug đã gặp: `capabilityRules` cũ sinh `drafts/* allow` rồi `* deny`, nên nhân viên được tuyển không ghi được gì cả, mà vẫn báo "đã lưu". `fromMarkdown` giờ đưa các deny `action *` lên đầu (`hoistBroadDenies`), nên các dòng `staff` cũ trong DB tự được sửa khi load.
- Chế độ unattended (cron/background subagent không có người trả lời): `ask` → `deny`.
- Tắt tool cho agent = rule `{ action: "<tool>", resource: "*", effect: "deny" }`; registry `snapshot(ruleset)` lọc tool bị `deny *` khỏi definitions luôn (tiết kiệm token).

## Registry (`tool/registry.ts`)

- `register(tool)`, `snapshot(ruleset, agent) → ToolDefinition[]`.
- Namespace: MCP tool đặt tên `<server>_<tool>`; description MCP được strip ký tự điều khiển / tag Unicode (chống prompt-injection, học hermes).
- Tool description có thể **động theo context** (vd `delegate` liệt kê agent được phép) — nhưng phải deterministic trong một session để không vỡ cache.

## Builtin tools v0.1

Không edit code. Tool tài liệu (`documentTools(docs)`) đọc/ghi bảng `documents` trong DB, không chạm filesystem; path ảo được chuẩn hóa và `..` bị từ chối (`normalizePath`).

| Tool | Mục đích | Permission action | Ai có |
|---|---|---|---|
| `read` | đọc tài liệu công ty | `read` | mọi vai |
| `list` | liệt kê "thư mục" tài liệu | `read` | mọi vai |
| `search` | tìm cụm từ trong tài liệu (không phân biệt hoa thường, cả tiếng Việt) | `read` | mọi vai |
| `write` | tạo/ghi đè tài liệu | `write` (resource = path, nhân viên chỉ `drafts/*`) | CTO, writer, marketer |
| `edit` | thay một đoạn chữ chính xác trong tài liệu (`old` → `new`, `all?`); không thấy hoặc thấy nhiều chỗ → lỗi hướng dẫn model sửa | `write` (như trên) | ai có `write` |
| `bash` | chạy lệnh/code (Python…) trong thư mục làm việc riêng, env không có secret (`15-bash.md`) | `bash` (resource = lệnh); nhân viên chỉ khi có capability `bash` | CTO |
| `webfetch` | tải trang → text | `webfetch` (resource = hostname) | CTO, researcher, writer, marketer |
| `websearch` | tìm web (DuckDuckGo HTML, không cần key) | `websearch` | researcher |
| `question` | hỏi CEO một câu kèm lựa chọn | — (hard deny cho nhân viên) | CTO |
| `todo` | plan list của phiên | — | mọi vai |
| `memory` | list/add/replace/remove MEMORY.md | `memory` | CTO |
| `delegate` | list/spawn/steer/stop nhân viên | `delegate` | CTO |
| `hire` | tạo vai mới (bảng `staff`) | `hire` | CTO |
| `staff` | show/edit/fire nhân viên (không đụng CTO) | `staff` (resource = id) | CTO |
| `knowledge` | các bộ tri thức dạng cây `knowledge/*` (outline/save/append/move/delete), COMPANY.md, USER.md | `knowledge` (resource = action) | CTO |
| `manage_skill` | tạo/sửa/xóa kỹ năng | `manage_skill` | CTO |
| `mcp_manage` | nối/bật/tắt/gỡ server MCP | `mcp_manage` (resource = action; `add` là `ask`) | CTO |
| `schedule` | việc định kỳ: tạo/sửa/tạm dừng/chạy ngay/lịch sử (`09-schedules.md`) | `schedule` (resource = action) | CTO |
| `skill` | load thân một kỹ năng | `skill` | mọi vai |
| `<server>_<tool>` | tool từ MCP server (xem `07-ui-server.md`) | `mcp:<server>:<tool>` | mọi vai, trừ khi vai deny `mcp:*` |

## Permission cho người dùng no-code

- Harness-level rule mặc định: `{ action: "*", resource: "*", effect: "allow" }`. **Không hỏi CEO.**
- An toàn đến từ ruleset của từng vai (deny cứng), không từ dialog. Vai do `hire` tạo chỉ chọn được 4 capability, và `write` luôn bị giới hạn `drafts/*`.
- `ask` chỉ xuất hiện ở `mcp_manage add` của CTO (server stdio chạy lệnh trên máy CEO) hoặc nếu ai đó chủ động viết rule `ask` vào định nghĩa vai.

## MCP (v1.1)

- Config `mcp.<server> = { transport: stdio|http, command|url, enabled, lazy }`.
- Mỗi tool remote wrap thành `Tool.define` với `input` = JSON Schema thô, permission action `mcp:<server>:<tool>` mặc định `ask`.
- `notifications/tools/list_changed` → rebuild snapshot (debounce 100ms).

## Code Mode (v2, tùy chọn)

Một tool `execute({ code })` chạy JS trong sandbox với `tools.*` proxy, học opencode/openclaw. Giảm số round-trip khi model cần gọi 10 tool nhỏ. Để sau vì tăng bề mặt bảo mật.

## Doom-loop guard

- Hash `(name, canonicalJSON(args))` của tool-call. 3 lần giống hệt liên tiếp → steer notice; 5 lần → fail turn.
- Cùng tool trả error 3 lần liên tiếp → steer notice "thử cách khác"; 5 lần → fail.
