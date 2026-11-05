# 03 — Context engineering

## Cấu trúc request gửi model

```
[system part 1]  Tier A — STABLE (cache prefix)
   ├─ identity          : agent.system (từ agents/<id>.md body) hoặc SOUL.md
   ├─ harness guidance  : tool usage rules, output style (~500 tokens, generic)
   └─ skills index      : <available_skills> id/name/description

[system part 2]  Tier B — COMPANY (ổn định trong session)
   ├─ <company>         : COMPANY.md — mọi vai đều thấy
   ├─ <ceo>             : USER.md    — chỉ primary (CTO)
   ├─ <memory>          : MEMORY.md  — chỉ primary, snapshot lúc bắt đầu session
   └─ <env>             : cwd, platform, date (ngày — không giờ)

[messages]
   ├─ <conversation-checkpoint> summary + recent-context   (nếu đã compaction)
   ├─ ... messages từ checkpoint ...
   └─ Tier C — VOLATILE đi qua messages, KHÔNG qua system:
        ├─ instruction diff (AGENTS.md đổi giữa session) → system-role message
        ├─ subagent result   → user-role message `<subagent …>`
        ├─ wrap-up / steer   → user-role message
        └─ skill content     → tool result của `skill`
```

Lý do: cả 3 harness đều hội tụ về "prefix bất biến, biến động đi qua message". Hermes đóng băng system prompt hoàn toàn; opencode inject diff; openclaw tách suffix động. Ta chọn: **system đóng băng trong session, mọi thay đổi qua message**.

## Workspace của công ty (`context/workspace.ts`)

Tài liệu công ty là bản ghi trong bảng `documents` (path ảo, xem `08-storage.md`). CEO "dạy" công ty bằng cách nói với CTO; CTO ghi bằng `knowledge` / `memory` / `manage_skill`. Harness tạo template COMPANY/USER lần đầu; template chưa sửa (chỉ heading/comment) **không** vào prompt.

| Tài liệu | Ai thấy | Nội dung | Cap |
|---|---|---|---|
| `COMPANY.md` | mọi vai | công ty làm gì, sản phẩm, khách hàng, giọng văn | 20k chars |
| `USER.md` | CTO | CEO là ai, muốn báo cáo thế nào, ghét gì | 20k |
| `MEMORY.md` | CTO | CTO tự ghi qua tool `memory`, mục ngăn bằng `§` | 4k, bỏ cũ nhất khi đầy |
| `knowledge/**` | mọi vai | chỉ **index** `<knowledge>` (path + dòng đầu); nội dung đọc bằng `read`/`search` | 60 tài liệu trong index |
| kỹ năng (bảng `skills`) | mọi vai | chỉ **index** `<available_skills>` ở Tier A; thân load bằng tool `skill` | — |

- Nhân viên không thấy `USER.md`/`MEMORY.md`: họ không cần biết sếp, và giảm rò rỉ sở thích cá nhân vào bài viết.
- Mỗi source hash SHA-256, baseline lưu theo session. Đổi giữa phiên → (v0.2) push steer message chứa diff, không rewrite system.
- Bỏ hẳn AGENTS.md discovery theo thư mục — đó là khái niệm của coding agent.

## Token budget (`context/budget.ts`)

```ts
interface Estimate { measured: number; estimated: number }
// measured  = usage.input_tokens của response gần nhất
// estimated = chars/4 của mọi part thêm vào sau đó
// total = measured + estimated * 1.15
```

- `contextWindow` và `maxOutput` lấy từ model catalog.
- `ceiling = contextWindow − max(0.15 * contextWindow, 16_000)`.
- `outputLimit = min(maxOutput, contextWindow − total)`.

## Compaction (`context/compaction.ts`)

Trigger khi `total >= ceiling` (kiểm tra đầu mỗi step), hoặc provider báo overflow. (`/compact [focus]` thủ công: chưa làm.)

Cấu hình (`hahaness.json` / bảng `settings`):

```json
{ "compaction": { "model": "proxy/gemini-2.5-flash", "memoryFlush": true } }
```

Mã: `compact()` / `flushMemory()` / `summarizeFitted()` trong `core/loop.ts`; hàm thuần trong `context/compaction.ts`.

### Pha 0 — Memory flush (học openclaw)
Chỉ khi trigger theo ước lượng (không chạy khi overflow, vì request flush cũng sẽ tràn) và agent có tool `memory` (thực tế: CTO). Gửi transcript hiện tại + `MEMORY_FLUSH_PROMPT`, kèm đủ tool definitions để giữ cache prefix, nhưng **chỉ thực thi `memory`** (tool khác trả lỗi), tối đa 3 vòng, dừng khi model trả `NO_REPLY` hoặc không gọi tool.

Exchange flush **không ghi vào transcript**: chỉ tác dụng lên MEMORY.md còn lại. Lý do: tránh làm bẩn recent-context bằng một lượt hội thoại "ảo". Lỗi trong lúc flush chỉ phát notice, không chặn compaction. Tắt bằng `compaction.memoryFlush = false`.

### Pha 1 — Prune
Tool result cũ hơn `PROTECT_LAST = 20` message và dài >200 chars → `[tool output pruned: <tool>]`. Output của `skill` → `[SKILL_PRUNED: <id>] Call skill again if you need it.` Chưa làm: bỏ ảnh cũ.

### Pha 2 — Chọn biên
- `PROTECT_FIRST = 2` (user message đầu + reply đầu — thường chứa mục tiêu).
- `keepRecentTokens = min(15_000, 40% ceiling)` từ cuối lên (model context nhỏ không bị giữ nguyên văn quá ceiling).
- Biên lùi lại cho tới khi không cắt đôi cặp tool-call/tool-result.
- Biên phải **tiến lên** so với checkpoint trước; không thì compaction trả false (không giải phóng được gì).
- Step ngay sau một lần nén không nén lại theo ước lượng (tránh vòng nén liên tục khi phần giữ lại vẫn lớn).

### Pha 3 — Summarize
Gửi messages hiện tại (từ checkpoint trước, đã prune; cùng system → tận dụng cache) + prompt summary theo schema cố định:

```
## Objective
## Constraints & Requirements
## Decisions Made (và lý do)
## Work State (đã xong / đang dở / chưa làm)
## Relevant Files (path + vai trò)
## Active Subagents (id, task, trạng thái)
## Next Move
## Important Context (identifiers, URL, lỗi gặp — giữ nguyên văn)
```

- Instruction bảo toàn identifier nguyên văn (UUID, hash, path, port, URL) — học openclaw.
- `maxOutputTokens = 8_000` cho bản tóm tắt.
- **Request summarize không được tràn chính nó** (`fitForSummary`): input phải vừa `ceiling(window của model tóm tắt) − system − 8k`. Nặng dần: clip text/output >2k chars → bỏ hết tool output → bỏ message cũ nhất (sau 2 message đầu, chèn ghi chú `[N earlier messages omitted…]`). 4 message cuối không bị clip ở hai mức đầu. Model tóm tắt vẫn báo tràn → thu budget theo `0.7`, `0.5`.
- Kiểm tra heading bắt buộc (`## Objective`, `## Work State`, `## Next Move`). Thiếu → **retry 1 lần** với nudge liệt kê heading thiếu (giữ reply sai trong hội thoại để model sửa).
- Thứ tự model: `compaction.model` (nếu có, resolve được) → model của phiên. Model compaction cấu hình sai → notice + bỏ qua, không làm hỏng lượt.
- Mọi model đều trả sai định dạng → `fallbackSummary`: checkpoint dựng tay từ transcript (yêu cầu của CEO nguyên văn đã cắt ngắn, tool đã dùng, reply cuối, checkpoint trước). Mất chi tiết nhưng phiên chạy tiếp được.
- Mọi model lỗi mạng/khác → compaction trả false, loop xử lý lỗi như bình thường (retry).
- Chưa làm: refusal detect, budget summary theo % content.

### Pha 4 — Checkpoint
Append `Compaction { summary, keepFromID }` vào store. Request sau build từ checkpoint:

```xml
<conversation-checkpoint>
  <summary>…</summary>
  <recent-context>(messages từ keepFromID)</recent-context>
</conversation-checkpoint>
```

Skills đã load trước checkpoint (và không load lại trong phần giữ nguyên văn) được liệt kê cuối summary dạng `[SKILL_PRUNED: <id>]` — model gọi `skill` lại nếu cần.

**Re-anchor**: sau khi nén, `measured = 0`, `estimated = system + messages từ checkpoint` (chars/4). Số đo cũ của provider không còn đúng với transcript mới; response kế tiếp sẽ đo lại.

### Overflow recovery
Provider trả lỗi khớp `isOverflow` (vd `context_length_exceeded`, "maximum context length", "prompt is too long", "exceeds the context window") trước khi có output → nén với `keepRecentTokens × [0.85, 0.7, 0.5]` lần lượt cho mỗi lần tràn trong cùng lượt. Hết 3 mức hoặc không nén được → `failed` với lỗi rõ ràng, không lặp vô hạn. Việc "drop oldest exchanges" nằm trong `fitForSummary` (áp cho request tóm tắt); request chính chỉ còn checkpoint + phần giữ nguyên văn đã thu nhỏ.

### Precompute (v1.1)
Khi `total >= ceiling − 40k`, chạy summarize nền (không block). Nếu tới ceiling mà bản precompute chưa quá 5 phút và không có message mới quá nhiều → dùng luôn.

## Memory (`tool/builtin/memory.ts` + `context/workspace.ts`)

Nhỏ và đọc được, học hermes + openclaw:

- `MEMORY.md` — cap 4.000 chars, mục ngăn bằng `§`. Tool `memory` với `list | add | replace | remove`, chỉ CTO có.
- Snapshot vào system khi session bắt đầu; sửa giữa session → chỉ hiện ở session sau (đổi lại là cache ổn định). Tool trả về toàn bộ memory sau mỗi lần ghi nên model vẫn "thấy" ngay.
- Memory flush trước compaction: đã làm (xem Pha 0).
- Sau: `memory/YYYY-MM-DD.md` daily notes; `session_search` trên bảng `events`.

## Skills (`context/skills.ts`)

- Kỹ năng (bảng `skills`) là markdown có frontmatter `name`, `description`; CTO tạo/sửa bằng `manage_skill`. Chỉ `<available_skills>` (id + description) vào Tier A.
- Tool `skill({ id })` trả full nội dung + đường dẫn resources. Permission action `skill`.
- Agent có thể khai báo `skills: [...]` để preload vào system (hiếm, cho agent chuyên biệt).

## Subagent context

| `context` | Child nhận | Dùng cho |
|---|---|---|
| `isolated` (mặc định) | Tier A của vai + `<company>` + `<env>` (**không** USER/MEMORY) + brief | researcher, writer, marketer, nhân viên tuyển thêm |
| `fork` | như isolated + `<parent-summary>` (compaction gần nhất của CTO) + `<parent-recent-context>` 20 message, cap 30k tokens | analyst |

Brief từ CTO phải có cấu trúc (được ép bởi schema của tool `delegate`):

```
goal:        1–2 câu, kết quả mong muốn
context:     những gì child cần biết (file, quyết định, ràng buộc)
done_when:   tiêu chí hoàn thành kiểm tra được
output:      "report" | "diff" | "json:<schema>"
```

Học hermes `output_schema`: nếu `output: json:<schema>` thì validate kết quả, `schema_valid: false` được báo về CTO.
