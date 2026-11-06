# 10 — Kho tri thức dạng cây

## Vấn đề

Bản trước để `knowledge/` thành danh sách phẳng: index trong system prompt chỉ có path và dòng tiêu đề của từng tài liệu. Agent không biết trong một tài liệu có những phần gì, nên muốn tìm một ý nhỏ thì phải `read` cả tài liệu dài hoặc đoán bằng `search`. Thêm tài liệu thì index cứ dài ra, và cũng không có cách nhóm theo chủ đề.

## Mô hình

**Mỗi bộ tri thức là một cây.** Agent thấy mục lục của các bộ, rồi đi thẳng tới node mình cần.

```
knowledge/brand.md                 ← gốc của bộ "brand": tổng quan
knowledge/brand/voice.md           ← node con
knowledge/brand/voice/examples.md  ← cháu
knowledge/brand/logo.md
knowledge/products/tea/menu.md     ← "products" và "products/tea" là node nhóm (không có .md riêng)
knowledge/pricing.md               ← tài liệu phẳng cũ = một bộ chỉ có gốc
```

- **Id của node** là path bỏ `.md`: `knowledge/brand/voice`. Nội dung node nằm ở `<id>.md`; các con nằm dưới `<id>/`.
- **Bộ tri thức** là mọi node con trực tiếp của `knowledge/`.
- **Node nhóm**: thư mục không có `.md` riêng. Tiêu đề lấy theo tên thư mục.
- Định dạng của một node:
  ```md
  # Tiêu đề
  > Một dòng: node này nói về gì
  Nội dung…
  ```
  Tóm tắt là đoạn đầu ngay sau tiêu đề (dấu `>` có thể bỏ). Nếu ngay sau tiêu đề là một heading thì node không có tóm tắt.

Mọi thứ vẫn là bản ghi trong bảng `documents`, nên **không đổi schema và không cần migrate**: tài liệu phẳng cũ tự thành bộ một node, và permission theo prefix (`read knowledge/*`) giữ nguyên.

Phương án đã cân nhắc rồi bỏ: **một tài liệu cho mỗi bộ, node là các heading**. Cách này gọn khi CEO dán một tài liệu dài, nhưng sửa một node thì phải ghi lại cả tài liệu (dễ đè lẫn nhau), id của node đổi khi đổi tên heading, và `author`/`updatedAt` không tách được theo node. Mỗi node một tài liệu thì giữ được cả ba.

## Agent thấy gì (`context/knowledge.ts`)

**Tier B `<knowledge>`** (mọi vai): mỗi bộ cùng các nhánh cấp 1, mỗi dòng gồm id, tiêu đề, tóm tắt, kích thước và số node con.

```
- knowledge/brand — Thương hiệu: Tất cả về thương hiệu (420 chars, 3 sub-nodes)
  - knowledge/brand/logo — Logo: Màu và cách đặt logo (300 chars)
  - knowledge/brand/voice — Giọng văn: Cách viết (900 chars, 1 sub-node)
- knowledge/pricing — Bảng giá: Gói A: 1 triệu (80 chars)
```

Index giới hạn ở 80 dòng. Nếu vượt, chỉ còn các dòng cấp bộ; nếu vẫn vượt thì cắt và nhắc dùng `read knowledge`. Hash và `<workspace-update>` vẫn như cũ (`03`): thêm hoặc sửa một node thì index đổi, và phiên đang chạy nhận diff.

**`read` có hiểu cây** (mọi vai có `read`, nhân viên vẫn chỉ đọc):

| Gọi | Trả về |
|---|---|
| `read knowledge` | danh sách các bộ |
| `read knowledge/brand` hoặc `…/brand.md` | breadcrumb + nội dung node + danh sách node con (id, tiêu đề, tóm tắt) |
| `read knowledge/products` (node nhóm) | tiêu đề + danh sách node con |
| `read knowledge/brand/xyz` (không có) | lỗi kèm danh sách con của node cha |
| `read …` có `offset`/`limit` | đọc tài liệu thô như trước (để phân trang) |

Nội dung của con không bao giờ được gộp vào: agent đi xuống từng nhánh mình cần. `list` và `search` vẫn chạy trên path như cũ.

## CTO quản lý (`knowledge` tool)

| Action | Tác dụng |
|---|---|
| `outline` | cả rừng, hoặc toàn bộ cây con của `path` |
| `save` | tạo/thay một node: `path`, `title`, `summary`, `content` (phần thân). Không có `title` thì `content` phải bắt đầu bằng `# …`. Cha chưa có thì thành node nhóm |
| `append` | nối vào cuối một node |
| `move` | đổi tên/chuyển node cùng cả cây con sang `to`. Từ chối khi chuyển vào chính nó hoặc khi đích đã có |
| `delete` | xóa node. Có con thì phải truyền `recursive: true` |
| `company`, `ceo` | như cũ (COMPANY.md, USER.md) |

`path` nhận `brand/voice`, `knowledge/brand/voice` hoặc `…voice.md`. Khoảng trắng đổi thành `-`; `..` bị từ chối.

Hướng dẫn trong mô tả tool và trong `cto.md`: một bộ cho mỗi chủ đề, một node cho mỗi ý mà người ta sẽ tra riêng, node nào cũng có tiêu đề và tóm tắt, và xem `outline` trước khi lưu để khỏi tạo bộ trùng. Khi giao việc, CTO chỉ cho nhân viên đúng các node path cần đọc. `DEFAULT_FOLLOW_UP` của scheduler (`09`) cũng lưu phát hiện mới vào đúng nhánh.

## UI và API

- `GET /api/knowledge` → `{ core, tree }`, trong đó `tree` là `KnowledgeNode[]` (id, title, summary, doc, size, updatedAt, author, children).
- `GET/PUT/DELETE /api/knowledge/file` không đổi: sửa từng tài liệu node.
- `DELETE /api/knowledge/node?path=…` xóa node cùng cây con.
- Trang Tri thức có mục "Bộ tri thức" hiển thị dạng cây thu gọn được, với nút "Thêm bộ" và nút `+` ở mỗi node để thêm phần con. Bấm vào một node nhóm rồi lưu thì node đó có nội dung riêng.

## Test

`src/context/knowledge.test.ts` (id/tóm tắt/node nhóm/index, `read` theo node, các action của tool) và `server.test.ts` "knowledge: …" (API cây, xóa node).
