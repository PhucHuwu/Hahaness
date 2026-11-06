import { useEffect, useState } from "react"
import { Chat } from "./pages/Chat.tsx"
import { Settings } from "./pages/Settings.tsx"
import { Knowledge } from "./pages/Knowledge.tsx"
import { Results } from "./pages/Results.tsx"
import { Skills } from "./pages/Skills.tsx"
import { Mcp } from "./pages/Mcp.tsx"
import { Schedules } from "./pages/Schedules.tsx"
import { useConnectionState } from "./events.ts"
import { api, onUnauthorized } from "./api.ts"
import { Login, type AuthState } from "./pages/Login.tsx"

const PAGES = [
  ["chat", "Chat"],
  ["results", "Kết quả"],
  ["knowledge", "Tri thức"],
  ["skills", "Kỹ năng"],
  ["schedules", "Lịch"],
  ["mcp", "MCP"],
  ["settings", "Cài đặt"],
] as const
type Page = (typeof PAGES)[number][0]

/** Hash router: #chat/<sessionID>, #knowledge, … — không thêm thư viện. */
function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1))
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1))
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  const [page, ...rest] = hash.split("/")
  return { page: (PAGES.some(([p]) => p === page) ? page : "chat") as Page, arg: rest.join("/") }
}

/** Kiểm tra đăng nhập trước khi dựng app (app mở kết nối SSE ngay khi dựng). */
export function App() {
  const [auth, setAuth] = useState<AuthState>()
  const [error, setError] = useState<string>()
  const check = () =>
    api.get<AuthState>("/api/auth").then(
      (a) => (setAuth(a), setError(undefined)),
      (e) => setError((e as Error).message),
    )
  useEffect(() => {
    void check()
    // Phiên hết hạn giữa chừng (API trả 401) → quay về màn hình đăng nhập.
    return onUnauthorized(() => location.reload())
  }, [])
  if (error) return <div className="login"><div className="notice err">Không kết nối được server: {error}</div></div>
  if (!auth) return null
  if (auth.required && !auth.authenticated) return <Login state={auth} onDone={() => location.reload()} />
  return <Shell />
}

function Shell() {
  const { page, arg } = useHash()
  const conn = useConnectionState()
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Hahaness</div>
        {PAGES.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={page === id ? "active" : undefined}>
            {label}
          </a>
        ))}
        <div className="foot">
          <span className={`dot ${conn === "open" ? "on" : conn === "closed" ? "err" : ""}`} />
          {conn === "open" ? "Đã kết nối" : conn === "closed" ? "Mất kết nối server" : "Đang kết nối…"}
        </div>
      </nav>
      <main className="main">
        {page === "chat" && <Chat sessionID={arg || undefined} />}
        {page === "results" && <Results path={arg || undefined} />}
        {page === "knowledge" && <Knowledge />}
        {page === "skills" && <Skills />}
        {page === "schedules" && <Schedules id={arg || undefined} />}
        {page === "mcp" && <Mcp />}
        {page === "settings" && <Settings />}
      </main>
    </div>
  )
}
