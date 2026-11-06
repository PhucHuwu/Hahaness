import type { DocumentStore } from "../context/documents.ts"
import type { Part } from "../core/types.ts"
import { extract, kindOf } from "./extract.ts"

/**
 * File CEO gửi kèm tin nhắn (web hoặc Telegram):
 * - PDF/Excel/Word/văn bản → chữ, lưu thành tài liệu `uploads/<tên>.md` để CTO và nhân viên `read`/`search`.
 *   Nội dung ngắn được đưa luôn vào tin nhắn; nội dung dài chỉ kèm phần đầu và path.
 * - Ảnh → part `image` trong tin nhắn, model nhìn trực tiếp. Không lưu thành tài liệu.
 * Khối `<attachments>` là một text part riêng; UI hiện nó thành danh sách file.
 */

export interface UploadFile {
  name: string
  mime?: string
  data: Buffer
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const INLINE_CHARS = 12_000
const PREVIEW_CHARS = 2_000

export class UploadError extends Error {}

export async function attach(docs: DocumentStore, files: UploadFile[], author = "ceo"): Promise<Part[]> {
  const images: Part[] = []
  const entries: string[] = []
  for (const f of files) {
    const name = clean(f.name)
    const kind = kindOf(name, f.mime)
    if (!kind) throw new UploadError(`Chưa đọc được loại file "${name}". Hỗ trợ: PDF, Excel (.xlsx), Word (.docx), CSV/TXT, ảnh PNG/JPG/WEBP/GIF.`)
    if (f.data.length > MAX_FILE_BYTES) throw new UploadError(`File "${name}" lớn hơn 20 MB.`)
    if (kind === "image") {
      if (f.data.length > MAX_IMAGE_BYTES) throw new UploadError(`Ảnh "${name}" lớn hơn 5 MB.`)
      images.push({ type: "image", mime: imageMime(name, f.mime), data: f.data.toString("base64") })
      entries.push(`<file name="${attrEscape(name)}" kind="image">(image attached below)</file>`)
      continue
    }
    let out
    try {
      out = await extract(name, f.data, kind)
    } catch (e) {
      throw new UploadError(`Không đọc được "${name}": ${(e as Error).message}. File có thể bị hỏng hoặc có mật khẩu.`)
    }
    const path = freePath(docs, `uploads/${name.replace(/\.(md|txt)$/i, "")}.md`)
    docs.put(path, `# ${name}\n\n${out.text}`, author)
    const lines = out.text.split("\n").length
    const body =
      out.text.length <= INLINE_CHARS
        ? out.text
        : `${out.text.slice(0, PREVIEW_CHARS)}\n[… ${lines} lines total. Read the rest with read("${path}", offset, limit) or search it.]`
    entries.push(`<file name="${attrEscape(name)}" path="${path}" summary="${attrEscape(out.summary)}">\n${body}\n</file>`)
  }
  if (entries.length === 0) return []
  return [{ type: "text", text: `<attachments>\nThe CEO attached these files. Text files are also saved as documents (path) that employees can read.\n${entries.join("\n")}\n</attachments>` }, ...images]
}

function clean(name: string) {
  const base = name.replaceAll("\\", "/").split("/").pop()!.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim()
  return (base || "file").slice(0, 120)
}

function freePath(docs: DocumentStore, path: string) {
  if (!docs.has(path)) return path
  const stem = path.replace(/\.md$/, "")
  for (let i = 2; ; i++) if (!docs.has(`${stem} (${i}).md`)) return `${stem} (${i}).md`
}

function imageMime(name: string, mime?: string) {
  if (mime && /^image\/(png|jpeg|gif|webp)$/.test(mime)) return mime
  const ext = name.toLowerCase().split(".").pop()
  return ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg"
}

function attrEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
