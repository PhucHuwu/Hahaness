import { useEffect, useState } from "react"
import { api, type SkillMeta } from "../api.ts"
import { Editor } from "../components/Editor.tsx"

export function Skills() {
  const [skills, setSkills] = useState<SkillMeta[]>()
  const [sel, setSel] = useState<string>()
  const [draft, setDraft] = useState<{ id: string; content: string }>()
  const [error, setError] = useState<string>()

  const load = async () => {
    try {
      const s = await api.get<SkillMeta[]>("/api/skills")
      setSkills(s)
      setError(undefined)
      if (sel && !s.some((x) => x.id === sel)) setSel(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])

  const create = async () => {
    const id = prompt("Tên kỹ năng (slug, ví dụ: weekly-report)")?.trim()
    if (!id) return
    const r = await api.get<{ content: string }>(`/api/skills-template/${encodeURIComponent(id)}`)
    setDraft({ id, content: r.content })
    setSel(undefined)
  }

  return (
    <div className="page">
      <header>
        <h1>Kỹ năng</h1>
        <p>Quy trình viết sẵn. Chỉ tên + mô tả nằm trong system prompt; nhân viên tải nội dung đầy đủ bằng tool <code>skill</code> khi việc khớp.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="split" style={{ height: "calc(100% - 70px)" }}>
        <div className="stack" style={{ overflow: "auto" }}>
          <div className="row between">
            <h3>skills/</h3>
            <button className="btn small" onClick={create}>
              Thêm
            </button>
          </div>
          <div className="list">
            {skills?.length === 0 && !draft && <div className="empty small">Chưa có kỹ năng nào. Mỗi kỹ năng là một thư mục skills/&lt;id&gt;/SKILL.md.</div>}
            {draft && (
              <button className={!sel ? "active" : undefined} onClick={() => setSel(undefined)}>
                <div className="title mono">{draft.id}</div>
                <div className="sub">chưa lưu</div>
              </button>
            )}
            {skills?.map((s) => (
              <button key={s.id} className={sel === s.id ? "active" : undefined} onClick={() => setSel(s.id)}>
                <div className="title">{s.name}</div>
                <div className="sub">{s.description || s.id}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {sel ? (
            <SkillEditor key={sel} id={sel} onChanged={load} />
          ) : draft ? (
            <Editor
              key={draft.id}
              title={`skills/${draft.id}/SKILL.md`}
              hint="Frontmatter name + description; description là câu quyết định khi nào nhân viên dùng kỹ năng này."
              initial={draft.content}
              onSave={async (text) => {
                const r = await api.put<{ id: string }>(`/api/skills/${encodeURIComponent(draft.id)}`, { content: text })
                setDraft(undefined)
                await load()
                setSel(r.id)
              }}
            />
          ) : (
            <div className="empty">Chọn một kỹ năng để xem hoặc sửa.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function SkillEditor({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [content, setContent] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    api
      .get<{ content: string }>(`/api/skills/${encodeURIComponent(id)}`)
      .then((r) => setContent(r.content))
      .catch((e) => setError((e as Error).message))
  }, [id])
  if (error) return <div className="notice err">{error}</div>
  if (content === undefined) return <div className="empty">Đang tải…</div>
  return (
    <Editor
      title={`skills/${id}/SKILL.md`}
      hint="Frontmatter name + description; description là câu quyết định khi nào nhân viên dùng kỹ năng này."
      initial={content}
      onSave={async (text) => {
        await api.put(`/api/skills/${encodeURIComponent(id)}`, { content: text })
        onChanged()
      }}
      onDelete={async () => {
        if (!confirm(`Xóa kỹ năng ${id}?`)) return
        await api.delete(`/api/skills/${encodeURIComponent(id)}`)
        onChanged()
      }}
    />
  )
}
