import { useEffect, useState } from "react"
import { api, type KnowledgeNode, type KnowledgeView, type Staff } from "../api.ts"
import { Editor } from "../components/Editor.tsx"

const CORE: Record<string, string> = {
  "COMPANY.md": "Công ty làm gì, sản phẩm, khách hàng, giọng văn. Mọi vai đều đọc.",
  "USER.md": "Bạn là ai, muốn được báo cáo thế nào. Chỉ CTO đọc.",
  "MEMORY.md": "CTO tự ghi nhớ qua các phiên. Bạn có thể sửa hoặc xóa bớt.",
}

const WHO: Record<string, string> = { ceo: "bạn", cto: "CTO" }

function updated(d?: { size: number; updatedAt: number; author: string | null }) {
  if (!d || d.size === 0) return "Trống"
  const by = d.author ? ` · ${WHO[d.author] ?? d.author}` : ""
  return `${d.size} ký tự · ${new Date(d.updatedAt).toLocaleDateString()}${by}`
}

type Selection = { kind: "core" | "knowledge"; path: string } | { kind: "staff"; id: string }

export function Knowledge() {
  const [view, setView] = useState<KnowledgeView>()
  const [staff, setStaff] = useState<Staff[]>([])
  const [sel, setSel] = useState<Selection>({ kind: "core", path: "COMPANY.md" })
  const [error, setError] = useState<string>()

  const load = async () => {
    try {
      const [v, s] = await Promise.all([api.get<KnowledgeView>("/api/knowledge"), api.get<Staff[]>("/api/staff")])
      setView(v)
      setStaff(s)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])

  /** Tạo node mới: dưới `parent` (id node) hoặc một bộ mới khi không có parent. */
  const newNode = (parent?: string) => {
    const name = prompt(parent ? `Tên phần mới trong ${parent.replace(/^knowledge\//, "")} (ví dụ: giong-van)` : "Tên bộ tri thức mới (ví dụ: thuong-hieu)")
      ?.trim()
      .replace(/\.md$/i, "")
      .replace(/^knowledge\//, "")
      .replace(/\s+/g, "-")
    if (!name) return
    setSel({ kind: "knowledge", path: `${parent ?? "knowledge"}/${name}.md` })
  }
  const newStaff = () => setSel({ kind: "staff", id: "" })

  const active = (s: Selection) => JSON.stringify(s) === JSON.stringify(sel)

  return (
    <div className="page">
      <header>
        <h1>Tri thức</h1>
        <p>Những gì công ty biết: mô tả công ty, về bạn, tài liệu tham khảo, nhân viên. Bạn chỉ cần dặn CTO trong Chat ("ghi nhớ bảng giá này", "tuyển thêm người viết"); trang này để xem và sửa khi cần.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="split" style={{ height: "calc(100% - 70px)" }}>
        <div className="stack" style={{ overflow: "auto" }}>
          <section>
            <h3>Cốt lõi</h3>
            <div className="list">
              {Object.keys(CORE).map((p) => (
                <button key={p} className={active({ kind: "core", path: p }) ? "active" : undefined} onClick={() => setSel({ kind: "core", path: p })}>
                  <div className="title mono">{p}</div>
                  <div className="sub">{updated(view?.core.find((c) => c.path === p))}</div>
                </button>
              ))}
            </div>
          </section>
          <section>
            <div className="row between">
              <h3>Bộ tri thức</h3>
              <button className="btn small" onClick={() => newNode()}>
                Thêm bộ
              </button>
            </div>
            <div className="list">
              {view?.tree.length === 0 && <div className="empty small">Chưa có. Gửi tài liệu cho CTO trong Chat, hoặc bấm Thêm bộ.</div>}
              {view?.tree.map((n) => <TreeNode key={n.id} node={n} depth={0} selected={sel.kind === "knowledge" ? sel.path : undefined} onSelect={(path) => setSel({ kind: "knowledge", path })} onAdd={newNode} />)}
            </div>
          </section>
          <section>
            <div className="row between">
              <h3>Nhân viên</h3>
              <button className="btn small" onClick={newStaff}>
                Tuyển
              </button>
            </div>
            <div className="list">
              {staff.map((s) => (
                <button key={s.id} className={active({ kind: "staff", id: s.id }) ? "active" : undefined} onClick={() => setSel({ kind: "staff", id: s.id })}>
                  <div className="title">
                    {s.name} {s.mode === "primary" && <span className="badge">CTO</span>}
                  </div>
                  <div className="sub">{s.description}</div>
                </button>
              ))}
            </div>
          </section>
        </div>
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {sel.kind === "core" && <FileEditor key={sel.path} path={sel.path} hint={CORE[sel.path]} onSaved={load} />}
          {sel.kind === "knowledge" && (
            <FileEditor
              key={sel.path}
              path={sel.path}
              hint={NODE_HINT}
              subtree={view && countBelow(findNode(view.tree, sel.path.replace(/\.md$/i, "")))}
              deletable
              onSaved={load}
              onDeleted={() => (setSel({ kind: "core", path: "COMPANY.md" }), load())}
            />
          )}
          {sel.kind === "staff" && <StaffEditor key={sel.id} id={sel.id} staff={staff} onChanged={(id) => (load(), id && setSel({ kind: "staff", id }))} />}
        </div>
      </div>
    </div>
  )
}

const NODE_HINT =
  "Dòng đầu \"# Tiêu đề\" và dòng tóm tắt \"> …\" ngay sau nó hiện trong mục lục mà mọi nhân viên thấy; họ dựa vào đó để chọn đúng phần cần đọc. Thay đổi áp dụng từ cuộc trò chuyện mới."

function findNode(nodes: KnowledgeNode[], id: string): KnowledgeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n
    if (id.startsWith(n.id + "/")) return findNode(n.children, id)
  }
  return undefined
}

function countBelow(n?: KnowledgeNode): number {
  return n ? n.children.reduce((s, c) => s + 1 + countBelow(c), 0) : 0
}

function TreeNode({ node, depth, selected, onSelect, onAdd }: { node: KnowledgeNode; depth: number; selected?: string; onSelect: (path: string) => void; onAdd: (parent: string) => void }) {
  const [open, setOpen] = useState(depth === 0 ? false : true)
  const path = node.doc ?? `${node.id}.md`
  const hasChildren = node.children.length > 0
  return (
    <>
      <div className="row tree-row" style={{ paddingLeft: depth * 14 }}>
        <button className="tree-toggle" onClick={() => setOpen(!open)} disabled={!hasChildren} aria-label={open ? "Thu gọn" : "Mở rộng"}>
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        <button className={`grow${selected === path ? " active" : ""}`} onClick={() => onSelect(path)}>
          <div className="title">
            {node.title}
            {!node.doc && <span className="muted small"> (nhóm)</span>}
          </div>
          <div className="sub">{node.summary || (hasChildren ? `${countBelow(node)} phần` : updated({ size: node.size, updatedAt: node.updatedAt, author: node.author ?? null }))}</div>
        </button>
        <button className="tree-add" title="Thêm phần con" onClick={() => onAdd(node.id)}>
          +
        </button>
      </div>
      {open && node.children.map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} onAdd={onAdd} />)}
    </>
  )
}

function FileEditor({ path, hint, subtree = 0, deletable, onSaved, onDeleted }: { path: string; hint?: string; subtree?: number; deletable?: boolean; onSaved: () => void; onDeleted?: () => void }) {
  const [content, setContent] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api
      .get<{ content: string }>(`/api/knowledge/file?path=${encodeURIComponent(path)}`)
      .then((r) => setContent(r.content))
      .catch((e) => setError((e as Error).message))
  }, [path])
  const save = async (text: string) => {
    await api.put("/api/knowledge/file", { path, content: text })
    onSaved()
  }
  const remove = async () => {
    if (subtree > 0) {
      if (!confirm(`Xóa ${path.replace(/\.md$/, "")} cùng ${subtree} phần con bên trong?`)) return
      await api.delete(`/api/knowledge/node?path=${encodeURIComponent(path)}`)
    } else {
      if (!confirm(`Xóa ${path}?`)) return
      await api.delete(`/api/knowledge/file?path=${encodeURIComponent(path)}`)
    }
    onDeleted?.()
  }
  if (error) return <div className="notice err">{error}</div>
  if (content === undefined) return <div className="empty">Đang tải…</div>
  const initial = content || (path.startsWith("knowledge/") ? `# \n\n> \n` : "")
  return <Editor title={path.replace(/\.md$/, "")} hint={hint} initial={initial} onSave={save} onDelete={deletable ? remove : undefined} />
}

const CAPS = ["read", "write", "webfetch", "websearch", "bash"] as const

function StaffEditor({ id, staff, onChanged }: { id: string; staff: Staff[]; onChanged: (id?: string) => void }) {
  const def = staff.find((s) => s.id === id)
  const [markdown, setMarkdown] = useState<string>()
  const [error, setError] = useState<string>()
  const [form, setForm] = useState({ id: "", name: "", description: "", system: "", capabilities: ["read"] as string[] })

  useEffect(() => {
    if (!id) return
    api
      .get<{ markdown: string }>(`/api/staff/${id}/markdown`)
      .then((r) => setMarkdown(r.markdown))
      .catch((e) => setError((e as Error).message))
  }, [id])

  if (!id) {
    const submit = async () => {
      setError(undefined)
      try {
        const r = await api.post<{ id: string }>("/api/staff", form)
        onChanged(r.id)
      } catch (e) {
        setError((e as Error).message)
      }
    }
    return (
      <div className="stack">
        <h2>Tuyển nhân viên</h2>
        <p className="small muted">Giống như CTO gọi tool `hire`: chọn năng lực, viết mô tả công việc. Thường bạn chỉ cần bảo CTO tuyển người.</p>
        {error && <div className="notice err">{error}</div>}
        <div className="row">
          <label className="field grow">
            id (slug)
            <input type="text" className="mono" value={form.id} placeholder="seo-specialist" onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </label>
          <label className="field grow">
            Tên
            <input type="text" value={form.name} placeholder="SEO Specialist" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Mô tả một dòng (CTO đọc dòng này khi chọn người)
          <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        <div className="row wrap">
          <span className="small muted">Năng lực:</span>
          {CAPS.map((c) => (
            <label key={c} className="check small">
              <input type="checkbox" checked={form.capabilities.includes(c)} onChange={(e) => setForm({ ...form, capabilities: e.target.checked ? [...form.capabilities, c] : form.capabilities.filter((x) => x !== c) })} />
              {c}
            </label>
          ))}
          <span className="small muted">(write chỉ được ghi vào drafts/; bash = chạy lệnh/code để tính toán, xử lý file)</span>
        </div>
        <label className="field grow">
          Mô tả công việc (system prompt)
          <textarea className="editor" style={{ minHeight: 200 }} value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={submit} disabled={!form.id.trim() || !form.name.trim() || !form.system.trim()}>
            Tuyển
          </button>
        </div>
      </div>
    )
  }

  if (!def) return <div className="notice err">Không tìm thấy nhân viên {id}.</div>
  if (error) return <div className="notice err">{error}</div>
  if (markdown === undefined) return <div className="empty">Đang tải…</div>
  const builtin = def.mode === "primary"
  const save = async (text: string) => {
    await api.put(`/api/staff/${id}`, { markdown: text })
    onChanged(id)
  }
  const fire = async () => {
    if (!confirm(`Cho ${def.name} nghỉ việc? CTO sẽ không giao việc cho vai này nữa.`)) return
    await api.delete(`/api/staff/${id}`)
    onChanged()
  }
  return (
    <Editor
      title={`${def.name} (${id})`}
      hint={builtin ? "Vai CTO là vai có sẵn, không sửa được từ đây." : "Frontmatter: mode, steps, context, permissions. Phần thân là mô tả công việc. Lưu sẽ ghi đè định nghĩa vai này (kể cả vai có sẵn — bản sửa thắng)."}
      initial={markdown}
      readOnly={builtin}
      onSave={save}
      onDelete={builtin ? undefined : fire}
      deleteLabel="Cho nghỉ việc"
    />
  )
}
