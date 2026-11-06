import { useState } from "react"
import { api } from "../api.ts"

export interface AuthState {
  configured: boolean
  authenticated: boolean
  required: boolean
  minPassword: number
}

/** Đăng nhập; lần đầu thì đặt mật khẩu bằng mã cài đặt trong log server. */
export function Login({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const setup = !state.configured
  const [password, setPassword] = useState("")
  const [again, setAgain] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(undefined)
    if (setup && password !== again) return setError("Hai lần nhập mật khẩu không khớp.")
    setBusy(true)
    try {
      await api.post(setup ? "/api/auth/setup" : "/api/auth/login", setup ? { password, code } : { password })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Hahaness</h2>
        {setup ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              Lần đầu sử dụng: đặt mật khẩu để chỉ bạn vào được công ty. Mã cài đặt được in trong log của server (dòng "Mã cài đặt"), người cài server cho bạn sẽ có mã này.
            </p>
            <label className="field">
              Mã cài đặt
              <input type="text" className="mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
            </label>
          </>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>Nhập mật khẩu để vào công ty.</p>
        )}
        <label className="field">
          {setup ? `Mật khẩu mới (ít nhất ${state.minPassword} ký tự)` : "Mật khẩu"}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} autoFocus={!setup} />
        </label>
        {setup && (
          <label className="field">
            Nhập lại mật khẩu
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {error && <div className="notice err small">{error}</div>}
        <button className="btn primary" disabled={busy || !password || (setup && !code.trim())}>
          {busy ? "Đang xử lý…" : setup ? "Đặt mật khẩu và vào" : "Đăng nhập"}
        </button>
      </form>
    </div>
  )
}

/** Đổi mật khẩu / đăng xuất các thiết bị khác (trang Cài đặt). */
export function AccountCard() {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setMsg(undefined)
    try {
      setMsg({ ok: true, text: await fn() })
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card stack">
      <div className="row between">
        <h2>Tài khoản</h2>
        <button className="btn small" onClick={() => void api.post("/api/auth/logout").then(() => location.reload())}>
          Đăng xuất
        </button>
      </div>
      <div className="row wrap">
        <input type="password" placeholder="Mật khẩu hiện tại" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        <input type="password" placeholder="Mật khẩu mới" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <button
          className="btn"
          disabled={busy || !current || !next}
          onClick={() =>
            run(async () => {
              await api.post("/api/auth/password", { current, next })
              setCurrent("")
              setNext("")
              return "Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất."
            })
          }
        >
          Đổi mật khẩu
        </button>
        <button className="btn" disabled={busy} onClick={() => run(async () => (await api.post("/api/auth/logout-others"), "Đã đăng xuất mọi thiết bị khác."))}>
          Đăng xuất thiết bị khác
        </button>
      </div>
      {msg && <div className={`notice small ${msg.ok ? "" : "err"}`}>{msg.text}</div>}
    </div>
  )
}
