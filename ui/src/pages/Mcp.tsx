import { useEffect, useState } from "react"
import { api, type McpServerConfig, type McpServerStatus } from "../api.ts"

export function Mcp() {
  const [servers, setServers] = useState<McpServerStatus[]>()
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string>()

  const load = async () => {
    try {
      setServers(await api.get<McpServerStatus[]>("/api/mcp"))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="page">
      <header>
        <h1>MCP</h1>
        <p>Nối công cụ bên ngoài (Google Drive, Notion, email…) qua Model Context Protocol. Tool của server được đặt tên <code>&lt;server&gt;_&lt;tool&gt;</code> và mọi vai đều thấy.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="stack" style={{ maxWidth: 820 }}>
        <div className="row between">
          <h2>Servers</h2>
          <button className="btn small" onClick={() => setAdding(true)} disabled={adding}>
            Thêm server
          </button>
        </div>
        {adding && (
          <AddForm
            onCancel={() => setAdding(false)}
            onAdd={async (id, config) => {
              await api.post("/api/mcp", { id, config })
              setAdding(false)
              await load()
            }}
          />
        )}
        {servers?.length === 0 && !adding && <div className="card empty">Chưa có server nào. Cấu hình lưu ở .hahaness/mcp.json.</div>}
        {servers?.map((s) => (
          <div key={s.id} className="card stack">
            <div className="row between">
              <div className="row">
                <strong className="mono">{s.id}</strong>
                <StateBadge s={s} />
                {s.serverInfo?.name && (
                  <span className="small muted">
                    {s.serverInfo.name} {s.serverInfo.version}
                  </span>
                )}
              </div>
              <div className="row">
                <button className="btn small" disabled={busy === s.id} onClick={() => act(s.id, () => api.post(`/api/mcp/${s.id}/enabled`, { enabled: s.state === "disabled" }))}>
                  {s.state === "disabled" ? "Bật" : "Tắt"}
                </button>
                <button className="btn small" disabled={busy === s.id || s.state === "disabled"} onClick={() => act(s.id, () => api.post(`/api/mcp/${s.id}/reconnect`))}>
                  Kết nối lại
                </button>
                <button
                  className="btn small danger"
                  disabled={busy === s.id}
                  onClick={() => confirm(`Gỡ server ${s.id}?`) && act(s.id, () => api.delete(`/api/mcp/${s.id}`))}
                >
                  Gỡ
                </button>
              </div>
            </div>
            <div className="small mono muted">{s.config.type === "stdio" ? `${s.config.command} ${(s.config.args ?? []).join(" ")}` : s.config.url}</div>
            {s.error && <div className="notice err small">{s.error}</div>}
            {s.state === "connected" && (
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Mô tả</th>
                  </tr>
                </thead>
                <tbody>
                  {s.tools.length === 0 && (
                    <tr>
                      <td colSpan={2} className="muted">
                        Server không công bố tool nào.
                      </td>
                    </tr>
                  )}
                  {s.tools.map((t) => (
                    <tr key={t.toolName}>
                      <td className="mono">{t.toolName}</td>
                      <td className="small">{t.description ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function StateBadge({ s }: { s: McpServerStatus }) {
  const cls = s.state === "connected" ? "ok" : s.state === "error" ? "err" : s.state === "connecting" ? "warn" : ""
  const text = s.state === "connected" ? `${s.tools.length} tool` : s.state === "error" ? "lỗi" : s.state === "connecting" ? "đang kết nối" : "tắt"
  return <span className={`badge ${cls}`}>{text}</span>
}

function AddForm({ onAdd, onCancel }: { onAdd: (id: string, cfg: McpServerConfig) => Promise<void>; onCancel: () => void }) {
  const [id, setId] = useState("")
  const [type, setType] = useState<"stdio" | "http">("stdio")
  const [command, setCommand] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (type === "stdio") {
        const [cmd, ...args] = command.trim().split(/\s+/)
        if (!cmd) throw new Error("command is required")
        await onAdd(id, { type: "stdio", command: cmd, args })
      } else {
        await onAdd(id, { type: "http", url })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card stack">
      <h2>Server mới</h2>
      {error && <div className="notice err small">{error}</div>}
      <div className="row">
        <label className="field grow">
          id
          <input type="text" className="mono" value={id} placeholder="filesystem" onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="field">
          Transport
          <select value={type} onChange={(e) => setType(e.target.value as "stdio" | "http")}>
            <option value="stdio">stdio (chạy lệnh)</option>
            <option value="http">HTTP (streamable)</option>
          </select>
        </label>
      </div>
      {type === "stdio" ? (
        <label className="field">
          Lệnh và tham số
          <input type="text" className="mono" value={command} placeholder="npx -y @modelcontextprotocol/server-filesystem ./knowledge" onChange={(e) => setCommand(e.target.value)} />
        </label>
      ) : (
        <label className="field">
          URL
          <input type="url" className="mono" value={url} placeholder="http://localhost:3000/mcp" onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="btn primary" onClick={submit} disabled={busy || !id.trim() || (type === "stdio" ? !command.trim() : !url.trim())}>
          {busy ? "Đang kết nối…" : "Thêm và kết nối"}
        </button>
        <button className="btn" onClick={onCancel} disabled={busy}>
          Hủy
        </button>
      </div>
    </div>
  )
}
