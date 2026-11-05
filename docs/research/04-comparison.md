# So sánh 3 harness

| Tiêu chí | hermes-agent | opencode V2 | openclaw |
|---|---|---|---|
| Ngôn ngữ / mô hình | Python, sync + thread | TS, Effect-TS, event-sourced | TS, async, pi-fork |
| Loop stop condition | không còn tool_calls, hoặc hết budget | `needsContinuation` (có tool local) + `Outcome` enum | `stopReason` + `endTurn` + `batch.terminate` |
| Step cap | 500 (sub 250), wrap-up notice 80% | `agent.steps`, step cuối `toolChoice:none` giữ tools | timeout 48h, idle timeout |
| Doom-loop | `repetition_guard.py` | **không** (V2 bỏ) | `agent-loop-tool-recovery.ts` (tool error lặp) |
| Steering giữa run | `/steer` chèn sau tool result | inbox `steer` promote giữa step | `steer/followup/collect/interrupt`, cap 20 |
| Tool chạy song song | ThreadPool 8, reinsert thứ tự | fork fiber ngay khi tool-call event | chạy ngay khi stream, batch |
| Persist trước execute | **có** (SQLite) | **có** (claim + event bus WAL) | SQLite + writer fence |
| Tool schema | dict OpenAI | Effect/Zod/JSON Schema, normalize byte-stable | TypeBox + tool-call-repair |
| Output lớn | spill disk + pointer | 2000 lines / 50 KiB, spill file 7 ngày | truncation + prune in-memory |
| Permission | approval callback + dangerous cmd detect + YOLO | ruleset `action/resource/effect` last-match, `ask` default | profile × allow/deny/alsoAllow × elevated × sandbox |
| MCP | `mcp_<server>_<tool>`, lazy, sanitize | `<server>_<tool>`, permission per-tool | bundle MCP + code mode |
| Code Mode | `execute_code` (refund budget) | mặc định cho hầu hết tool qua `execute` | `code-mode-*.ts` |
| System prompt | 3 tier theo volatility, **đóng băng** | `system.txt` + instruction sources shared-first, diff khi đổi | prefix stable + dynamic suffix, `promptMode` |
| Project rules | `.hermes.md` > `AGENTS.md` > `CLAUDE.md` | `AGENTS.md` + config `instructions` | workspace bootstrap files (cap 20k/60k chars) |
| Skills | index + `skill_view` on demand | `<available_skills>` + tool `skill` | `<available_skills>` + `formatSkillsForPrompt` |
| Memory | `MEMORY.md` 2.2k + `USER.md` 1.4k + FTS5 session_search | không built-in (plugin) | `MEMORY.md` + daily notes + vector search + flush + dreaming |
| Compaction trigger | 50% window | `ctx − max(15%, 16k)`, precompute trước 60k | `min(75%, ctx − 20k)` |
| Compaction method | prune → protect 3/20 → summary schema → reassemble | summary-over-full-request, keep 15k, checkpoint tag, shrink steps | summarizer cap 160k chars, keep 20k, preserve identifiers, refusal detect |
| Token estimate | heuristic + usage anchor | `{measured, estimated}` ±15% | char-based bootstrap, token cho compaction |
| Subagent spawn | `delegate_task` tasks[] | tool `subagent` `{agent, prompt, background, sessionID}` | `sessions_spawn` `{task, context: isolated|fork}` |
| Context cho child | chỉ goal + context string | chỉ prompt | `isolated` hoặc `fork` transcript |
| Kết quả về parent | result entry (status/summary) qua queue | text cuối hoặc synthetic user message (background) | announce message vào session parent |
| Depth / concurrency | depth 2, 3 concurrent | depth 1 | 8 concurrent, depth cap |
| Child tool restriction | leaf mất delegate/clarify/memory | permission `subagent` action | `SUBAGENT_TOOL_DENY_ALWAYS/LEAF` |
| Follow-up child | `steer`, `stop` | gửi lại `sessionID` | `sessions_send`, `subagents wait/cancel` |

## Điểm chung cả 3 đều làm

1. Prompt-cache là ưu tiên kiến trúc: phần ổn định đứng trước, phần biến động đẩy xuống cuối hoặc đi qua message.
2. Skills chỉ đưa index vào prompt, load nội dung on demand.
3. Tool-call/result pair không bao giờ bị cắt đôi khi compaction.
4. Summary theo schema cố định (Goal / Decisions / Files / Next steps…).
5. Subagent cô lập context, chỉ nhận brief, chỉ trả kết quả gọn.
6. Kết quả subagent nền quay về parent dưới dạng **message** (không phải tool result muộn).
7. Tool output lớn phải truncate/spill, không đổ hết vào context.

## Điểm khác biệt đáng chọn

- **Steering**: opencode inbox (queue/steer) sạch nhất về mô hình; openclaw phong phú nhất về mode.
- **Permission**: opencode ruleset last-match-wins dễ suy luận hơn openclaw layered profiles.
- **Memory**: openclaw đầy đủ nhất (flush trước compaction là ý hay); hermes gọn nhất.
- **Durability**: opencode claim + WAL là mạnh nhất nhưng phức tạp; hermes persist-before-execute đủ tốt và đơn giản.
- **Child context**: openclaw `fork` là lựa chọn duy nhất cho phép child thấy transcript parent — hữu ích cho reviewer.
