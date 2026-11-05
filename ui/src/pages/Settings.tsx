import { useEffect, useState } from "react"
import { api, type Config, type ConfigView, type ProviderConfig } from "../api.ts"

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
