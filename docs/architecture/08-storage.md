# 08 — Storage: một file SQLite

## Vì sao

Người dùng là CEO no-code: họ **không tự làm gì**, chỉ ra lệnh cho CTO. Workspace dạng thư mục (COMPANY.md, `staff/`, `skills/`, `.hahaness/*.jsonl`, `hahaness.json`) buộc họ biết file nằm đâu, và đồng bộ/backup thì rời rạc. Từ bản này **toàn bộ công ty là một file** `.db`:

- Mặc định `<cwd>/.hahaness/hahaness.db`; đổi bằng env `HAHANESS_DB` hoặc option `dbPath` (`:memory:` cho test).
- Backup/di chuyển = copy một file. Không có thư mục nào CEO cần mở.
- CTO quản lý mọi thứ bằng tool (xem dưới); UI chủ yếu để **xem**, vẫn sửa được khi cần.

## Engine

`node:sqlite` (`DatabaseSync`, có sẵn trong Node 22) — không thêm dependency.

- Node 22 in `ExperimentalWarning` khi load; `src/core/db.ts` lọc **đúng warning đó** trong lúc `createRequire("node:sqlite")`, rồi trả lại `process.emitWarning` gốc.
- API đồng bộ: hợp với workload nhỏ (một công ty, vài nghìn tài liệu). `SessionStore`/`SkillStore` giữ chữ ký `async` để không đổi caller.
- Bản build hiện tại **không có FTS5** → `DocumentStore.search` lọc trong JS bằng `toLocaleLowerCase` (đúng với tiếng Việt; `LIKE`/`lower()` của SQLite chỉ xử lý ASCII).
- Version schema bằng `PRAGMA user_version`; `Db.fresh` = file vừa tạo.

## Schema (v1)

| Bảng | Cột chính | Thay cho |
|---|---|---|
| `sessions` | id, parent_id, agent, model, title, created_at | dòng đầu `.jsonl` |
| `events` | seq (autoinc), session_id, kind, data (JSON `StoreEvent`) | `.hahaness/sessions/<id>.jsonl` — vẫn append-only, đọc lại bằng `fold` |
| `documents` | path (PK), content, created_at, updated_at, author | COMPANY/USER/MEMORY.md, `knowledge/`, `drafts/`, `deliverables/`, `.hahaness/tool-output/` |
| `staff` | id, markdown, fired, updated_at | `staff/<id>.md` |
| `skills` | id, content (markdown + frontmatter), updated_at | `skills/<id>/SKILL.md` |
| `settings` | key, value (JSON) | `hahaness.json` (key `config`) |
| `mcp_servers` | id, config (JSON) | `.hahaness/mcp.json` |

### Documents giữ dạng path

Tài liệu khóa bằng path ảo (`knowledge/pricing.md`, `drafts/post.md`). Lý do: permission theo prefix (`write drafts/*` cho nhân viên) và thói quen của model (`read`, `list`, `write`) không đổi. `normalizePath` đổi `\` → `/`, bỏ `.`, **từ chối `..`**. `tool-output/` bị ẩn khỏi `list` gốc nhưng `read` được (footer của output bị cắt trỏ tới nó). `author` ghi ai sửa cuối (`ceo` từ UI, id vai từ tool).

### Staff overlay

Vai builtin vẫn là file trong `src/agent/builtin/*.md` (là code, không phải dữ liệu). `AgentRegistry.useDb(db)` phủ lên: dòng `staff` đè vai cùng id, `fired = 1` xóa vai. Vai `primary` (CTO) không bao giờ bị đè/đuổi.

### Config

`settings.config` thắng; `~/.hahaness/config.json` là nền cấp máy (providers merge theo id). API key không bao giờ trả ra UI (`••••`; gửi lại `••••` = giữ key cũ).

## Nhập từ bố cục cũ

Khi `Db.fresh` (lần đầu tạo file, không áp dụng `:memory:`), `importLegacy(cwd)` nhập một lần: COMPANY/USER/MEMORY.md, `knowledge|drafts|deliverables/**` (.md/.txt/.csv/.json/.html), `staff/*.md`, `skills/*/SKILL.md`, `.hahaness/mcp.json`, `.hahaness/sessions/*.jsonl`. `hahaness.json`/`.hahaness/config.json` nhập qua `loadConfig` khi chưa có setting. **Không xóa file gốc.** Sau đó DB là nguồn sự thật duy nhất.

## CTO quản lý công ty bằng tool

| Tool | Action | Tác dụng |
|---|---|---|
| `knowledge` | list, save, append, delete, company, ceo | thư viện `knowledge/*`, COMPANY.md, USER.md |
| `manage_skill` | list, show, save, delete | kỹ năng (description = khi nào dùng; instructions = quy trình) |
| `staff` | show, edit, fire | sửa job description/capabilities, cho nghỉ; không sửa/đuổi CTO |
| `mcp_manage` | list, add, enable, disable, reconnect, remove | kết nối công cụ ngoài; **`add` là `ask`** trong ruleset CTO → CEO duyệt trên UI (stdio chạy lệnh trên máy) |
| `memory` | list, add, replace, remove | sự thật ngắn (≤ 4k ký tự) |
| `hire` | — | tuyển vai mới |
| `search` | — | tìm trong tài liệu (mọi vai có `read`) |

`MANAGEMENT_ACTIONS` (delegate, hire, memory, question, knowledge, manage_skill, staff, mcp_manage) luôn bị deny cho nhân viên: `Harness.spawn` deny tất cả trừ `delegate` (deny thêm cho vai leaf), và `capabilityRules` của vai được tuyển cũng deny. Test: "employees never get management tools".

Thay đổi có hiệu lực ở **phiên mới** (system prompt đóng băng per-session, xem `03`); tool trả câu nhắc này cho model.

## Kết quả cho CEO

`deliverables/*` (CTO nộp) và `drafts/*` (nhân viên) hiển thị ở trang **Kết quả**: xem, chép, tải `.md` (`/api/results/download`, `content-disposition` có `filename*` UTF-8), xóa. `.docx`/`.pdf` để sau (roadmap).
