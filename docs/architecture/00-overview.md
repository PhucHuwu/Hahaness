# Hahaness — Tổng quan kiến trúc

## Mục tiêu

Harness multi-agent bằng TypeScript (Bun), nơi người dùng đóng vai **CEO** và điều phối công việc qua một agent **CTO**, hoặc gọi thẳng các **worker subagent**. Ba trọng tâm: **context engineering**, **agent loop**, **tool calling**.

Hai chế độ hoạt động, cùng một runtime:

| Chế độ | Luồng | Khi nào dùng |
|---|---|---|
| **Orchestrated** (mặc định) | CEO ↔ CTO agent → spawn worker (coder, researcher, reviewer…) | Việc nhiều bước, cần lập kế hoạch, chia nhỏ |
| **Direct** | CEO → `@coder làm X` / `@researcher tìm Y` | Việc nhỏ, biết rõ ai làm; debug một worker |

Direct mode chỉ là CEO tự làm vai CTO: cùng tool `delegate`, cùng session model, chỉ khác người gọi.

## Mô hình vai

```
CEO (người dùng)
 └─ CTO (primary agent, orchestrator)
     ├─ planner     : phân rã task, viết brief
     ├─ coder       : sửa code, chạy test
     ├─ researcher  : đọc codebase / web, trả báo cáo
     ├─ reviewer    : đọc diff, trả nhận xét (context: fork)
     └─ ops         : shell, build, deploy (permission chặt)
```

- CTO là agent duy nhất `mode: primary` nói chuyện với CEO. Worker là `mode: subagent`, không bao giờ message CEO trực tiếp (học openclaw `SUBAGENT_TOOL_DENY_ALWAYS`).
- Depth mặc định 1 (CTO → worker). Worker có role `orchestrator` mới được delegate tiếp (học hermes, `max_depth = 2`).
- CEO có thể `/steer` CTO giữa chừng; CTO có thể `steer` worker.

## Nguyên tắc thiết kế (rút từ 3 harness)

1. **Prompt-cache là kiến trúc, không phải tối ưu sau.** System prompt chia tier theo độ biến động; thứ biến động đi qua message, không rewrite prefix. Thay đổi instruction giữa session → inject diff.
2. **Persist trước khi execute.** Assistant message có tool-call được ghi xuống store trước khi tool chạy. Crash → resume được.
3. **Mọi thứ là message trong inbox.** User input, steer, kết quả subagent nền, compaction request, wrap-up notice — tất cả là item trong inbox với `delivery: queue | steer`. Loop chỉ có một chỗ nhận input.
4. **Tool result có ngân sách.** Truncate theo dòng/byte, spill ra file, prune output cũ trước khi summary.
5. **Subagent cô lập, trả kết quả gọn.** Child chỉ nhận brief (hoặc fork transcript khi cần), chỉ trả `ResultEntry` có cấu trúc. Transcript child không bao giờ vào context parent.
6. **Permission = ruleset `{action, resource, effect}` last-match-wins**, mặc định `ask`; saved approval không bao giờ thắng `deny` đã config.
7. **Core hẹp, capability ở rìa.** Core = loop + inbox + store + context + permission. Tools, skills, MCP, memory provider, subagent runner đều plug vào.
8. **Không Effect-TS, không event sourcing** ở giai đoạn này. Async/await thuần + AbortSignal + append-only JSONL store. Ưu tiên đọc được.

## Bố cục mã nguồn

```
src/
  core/
    types.ts          # Message, Part, ToolCall, Outcome, Session
    inbox.ts          # queue | steer
    loop.ts           # runTurn / runStep
    store.ts          # append-only JSONL session store
  provider/
    types.ts          # ProviderClient.stream(request) → AsyncIterable<StreamEvent>
    openai.ts         # OpenAI-compatible (Chat Completions)
    anthropic.ts
  tool/
    define.ts         # Tool.define({name, description, input: zod, execute})
    registry.ts
    output.ts         # truncate + spill
    builtin/          # read, write, edit, glob, grep, shell, question, delegate, skill, memory
  context/
    system.ts         # tier assembly
    instructions.ts   # AGENTS.md discovery, hashing, diff
    budget.ts         # token estimate {measured, estimated}
    compaction.ts     # prune → summarize → checkpoint
    memory.ts         # MEMORY.md / USER.md provider
    skills.ts
  permission/
    ruleset.ts
    ask.ts            # Deferred-based approval
  agent/
    registry.ts       # load agents/*.md
    subagent.ts       # spawn / block / background notify
    builtin/          # cto.md, coder.md, researcher.md, reviewer.md, planner.md, ops.md
  cli.ts
agents/               # user-defined agents (override builtin)
skills/               # SKILL.md per folder
workspace/            # SOUL.md, AGENTS.md, MEMORY.md, USER.md
docs/
```

Chi tiết từng phần: `01-agent-loop.md`, `02-tool-calling.md`, `03-context-engineering.md`, `04-multi-agent.md`, `05-roadmap.md`.
