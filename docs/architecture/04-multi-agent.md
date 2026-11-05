# 04 — Multi-agent: CEO / CTO / workers

## Agent definition

`agents/<id>.md` (user) hoặc `src/agent/builtin/<id>.md`:

```md
---
id: coder
name: Coder
description: Sửa code, viết test, chạy test. Nhận brief rõ ràng về file và tiêu chí xong.
mode: subagent            # primary | subagent | all
model: [anthropic/claude-sonnet-4.5, openai/gpt-5]   # list = fallback
steps: 60
context: isolated         # isolated | fork (mặc định khi được spawn)
permissions:
  - { action: read,  resource: "*", effect: allow }
  - { action: edit,  resource: "*", effect: allow }
  - { action: write, resource: "*", effect: allow }
  - { action: shell, resource: "*", effect: ask }
  - { action: shell, resource: "bun test*", effect: allow }
  - { action: shell, resource: "git push*", effect: deny }
  - { action: delegate, resource: "*", effect: deny }
---
Bạn là kỹ sư phần mềm… (system prompt)
```

Merge thứ tự: builtin → `agents/*.md` → config JSON. Permissions append (last-match-wins).

## Builtin agents

| id | mode | context | Vai trò | Tool chính |
|---|---|---|---|---|
| `cto` | primary | — | Nói chuyện với CEO; lập kế hoạch, chia việc, tổng hợp, quyết định | `delegate`, `todo`, `question`, `read`, `grep`, `memory` |
| `planner` | subagent | fork | Phân rã yêu cầu lớn thành task list có dependency | `read`, `glob`, `grep` |
| `researcher` | subagent | isolated | Đọc codebase/web, trả báo cáo có trích dẫn path | `read`, `glob`, `grep`, `webfetch` |
| `coder` | subagent | isolated | Sửa code, chạy test | `read`, `edit`, `write`, `shell` |
| `reviewer` | subagent | fork | Đọc diff + lịch sử, trả nhận xét theo mức độ | `read`, `shell(git diff*)` |
| `ops` | subagent | isolated | build/deploy/script, permission `ask` mặc định | `shell`, `read` |

CTO mặc định có `delegate` allow cho mọi subagent; worker mặc định `delegate: deny` (leaf). Để worker được delegate tiếp, set `role: orchestrator` + depth cap `delegate.maxDepth = 2`.

## Tool `delegate`

```ts
input: z.object({
  action: z.enum(["spawn", "steer", "stop", "list", "wait"]),
  agent: z.string().optional(),
  brief: z.object({
    goal: z.string(),
    context: z.string(),
    done_when: z.string(),
    output: z.string().default("report"),
  }).optional(),
  context: z.enum(["isolated", "fork"]).optional(),
  background: z.boolean().default(false),
  sessionID: z.string().optional(),     // steer / stop / wait / follow-up spawn
  message: z.string().optional(),       // steer
})
```

Description của tool liệt kê các agent CTO được phép dùng (từ ruleset) — tính một lần khi session bắt đầu để deterministic.

### Lifecycle

```
spawn ─▶ child session created (parentID, agent, model, context)
      ─▶ inbox(child).push(queue, brief)
      ─▶ runTurn(child) trên lane riêng (giới hạn maxConcurrentSubagents = 4)
      │
      ├─ foreground: parent await; trả ResultEntry trong tool result
      │
      └─ background: tool result trả ngay `{sessionID, status: "running"}`
                     khi child xong → inbox(parent).push(queue, SubagentResultMessage)
                     → parent wake nếu đang idle, hoặc thấy ở turn tiếp theo
```

### ResultEntry — thứ duy nhất đi qua biên

```ts
interface ResultEntry {
  sessionID: string
  agent: string
  status: "completed" | "failed" | "stopped" | "timeout"
  exitReason: string               // "done" | "max_steps" | "error:<msg>" | "interrupted"
  summary: string                  // assistant text cuối, cap 8k chars
  filesTouched: string[]           // từ metadata tool write/edit
  schemaValid?: boolean            // nếu output: json:<schema>
  usage: { steps: number; inputTokens: number; outputTokens: number }
}
```

Render vào parent:

```xml
<subagent sessionID="ses_x" agent="coder" status="completed" steps="14">
…summary…
</subagent>
```

Không bao giờ đưa transcript child vào parent. CEO muốn xem thì mở session child trong UI.

### Steer / stop / wait

- `steer(sessionID, message)` → `inbox(child).push(steer, message)`. Child thấy nó sau tool batch hiện tại.
- `stop(sessionID)` → `abort("parent")` child; child trả `status: stopped`.
- `wait(sessionID | "*")` → block tới khi child (hoặc tất cả) xong; dùng khi CTO đã spawn nhiều background.
- Follow-up: `spawn` với `sessionID` có sẵn → push brief mới vào child cũ (giữ context của nó).

### Isolation rules cho child

- Hard deny (không config được): `question` (không hỏi CEO trực tiếp — trả về `status: needs_input` để CTO hỏi), `memory` write (chỉ CTO ghi memory), `delegate` nếu leaf.
- Child kế thừa ruleset của parent **giao** với ruleset của chính nó: parent `deny` thì child không bao giờ `allow`.
- `ask` trong child khi chạy background → forward lên CEO qua parent session UI (có nhãn agent); nếu CEO không trả lời trong `askTimeout` (10 phút) → `deny`.
- Child `cwd` = parent cwd, hoặc `worktree: true` → git worktree riêng (v1.1).

## CEO giao tiếp

### Orchestrated mode (mặc định)
CEO gõ tự nhiên. CTO quyết định tự làm hay delegate. CTO được hướng dẫn trong system prompt:

- Việc < 3 bước và trong khả năng tool của mình → tự làm.
- Việc cần đọc nhiều file / tìm hiểu → `researcher` (background nếu có việc khác song song).
- Việc sửa code → `coder` với brief có `done_when` kiểm tra được (test pass, lệnh chạy ok).
- Sau `coder` xong và thay đổi > 50 dòng → `reviewer` (fork) trước khi báo CEO.
- Luôn tổng hợp cho CEO ở mức quyết định, không lặp lại chi tiết worker.

### Direct mode
- `@coder sửa bug X ở file Y` → harness tạo brief tối thiểu `{goal: "...", context: "(CEO direct)", done_when: "theo goal"}` và spawn foreground, kết quả in thẳng ra CEO. Session cha vẫn là session CTO hiện tại nên CTO thấy ResultEntry ở turn sau.
- `/agent coder` → chuyển session hiện tại sang nói thẳng với coder (coder lúc này chạy `mode: primary` tạm thời, vẫn chịu permission của nó).
- `/sessions` liệt kê child đang chạy; `/steer <id> <msg>`, `/stop <id>`.

## Giới hạn

| Tham số | Mặc định |
|---|---|
| `delegate.maxDepth` | 1 (CTO → worker) |
| `delegate.maxConcurrent` | 4 |
| `delegate.childSteps` | 60 |
| `delegate.timeout` | 30 phút |
| `delegate.askTimeout` | 10 phút |
| `delegate.summaryCap` | 8.000 chars |

## Trạng thái hiển thị cho CTO

Thay vì inject block "Active Subagents" vào system (openclaw) — vỡ cache — ta để `delegate(action: "list")` cho CTO tự hỏi, và compaction summary có mục `## Active Subagents`.
