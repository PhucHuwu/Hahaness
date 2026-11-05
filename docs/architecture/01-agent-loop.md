# 01 — Agent loop

## Thuật ngữ

- **Turn**: từ lúc inbox có input tới khi assistant trả lời không kèm tool-call (hoặc dừng vì lý do khác).
- **Step**: một lần gọi model + thực thi batch tool-call của nó. Một turn gồm nhiều step.
- **Outcome**: kết quả tagged union của một step, quyết định loop làm gì tiếp (học opencode).

## Kiểu dữ liệu cốt lõi

```ts
type Outcome =
  | { tag: "completed"; text: string }            // không có tool-call → kết thúc turn
  | { tag: "continue" }                           // có tool local đã chạy → step tiếp
  | { tag: "retry"; delay: number; reason: string }
  | { tag: "compacted" }                          // overflow → đã compaction → rebuild request
  | { tag: "output-limit" }                       // finish=length → nối tiếp
  | { tag: "interrupted" }
  | { tag: "failed"; error: Error }

interface InboxItem {
  id: string
  delivery: "queue" | "steer"
  message: UserMessage | SystemNotice
  source: "user" | "subagent" | "cron" | "system"
}
```

## Vòng lặp

```ts
async function runTurn(session, signal) {
  await store.claim(session.id)                       // durable claim, crash → resume
  let step = 0
  try {
    while (true) {
      const next = await inbox.next(session.id)        // promote steer giữa step, queue ở đầu turn
      if (next.tag === "idle") break
      const outcome = await runStep(session, next.context, step++, signal)
      switch (outcome.tag) {
        case "continue":      continue
        case "compacted":     continue                  // rebuild request với checkpoint mới
        case "output-limit":  inbox.push(steer(CONTINUE_AFTER_OUTPUT_LIMIT)); continue
        case "retry":         await sleep(outcome.delay); continue
        case "completed":
        case "interrupted":
        case "failed":        return outcome
      }
    }
  } finally {
    await store.release(session.id, { keepOnShutdown: signal.reason === "shutdown" })
  }
}
```

### `runStep`

1. **Budget check**: nếu `step >= agent.steps` → chèn `MAX_STEPS_PROMPT`, `toolChoice: "none"`, **giữ nguyên tool definitions** (cache). Nếu `step >= 0.8 * agent.steps` lần đầu → push steer `WRAPUP_NOTICE` (học hermes).
2. **Context assembly** (`context/system.ts` + `context/compaction.ts`): nếu `estimate.total >= ceiling` → compaction trước khi gọi model.
3. **Build request**: system parts + messages từ checkpoint gần nhất + tool definitions (sau khi lọc permission).
4. **Stream**: `provider.stream(request, signal)` → `AsyncIterable<StreamEvent>`.
   - `text-delta` → append vào assistant part, emit ra UI.
   - `tool-call` (hoàn chỉnh args) → **persist assistant message với tool-call part ngay** (`store.append`), rồi start `executeTool()` promise ngay, không chờ stream kết thúc (học opencode/openclaw).
   - `finish` → ghi `usage` vào `budget.measured`.
5. **Settle tools**: `await Promise.allSettled(toolRuns)`; kết quả reinsert đúng thứ tự tool-call; mỗi result qua `output.truncate()`.
6. **Doom-loop check** (`loop/guard.ts`): nếu 3 tool-call liên tiếp giống hệt (name + args hash) hoặc cùng tool lỗi 3 lần liên tiếp → push steer `REPEATED_TOOL_NOTICE`; lần 2 → `failed`. (opencode V2 bỏ cái này và bị coi là điểm yếu, nên ta giữ.)
7. **Outcome**: có tool local chạy → `continue`; `finish === "length"` → `output-limit` (3 lần liên tiếp → `failed`); không tool → `completed`.

### Tool song song

- Mặc định chạy song song tất cả tool-call trong một step.
- Tool khai báo `concurrency: "serial"` (vd `question`, `delegate` foreground) sẽ chờ các tool trước hoàn tất.
- Approval prompt đi qua một gate tuần tự: nhiều tool cần `ask` cùng lúc thì hỏi lần lượt (học hermes `_ConcurrentToolAuthorizationGate`).
- Batch deadline mặc định 300s; tool `delegate` miễn deadline.

### Interrupt & steer

- `AbortSignal` xuyên suốt: provider stream, tool execute, subagent block.
- User `Esc` → `abort("user")`: hủy stream, hủy tool đang chạy, ghi tool result `{error: "interrupted"}` cho call dang dở, release claim.
- User gõ giữa chừng → mặc định `steer`: item được promote **sau khi batch tool hiện tại settle**, trước step tiếp theo. Model thấy nó như user message mới sau tool results.
- `/queue <msg>` → `queue`: chỉ xử lý sau khi turn kết thúc.

### Retry & lỗi provider

- 429 / 5xx / network → `retry` với backoff 1s→2s→4s→8s, tối đa 5 lần; 401/403 → `failed` ngay.
- Provider gửi `retry-after-ms` / `retry-after` → chờ đúng thời gian đó thay cho backoff. Chờ quá 60s (vd hết quota ngày) → `failed` ngay với lỗi "provider asked to wait Ns", không treo lượt.
- Stream đứt (provider ném hoặc trả `error`) sau khi đã phát tool-call → tool vẫn chạy xong, result vẫn được ghi, lượt `continue`. Đứt trước tool-call → `retry` như lỗi mạng.
- Bị dừng giữa stream: OpenAI provider không phát tool-call có args dở dang; loop không khởi động tool mới sau khi đã abort; text đã stream được giữ lại.
- `usage.inputTokens = 0` (proxy không trả usage) → **không** reset `measured`; cộng dồn ước lượng chars/4. Trước đây reset về 0 khiến compaction không bao giờ kích hoạt.
- Dừng CTO khi đang chờ nhân viên (`delegate` foreground) → signal của tool call lan xuống `spawn`, nhân viên bị abort theo. Nhân viên chạy nền không bị dừng theo (dừng bằng `delegate stop` hoặc nút Dừng ở phiên của họ).
- Provider báo context quá dài → `compaction.recoverOverflow()` thử shrink `[0.85, 0.7, 0.5]` → `compacted`.
- **Model dự phòng** (`Harness.modelChain` + `TurnContext.fallbacks`):
  - Thứ tự: model của phiên → phần còn lại của `agent.model` → `fallbackModels` trong config công ty → `defaultModel`. Trùng lặp và ref không resolve được thì bị bỏ.
  - Đổi model khi: (a) hết 5 lần retry; (b) provider bảo chờ quá 60s; (c) lỗi không retry được từ provider (401/403/400, model không tồn tại). Các lỗi này mang class `ProviderError`. Lỗi do agent gây ra (doom loop, output limit, overflow không nén được) **không** đổi model.
  - Lượt hiện tại chạy tiếp trên model mới, từ đúng step lỗi; transcript không đổi. Có notice `model X failed (…); switching to Y`.
  - `Live.activeModel` nhớ model đang dùng: các lượt sau bắt đầu từ model đó, không thử lại model hỏng mỗi lượt. Chỉ lưu trong bộ nhớ: restart thì thử lại model chính. `session.model` giữ nguyên (đó là lựa chọn ban đầu).
  - System prompt không đổi khi đổi model (cache của provider mới bắt đầu lại, chấp nhận được).

### Durability

- Store là event log append-only trong SQLite: bảng `events` (seq, session_id, kind, data JSON), đọc lại bằng `fold`; metadata ở bảng `sessions` (xem `08-storage.md`). Mỗi dòng = `MessageAppended | PartUpdated | ToolResult | Compaction | Claim | Release`.
- **Tool-call mồ côi** (có `tool-call` mà không có `tool-result`, do server tắt giữa lúc tool chạy): `repairDangling` ghi result `interrupted: …` (isError) vào store. Chạy ở `Harness.resume` và đầu mỗi `runTurn`. Lý do: API kiểu OpenAI trả 400 cho mọi request có `tool_calls` thiếu tool message → không vá thì phiên hỏng vĩnh viễn.
- `resume` thấy `staleClaim` (Claim không có Release) hoặc vừa vá tool-call → xếp `RESUMED_AFTER_CRASH` (system message) vào inbox, model thấy ở lượt kế tiếp. **Không tự chạy tiếp**: lượt dở có thể tốn tiền và CEO có thể không còn muốn; CEO nhắn tiếp là đủ.

## Những gì cố ý KHÔNG làm ở v1

- Không event bus / projector kiểu opencode. Store đọc tuần tự là đủ.
- Không lane / global concurrency cap kiểu openclaw. Chỉ giới hạn `maxConcurrentSubagents` per session.
- Không provider-side compaction.
