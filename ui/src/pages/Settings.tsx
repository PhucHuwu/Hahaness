import { useEffect, useState } from "react"
import { AccountCard } from "./Login.tsx"
import { api, type Config, type ConfigView, type LicenseView, type ProviderConfig, type TelegramStatus, type UpdateState } from "../api.ts"

export function Settings() {
  const [view, setView] = useState<ConfigView>()
  const [config, setConfig] = useState<Config>({ providers: {} })
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string>()
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "err"; text?: string }>({ state: "idle" })

  const load = async () => {
    try {
      const v = await api.get<ConfigView>("/api/config")
      setView(v)
      setConfig(v.config)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => void load(), [])

  const save = async () => {
    setSaving(true)
    setSaved(undefined)
    try {
      const r = await api.put<{ providerError: string | null }>("/api/config", config)
      setSaved("Đã lưu")
      await load()
      if (r.providerError) setError(r.providerError)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    setTest({ state: "running" })
    try {
      const r = await api.post<{ model: string; reply: string; ms: number }>("/api/config/test", { model: config.defaultModel })
      setTest({ state: "ok", text: `${r.model} trả lời "${r.reply}" sau ${r.ms}ms` })
    } catch (e) {
      setTest({ state: "err", text: (e as Error).message })
    }
  }

  const setProvider = (id: string, p: ProviderConfig | undefined) => {
    const providers = { ...config.providers }
    if (p) providers[id] = p
    else delete providers[id]
    setConfig({ ...config, providers })
  }
  const rename = (from: string, to: string) => {
    if (!to || to === from || config.providers[to]) return
    const providers: Record<string, ProviderConfig> = {}
    for (const [k, v] of Object.entries(config.providers)) providers[k === from ? to : k] = v
    setConfig({ ...config, providers })
  }
  const addProvider = () => {
    let id = "openai"
    let n = 2
    while (config.providers[id]) id = `provider-${n++}`
    setProvider(id, { type: "openai" })
  }

  const dirty = view && JSON.stringify(config) !== JSON.stringify(view.config)

  return (
    <div className="page">
      <header>
        <h1>Cài đặt</h1>
        <p>Provider và model mà CTO cùng nhân viên dùng.</p>
      </header>
      {error && <div className="notice err" style={{ marginBottom: 16 }}>{error}</div>}
      {!view && !error && <div className="empty">Đang tải…</div>}
      {view && (
        <div className="stack" style={{ maxWidth: 760 }}>
          <div className="card stack">
            <div className="row between">
              <h2>Model mặc định</h2>
              <span className="small muted mono" title="Toàn bộ dữ liệu công ty nằm trong file này">{view.db}</span>
            </div>
            <label className="field">
              Dạng <code>provider/model</code>, ví dụ <code>openai/gpt-4.1</code>
              <input type="text" value={config.defaultModel ?? ""} placeholder="openai/gpt-4.1" onChange={(e) => setConfig({ ...config, defaultModel: e.target.value || undefined })} />
            </label>
            {view.env.HAHANESS_MODEL && <div className="small muted">Biến môi trường HAHANESS_MODEL={view.env.HAHANESS_MODEL} đang ghi đè giá trị này.</div>}
            <label className="field">
              Model dự phòng: dùng khi model chính lỗi hẳn (hết lượt thử lại, quota, key sai). Mỗi dòng một model, thử theo thứ tự.
              <textarea
                rows={2}
                className="mono"
                value={(config.fallbackModels ?? []).join("\n")}
                placeholder="anthropic/claude-sonnet-4-5"
                onChange={(e) => {
                  const list = e.target.value.split("\n").map((s) => s.trim())
                  setConfig({ ...config, fallbackModels: list.some(Boolean) ? list : undefined })
                }}
                onBlur={() => setConfig({ ...config, fallbackModels: config.fallbackModels?.filter(Boolean).length ? config.fallbackModels.filter(Boolean) : undefined })}
              />
            </label>
            <div className="row">
              <button className="btn" onClick={runTest} disabled={test.state === "running" || !!dirty}>
                {test.state === "running" ? "Đang gọi model…" : "Gọi thử"}
              </button>
              {dirty && <span className="small muted">Lưu trước khi gọi thử.</span>}
              {test.state === "ok" && <span className="badge ok">{test.text}</span>}
              {test.state === "err" && <span className="small" style={{ color: "var(--err)" }}>{test.text}</span>}
            </div>
          </div>

          <div className="row between">
            <h2>Providers</h2>
            <button className="btn small" onClick={addProvider}>
              Thêm provider
            </button>
          </div>
          {Object.keys(config.providers).length === 0 && (
            <div className="card">
              <p>Chưa khai báo provider nào.</p>
              <p className="small muted">
                {view.env.OPENAI_API_KEY ? "Harness đang dùng OPENAI_API_KEY từ môi trường." : "Thêm một provider bên dưới, hoặc đặt biến môi trường OPENAI_API_KEY."}
              </p>
            </div>
          )}
          {Object.entries(config.providers).map(([id, p]) => (
            <ProviderCard key={id} id={id} p={p} onChange={(np) => setProvider(id, np)} onRename={(to) => rename(id, to)} onRemove={() => setProvider(id, undefined)} />
          ))}

          <div className="row">
            <button className="btn primary" onClick={save} disabled={saving || !dirty}>
              {saving ? "Đang lưu…" : "Lưu"}
            </button>
            {saved && <span className="small muted">{saved}</span>}
            {dirty && !saved && <span className="small muted">Có thay đổi chưa lưu.</span>}
          </div>
          <p className="small muted">Phiên chat đang mở vẫn dùng model cũ; phiên mới sẽ dùng cấu hình này.</p>
          <TelegramCard />
          <AccountCard />
          <LicenseCard />
          <UpdateCard />
        </div>
      )}
    </div>
  )
}

const positive = (v: string) => {
  const n = Math.floor(Number(v))
  return n > 0 ? n : undefined
}

function ProviderCard({ id, p, onChange, onRename, onRemove }: { id: string; p: ProviderConfig; onChange: (p: ProviderConfig) => void; onRename: (to: string) => void; onRemove: () => void }) {
  const [name, setName] = useState(id)
  useEffect(() => setName(id), [id])
  return (
    <div className="card stack">
      <div className="row between">
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => onRename(name.trim())} style={{ width: 180 }} className="mono" />
          <select
            value={p.type}
            onChange={(e) => onChange(e.target.value === "openai" || e.target.value === "anthropic" ? { type: e.target.value } : { type: "custom", module: "./examples/providers/echo.ts" })}
          >
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="custom">Custom module</option>
          </select>
        </div>
        <button className="btn small danger" onClick={onRemove}>
          Xóa
        </button>
      </div>
      {p.type === "openai" || p.type === "anthropic" ? (
        <>
          <label className="field">
            {p.type === "openai"
              ? "Base URL (bỏ trống = api.openai.com; điền URL của OpenRouter, Groq, Ollama, LM Studio…)"
              : "Base URL (bỏ trống = api.anthropic.com)"}
            <input
              type="url"
              value={p.baseURL ?? ""}
              placeholder={p.type === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
              onChange={(e) => onChange({ ...p, baseURL: e.target.value || undefined })}
            />
          </label>
          <label className="field">
            API key — dán nguyên key (vd <code>{p.type === "openai" ? "sk-…" : "sk-ant-…"}</code>). Đã lưu thì hiện <code>••••</code>; dán key mới để thay.
            <input
              type="text"
              className="mono"
              value={p.apiKey ?? ""}
              placeholder={p.type === "openai" ? "sk-…" : "sk-ant-…"}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => p.apiKey === "••••" && e.target.select()}
              onChange={(e) => onChange({ ...p, apiKey: e.target.value.trim() || undefined })}
            />
          </label>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              Context tối đa (token) — tự tóm tắt hội thoại khi gần chạm (~85%). Bỏ trống = {p.type === "openai" ? "128000" : "200000"}
              <input
                type="number"
                min={1}
                value={p.contextWindow ?? ""}
                placeholder={p.type === "openai" ? "128000" : "200000"}
                onChange={(e) => onChange({ ...p, contextWindow: positive(e.target.value) })}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              Trả lời tối đa (token). Bỏ trống = 16384
              <input type="number" min={1} value={p.maxOutput ?? ""} placeholder="16384" onChange={(e) => onChange({ ...p, maxOutput: positive(e.target.value) })} />
            </label>
          </div>
        </>
      ) : (
        <label className="field">
          Đường dẫn module (export default (options, {"{id, cwd}"}) =&gt; ProviderClient)
          <input type="text" className="mono" value={p.module} onChange={(e) => onChange({ ...p, module: e.target.value })} />
        </label>
      )}
    </div>
  )
}

/** Giấy phép gắn với mã cài đặt: CEO gửi mã cho nhà cung cấp, nhận key, dán vào đây. Hết hạn chỉ khoá mục trả phí trong chợ. */
function LicenseCard() {
  const [st, setSt] = useState<LicenseView>()
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const run = async (fn: () => Promise<LicenseView>) => {
    setBusy(true)
    setError(undefined)
    try {
      setSt(await fn())
      setKey("")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => void run(() => api.get<LicenseView>("/api/license")), [])
  const copy = async () => {
    if (!st) return
    await navigator.clipboard.writeText(st.instance)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const badge =
    st?.state === "valid" ? (
      <span className="badge ok">còn hạn</span>
    ) : st?.state === "expired" ? (
      <span className="badge err">hết hạn</span>
    ) : st?.state === "invalid" ? (
      <span className="badge err">không hợp lệ</span>
    ) : null

  return (
    <div className="card stack">
      <div className="row between">
        <h2>Giấy phép</h2>
        {badge}
      </div>
      <p className="small muted">Giấy phép mở các công cụ trả phí trong Chợ ứng dụng và là chìa khoá để công cụ của nhà cung cấp kết nối. Không có hay hết hạn thì hệ thống và các công cụ còn lại vẫn dùng bình thường.</p>
      {error && <div className="notice err small">{error}</div>}
      {st && (
        <>
          <div className="row wrap">
            <span className="small">Mã cài đặt (gửi cho nhà cung cấp để nhận giấy phép):</span>
            <code>{st.instance}</code>
            <button className="btn small" onClick={copy}>
              {copied ? "Đã chép" : "Chép"}
            </button>
          </div>
          {st.state !== "none" && (
            <div className="small">
              Gói <b>{st.plan}</b>
              {st.customer && <> cấp cho <b>{st.customer}</b></>}
              {st.expiresAt && (
                <>
                  , {st.state === "expired" ? "đã hết hạn" : "hết hạn"} ngày {new Date(st.expiresAt).toLocaleDateString("vi-VN")}
                  {st.state === "valid" && st.daysLeft !== null && <> (còn {st.daysLeft} ngày)</>}
                </>
              )}
              .{st.error && <> {st.error}</>}
            </div>
          )}
          <div className="row">
            <input type="text" className="mono grow" value={key} placeholder={st.state === "none" ? "HH1.…" : "Dán giấy phép mới để thay"} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" disabled={busy || !key.trim()} onClick={() => run(() => api.put<LicenseView>("/api/license", { key }))}>
              {busy ? "Đang kiểm tra…" : "Kích hoạt"}
            </button>
            {st.state !== "none" && (
              <button className="btn danger" disabled={busy} onClick={() => confirm("Gỡ giấy phép?") && run(() => api.delete<LicenseView>("/api/license"))}>
                Gỡ
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Bản đang chạy và bản mới nhất. Không tự cập nhật: người quản trị chạy `docker compose pull && up -d`. */
function UpdateCard() {
  const [st, setSt] = useState<UpdateState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (fn: () => Promise<UpdateState>) => {
    setBusy(true)
    setError(undefined)
    try {
      setSt(await fn())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => void run(() => api.get<UpdateState>("/api/updates")), [])

  return (
    <div className="card stack">
      <div className="row between">
        <h2>Phiên bản</h2>
        {st?.available ? <span className="badge warn">có bản mới</span> : st?.enabled && st.checkedAt && !st.error ? <span className="badge ok">mới nhất</span> : null}
      </div>
      {error && <div className="notice err small">{error}</div>}
      {st && (
        <div className="row between">
          <span>
            Đang chạy <b className="mono">{st.current}</b>
            {st.available && st.latest && (
              <>
                , bản mới nhất <b className="mono">{st.latest.version}</b>
                {st.latest.url && (
                  <>
                    {" "}
                    (<a href={st.latest.url} target="_blank" rel="noreferrer">ghi chú phát hành</a>)
                  </>
                )}
              </>
            )}
            .
          </span>
          {st.enabled && (
            <button className="btn small" disabled={busy} onClick={() => run(() => api.post<UpdateState>("/api/updates/check"))}>
              {busy ? "Đang kiểm tra…" : "Kiểm tra ngay"}
            </button>
          )}
        </div>
      )}
      {st?.error && <div className="small" style={{ color: "var(--err)" }}>Không kiểm tra được bản mới: {st.error}</div>}
      {st && !st.enabled && <div className="small muted">Đã tắt kiểm tra bản mới (HAHANESS_UPDATE_URL=off).</div>}
      {st?.available && (
        <div className="small muted">
          Để cập nhật, người quản trị chạy trên máy chủ: <code>docker compose pull &amp;&amp; docker compose up -d</code>. Nên sao lưu dữ liệu trước.
        </div>
      )}
      {st?.enabled && st.checkedAt && <div className="small muted">Kiểm tra lần cuối: {new Date(st.checkedAt).toLocaleString("vi-VN")}. Tự kiểm tra mỗi ngày.</div>}
    </div>
  )
}

/** Chat với CTO qua bot Telegram: dán token từ @BotFather, rồi gửi mã ghép nối cho bot. */
function TelegramCard() {
  const [st, setSt] = useState<TelegramStatus>()
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (fn: () => Promise<TelegramStatus>) => {
    setBusy(true)
    setError(undefined)
    try {
      setSt(await fn())
      setToken("")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => void run(() => api.get<TelegramStatus>("/api/telegram")), [])
  // Chờ CEO gửi mã cho bot → tự cập nhật khi đã liên kết.
  useEffect(() => {
    if (!st?.pairCode) return
    const t = setInterval(() => void api.get<TelegramStatus>("/api/telegram").then(setSt, () => {}), 3000)
    return () => clearInterval(t)
  }, [st?.pairCode])

  return (
    <div className="card stack">
      <div className="row between">
        <h2>Telegram</h2>
        {st?.linked ? <span className="badge ok">đã liên kết</span> : st?.configured ? <span className="badge">chờ liên kết</span> : null}
      </div>
      <p className="small muted">Nhắn với CTO qua Telegram như trên web. CTO trả lời, hỏi bạn và báo việc xong cũng qua đó, kể cả khi bạn không mở web.</p>
      {error && <div className="notice err small">{error}</div>}
      {st?.error && <div className="notice err small">Lỗi kết nối Telegram: {st.error}</div>}
      {st?.linked && (
        <div className="row between">
          <span>
            Bot <b>@{st.bot}</b> đang nói chuyện với <b>{st.linked}</b>.
          </span>
          <button className="btn small" disabled={busy} onClick={() => run(() => api.post<TelegramStatus>("/api/telegram/unlink"))}>
            Đổi người dùng
          </button>
        </div>
      )}
      {st?.configured && !st.linked && st.pairCode && (
        <div className="stack">
          <div>
            Mở Telegram, tìm bot {st.bot ? <a href={`https://t.me/${st.bot}?start=${st.pairCode}`} target="_blank" rel="noreferrer">@{st.bot}</a> : "của bạn"} và bấm <b>Start</b>, hoặc gửi cho bot mã:
          </div>
          <code style={{ fontSize: 20 }}>{st.pairCode}</code>
          <div className="small muted">Trang này tự cập nhật khi liên kết xong. Chỉ người gửi đúng mã mới chat được với CTO.</div>
        </div>
      )}
      {!st?.configured && (
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Trong Telegram, nhắn cho <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> lệnh <code>/newbot</code>, đặt tên cho bot.</li>
          <li>BotFather gửi lại một token dạng <code>123456:ABC…</code>. Dán vào ô dưới và bấm Kết nối.</li>
        </ol>
      )}
      <div className="row">
        <input type="text" className="mono grow" value={token} placeholder={st?.configured ? "Dán token mới để đổi bot" : "123456789:ABC…"} autoComplete="off" spellCheck={false} onChange={(e) => setToken(e.target.value)} />
        <button className="btn primary" disabled={busy || !token.trim()} onClick={() => run(() => api.put<TelegramStatus>("/api/telegram", { token }))}>
          {busy ? "Đang kết nối…" : "Kết nối"}
        </button>
        {st?.configured && (
          <button className="btn danger" disabled={busy} onClick={() => confirm("Ngắt kết nối Telegram?") && run(() => api.delete<TelegramStatus>("/api/telegram"))}>
            Ngắt
          </button>
        )}
      </div>
    </div>
  )
}
