import { useCallback, useEffect, useState } from "react"
import { api, type ContextCategory, type UsageReport, type UsageTotals } from "../api.ts"
import { useServerEvents } from "../events.ts"

const LABEL: Record<ContextCategory, string> = {
  system: "Vai trò & hướng dẫn",
  workspace: "Tài liệu công ty",
  tools: "Định nghĩa tool",
  checkpoint: "Bản tóm tắt (compact)",
  user: "Tin nhắn của bạn",
  agent: "Tin nhắn giữa agent",
  notice: "Thông báo hệ thống",
  assistant: "Trả lời của agent",
  "tool-calls": "Lời gọi tool",
  "tool-results": "Kết quả tool",
}

const COLOR: Record<ContextCategory, string> = {
  system: "#2f5d50",
  workspace: "#5b8a7c",
  tools: "#8fb5a8",
  checkpoint: "#b08d57",
  user: "#3d6fa8",
  agent: "#7a93c4",
  notice: "#a8a29a",
  assistant: "#8a5a9e",
  "tool-calls": "#c47a3d",
  "tool-results": "#9b2c2c",
}

export const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Nút trên đầu khung chat: context đang dùng / ngưỡng compact; bấm để xem chi tiết theo loại. */
export function SessionUsage({ sessionID, agentName }: { sessionID: string; agentName: (id: string) => string }) {
  const [report, setReport] = useState<UsageReport>()
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    api.get<UsageReport>(`/api/sessions/${sessionID}/usage`).then(setReport, () => {})
  }, [sessionID])
  useEffect(() => {
    setReport(undefined)
    load()
  }, [load])
  useServerEvents((ev) => {
    if ((ev.type === "usage" || (ev.type === "turn" && !ev.running)) && ev.sessionID === sessionID) load()
  })

  if (!report) return null
  const used = report.lastInput ?? report.estimatedContext
  const pct = report.ceiling ? Math.min(100, Math.round((used / report.ceiling) * 100)) : undefined

  return (
    <>
      <button className={`usage-chip ${pct !== undefined && pct >= 80 ? "warn" : ""}`} onClick={() => setOpen((o) => !o)} title="Token đã dùng trong phiên">
        <span className="usage-mini">
          <span style={{ width: `${pct ?? 0}%` }} />
        </span>
        {fmt(used)}
        {report.ceiling ? ` / ${fmt(report.ceiling)}` : ""}
        <span className="muted"> · {fmt(report.total.inputTokens + report.total.outputTokens)} tổng</span>
      </button>
      {open && <UsagePanel report={report} agentName={agentName} onClose={() => setOpen(false)} />}
    </>
  )
}

function UsagePanel({ report, agentName, onClose }: { report: UsageReport; agentName: (id: string) => string; onClose: () => void }) {
  const est = report.estimatedContext || 1
  const childTotal = report.children.reduce((n, c) => n + c.total.inputTokens + c.total.outputTokens, 0)
  return (
    <div className="usage-panel">
      <div className="row between">
        <strong>Token của phiên</strong>
        <button className="btn small" onClick={onClose}>
          Đóng
        </button>
      </div>

      <section>
        <h4>Context hiện tại</h4>
        <div className="small muted">
          {report.lastInput !== undefined ? `Provider đếm ${report.lastInput.toLocaleString()} token ở lượt gần nhất.` : "Provider chưa trả số token; dùng ước lượng."}{" "}
          {report.ceiling ? `Tự tóm tắt khi chạm ${report.ceiling.toLocaleString()} (context ${report.contextWindow?.toLocaleString()}).` : ""}
        </div>
        <div className="usage-bar">
          {report.context.categories.map((c) => (
            <span key={c.key} style={{ width: `${(c.tokens / est) * 100}%`, background: COLOR[c.key] }} title={`${LABEL[c.key]}: ${c.tokens.toLocaleString()}`} />
          ))}
        </div>
        <table className="usage-table">
          <tbody>
            {report.context.categories.map((c) => (
              <tr key={c.key}>
                <td>
                  <span className="swatch" style={{ background: COLOR[c.key] }} />
                  {LABEL[c.key]}
                </td>
                <td className="num">~{fmt(c.tokens)}</td>
                <td className="num muted">{Math.round((c.tokens / est) * 100)}%</td>
              </tr>
            ))}
            <tr className="sum">
              <td>Tổng ước lượng</td>
              <td className="num">~{fmt(report.estimatedContext)}</td>
              <td />
            </tr>
          </tbody>
        </table>
        {!report.live && <div className="small muted">Phiên chưa mở lại nên chưa tính phần vai trò, tài liệu và định nghĩa tool.</div>}
      </section>

      {report.context.tools.length > 0 && (
        <section>
          <h4>Theo tool (trong context)</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Lần gọi</th>
                <th className="num">Lời gọi</th>
                <th className="num">Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {report.context.tools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="num">{t.calls}</td>
                  <td className="num">~{fmt(t.callTokens)}</td>
                  <td className="num">~{fmt(t.resultTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h4>Đã gọi model (số thật từ provider)</h4>
        <table className="usage-table">
          <thead>
            <tr>
              <th />
              <th className="num">Lần</th>
              <th className="num">Vào</th>
              <th className="num">Cache</th>
              <th className="num">Ra</th>
            </tr>
          </thead>
          <tbody>
            <TotalsRow label="Lượt làm việc" t={report.byPurpose.turn} />
            <TotalsRow label="Tóm tắt (compact)" t={report.byPurpose.compaction} />
            <TotalsRow label="Ghi nhớ trước compact" t={report.byPurpose.memory} />
            <TotalsRow label="Tổng" t={report.total} sum />
          </tbody>
        </table>
        {report.byModel.length > 1 && (
          <table className="usage-table">
            <tbody>
              {report.byModel.map((m) => (
                <TotalsRow key={m.model} label={m.model} t={m} mono />
              ))}
            </tbody>
          </table>
        )}
        <div className="small muted">"Vào" tính lại toàn bộ context ở mỗi lần gọi; "Cache" là phần provider đọc lại từ cache (rẻ hơn).</div>
      </section>

      {report.children.length > 0 && (
        <section>
          <h4>Nhân viên được giao việc · {fmt(childTotal)} token</h4>
          <table className="usage-table">
            <tbody>
              {report.children.map((c) => (
                <tr key={c.sessionID}>
                  <td>
                    <a href={`#chat/${c.sessionID}`}>{agentName(c.agent)}</a> <span className="muted">{c.title}</span>
                  </td>
                  <td className="num">{c.total.calls} lần</td>
                  <td className="num">{fmt(c.total.inputTokens)} vào</td>
                  <td className="num">{fmt(c.total.outputTokens)} ra</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function TotalsRow({ label, t, sum, mono }: { label: string; t: UsageTotals; sum?: boolean; mono?: boolean }) {
  if (!sum && t.calls === 0) return null
  return (
    <tr className={sum ? "sum" : undefined}>
      <td className={mono ? "mono" : undefined}>{label}</td>
      <td className="num">{t.calls}</td>
      <td className="num">{fmt(t.inputTokens)}</td>
      <td className="num">{t.cacheReadTokens ? fmt(t.cacheReadTokens) : "–"}</td>
      <td className="num">{fmt(t.outputTokens)}</td>
    </tr>
  )
}
