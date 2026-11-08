import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError, type CommandResult, type CommandSpec, type Message, type Part, type Question, type SessionDetail, type SessionView, type Staff } from "../api.ts"
import { useServerEvents } from "../events.ts"
import { applyEvent, userMessage, type ChatState } from "./chat-state.ts"
import { Comms } from "./Comms.tsx"
import { SessionUsage } from "./Usage.tsx"

export function Chat({ sessionID }: { sessionID?: string }) {
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState<string>()
  const [commands, setCommands] = useState<CommandSpec[]>([])
  /** Kết quả `/new` hiện ở cuộc trò chuyện mới vừa chuyển sang. */
  const [carry, setCarry] = useState<{ sessionID: string; text: string }>()

  useEffect(() => {
    api.get<CommandSpec[]>("/api/commands").then(setCommands, () => {})
  }, [])

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
        <Conversation
          key={current}
          sessionID={current}
          staff={staff}
          homeOf={(a) => homeOf(a)?.session.id}
          commands={commands}
          initialReply={carry?.sessionID === current ? carry.text : undefined}
          onNewSession={(id, text) => {
            setCarry({ sessionID: id, text })
            void refresh()
            location.hash = `chat/${id}`
          }}
        />
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

/** Phiên cũ của agent (trước khi mỗi agent chỉ có một phiên, hoặc trước `/new`): vẫn xem được, không nhắn tiếp. */
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

function Conversation({
  sessionID,
  staff,
  homeOf,
  commands,
  initialReply,
  onNewSession,
}: {
  sessionID: string
  staff: Staff[]
  homeOf: (agent: string) => string | undefined
  commands: CommandSpec[]
  initialReply?: string
  onNewSession: (sessionID: string, reply: string) => void
}) {
  const [detail, setDetail] = useState<SessionDetail>()
  /** Kết quả lệnh slash gần nhất (không thuộc transcript). */
  const [cmdReply, setCmdReply] = useState(initialReply)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [state, setState] = useState<ChatState>({ messages: [], running: false, notices: [] })
  const [questions, setQuestions] = useState<Question[]>([])
  const [loadError, setLoadError] = useState<string>()
  const [sendError, setSendError] = useState<string>()
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
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

  // Lệnh slash: gõ "/" → danh sách lệnh lọc theo chữ đang gõ (chỉ khi chưa có dấu cách).
  const typed = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase()
  const matches = typed === undefined || menuClosed ? [] : commands.filter((c) => [c.name, ...c.aliases].some((n) => n.startsWith(typed)))
  const picked = matches[Math.min(menuIndex, matches.length - 1)]
  const fill = (c: CommandSpec) => {
    setText(`/${c.name}${c.args ? " " : ""}`)
    setMenuIndex(0)
  }

  const runSlash = async (t: string) => {
    setSending(true)
    setCmdReply(undefined)
    try {
      const r = await api.post<CommandResult>(`/api/sessions/${sessionID}/command`, { text: t })
      setText("")
      if (r.sessionID && r.sessionID !== sessionID) onNewSession(r.sessionID, r.text)
      else setCmdReply(r.text)
    } finally {
      setSending(false)
    }
  }

  const send = async () => {
    const t = text.trim()
    if (!t && files.length === 0) return
    setSendError(undefined)
    if (files.length === 0 && t.startsWith("/")) {
      try {
        await runSlash(t)
      } catch (e) {
        setSendError((e as Error).message)
      }
      return
    }
    const direct = isPrimary && files.length === 0 ? /^@([\w-]+)\s+([\s\S]+)$/.exec(t) : null
    try {
      if (files.length > 0) {
        setSending(true)
        const payload = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, data: await toBase64(f) })))
        await api.post(`/api/sessions/${sessionID}/messages`, { text: t, files: payload })
        setState((s) => ({ ...s, messages: [...s.messages, userMessage(t, files.map((f) => f.name))], error: undefined }))
        setText("")
        setFiles([])
        return
      }
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
    } finally {
      setSending(false)
    }
  }

  const stop = () => api.post(`/api/sessions/${sessionID}/stop`).catch((e) => setSendError((e as Error).message))
  const answer = (q: Question, a: string) => api.post(`/api/questions/${q.id}`, { answer: a }).catch((e) => setSendError((e as Error).message))
  // Câu hỏi của CTO (tool `question`) nằm trong lịch sử chat; trả lời = gửi tin nhắn.
  const asked = state.running ? undefined : openQuestion(state.messages)
  const reply = async (a: string) => {
    setSendError(undefined)
    try {
      await api.post(`/api/sessions/${sessionID}/messages`, { text: a })
      setState((s) => ({ ...s, messages: [...s.messages, userMessage(a)], error: undefined }))
    } catch (e) {
      setSendError((e as Error).message)
    }
  }

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
        {asked && detail.home && (
          <div className="question">
            <div className="small muted">{myName} hỏi bạn</div>
            <div>{asked.question}</div>
            <QuestionReply q={{ id: "", sessionID, kind: "question", text: asked.question, options: asked.options }} onAnswer={reply} />
          </div>
        )}
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
            Đây là cuộc trò chuyện cũ, chỉ để xem.{" "}
            {homeOf(detail.session.agent) ? <a href={`#chat/${homeOf(detail.session.agent)}`}>Nhắn {myName} ở cuộc trò chuyện hiện tại</a> : null}
          </div>
        </div>
      ) : (
      <div className="chat-compose">
        {cmdReply && (
          <div className="cmd-reply" role="status">
            <pre>{cmdReply}</pre>
            <button className="link" title="Đóng" aria-label="Đóng" onClick={() => setCmdReply(undefined)}>
              ×
            </button>
          </div>
        )}
        {sendError && <div className="notice err small" style={{ marginBottom: 8 }}>{sendError}</div>}
        {matches.length > 0 && (
          <ul className="slash-menu" id="slash-menu" role="listbox" aria-label="Lệnh">
            {matches.map((c) => (
              <li
                key={c.name}
                id={`slash-${c.name}`}
                role="option"
                aria-selected={c === picked}
                className={c === picked ? "active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault()
                  fill(c)
                }}
              >
                <code>/{c.name}</code>
                {c.args && <span className="muted"> {c.args}</span>}
                {c.aliases.length > 0 && <span className="muted small"> ({c.aliases.map((a) => `/${a}`).join(", ")})</span>}
                <span className="desc">{c.description}</span>
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <div className="attach-list">
            {files.map((f, i) => (
              <span key={i} className="attach-chip">
                📎 {f.name} <span className="muted">{fmtSize(f.size)}</span>
                <button className="link" title="Bỏ file này" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className="row"
          style={{ alignItems: "flex-end" }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (e.dataTransfer.files.length) setFiles([...files, ...e.dataTransfer.files])
          }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.xlsx,.xlsm,.docx,.csv,.tsv,.txt,.md,.json,image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => {
              if (e.target.files) setFiles([...files, ...e.target.files])
              e.target.value = ""
            }}
          />
          <button className="btn" title="Đính kèm file: PDF, Excel, Word, CSV, ảnh" onClick={() => fileRef.current?.click()}>
            📎
          </button>
          <textarea
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files]
              if (pasted.length) {
                e.preventDefault()
                setFiles([...files, ...pasted])
              }
            }}
            className="grow"
            value={text}
            placeholder={state.running ? `Gửi thêm chỉ dẫn cho ${myName} đang làm…` : `Nhắn cho ${myName}… (gõ / để xem lệnh)`}
            onChange={(e) => {
              setText(e.target.value)
              setMenuClosed(false)
            }}
            aria-autocomplete="list"
            aria-controls={matches.length ? "slash-menu" : undefined}
            aria-activedescendant={picked ? `slash-${picked.name}` : undefined}
            onKeyDown={(e) => {
              if (picked) {
                const move = (d: number) => {
                  e.preventDefault()
                  setMenuIndex((Math.min(menuIndex, matches.length - 1) + d + matches.length) % matches.length)
                }
                if (e.key === "ArrowDown") return move(1)
                if (e.key === "ArrowUp") return move(-1)
                if (e.key === "Escape") {
                  e.preventDefault()
                  return setMenuClosed(true)
                }
                // Tab luôn điền; Enter điền khi chữ đang gõ chưa phải đúng tên lệnh (đúng rồi thì chạy luôn).
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && typed !== picked.name && !picked.aliases.includes(typed ?? ""))) {
                  e.preventDefault()
                  // Lệnh có tham số thì điền để gõ tiếp; không có thì Enter chạy luôn.
                  if (e.key === "Tab" || picked.args) return fill(picked)
                  setSendError(undefined)
                  void runSlash(`/${picked.name}`).catch((err) => setSendError((err as Error).message))
                  return
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button className="btn primary" onClick={send} disabled={sending || (!text.trim() && files.length === 0)}>
            {sending ? "Đang gửi…" : "Gửi"}
          </button>
        </div>
        <div className="hint">
          Enter để gửi, Shift+Enter xuống dòng. Kéo thả hoặc dán file/ảnh vào đây để gửi kèm. Gõ <code>/</code> để xem lệnh.
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

/** Lượt cuối của agent kết thúc bằng `question` và CEO chưa nhắn gì sau đó → câu hỏi còn chờ. */
function openQuestion(messages: Message[]): { question: string; options?: string[] } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user" && (m.source === "user" || m.source === undefined)) return undefined
    if (m.role !== "assistant") continue
    const done = new Set(m.parts.flatMap((p) => (p.type === "tool-result" && !p.isError ? [p.callID] : [])))
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!
      if (p.type === "tool-call" && p.name === "question" && done.has(p.callID)) {
        const a = (p.args ?? {}) as { question?: string; options?: string[] }
        return a.question ? { question: a.question, options: a.options } : undefined
      }
    }
    return undefined
  }
  return undefined
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
    const said = m.parts.flatMap((p) => (p.type === "text" && !p.text.startsWith("<attachments>") ? [p.text] : [])).join("\n")
    const names = attachedNames(m)
    const images = m.parts.flatMap((p) => (p.type === "image" ? [p] : []))
    return (
      <div className="msg user">
        {said}
        {(names.length > 0 || images.length > 0) && (
          <div className="attach-list">
            {names.map((n, i) => (
              <span key={i} className="attach-chip">
                📎 {n.name}
                {n.path && <a href={`#results/${encodeURIComponent(n.path)}`} className="muted small" style={{ marginLeft: 6 }}>{n.summary}</a>}
              </span>
            ))}
            {images.map((p, i) => (
              <img key={i} className="attach-img" src={`data:${p.mime};base64,${p.data}`} alt="" />
            ))}
          </div>
        )}
      </div>
    )
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

/** File trong khối `<attachments>` (server tạo) hoặc tên file của tin vừa gửi (chưa có từ server). */
function attachedNames(m: Message): Array<{ name: string; path?: string; summary?: string }> {
  const out: Array<{ name: string; path?: string; summary?: string }> = []
  for (const p of m.parts) {
    if (p.type !== "text" || !p.text.startsWith("<attachments>")) continue
    for (const f of p.text.matchAll(/<file\b([^>]*)>/g)) {
      const at = (k: string) => new RegExp(` ${k}="([^"]*)"`).exec(f[1]!)?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&")
      if (at("kind") === "image") continue
      out.push({ name: at("name") ?? "file", path: at("path"), summary: at("summary") })
    }
  }
  return out
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })
}

function fmtSize(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
