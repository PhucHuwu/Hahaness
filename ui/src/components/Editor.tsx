import { useEffect, useState } from "react"

/** Textarea + Lưu/Xóa với trạng thái bẩn, lỗi, đang lưu. Dùng cho mọi file markdown trong UI. */
export function Editor({
  title,
  hint,
  initial,
  readOnly,
  onSave,
  onDelete,
  deleteLabel = "Xóa",
}: {
  title: string
  hint?: string
  initial: string
  readOnly?: boolean
  onSave: (text: string) => Promise<void>
  onDelete?: () => Promise<void>
  deleteLabel?: string
}) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [savedAt, setSavedAt] = useState<number>()
  useEffect(() => setText(initial), [initial])
  const dirty = text !== initial

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onSave(text)
      setSavedAt(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!onDelete) return
    setBusy(true)
    try {
      await onDelete()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ height: "100%", minHeight: 0 }}>
      <div className="row between">
        <h2 className="mono">{title}</h2>
        <div className="row">
          {onDelete && (
            <button className="btn small danger" onClick={remove} disabled={busy}>
              {deleteLabel}
            </button>
          )}
          <button className="btn small primary" onClick={save} disabled={busy || !dirty || readOnly}>
            {busy ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
      </div>
      {hint && <div className="small muted">{hint}</div>}
      {error && <div className="notice err small">{error}</div>}
      <textarea className="editor grow" value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="small muted">
        {dirty ? "Chưa lưu." : savedAt ? `Đã lưu ${new Date(savedAt).toLocaleTimeString()}.` : `${text.length} ký tự.`}
        {" "}Phiên chat đang mở không thấy thay đổi này; phiên mới sẽ thấy.
      </div>
    </div>
  )
}
