import { useCallback, useEffect, useState } from "react"
import { api, type CommItem } from "../api.ts"
import { useServerEvents } from "../events.ts"

const KIND: Record<CommItem["kind"], string> = {
  brief: "giao việc",
  steer: "nhắc thêm",
  ceo: "CEO nhắn",
  report: "báo cáo",
}

/** Dòng thời gian CTO ↔ nhân viên: brief, chỉ dẫn thêm, báo cáo — đọc từ lịch sử các phiên. */
export function Comms({ agentName }: { agentName: (id: string) => string }) {
  const [items, setItems] = useState<CommItem[]>()
  const [error, setError] = useState<string>()
  const [who, setWho] = useState("")

  const load = useCallback(async () => {
    try {
      setItems(await api.get<CommItem[]>("/api/conversations"))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => void load(), [load])
  useServerEvents((ev) => {
    if (ev.type === "session" || (ev.type === "turn" && !ev.running)) void load()
  })

  const name = (id: string) => (id === "ceo" ? "Bạn (CEO)" : agentName(id))
  const people = [...new Set((items ?? []).flatMap((i) => [i.from, i.to]))].filter((p) => p !== "ceo")
  const shown = (items ?? []).filter((i) => !who || i.from === who || i.to === who)

  return (
    <div className="chat-main">
      <div className="chat-head">
        <div className="grow">
          <strong>Giao tiếp</strong>
          <span className="muted small"> · việc được giao qua lại giữa CTO và nhân viên</span>
        </div>
        {people.length > 1 && (
          <select value={who} onChange={(e) => setWho(e.target.value)} style={{ width: "auto" }} aria-label="Lọc theo người">
            <option value="">Mọi người</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {name(p)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="chat-log">
        {error && <div className="notice err">Không tải được: {error}</div>}
        {!error && !items && <div className="empty">Đang tải…</div>}
        {items && shown.length === 0 && (
          <div className="empty">Chưa có trao đổi nào. Khi CTO giao việc cho nhân viên, từng lượt giao việc và báo cáo sẽ hiện ở đây.</div>
        )}
        {shown.map((i, n) => (
          <div key={n} className={`comm ${i.kind}`}>
            <div className="comm-head">
              <strong>{name(i.from)}</strong>
              <span className="muted"> → </span>
              <strong>{name(i.to)}</strong>
              <span className="muted"> · {KIND[i.kind]} · {new Date(i.at).toLocaleString()}</span>
              {i.status && <span className={`badge ${i.status === "completed" ? "ok" : "err"}`}>{i.status}</span>}
              <a href={`#chat/${i.sessionID}`} className="grow-right small">
                Mở phiên
              </a>
            </div>
            <div className="comm-body">{i.text || "(trống)"}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
