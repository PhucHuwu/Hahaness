import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError, type Message, type Part, type Question, type SessionDetail, type SessionView, type Staff } from "../api.ts"
import { useServerEvents } from "../events.ts"
import { applyEvent, userMessage, type ChatState } from "./chat-state.ts"

export function Chat({ sessionID }: { sessionID?: string }) {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [error, setError] = useState<string>()
  const [creating, setCreating] = useState(false)

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
    if (ev.type === "session") setSessions((prev) => (prev.some((s) => s.session.id === ev.session.session.id) ? prev.map((s) => (s.session.id === ev.session.session.id ? ev.session : s)) : [ev.session, ...prev]))
    if (ev.type === "turn") setSessions((prev) => prev.map((s) => (s.session.id === ev.sessionID ? { ...s, running: ev.running, live: true } : s)))
  })

  const roots = sessions.filter((s) => !s.session.parentID)
  const current = sessionID ?? roots[0]?.session.id

  const create = async () => {
    setCreating(true)
    try {
      const s = await api.post<SessionView>("/api/sessions", { agent: "cto" })
      location.hash = `chat/${s.session.id}`
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="chat">
      <aside className="chat-side">
        <div className="head row between">
          <h2>Phiên làm việc</h2>
          <button className="btn small" onClick={create} disabled={creating}>
            Mới
          </button>
        </div>
        <div className="list">
          {error && <div className="notice err small">{error}</div>}
          {!error && roots.length === 0 && <div className="empty small">Chưa có phiên nào.</div>}
          {roots.map((s) => (
            <button key={s.session.id} className={s.session.id === current ? "active" : undefined} onClick={() => (location.hash = `chat/${s.session.id}`)}>
              <div className="title">
                <span className={`dot ${s.running ? "on" : ""}`} />
                {s.session.title}
              </div>
              <div className="sub">
                {s.session.agent} · {new Date(s.session.createdAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </aside>
      {current ? (
        <Conversation key={current} sessionID={current} staff={staff} />
      ) : (
        <div className="chat-main">
          <div className="empty" style={{ margin: "auto" }}>
            {error ? "Không kết nối được server." : "Bắt đầu một phiên mới để nói chuyện với CTO."}
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={create} disabled={creating || !!error}>
                Phiên mới
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Conversation({ sessionID, staff }: { sessionID: string; staff: Staff[] }) {
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
      setState({ messages: d.messages, running: d.running, notices: [] })
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
    if (ev.type === "session" && ev.session.session.parentID === sessionID) {
      setDetail((d) => d && { ...d, children: d.children.some((c) => c.session.id === ev.session.session.id) ? d.children.map((c) => (c.session.id === ev.session.session.id ? ev.session : c)) : [...d.children, ev.session] })
    }
    if (ev.type === "turn" && detail?.children.some((c) => c.session.id === ev.sessionID)) {
      setDetail((d) => d && { ...d, children: d.children.map((c) => (c.session.id === ev.sessionID ? { ...c, running: ev.running } : c)) })
    }
    // Kết quả nhân viên nền đẩy vào inbox CTO không phát qua SSE → nạp lại khi lượt kết thúc.
    if (ev.type === "turn" && ev.sessionID === sessionID && !ev.running) void load()
  })

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [state.messages, questions])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setSendError(undefined)
    const direct = /^@([\w-]+)\s+([\s\S]+)$/.exec(t)
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

  const agentName = (id: string) => staff.find((s) => s.id === id)?.name ?? id

  if (loadError) return <div className="chat-main"><div className="notice err" style={{ margin: 20 }}>{loadError}</div></div>
  if (!detail) return <div className="chat-main"><div className="empty">Đang tải…</div></div>

  return (
    <div className="chat-main">
      <div className="chat-head">
        <div className="grow">
          {detail.session.parentID && (
            <a href={`#chat/${detail.session.parentID}`} className="small">
              ← về CTO
            </a>
          )}{" "}
          <strong>{agentName(detail.session.agent)}</strong>
          <span className="muted small"> · {detail.session.model}</span>
        </div>
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
        {state.messages.length === 0 && <div className="empty">Chưa có tin nhắn. Hãy nói cho CTO biết bạn cần gì.</div>}
        {state.messages.map((m) => (
          <MessageView key={m.id} m={m} agentName={agentName} />
        ))}
        {questions.map((q) => (
          <div key={q.id} className="question">
            <div className="small muted">{q.kind === "permission" ? "Cần cho phép" : "CTO hỏi bạn"}</div>
            <div>{q.text}</div>
            <QuestionReply q={q} onAnswer={(a) => answer(q, a)} />
          </div>
        ))}
        {state.error && <div className="notice err">Lượt vừa rồi lỗi: {state.error}</div>}
      </div>
      {detail.children.length > 0 && (
        <div className="children">
          <span className="muted">Nhân viên:</span>
          {detail.children.map((c) => (
            <a key={c.session.id} href={`#chat/${c.session.id}`} title="Xem nhân viên đang làm gì">
              <span className={`dot ${c.running ? "on" : ""}`} />
              {agentName(c.session.agent)} — {c.session.title}
            </a>
          ))}
        </div>
      )}
      <div className="chat-compose">
        {sendError && <div className="notice err small" style={{ marginBottom: 8 }}>{sendError}</div>}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <textarea
            className="grow"
            value={text}
            placeholder={state.running ? "Gửi thêm chỉ dẫn cho CTO đang làm…" : "Bạn cần gì?"}
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
        <div className="hint">Enter để gửi, Shift+Enter xuống dòng. Giao việc thẳng cho nhân viên: <code>@writer viết email chào mừng</code></div>
      </div>
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
    if (m.source === "system") return <div className="msg system">{text}</div>
    if (m.source === "subagent") return <SubagentResult text={text} agentName={agentName} />
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
