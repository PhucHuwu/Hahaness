import { test } from "node:test"
import assert from "node:assert/strict"
import { Db } from "../core/db.ts"
import { DocumentStore } from "./documents.ts"
import { knowledgeIndex, knowledgeTree, normalizeNodeID, readNode, summaryOf } from "./knowledge.ts"
import * as workspace from "./workspace.ts"
import { knowledgeTool } from "../tool/builtin/manage.ts"
import { documentTools } from "../tool/builtin/fs.ts"
import type { Tool, ToolContext } from "../tool/define.ts"

const ctx = { agent: "cto" } as ToolContext
const run = (tool: Tool, input: unknown) => tool.execute(tool.schema.parse(input), ctx)

function setup() {
  const db = new Db(":memory:")
  const docs = new DocumentStore(db)
  return { db, docs, kn: knowledgeTool(docs), read: documentTools(docs).find((t) => t.name === "read")! }
}

test("knowledge tree: node ids, summaries, group nodes, legacy flat docs are one-node sets", () => {
  const { db, docs } = setup()
  try {
    assert.equal(normalizeNodeID("brand/voice"), "knowledge/brand/voice")
    assert.equal(normalizeNodeID("knowledge/brand/voice.md"), "knowledge/brand/voice")
    assert.equal(normalizeNodeID("Thương hiệu/Giọng văn"), "knowledge/Thương-hiệu/Giọng-văn")
    assert.throws(() => normalizeNodeID("knowledge"))
    assert.throws(() => normalizeNodeID("../x"))
    assert.equal(summaryOf("# T\n\n> What this covers\n\nBody"), "What this covers")
    assert.equal(summaryOf("# T\n## Section\nx"), "")

    docs.put("knowledge/pricing.md", "# Bảng giá\nGói A: 1 triệu")
    docs.put("knowledge/brand.md", "# Thương hiệu\n> Tất cả về thương hiệu")
    docs.put("knowledge/brand/voice.md", "# Giọng văn\n> Cách viết\nThân thiện.")
    docs.put("knowledge/products/tea/menu.md", "# Menu trà\n> Giá từng món")
    const forest = knowledgeTree(docs)
    assert.deepEqual(forest.map((n) => n.id), ["knowledge/brand", "knowledge/pricing", "knowledge/products"])
    const products = forest[2]!
    assert.equal(products.doc, undefined, "folder without its own document is a group node")
    assert.equal(products.title, "products")
    assert.equal(products.children[0]!.children[0]!.id, "knowledge/products/tea/menu")

    const index = knowledgeIndex(forest)!
    assert.match(index, /- knowledge\/brand — Thương hiệu: Tất cả về thương hiệu \(\d+ chars, 1 sub-node\)/)
    assert.match(index, /\n  - knowledge\/brand\/voice — Giọng văn: Cách viết/)
    assert.match(index, /- knowledge\/pricing — Bảng giá: Gói A: 1 triệu/)
    assert.match(index, /\n  - knowledge\/products\/tea — tea \(group only, 1 sub-node\)/)
    assert.doesNotMatch(index, /menu/, "index stops at the first level below each set")
    assert.ok(workspace.sources(docs, { includePersonal: false }).some((s) => s.id === "workspace/knowledge" && s.content === index))
  } finally {
    db.close()
  }
})

test("read: a knowledge node returns its content plus sub-nodes; plain paths still work", async () => {
  const { db, docs, read } = setup()
  try {
    docs.put("knowledge/brand.md", "# Thương hiệu\n> Tổng quan")
    docs.put("knowledge/brand/voice.md", "# Giọng văn\n> Cách viết\nThân thiện, không dùng từ lóng.")
    docs.put("knowledge/brand/voice/examples.md", "# Ví dụ\nXin chào!")

    const set = (await run(read, { path: "knowledge/brand" })).output
    assert.match(set, /^# Thương hiệu/)
    assert.match(set, /Sub-nodes[\s\S]*- knowledge\/brand\/voice — Giọng văn: Cách viết \(\d+ chars, 1 sub-node\)/)
    assert.doesNotMatch(set, /Thân thiện/, "children's content is not inlined")

    const node = (await run(read, { path: "knowledge/brand/voice.md" })).output
    assert.match(node, /\[knowledge\/brand › knowledge\/brand\/voice\]/)
    assert.match(node, /Thân thiện/)
    assert.match(node, /knowledge\/brand\/voice\/examples — Ví dụ/)

    assert.match((await run(read, { path: "knowledge" })).output, /Knowledge sets:\n- knowledge\/brand/)
    const missing = await run(read, { path: "knowledge/brand/logo" })
    assert.ok(missing.isError)
    assert.match(missing.output, /Sub-nodes of knowledge\/brand: knowledge\/brand\/voice/)

    const paged = (await run(read, { path: "knowledge/brand/voice.md", offset: 3, limit: 1 })).output
    assert.equal(paged, "Thân thiện, không dùng từ lóng.")
    docs.put("COMPANY.md", "# Acme")
    assert.equal((await run(read, { path: "COMPANY.md" })).output, "# Acme")
  } finally {
    db.close()
  }
})

test("knowledge tool: save/append/outline/move/delete work on nodes", async () => {
  const { db, docs, kn } = setup()
  try {
    const saved = await run(kn, { action: "save", path: "brand", title: "Thương hiệu", summary: "Tất cả về thương hiệu", content: "Tổng quan." })
    assert.match(saved.output, /Saved knowledge\/brand\.md/)
    assert.equal(docs.read("knowledge/brand.md"), "# Thương hiệu\n\n> Tất cả về thương hiệu\n\nTổng quan.\n")
    assert.equal(docs.get("knowledge/brand.md")?.author, "cto")
    await run(kn, { action: "save", path: "knowledge/brand/voice", title: "Giọng văn", summary: "Cách viết", content: "Thân thiện." })
    await run(kn, { action: "save", path: "brand/voice/examples", content: "# Ví dụ\nXin chào" })
    assert.ok((await run(kn, { action: "save", path: "x", content: "no title" })).isError)

    await run(kn, { action: "append", path: "brand/voice", content: "Không dùng từ lóng." })
    assert.match(docs.read("knowledge/brand/voice.md")!, /Thân thiện\.\n\nKhông dùng từ lóng\./)
    assert.ok((await run(kn, { action: "append", path: "brand/logo", content: "x" })).isError)

    const tree = (await run(kn, { action: "outline" })).output
    assert.match(tree, /- knowledge\/brand — Thương hiệu[\s\S]*\n  - knowledge\/brand\/voice[\s\S]*\n    - knowledge\/brand\/voice\/examples — Ví dụ: Xin chào/)

    assert.ok((await run(kn, { action: "move", path: "brand", to: "brand/inner" })).isError, "cannot move into itself")
    const moved = await run(kn, { action: "move", path: "brand/voice", to: "style" })
    assert.match(moved.output, /Moved knowledge\/brand\/voice → knowledge\/style \(2 documents\)/)
    assert.deepEqual(docs.list("knowledge").map((d) => d.path), ["knowledge/brand.md", "knowledge/style.md", "knowledge/style/examples.md"])

    const refuse = await run(kn, { action: "delete", path: "style" })
    assert.ok(refuse.isError)
    assert.match(refuse.output, /recursive: true/)
    await run(kn, { action: "delete", path: "style", recursive: true })
    assert.deepEqual(docs.list("knowledge").map((d) => d.path), ["knowledge/brand.md"])
    assert.equal(readNode(docs, "drafts/x.md"), undefined)
  } finally {
    db.close()
  }
})
