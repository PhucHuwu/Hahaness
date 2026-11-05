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
- Vượt → ghi `.hahaness/tool-output/<callID>.txt`, output kết thúc bằng `[showing lines 1-N of M; full output saved to <path>]`. Model có thể `read` file đó với offset.
- Tool `shell` có thêm `tail` mode: giữ 200 dòng cuối thay vì đầu (log build thường quan trọng ở cuối).

## Permission (`permission/ruleset.ts`)

```ts
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
// evaluate = findLast(rule matches action && glob(resource)) ?? { effect: "ask" }
```

- Thứ tự merge: `config.permissions` → `agent.permissions` → `session.permissions` (saved "always" của user). Saved rule **không override** rule `deny` có sẵn: check `denied()` trước.
- Actions chuẩn: `read`, `write`, `webfetch`, `websearch`, `delegate`, `hire`, `memory`, `mcp:<server>:<tool>`.
- `write` có resource = path → rule `{ write, "drafts/*", allow }` + `{ write, "*", deny }` giới hạn nhân viên.
- Chế độ unattended (cron/background subagent không có người trả lời): `ask` → `deny`.
- Tắt tool cho agent = rule `{ action: "<tool>", resource: "*", effect: "deny" }`; registry `snapshot(ruleset)` lọc tool bị `deny *` khỏi definitions luôn (tiết kiệm token).

## Registry (`tool/registry.ts`)

- `register(tool)`, `snapshot(ruleset, agent) → ToolDefinition[]`.
- Namespace: MCP tool đặt tên `<server>_<tool>`; description MCP được strip ký tự điều khiển / tag Unicode (chống prompt-injection, học hermes).
- Tool description có thể **động theo context** (vd `delegate` liệt kê agent được phép) — nhưng phải deterministic trong một session để không vỡ cache.

## Builtin tools v0.1

Không có shell, không edit code. Mọi tool file bị chặn trong workspace (`inside()` ném lỗi nếu path thoát ra ngoài).

| Tool | Mục đích | Permission action | Ai có |
|---|---|---|---|
| `read` | đọc tài liệu trong workspace | `read` | mọi vai |
| `list` | liệt kê thư mục | `read` | mọi vai |
| `write` | tạo/ghi đè tài liệu | `write` (resource = path, nhân viên chỉ `drafts/*`) | CTO, writer, marketer |
| `webfetch` | tải trang → text | `webfetch` (resource = hostname) | CTO, researcher, writer, marketer |
| `websearch` | tìm web (DuckDuckGo HTML, không cần key) | `websearch` | researcher |
| `question` | hỏi CEO một câu kèm lựa chọn | — (hard deny cho nhân viên) | CTO |
| `todo` | plan list của phiên | — | mọi vai |
| `memory` | list/add/replace/remove MEMORY.md | `memory` | CTO |
| `delegate` | list/spawn/steer/stop nhân viên | `delegate` | CTO |
| `hire` | tạo vai mới, ghi `staff/<id>.md` | `hire` | CTO |

## Permission cho người dùng no-code

- Harness-level rule mặc định: `{ action: "*", resource: "*", effect: "allow" }`. **Không hỏi CEO.**
- An toàn đến từ ruleset của từng vai (deny cứng), không từ dialog. Vai do `hire` tạo chỉ chọn được 4 capability, và `write` luôn bị giới hạn `drafts/*`.
- `ask` chỉ còn xuất hiện nếu CEO/ai đó chủ động viết rule `ask` trong `staff/*.md`.

## MCP (v1.1)

- Config `mcp.<server> = { transport: stdio|http, command|url, enabled, lazy }`.
- Mỗi tool remote wrap thành `Tool.define` với `input` = JSON Schema thô, permission action `mcp:<server>:<tool>` mặc định `ask`.
- `notifications/tools/list_changed` → rebuild snapshot (debounce 100ms).

## Code Mode (v2, tùy chọn)

Một tool `execute({ code })` chạy JS trong sandbox với `tools.*` proxy, học opencode/openclaw. Giảm số round-trip khi model cần gọi 10 tool nhỏ. Để sau vì tăng bề mặt bảo mật.

## Doom-loop guard

- Hash `(name, canonicalJSON(args))` của tool-call. 3 lần giống hệt liên tiếp → steer notice; 5 lần → fail turn.
- Cùng tool trả error 3 lần liên tiếp → steer notice "thử cách khác"; 5 lần → fail.
