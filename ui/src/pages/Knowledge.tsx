import { useEffect, useState } from "react"
import { api, type KnowledgeView, type Staff } from "../api.ts"
import { Editor } from "../components/Editor.tsx"

const CORE: Record<string, string> = {
  "COMPANY.md": "Công ty làm gì, sản phẩm, khách hàng, giọng văn. Mọi vai đều đọc.",
  "USER.md": "Bạn là ai, muốn được báo cáo thế nào. Chỉ CTO đọc.",
  "MEMORY.md": "CTO tự ghi nhớ qua các phiên. Bạn có thể sửa hoặc xóa bớt.",
}

type Selection = { kind: "core" | "knowledge" | "output"; path: string } | { kind: "staff"; id: string }

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

  const newKnowledge = () => {
    const name = prompt("Tên file (ví dụ: brand-voice.md)")?.trim()
    if (!name) return
    const path = `knowledge/${name.replace(/^knowledge\//, "")}`
    setSel({ kind: "knowledge", path })
  }
  const newStaff = () => setSel({ kind: "staff", id: "" })

  const active = (s: Selection) => JSON.stringify(s) === JSON.stringify(sel)

  return (
    <div className="page">
      <header>
        <h1>Tri thức</h1>
        <p>Những gì công ty biết: mô tả công ty, về bạn, tài liệu tham khảo, nhân viên.</p>
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
                  <div className="sub">{view?.core.find((c) => c.path === p)?.size ?? 0} ký tự</div>
                </button>
              ))}
            </div>
          </section>
          <section>
            <div className="row between">
              <h3>Tài liệu tham khảo</h3>
              <button className="btn small" onClick={newKnowledge}>
                Thêm
              </button>
            </div>
            <div className="list">
              {view?.files.length === 0 && <div className="empty small">Chưa có. Bỏ file .md/.txt/.csv vào thư mục knowledge/ hoặc bấm Thêm.</div>}
              {view?.files.map((f) => (
                <button key={f.path} className={active({ kind: "knowledge", path: f.path }) ? "active" : undefined} onClick={() => setSel({ kind: "knowledge", path: f.path })}>
                  <div className="title mono">{f.path.replace(/^knowledge\//, "")}</div>
                  <div className="sub">{f.title || `${f.size} ký tự`}</div>
                </button>
              ))}
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
          <section>
            <h3>Kết quả</h3>
            <div className="list">
              {view?.outputs.length === 0 && <div className="empty small">deliverables/ và drafts/ còn trống.</div>}
              {view?.outputs.map((f) => (
                <button key={f.path} className={active({ kind: "output", path: f.path }) ? "active" : undefined} onClick={() => setSel({ kind: "output", path: f.path })}>
                  <div className="title mono">{f.path}</div>
                  <div className="sub">{new Date(f.mtime).toLocaleString()}</div>
                </button>
              ))}
            </div>
          </section>
        </div>
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {sel.kind === "core" && <FileEditor key={sel.path} path={sel.path} hint={CORE[sel.path]} onSaved={load} />}
          {sel.kind === "knowledge" && <FileEditor key={sel.path} path={sel.path} deletable onSaved={load} onDeleted={() => (setSel({ kind: "core", path: "COMPANY.md" }), load())} />}
          {sel.kind === "output" && <OutputViewer key={sel.path} path={sel.path} />}
          {sel.kind === "staff" && <StaffEditor key={sel.id} id={sel.id} staff={staff} onChanged={(id) => (load(), id && setSel({ kind: "staff", id }))} />}
        </div>
      </div>
    </div>
  )
}

function FileEditor({ path, hint, deletable, onSaved, onDeleted }: { path: string; hint?: string; deletable?: boolean; onSaved: () => void; onDeleted?: () => void }) {
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
    if (!confirm(`Xóa ${path}?`)) return
    await api.delete(`/api/knowledge/file?path=${encodeURIComponent(path)}`)
    onDeleted?.()
  }
  if (error) return <div className="notice err">{error}</div>
  if (content === undefined) return <div className="empty">Đang tải…</div>
  return (
    <Editor title={path} hint={hint ?? "Nhân viên đọc file này bằng tool `read` khi cần; tên file + dòng đầu được liệt kê trong system prompt."} initial={content} onSave={save} onDelete={deletable ? remove : undefined} />
  )
}

function OutputViewer({ path }: { path: string }) {
  const [content, setContent] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api
      .get<{ content: string }>(`/api/outputs/file?path=${encodeURIComponent(path)}`)
      .then((r) => setContent(r.content))
      .catch((e) => setError((e as Error).message))
  }, [path])
  if (error) return <div className="notice err">{error}</div>
  if (content === undefined) return <div className="empty">Đang tải…</div>
  return (
    <div className="stack" style={{ minHeight: 0 }}>
      <div className="row between">
        <h2 className="mono">{path}</h2>
        <span className="small muted">Chỉ đọc — CTO và nhân viên ghi file này.</span>
      </div>
      <pre style={{ overflow: "auto", flex: 1 }}>{content}</pre>
    </div>
  )
}

const CAPS = ["read", "write", "webfetch", "websearch"] as const

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
        <p className="small muted">Giống như CTO gọi tool `hire`: chọn năng lực, viết mô tả công việc. Vai mới được ghi vào staff/&lt;id&gt;.md.</p>
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
          <span className="small muted">(write chỉ được ghi vào drafts/)</span>
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
    if (!confirm(`Cho ${def.name} nghỉ việc? File staff/${id}.md sẽ bị xóa.`)) return
    await api.delete(`/api/staff/${id}`)
    onChanged()
  }
  return (
    <Editor
      title={`${def.name} (${id})`}
      hint={builtin ? "Vai CTO là vai có sẵn, không sửa được từ đây." : "Frontmatter: mode, steps, context, permissions. Phần thân là mô tả công việc. Lưu sẽ ghi đè staff/<id>.md (kể cả vai có sẵn — bản ghi đè thắng)."}
      initial={markdown}
      readOnly={builtin}
      onSave={save}
      onDelete={builtin ? undefined : fire}
      deleteLabel="Cho nghỉ việc"
    />
  )
}
