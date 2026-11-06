import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError, type Message, type Part, type Question, type SessionDetail, type SessionView, type Staff } from "../api.ts"
import { useServerEvents } from "../events.ts"
import { applyEvent, userMessage, type ChatState } from "./chat-state.ts"
import { Comms } from "./Comms.tsx"
import { SessionUsage } from "./Usage.tsx"

export function Chat({ sessionID }: { sessionID?: string }) {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.get<SessionView[]>("/api/sessions"), api.get<Staff[]>("/api/staff")])
      setSessions(s)
      setStaff(st)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => void refresh(), [refresh])
  useServerEvents((ev) => {
    if (ev.type === "session") setSessions((prev) => (prev.some((s) => s.session.id === ev.session.session.id) ? prev.map((s) => (s.session.id === ev.session.session.id ? { ...ev.session, home: s.home || ev.session.home } : s)) : [ev.session, ...prev]))
    if (ev.type === "turn") {
      setSessions((prev) => prev.map((s) => (s.session.id === ev.sessionID ? { ...s, running: ev.running, live: true } : s)))
      // Trạng thái công việc của nhân viên (đang làm gì, còn mấy việc chờ) chỉ có ở server.
      if (!ev.running) void refresh()
    }
  })

  const homes = sessions.filter((s) => s.home)
  const homeOf = (agent: string) => homes.find((s) => s.session.agent === agent)
  const comms = sessionID === "comms"
  const agentName = (id: string) => staff.find((s) => s.id === id)?.name ?? id

  // 1 agent = 1 phiên: mở phiên của agent (server tạo nếu chưa có).
  const open = useCallback(async (agent: string) => {
    setOpening(agent)
    try {
      const s = await api.post<SessionView>("/api/sessions", { agent })
      setSessions((prev) => (prev.some((x) => x.session.id === s.session.id) ? prev : [s, ...prev]))
      location.hash = `chat/${s.session.id}`
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setOpening(undefined)
    }
  }, [])

  // CTO (và agent primary khác) trước, rồi từng nhân viên; nhân viên đã nghỉ nhưng còn phiên vẫn hiện.
  const primary = staff.filter((s) => s.mode === "primary").map((s) => s.id)
  const employees = staff.filter((s) => s.mode !== "primary").map((s) => s.id)
  const known = new Set([...primary, ...employees])
  const former = [...new Set(homes.map((s) => s.session.agent))].filter((a) => !known.has(a))
  const people = [...(primary.length ? primary : ["cto"]), ...employees, ...former]
  const old = sessions.filter((s) => !s.home)

  const current = comms ? undefined : (sessionID ?? homeOf(primary[0] ?? "cto")?.session.id)
  const ceo = primary[0] ?? "cto"
  // Lần đầu chưa có phiên CTO → tạo luôn, không bắt CEO bấm nút.
  const ready = staff.length > 0 && !error
  useEffect(() => {
    if (!comms && !sessionID && ready && !homeOf(ceo) && !opening) void open(ceo)
  }, [comms, sessionID, ready, sessions, ceo])

  return (
    <div className="chat">
      <aside className="chat-side">
        <div className="head">
          <h2>Trò chuyện</h2>
        </div>
        <div className="list">
          {error && <div className="notice err small">{error}</div>}
          <button className={comms ? "list-item active" : "list-item"} onClick={() => (location.hash = "chat/comms")}>
            <div className="title">Giao tiếp giữa các agent</div>
          </button>
          <div className="side-group">
            {people.map((agent) => {
              const home = homeOf(agent)
              const fired = !known.has(agent) && staff.length > 0
              const w = home?.work
              const sub = fired
                ? "Đã nghỉ việc"
                : w?.status === "waiting"
                  ? "Đang chờ trả lời"
                  : w?.status === "working"
                    ? `Đang làm${w.goal ? `: ${w.goal}` : ""}`
                    : home?.running
                      ? "Đang trả lời"
                      : primary.includes(agent)
                        ? "Trợ lý chính"
                        : "Rảnh"
              return (
                <button
                  key={agent}
                  className={`list-item ${home && home.session.id === current ? "active" : ""}`}
                  onClick={() => (home ? (location.hash = `chat/${home.session.id}`) : fired ? undefined : void open(agent))}
                  disabled={opening === agent || (fired && !home)}
                  title={sub}
                >
                  <div className="title">
                    <span className={`dot ${home?.running || w?.status === "working" ? "on" : ""}`} />
                    {agentName(agent)}
                    {w && w.queued > 0 && <span className="badge">{w.queued} việc chờ</span>}
                  </div>
                  <div className="sub">{sub}</div>
                </button>
              )
            })}
          </div>
          {old.length > 0 && <OldSessions sessions={old} current={current} agentName={agentName} />}
        </div>
      </aside>
      {comms ? (
        <Comms agentName={agentName} />
      ) : current ? (
        <Conversation key={current} sessionID={current} staff={staff} homeOf={(a) => homeOf(a)?.session.id} />
      ) : (
        <div className="chat-main">
          <div className="empty" style={{ margin: "auto" }}>
            {error ? "Không kết nối được server." : "Đang mở cuộc trò chuyện với CTO…"}
          </div>
        </div>
      )}
    </div>
  )
}

/** Phiên từ trước khi mỗi agent chỉ có một phiên: vẫn xem được, không nhắn tiếp. */
function OldSessions({ sessions, current, agentName }: { sessions: SessionView[]; current?: string; agentName: (id: string) => string }) {
  const [open, setOpen] = useState(sessions.some((s) => s.session.id === current))
  return (
    <div className="side-group">
      <div className="gh">
        <button className="link small" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Lịch sử cũ ({sessions.length})
        </button>
      </div>
      {open &&
        sessions.map((s) => (
          <button key={s.session.id} className={`list-item child ${s.session.id === current ? "active" : ""}`} onClick={() => (location.hash = `chat/${s.session.id}`)} title={s.session.title}>
            <div className="title">
              {agentName(s.session.agent)} · {s.session.title}
            </div>
            <div className="sub">{new Date(s.session.createdAt).toLocaleString()}</div>
          </button>
        ))}
    </div>
  )
}

function Conversation({ sessionID, staff, homeOf }: { sessionID: string; staff: Staff[]; homeOf: (agent: string) => string | undefined }) {
  const [detail, setDetail] = useState<SessionDetail>()
  const [state, setState] = useState<ChatState>({ messages: [], running: false, notices: [] })
  const [questions, setQuestions] = useState<Question[]>([])
  const [loadError, setLoadError] = useState<string>()
  const [sendError, setSendError] = useState<string>()
  const [text, setText] = useState("")
  const logRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const [d, qs] = await Promise.all([api.get<SessionDetail>(`/api/sessions/${sessionID}`), api.get<Question[]>("/api/questions")])
      setDetail(d)
      setState({ messages: d.messages, running: d.running, notices: [], error: d.error })
      setQuestions(qs.filter((q) => q.sessionID === sessionID))
      setLoadError(undefined)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [sessionID])
  useEffect(() => void load(), [load])

  useServerEvents((ev) => {
    setState((s) => applyEvent(s, ev, sessionID))
    if (ev.type === "question" && ev.sessionID === sessionID) setQuestions((q) => [...q, ev])
    if (ev.type === "question-answered") setQuestions((q) => q.filter((x) => x.id !== ev.id))
    // Kết quả nhân viên nền đẩy vào inbox CTO không phát qua SSE → nạp lại khi lượt kết thúc.
    if (ev.type === "turn" && ev.sessionID === sessionID && !ev.running) void load()
  })

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [state.messages, questions])

  const me = detail ? staff.find((s) => s.id === detail.session.agent) : undefined
  const isPrimary = !me || me.mode === "primary"
  const myName = me?.name ?? detail?.session.agent ?? "CTO"

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setSendError(undefined)
    const direct = isPrimary ? /^@([\w-]+)\s+([\s\S]+)$/.exec(t) : null
    try {
      if (direct) {
        const [, agent, task] = direct
        if (!staff.some((s) => s.id === agent)) {
          setSendError(`Không có nhân viên "${agent}". Nhân viên hiện có: ${staff.filter((s) => s.mode !== "primary").map((s) => s.id).join(", ")}`)
          return
        }
        await api.post(`/api/sessions/${sessionID}/direct`, { agent, task })
        setState((s) => ({ ...s, messages: [...s.messages, userMessage(t)] }))
      } else {
        await api.post(`/api/sessions/${sessionID}/messages`, { text: t })
        setState((s) => ({ ...s, messages: [...s.messages, userMessage(t)], error: undefined }))
      }
      setText("")
    } catch (e) {
      setSendError(e instanceof ApiError && e.status === 409 ? `${e.message} — vào Cài đặt để cấu hình provider.` : (e as Error).message)
    }
  }

  const stop = () => api.post(`/api/sessions/${sessionID}/stop`).catch((e) => setSendError((e as Error).message))
  const answer = (q: Question, a: string) => api.post(`/api/questions/${q.id}`, { answer: a }).catch((e) => setSendError((e as Error).message))

  const agentName = (id: string) => (id === "ceo" ? "Bạn" : (staff.find((s) => s.id === id)?.name ?? id))

  if (loadError) return <div className="chat-main"><div className="notice err" style={{ margin: 20 }}>{loadError}</div></div>
  if (!detail) return <div className="chat-main"><div className="empty">Đang tải…</div></div>

  return (
    <div className="chat-main">
      <div className="chat-head">
        <div className="grow">
          <strong>{myName}</strong>
          <span className="muted small">
            {" · "}
            {[!detail.home ? `phiên cũ ${new Date(detail.session.createdAt).toLocaleDateString()}` : undefined, detail.work?.status === "working" ? "đang làm việc được giao" : undefined, detail.session.model].filter(Boolean).join(" · ")}
          </span>
        </div>
        <SessionUsage sessionID={sessionID} agentName={agentName} />
        {state.running ? (
          <>
            <span className="badge ok">đang làm việc</span>
            <button className="btn small" onClick={stop}>
              Dừng
            </button>
          </>
        ) : (
          <span className="badge">rảnh</span>
        )}
      </div>
      <div className="chat-log" ref={logRef}>
        {state.messages.length === 0 && <div className="empty">Chưa có tin nhắn. Hãy nói cho {myName} biết bạn cần gì.</div>}
        {state.messages.map((m) => (
          <MessageView key={m.id} m={m} agentName={agentName} />
        ))}
        {questions.map((q) => (
          <div key={q.id} className="question">
            <div className="small muted">{q.kind === "permission" ? "Cần cho phép" : `${myName} hỏi bạn`}</div>
            <div>{q.text}</div>
            <QuestionReply q={q} onAnswer={(a) => answer(q, a)} />
          </div>
        ))}
        {state.error && <div className="notice err">Lượt vừa rồi lỗi: {state.error}</div>}
      </div>
      {!detail.home ? (
        <div className="chat-compose">
          <div className="hint">
            Đây là phiên cũ (trước khi mỗi người chỉ có một cuộc trò chuyện), chỉ để xem.{" "}
            {homeOf(detail.session.agent) ? <a href={`#chat/${homeOf(detail.session.agent)}`}>Nhắn {myName} ở cuộc trò chuyện hiện tại</a> : null}
          </div>
        </div>
      ) : (
      <div className="chat-compose">
        {sendError && <div className="notice err small" style={{ marginBottom: 8 }}>{sendError}</div>}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <textarea
            className="grow"
            value={text}
            placeholder={state.running ? `Gửi thêm chỉ dẫn cho ${myName} đang làm…` : `Nhắn cho ${myName}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button className="btn primary" onClick={send} disabled={!text.trim()}>
            Gửi
          </button>
        </div>
        <div className="hint">
          Enter để gửi, Shift+Enter xuống dòng.
          {isPrimary ? (
            <>
              {" "}Giao việc thẳng cho nhân viên: <code>@writer viết email chào mừng</code>
            </>
          ) : (
            " Nhân viên không giao việc hay tuyển người được; việc đó để CTO lo."
          )}
        </div>
      </div>
      )}
    </div>
  )
}

function QuestionReply({ q, onAnswer }: { q: Question; onAnswer: (a: string) => void }) {
  const [custom, setCustom] = useState("")
  return (
    <div className="opts">
      {q.options?.map((o) => (
        <button key={o} className="btn small" onClick={() => onAnswer(o)}>
          {o}
        </button>
      ))}
      {q.kind === "question" && (
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault()
            if (custom.trim()) onAnswer(custom.trim())
          }}
        >
          <input type="text" value={custom} placeholder="Trả lời khác…" onChange={(e) => setCustom(e.target.value)} />
          <button className="btn small" type="submit" disabled={!custom.trim()}>
            Trả lời
          </button>
        </form>
      )}
    </div>
  )
}

function MessageView({ m, agentName }: { m: Message; agentName: (id: string) => string }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
    if (m.source === "subagent") return <SubagentResult text={text} agentName={agentName} />
    if (m.from === "scheduler") {
      const title = /^\[Scheduled job\] "([^"]*)"/.exec(text)?.[1]
      const g = /<goal>([\s\S]*?)<\/goal>/.exec(text)?.[1]
      return (
        <div className="msg agent">
          <div className="from">Lịch tự động{title ? ` · ${title}` : ""}</div>
          {g ? <BriefView text={text} /> : text}
        </div>
      )
    }
    const brief = m.source === "agent" || (m.source === "system" && text.startsWith("You are a subagent"))
    if (brief || (m.source === "user" && m.from && m.from !== "ceo")) {
      const g = /<goal>([\s\S]*?)<\/goal>/.exec(text)?.[1]
      return (
        <div className="msg agent">
          <div className="from">{m.from ? agentName(m.from) : "CTO"} {g ? "giao việc" : "nhắn"}</div>
          {g ? <BriefView text={text} /> : text}
        </div>
      )
    }
    if (m.source === "system") return <div className="msg system">{text}</div>
    return <div className="msg user">{text}</div>
  }
  if (m.role !== "assistant") return null
  const calls = new Map<string, Part & { type: "tool-call" }>()
  const results = new Map<string, Part & { type: "tool-result" }>()
  for (const p of m.parts) {
    if (p.type === "tool-call") calls.set(p.callID, p)
    if (p.type === "tool-result") results.set(p.callID, p)
  }
  return (
    <div className="msg assistant">
      {m.parts.map((p, i) => {
        if (p.type === "text") return <div key={i}>{p.text}</div>
        if (p.type === "tool-call") return <ToolView key={p.callID} call={p} result={results.get(p.callID)} />
        return null
      })}
    </div>
  )
}

function ToolView({ call, result }: { call: Part & { type: "tool-call" }; result?: Part & { type: "tool-result" } }) {
  const a = call.args as Record<string, unknown> | undefined
  const key = a?.goal ?? (a?.brief as any)?.goal ?? a?.query ?? a?.url ?? a?.path ?? a?.id ?? a?.question ?? a?.action
  return (
    <details className={`tool ${result?.isError ? "err" : ""}`}>
      <summary>
        <span>{call.name}</span>
        {key !== undefined && <span className="muted">{String(key).slice(0, 100)}</span>}
        {!result && <span className="muted">…</span>}
      </summary>
      <pre>{JSON.stringify(call.args, null, 2)}</pre>
      {result && <pre>{result.output}</pre>}
    </details>
  )
}

function BriefView({ text }: { text: string }) {
  const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1]?.trim()
  const ctx = tag("context")
  const done = tag("done_when")
  return (
    <>
      <div>{tag("goal")}</div>
      {ctx && <div className="muted small">Bối cảnh: {ctx}</div>}
      {done && <div className="muted small">Xong khi: {done}</div>}
    </>
  )
}

function SubagentResult({ text, agentName }: { text: string; agentName: (id: string) => string }) {
  const m = /<subagent sessionID="([^"]+)" agent="([^"]+)" status="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/subagent>/.exec(text)
  if (!m) return <div className="msg system">{text}</div>
  const [, , agent, status, body] = m
  return (
    <div className="msg system">
      <div className="who">
        {agentName(agent!)} đã nộp bài · <span className={`badge ${status === "completed" ? "ok" : "err"}`}>{status}</span>
      </div>
      {body}
    </div>
  )
}
