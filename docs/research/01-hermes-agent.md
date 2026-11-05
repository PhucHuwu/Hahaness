# Hermes Agent (NousResearch/hermes-agent)

> Python, loop đồng bộ, song song bằng thread. Nghiên cứu 11/2026.

## 1. Agent loop

- Entry: `run_agent.py::AIAgent` (facade) → `agent/agent_init.py::init_agent` (~60 tham số) → `agent/conversation_loop.py::run_conversation` (~1.950 dòng).
- Mỗi pha của một turn tách thành module `agent/turn_<phase>.py`: `iteration_prep`, `api_call`, `api_error`, `overflow`, `truncation`, `recovery`, `tool_round`, `stop_gates`, `finalizer`.
- Vòng lặp cốt lõi (từ `agent/AGENTS.md`):

```python
while (api_call_count < self.max_iterations
       and self.iteration_budget.remaining > 0) or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(...)
    if response.tool_calls:
        execute tools, append results, api_call_count += 1
    else:
        return content
```

- Budget: `max_iterations` = 500 (`IterationBudget`), subagent 250. Round chỉ có `execute_code` được **refund** budget. Ở 80% budget inject `RUN_BUDGET_WRAPUP_NOTICE` để model tự kết thúc gọn. `_MAX_OUTER_LOOP_ERRORS = 8`.
- Interrupt: `_interruptible_api_call()` chạy HTTP trong thread nền, main thread watch event. `/steer` chèn user message sau tool result hiện tại kèm `_INTERRUPT_SCAFFOLD_MARKER`. `agent/repetition_guard.py` phát hiện tool call lặp.
- Provider: 3 chế độ API (`chat_completions`, `codex_responses`, `anthropic_messages`) đều normalize về message list kiểu OpenAI; reasoning lưu trong `assistant_msg["reasoning"]`. `fallback_providers` thử lại khi 429/5xx/401/403.

## 2. Tool calling

- `tools/registry.py::ToolRegistry`. Tool tự đăng ký lúc import:

```python
registry.register(name="web_search", toolset="web", schema={...},
    handler=fn, check_fn=has_api_key, requires_env=[...],
    max_result_size_chars=..., execution_timeout=...)
```

- Discovery: AST-scan `tools/*.py` tìm `registry.register(` thay vì import eager → cache `cache/tool_discovery_cache.json`. `check_fn` cache TTL 30s.
- Handler trả JSON string hoặc envelope multimodal `{"_multimodal": True, "content": [...], "text_summary": str}`. Lỗi tool cắt ở 2048 ký tự.
- Toolsets (`toolsets.py`, ~28 nhóm): `browser`, `code_execution`, `delegation`, `file`, `memory`, `skills`, `terminal`, `todo`, `web`... Core tools luôn bật.
- Pipeline 1 round (`agent/turn_tool_round.py`): validate → dedupe → **persist assistant tool-call vào SQLite trước khi execute** → execute → `compress_after_tool_results`. Crash giữa chừng vẫn recover được.
- Dispatch (`agent/tool_executor.py`): `pre_tool_call` hook → guardrails → approval (`tools/approval.py`, phát hiện lệnh nguy hiểm, YOLO mode) → handler → `post_tool_call`.
- Song song: `ThreadPoolExecutor(8)`, kết quả reinsert đúng thứ tự. `_NEVER_PARALLEL_TOOLS` (vd `clarify`). Batch deadline 420s. `_ConcurrentToolAuthorizationGate` serialize prompt approval để user không bị 8 popup cùng lúc.
- Output lớn spill ra disk (`tools/tool_result_storage.py`), để lại pointer trong context.
- MCP (`tools/mcp_tool.py`): stdio/HTTP/OAuth, tool đặt tên `mcp_<server>_<tool>`, lazy start, refresh khi `tools/list_changed`, strip TAG chars trong description chống prompt injection.

## 3. Context engineering

System prompt 3 tầng xếp theo **độ biến động** để tối đa prefix-cache (`agent/prompt_builder.py`, `agent/system_prompt.py`):

1. **Stable**: identity (`SOUL.md`), tool guidance, `<available_skills>` index.
2. **Context**: operator `system_message`, project file first-match (`.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`), git snapshot, platform hints.
3. **Volatile**: snapshot `MEMORY.md`/`USER.md`, timestamp, cwd.

- Prompt **đóng băng byte-stable suốt conversation**, persist trong session DB. Thứ gì cần thay đổi giữa chừng thì đi qua user message/tool result (skill slash command, subdirectory `AGENTS.md` hints cap 32k chars).
- Memory nhỏ có chủ đích: `MEMORY.md` 2.200 chars, `USER.md` 1.375 chars, sửa qua tool `memory` (add/patch/remove). Vì prompt đóng băng nên memory mới chỉ thấy ở session sau. Long-range recall = `session_search` (FTS5 trên `state.db`).
- Skills: chỉ index trong prompt; `skill_view(name)` load on demand. Sau compaction skill đã load thay bằng `[SKILL_PRUNED: ...]`.
- Compression (`agent/context_compressor.py`, ABC `context_engine.py`): trigger 50% window. 4 pha:
  1. Prune tool result cũ >200 chars → `[Old tool output cleared]`.
  2. Chọn biên: `protect_first_n=3`, `protect_last_n=20`, align lùi để không cắt đôi cặp tool-call/result.
  3. Summarize phần giữa bằng model phụ theo schema cố định (Goal / Constraints / Progress / Key Decisions / Relevant Files / Next Steps / Critical Context), budget 20% content tokens, clamp 2k–12k.
  4. Reassemble tại chỗ.
- `agent/usage_anchor.py` re-anchor ước lượng token từ usage thật của provider. `agent/prompt_caching.py` strategy `system_and_3` cho Anthropic.

## 4. Multi-agent

- `tools/delegate_tool.py::delegate_task`: `tasks[{goal, context, output_schema, images, group}]`, `action ∈ {spawn, list, steer, stop}`.
- Child = agent hoàn toàn mới: `skip_context_files=True, skip_memory=True, clarify_callback=None, platform="subagent"`. **Không biết gì về parent** ngoài `_build_child_system_prompt(goal, context, workspace, role)`.
- Role theo depth: `leaf` mất `delegate_task`, `clarify`, `memory`, `send_message`, `cronjob`; `orchestrator` (`max_spawn_depth=2`) được delegate tiếp. `max_concurrent_children=3`.
- Return path: interactive → trả delegation id ngay, child chạy nền, kết quả vào parent qua async queue như message mới giữa các turn. Chỉ `_build_result_entry` (status, exit_reason, summary, schema_valid) qua biên — **không bao giờ là transcript**.
- Heartbeat 30s, stale detection, interrupt fan-out qua `_active_children`.

## 5. Đánh giá

**Mạnh**: cache discipline là kiến trúc (prompt đóng băng, tier theo volatility); persist-before-execute; context engine / memory provider / delegation provider đều pluggable qua ABC; hardening tốt (fallback provider, wrap-up notice, gate approval).

**Yếu**: file khổng lồ, 60 tham số constructor; thread thay vì async, state global (`_last_resolved_tool_names`) phải save/restore thủ công; gửi toàn bộ tool definition mỗi call; memory đóng băng trong session; docs lệch code.

**Rút ra cho Hahaness**: tier prompt theo volatility; persist-before-execute; schema summary cố định; subagent chỉ trả result entry; wrap-up notice ở 80% budget.
