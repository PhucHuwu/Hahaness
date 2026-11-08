import { useEffect, useMemo, useState } from "react"
import { api, type MarketItem, type MarketplaceView } from "../api.ts"

/** Chợ ứng dụng: danh mục do nhà cung cấp phát hành, cài bằng một nút; quản lý sau khi cài ở trang MCP. */
export function Market() {
  const [view, setView] = useState<MarketplaceView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [q, setQ] = useState("")
  const [tag, setTag] = useState<string>()

  const load = async (refresh = false) => {
    try {
      setView(refresh ? await api.post<MarketplaceView>("/api/marketplace/refresh") : await api.get<MarketplaceView>("/api/marketplace"))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])

  const install = async (it: MarketItem) => {
    setBusy(it.id)
    setError(undefined)
    try {
      const st = await api.post<{ state: string; error?: string }>(`/api/marketplace/${it.id}/install`)
      if (st.state === "error") setError(`Đã cài ${it.title} nhưng chưa kết nối được: ${st.error ?? "lỗi không rõ"}. Xem trang MCP.`)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const tags = useMemo(() => [...new Set((view?.items ?? []).flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, "vi")), [view])
  const items = (view?.items ?? []).filter((i) => {
    if (tag && !i.tags.includes(tag)) return false
    const s = q.trim().toLowerCase()
    return !s || [i.title, i.description, i.publisher ?? "", ...i.tags].some((t) => t.toLowerCase().includes(s))
  })

  return (
    <div className="page">
      <header>
        <h1>Chợ ứng dụng</h1>
        <p>Công cụ có sẵn để nối thêm cho công ty: bấm Cài là CTO và nhân viên dùng được ngay. Quản lý, tắt hay gỡ ở trang MCP.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      {!view && !error && <div className="empty">Đang tải…</div>}
      {view && (
        <div className="stack" style={{ maxWidth: 820 }}>
          <div className="row between wrap">
            <div className="row wrap">
              <input type="search" value={q} placeholder="Tìm công cụ…" onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
              {tags.map((t) => (
                <button key={t} className={`btn small${tag === t ? " primary" : ""}`} onClick={() => setTag(tag === t ? undefined : t)}>
                  {t}
                </button>
              ))}
            </div>
            {view.source !== "off" && (
              <button className="btn small" onClick={() => load(true)}>
                Tải lại danh mục
              </button>
            )}
          </div>
          {view.error && (
            <div className="notice warn small">
              Không tải được danh mục mới ({view.error}); đang dùng {view.source === "bundled" ? "danh mục đi kèm bản cài" : "danh mục tải lần trước"}.
            </div>
          )}
          {items.length === 0 && <div className="card empty">{view.items.length === 0 ? "Danh mục trống." : "Không có công cụ nào khớp."}</div>}
          {items.map((it) => (
            <div key={it.id} className="card stack">
              <div className="row between">
                <div className="row wrap">
                  <strong>{it.title}</strong>
                  {it.installed && <span className={`badge ${it.state === "connected" ? "ok" : it.state === "error" ? "err" : ""}`}>{it.state === "connected" ? "đã cài" : it.state === "error" ? "cài rồi, lỗi kết nối" : it.state === "disabled" ? "đã cài, đang tắt" : "đang kết nối"}</span>}
                  {it.tags.map((t) => (
                    <span key={t} className="badge">
                      {t}
                    </span>
                  ))}
                </div>
                {it.installed ? (
                  <a href="#mcp" className="btn small">
                    Xem ở MCP
                  </a>
                ) : (
                  <button className="btn small primary" disabled={busy === it.id} onClick={() => install(it)}>
                    {busy === it.id ? "Đang cài…" : "Cài"}
                  </button>
                )}
              </div>
              <div className="small">{it.description}</div>
              <div className="small muted row wrap">
                {it.publisher && <span>Nhà phát hành: {it.publisher}</span>}
                {it.homepage && (
                  <a href={it.homepage} target="_blank" rel="noreferrer">
                    Trang chủ
                  </a>
                )}
                <span className="mono">{it.config.type === "http" ? it.config.url : `${it.config.command} ${(it.config.args ?? []).join(" ")}`}</span>
              </div>
            </div>
          ))}
          <p className="small muted">
            {view.updatedAt && <>Danh mục cập nhật {view.updatedAt}. </>}
            {view.source === "off" ? "Chỉ dùng danh mục đi kèm bản cài (HAHANESS_CATALOG_URL=off)." : "Danh mục tự tải lại mỗi giờ."}
          </p>
        </div>
      )}
    </div>
  )
}
