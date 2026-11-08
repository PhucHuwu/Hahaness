# 10 — Tree-structured knowledge base

## Problem

The previous version kept `knowledge/` as a flat list: the index in the system prompt held only each document's path and title line. The agent could not see which sections a document contained, so to find a small point it had to `read` the whole long document or guess with `search`. Every new document made the index longer, and there was no way to group documents by topic.

## Model

**Each knowledge set is a tree.** The agent sees an outline of the sets, then goes straight to the node it needs.

```
knowledge/brand.md                 ← root of the "brand" set: overview
knowledge/brand/voice.md           ← child node
knowledge/brand/voice/examples.md  ← grandchild
knowledge/brand/logo.md
knowledge/products/tea/menu.md     ← "products" and "products/tea" are group nodes (no own .md)
knowledge/pricing.md               ← old flat document = a set with only a root
```

- **Node id** is the path without `.md`: `knowledge/brand/voice`. The node's content is in `<id>.md`; its children are under `<id>/`.
- **Knowledge sets** are all direct children of `knowledge/`.
- **Group node**: a directory without its own `.md`. Its title is taken from the directory name.
- Node format:
  ```md
  # Title
  > One line: what this node is about
  Content…
  ```
  The summary is the first paragraph right after the title (the `>` is optional). If a heading comes right after the title, the node has no summary.

Everything is still a record in the `documents` table, so there is **no schema change and no migration**: an old flat document becomes a one-node set, and prefix-based permissions (`read knowledge/*`) stay the same.

Option considered and rejected: **one document per set, with headings as nodes**. This is convenient when the CEO pastes one long document, but editing one node means rewriting the whole document (easy to overwrite each other's changes), node ids change when a heading is renamed, and `author`/`updatedAt` cannot be tracked per node. One document per node keeps all three.

## What the agent sees (`context/knowledge.ts`)

**Tier B `<knowledge>`** (all roles): each set with its level-1 branches. Each line has the id, title, summary, size and number of child nodes.

```
- knowledge/brand — Thương hiệu: Tất cả về thương hiệu (420 chars, 3 sub-nodes)
  - knowledge/brand/logo — Logo: Màu và cách đặt logo (300 chars)
  - knowledge/brand/voice — Giọng văn: Cách viết (900 chars, 1 sub-node)
- knowledge/pricing — Bảng giá: Gói A: 1 triệu (80 chars)
```

The index is capped at 80 lines. If it exceeds that, only the set-level lines remain; if it still exceeds, it is truncated with a hint to use `read knowledge`. Hashing and `<workspace-update>` are unchanged (`03`): adding or editing a node changes the index, and running sessions receive the diff.

**`read` understands the tree** (every role with `read`; employees remain read-only):

| Call | Returns |
|---|---|
| `read knowledge` | list of sets |
| `read knowledge/brand` or `…/brand.md` | breadcrumb + node content + list of child nodes (id, title, summary) |
| `read knowledge/products` (group node) | title + list of child nodes |
| `read knowledge/brand/xyz` (does not exist) | error with the parent node's child list |
| `read …` with `offset`/`limit` | reads the raw document as before (for paging) |

Child content is never merged in: the agent descends into each branch it needs. `list` and `search` still work on paths as before.

## CTO management (`knowledge` tool)

| Action | Effect |
|---|---|
| `outline` | the whole forest, or the full subtree of `path` |
| `save` | create/replace a node: `path`, `title`, `summary`, `content` (the body). Without `title`, `content` must start with `# …`. A missing parent becomes a group node |
| `append` | append to the end of a node |
| `move` | rename/move a node and its whole subtree to `to`. Refused when moving into itself or when the target already exists |
| `delete` | delete a node. If it has children, `recursive: true` is required |
| `company`, `ceo` | unchanged (COMPANY.md, USER.md) |

`path` accepts `brand/voice`, `knowledge/brand/voice` or `…voice.md`. Spaces become `-`; `..` is refused.

Guidance in the tool description and in `cto.md`: one set per topic, one node per idea that people will look up on its own, every node has a title and a summary, and check `outline` before saving to avoid duplicate sets. When assigning work, the CTO points employees to exactly the node paths they need to read. The scheduler's `DEFAULT_FOLLOW_UP` (`09`) also saves new findings into the right branch.

## UI and API

- `GET /api/knowledge` → `{ core, tree }`, where `tree` is `KnowledgeNode[]` (id, title, summary, doc, size, updatedAt, author, children).
- `GET/PUT/DELETE /api/knowledge/file` unchanged: edits individual node documents.
- `DELETE /api/knowledge/node?path=…` deletes a node and its subtree.
- The **Knowledge** (Tri thức) page has a "Knowledge sets" (Bộ tri thức) section shown as a collapsible tree, with an "Add set" (Thêm bộ) button and a `+` button on each node to add a child. Clicking a group node and saving gives that node its own content.

## Tests

`src/context/knowledge.test.ts` (id/summary/group nodes/index, per-node `read`, tool actions) and `server.test.ts` "knowledge: …" (tree API, node deletion).
