import { useCallback, useEffect, useState } from "react"
import { api, type RunStatus, type Schedule, type ScheduleRun, type Staff } from "../api.ts"
import { useServerEvents } from "../events.ts"

const STATUS: Record<RunStatus, [string, "ok" | "warn" | "err" | ""]> = {
  running: ["đang chạy", ""],
  completed: ["xong", "ok"],
  failed: ["lỗi", "err"],
  stopped: ["đã dừng", "warn"],
  needs_input: ["cần trả lời", "warn"],
  skipped: ["bỏ qua (lần trước chưa xong)", "warn"],
  blocked: ["thiếu công cụ", "err"],
  interrupted: ["bị ngắt (app tắt)", "warn"],
}

const PRESETS: Array<[string, string]> = [
  ["0 2 * * *", "Mỗi ngày 2:00 sáng"],
  ["0 8 * * *", "Mỗi ngày 8:00"],
  ["30 8 * * 1-5", "Ngày thường 8:30"],
  ["0 9 * * 1", "Thứ Hai 9:00"],
  ["0 */6 * * *", "Mỗi 6 tiếng"],
  ["0 * * * *", "Mỗi giờ"],
]

function when(ms?: number) {
  return ms ? new Date(ms).toLocaleString() : "—"
}

function Status({ s }: { s?: RunStatus }) {
  if (!s) return <span className="badge">chưa chạy</span>
  const [label, cls] = STATUS[s] ?? [s, ""]
  return <span className={`badge ${cls}`}>{label}</span>
}

/** Việc định kỳ: CTO tạo khi CEO dặn ("mỗi 2h sáng…"); ở đây xem, tạm dừng, chạy ngay, sửa. */
export function Schedules({ id }: { id?: string }) {
  const [list, setList] = useState<Schedule[]>()
  const [tz, setTz] = useState("")
  const [staff, setStaff] = useState<Staff[]>([])
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, st] = await Promise.all([api.get<{ timezone: string; schedules: Schedule[] }>("/api/schedules"), api.get<Staff[]>("/api/staff")])
      setList(r.schedules)
      setTz(r.timezone)
      setStaff(st)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => void load(), [load])
  useServerEvents((ev) => {
    if (ev.type === "schedule") void load()
  })

  const agentName = (a: string) => staff.find((s) => s.id === a)?.name ?? a
  const selected = creating ? undefined : (list?.find((s) => s.id === id) ?? list?.[0])

  return (
    <div className="page">
      <header>
        <h1>Lịch</h1>
        <p>Việc định kỳ: tới giờ công ty tự thức dậy, giao việc, CTO xử lý kết quả. Giờ theo máy chủ{tz ? ` (${tz})` : ""}; máy tắt lúc tới giờ thì chạy bù một lần khi mở lại.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="split" style={{ height: "calc(100% - 70px)" }}>
        <div className="stack" style={{ overflow: "auto" }}>
          <div className="row between">
            <h3>Việc định kỳ</h3>
            <button className="btn small" onClick={() => setCreating(true)} disabled={creating}>
              Thêm
            </button>
          </div>
          <div className="list">
            {list?.length === 0 && !creating && <div className="empty small">Chưa có việc định kỳ. Nói với CTO, ví dụ: "mỗi 2h sáng cho researcher đọc tin thị trường và lưu điều mới vào tri thức".</div>}
            {list?.map((s) => (
              <button key={s.id} className={selected?.id === s.id ? "active" : undefined} onClick={() => ((location.hash = `schedules/${s.id}`), setCreating(false))}>
                <div className="title">
                  <span className={`dot ${s.running ? "on" : s.missingTools.length || s.lastStatus === "failed" ? "err" : ""}`} />
                  {s.title}
                </div>
                <div className="sub">
                  {agentName(s.agent)} · {s.enabled ? `lần tới ${when(s.nextRunAt)}` : "tạm dừng"}
                </div>
              </button>
            ))}
          </div>
        </div>
        <div style={{ overflow: "auto" }}>
          {creating ? (
            <ScheduleForm
              staff={staff}
              onCancel={() => setCreating(false)}
              onSave={async (body) => {
                const s = await api.post<Schedule>("/api/schedules", body)
                setCreating(false)
                await load()
                location.hash = `schedules/${s.id}`
              }}
            />
          ) : selected ? (
            <Detail key={selected.id} s={selected} staff={staff} agentName={agentName} onChanged={load} />
          ) : (
            <div className="empty">{list ? "Chọn một việc để xem." : "Đang tải…"}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Detail({ s, staff, agentName, onChanged }: { s: Schedule; staff: Staff[]; agentName: (id: string) => string; onChanged: () => Promise<void> }) {
  const [runs, setRuns] = useState<ScheduleRun[]>()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.get<{ runs: ScheduleRun[] }>(`/api/schedules/${s.id}`)).runs)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [s.id])
  useEffect(() => void loadRuns(), [loadRuns, s.updatedAt, s.lastRunAt, s.lastStatus])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      await onChanged()
      await loadRuns()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (editing)
    return (
      <ScheduleForm
        staff={staff}
        initial={s}
        onCancel={() => setEditing(false)}
        onSave={async (body) => {
          await api.put(`/api/schedules/${s.id}`, body)
          setEditing(false)
          await onChanged()
        }}
      />
    )

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card stack">
        <div className="row between">
          <div className="row">
            <strong>{s.title}</strong>
            {s.enabled ? <span className="badge ok">đang bật</span> : <span className="badge">tạm dừng</span>}
            {s.running && <span className="badge">đang chạy</span>}
          </div>
          <div className="row">
            <button className="btn small" disabled={busy || s.running} onClick={() => act(() => api.post(`/api/schedules/${s.id}/run`))}>
              Chạy ngay
            </button>
            <button className="btn small" disabled={busy} onClick={() => act(() => api.put(`/api/schedules/${s.id}`, { enabled: !s.enabled }))}>
              {s.enabled ? "Tạm dừng" : "Bật lại"}
            </button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(true)}>
              Sửa
            </button>
            <button
              className="btn small danger"
              disabled={busy}
              onClick={() =>
                confirm(`Xóa việc định kỳ "${s.title}"?`) &&
                act(async () => {
                  await api.delete(`/api/schedules/${s.id}`)
                  location.hash = "schedules"
                })
              }
            >
              Xóa
            </button>
          </div>
        </div>
        {error && <div className="notice err small">{error}</div>}
        {s.missingTools.length > 0 && (
          <div className="notice warn small">
            Cần công cụ chưa có: <code>{s.missingTools.join(", ")}</code>. Các lần chạy sẽ bị chặn (không tốn tiền) cho tới khi công cụ được nối, ví dụ qua trang MCP.
          </div>
        )}
        <table>
          <tbody>
            <tr>
              <th>Người làm</th>
              <td>{agentName(s.agent)}</td>
            </tr>
            <tr>
              <th>Lịch</th>
              <td>
                <code>{s.cron}</code> {PRESETS.find(([c]) => c === s.cron)?.[1] && <span className="muted small">· {PRESETS.find(([c]) => c === s.cron)![1]}</span>}
              </td>
            </tr>
            <tr>
              <th>Lần tới</th>
              <td>{s.enabled ? s.upcoming.map(when).join(" · ") || "—" : "tạm dừng"}</td>
            </tr>
            <tr>
              <th>Mục tiêu</th>
              <td style={{ whiteSpace: "pre-wrap" }}>{s.task.goal}</td>
            </tr>
            {s.task.context && (
              <tr>
                <th>Bối cảnh</th>
                <td style={{ whiteSpace: "pre-wrap" }}>{s.task.context}</td>
              </tr>
            )}
            <tr>
              <th>Xong khi</th>
              <td style={{ whiteSpace: "pre-wrap" }}>{s.task.done_when}</td>
            </tr>
            <tr>
              <th>CTO xử lý kết quả</th>
              <td style={{ whiteSpace: "pre-wrap" }}>{s.followUp ?? <span className="muted">Mặc định: lưu điều mới vào tri thức và tóm tắt cho bạn.</span>}</td>
            </tr>
            {s.tools?.length ? (
              <tr>
                <th>Công cụ cần</th>
                <td className="mono">{s.tools.join(", ")}</td>
              </tr>
            ) : null}
            <tr>
              <th>Tạo bởi</th>
              <td>
                {s.createdBy === "ceo" ? "bạn" : agentName(s.createdBy)} · {when(s.createdAt)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3>Các lần chạy</h3>
      {runs?.length === 0 && <div className="card empty small">Chưa chạy lần nào.</div>}
      {runs && runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Bắt đầu</th>
              <th>Trạng thái</th>
              <th>Ghi chú</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  {when(r.startedAt)}
                  {r.reason === "manual" && <span className="muted small"> · chạy tay</span>}
                  {r.reason === "due" && r.startedAt - r.dueAt > 120_000 && <span className="muted small"> · bù lịch {when(r.dueAt)}</span>}
                </td>
                <td>
                  <Status s={r.status} />
                </td>
                <td className="small">{r.error ?? ""}</td>
                <td>{r.sessionID && <a href={`#chat/${r.sessionID}`}>Xem phiên</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

interface FormBody {
  title: string
  agent: string
  cron: string
  task: { goal: string; context: string; done_when: string }
  followUp: string
  tools: string[]
}

function ScheduleForm({ staff, initial, onSave, onCancel }: { staff: Staff[]; initial?: Schedule; onSave: (b: FormBody) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState<FormBody>({
    title: initial?.title ?? "",
    agent: initial?.agent ?? staff.find((s) => s.mode !== "primary")?.id ?? "cto",
    cron: initial?.cron ?? "0 2 * * *",
    task: { goal: initial?.task.goal ?? "", context: initial?.task.context ?? "", done_when: initial?.task.done_when ?? "" },
    followUp: initial?.followUp ?? "",
    tools: initial?.tools ?? [],
  })
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormBody>(k: K, v: FormBody[K]) => setF((p) => ({ ...p, [k]: v }))
  const setTask = (k: keyof FormBody["task"], v: string) => setF((p) => ({ ...p, task: { ...p.task, [k]: v } }))

  return (
    <form
      className="card stack"
      style={{ maxWidth: 820 }}
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        setError(undefined)
        try {
          await onSave({ ...f, task: { ...f.task, done_when: f.task.done_when || "The goal above is satisfied." } })
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setSaving(false)
        }
      }}
    >
      <h3>{initial ? "Sửa việc định kỳ" : "Việc định kỳ mới"}</h3>
      <label className="field">
        Tên
        <input type="text" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Đọc tin thị trường mỗi đêm" required />
      </label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          Người làm
          <select value={f.agent} onChange={(e) => set("agent", e.target.value)}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.mode === "primary" ? " (tự làm)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          Lịch (cron: phút giờ ngày tháng thứ)
          <input type="text" className="mono" value={f.cron} onChange={(e) => set("cron", e.target.value)} required />
        </label>
      </div>
      <div className="row wrap">
        {PRESETS.map(([c, label]) => (
          <button key={c} type="button" className={`btn small ${f.cron === c ? "primary" : ""}`} onClick={() => set("cron", c)}>
            {label}
          </button>
        ))}
      </div>
      <label className="field">
        Mục tiêu (người làm chỉ thấy phần này và bối cảnh, mỗi lần chạy)
        <textarea rows={2} value={f.task.goal} onChange={(e) => setTask("goal", e.target.value)} required />
      </label>
      <label className="field">
        Bối cảnh
        <textarea rows={3} value={f.task.context} onChange={(e) => setTask("context", e.target.value)} />
      </label>
      <label className="field">
        Xong khi
        <input type="text" value={f.task.done_when} onChange={(e) => setTask("done_when", e.target.value)} placeholder="5 điều mới, có nguồn" />
      </label>
      <label className="field">
        CTO xử lý kết quả thế nào (để trống = lưu điều mới vào tri thức và tóm tắt)
        <textarea rows={2} value={f.followUp} onChange={(e) => set("followUp", e.target.value)} />
      </label>
      <label className="field">
        Công cụ bắt buộc (tên tool, cách nhau bằng dấu phẩy; * khớp nhiều, vd facebook_*)
        <input
          type="text"
          className="mono"
          value={f.tools.join(", ")}
          onChange={(e) =>
            set(
              "tools",
              e.target.value.split(",").map((t) => t.trim()),
            )
          }
        />
      </label>
      {error && <div className="notice err small">{error}</div>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? "Đang lưu…" : "Lưu"}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Hủy
        </button>
      </div>
    </form>
  )
}
