import { useEffect, useState } from "react"
import { api, type Doc, type DocView, type ResultsView } from "../api.ts"
import { useServerEvents } from "../events.ts"

const WHO: Record<string, string> = { ceo: "bạn", cto: "CTO" }

function meta(d: DocView) {
  const by = d.author ? `${WHO[d.author] ?? d.author} · ` : ""
  return `${by}${new Date(d.updatedAt).toLocaleString()}`
}

/** location.hash giữ ký tự tiếng Việt/khoảng trắng ở dạng %XX. */
function decode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function name(path: string) {
  return path.replace(/^(deliverables|drafts)\//, "")
}

/** Kết quả công việc: deliverables (CTO nộp cho CEO) và drafts (bản nháp nhân viên). */
export function Results({ path }: { path?: string }) {
  const [view, setView] = useState<ResultsView>()
  const [error, setError] = useState<string>()

  const load = async () => {
    try {
      setView(await api.get<ResultsView>("/api/results"))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])
  useServerEvents((ev) => {
    if (ev.type === "tool-end" && ev.name === "write" && !ev.isError) void load()
  })

  const selected = (path && decode(path)) || view?.deliverables[0]?.path
  const open = (p: string) => (location.hash = `results/${encodeURIComponent(p)}`)

  const section = (title: string, items: DocView[] | undefined, empty: string) => (
    <section>
      <h3>{title}</h3>
      <div className="list">
        {items?.length === 0 && <div className="empty small">{empty}</div>}
        {items?.map((d) => (
          <button key={d.path} className={selected === d.path ? "active" : undefined} onClick={() => open(d.path)}>
            <div className="title">{d.title || name(d.path)}</div>
            <div className="sub">{meta(d)}</div>
          </button>
        ))}
      </div>
    </section>
  )

  return (
    <div className="page">
      <header>
        <h1>Kết quả</h1>
        <p>Tài liệu CTO đã hoàn thành cho bạn, và bản nháp của nhân viên.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      {!view && !error && <div className="empty">Đang tải…</div>}
      {view && (
        <div className="split" style={{ height: "calc(100% - 70px)" }}>
          <div className="stack" style={{ overflow: "auto" }}>
            {section("Đã hoàn thành", view.deliverables, "Chưa có. Giao việc cho CTO trong Chat; kết quả cuối sẽ xuất hiện ở đây.")}
            {section("Bản nháp", view.drafts, "Chưa có bản nháp.")}
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {selected ? (
              <Viewer key={selected} path={selected} onDeleted={() => ((location.hash = "results"), load())} />
            ) : (
              <div className="empty">Chọn một tài liệu để xem.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Viewer({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  const [doc, setDoc] = useState<Doc>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api
      .get<Doc>(`/api/results/file?path=${encodeURIComponent(path)}`)
      .then(setDoc)
      .catch((e) => setError((e as Error).message))
  }, [path])

  if (error) return <div className="notice err">{error}</div>
  if (!doc) return <div className="empty">Đang tải…</div>

  const copy = async () => {
    await navigator.clipboard.writeText(doc.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const remove = async () => {
    if (!confirm(`Xóa "${doc.title || name(path)}"? Không hoàn tác được.`)) return
    try {
      await api.delete(`/api/results/file?path=${encodeURIComponent(path)}`)
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="stack" style={{ minHeight: 0, flex: 1 }}>
      <div className="row between wrap">
        <div className="grow">
          <h2>{doc.title || name(path)}</h2>
          <div className="small muted">
            <span className="mono">{name(path)}</span> · {doc.size} ký tự · {meta(doc)}
          </div>
        </div>
        <div className="row">
          <a className="btn primary" href={`/api/results/download?path=${encodeURIComponent(path)}`} download>
            Tải .md
          </a>
          <button className="btn" onClick={copy}>
            {copied ? "Đã chép" : "Chép nội dung"}
          </button>
          <button className="btn" onClick={remove}>
            Xóa
          </button>
        </div>
      </div>
      <pre style={{ overflow: "auto", flex: 1, borderTop: "1px solid var(--line)", paddingTop: 12 }}>{doc.content}</pre>
    </div>
  )
}
