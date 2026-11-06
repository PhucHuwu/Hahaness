import { unzip } from "./zip.ts"

/**
 * Chuyển file CEO gửi lên thành chữ để agent đọc được bằng `read`/`search`.
 * PDF dùng `unpdf`; Excel/Word là zip + XML nên đọc bằng `node:zlib`; CSV/TXT/MD/JSON giữ nguyên.
 * Ảnh không đi qua đây: gửi thẳng cho model (xem `attachments.ts`).
 * Xem `docs/architecture/14-uploads.md`.
 */

export type Kind = "pdf" | "excel" | "word" | "text" | "image"

export function kindOf(name: string, mime = ""): Kind | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  if (ext === "pdf" || mime === "application/pdf") return "pdf"
  if (ext === "xlsx" || ext === "xlsm" || mime.includes("spreadsheetml")) return "excel"
  if (ext === "docx" || mime.includes("wordprocessingml")) return "word"
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext) || /^image\/(png|jpeg|gif|webp)$/.test(mime)) return "image"
  if (["txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml", "log"].includes(ext) || mime.startsWith("text/")) return "text"
  return undefined
}

export interface Extracted {
  text: string
  /** Mô tả ngắn cho agent, vd "PDF, 12 trang". */
  summary: string
}

export async function extract(name: string, data: Buffer, kind: Exclude<Kind, "image">): Promise<Extracted> {
  if (kind === "pdf") return pdf(data)
  if (kind === "excel") return excel(data)
  if (kind === "word") return word(data)
  const text = data.toString("utf8").replace(/^\uFEFF/, "")
  return { text, summary: `${text.split("\n").length} dòng` }
}

async function pdf(data: Buffer): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const doc = await getDocumentProxy(new Uint8Array(data))
  const { totalPages, text } = await extractText(doc, { mergePages: false })
  const body = text.map((t, i) => `--- Trang ${i + 1} ---\n${t.trim()}`).join("\n\n")
  const empty = text.every((t) => !t.trim())
  return {
    text: empty ? "(PDF này không có lớp chữ, có thể là ảnh scan. Cần gửi lại dạng ảnh để đọc.)" : body,
    summary: `PDF, ${totalPages} trang${empty ? ", không có chữ (bản scan)" : ""}`,
  }
}

// ---- XML tối giản cho OOXML ----------------------------------------------------

function decode(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
}

function attr(tag: string, name: string) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

/** Nối mọi `<t>` (hoặc `<w:t>`) trong một đoạn XML. */
function texts(xml: string, prefix = "") {
  const re = new RegExp(`<${prefix}t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}t>`, "g")
  let out = ""
  for (const m of xml.matchAll(re)) out += decode(m[1]!)
  return out
}

function excel(data: Buffer): Extracted {
  const zip = unzip(data)
  const read = (p: string) => zip.get(p)?.().toString("utf8")
  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!))
  const rels = new Map([...(read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]))
  const sheets = [...(read("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(attr(m[0], "r:id")) ?? ""
    return { name: decode(attr(m[0], "name") ?? "Sheet"), path: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}` }
  })
  const parts: string[] = []
  let total = 0
  for (const sh of sheets) {
    const xml = read(sh.path)
    if (!xml) continue
    const rows: string[][] = []
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row: string[] = []
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1]!, "r")
        const col = ref ? colIndex(ref) : row.length
        const type = attr(c[1]!, "t")
        const inner = c[2] ?? ""
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        let value = ""
        if (type === "s") value = shared[Number(v)] ?? ""
        else if (type === "inlineStr") value = texts(inner)
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE"
        else if (v !== undefined) value = decode(v)
        while (row.length < col) row.push("")
        row[col] = value
      }
      rows.push(row)
    }
    while (rows.length && rows.at(-1)!.every((c) => !c)) rows.pop()
    total += rows.length
    parts.push(`## Sheet: ${sh.name} (${rows.length} dòng)\n${rows.map((r) => r.map(csvCell).join(",")).join("\n")}`)
  }
  return {
    text: parts.join("\n\n") + (parts.length ? "\n\n(Ngày tháng trong Excel có thể hiện dạng số serial: 45000 = 2023-03-15.)" : ""),
    summary: `Excel, ${sheets.length} sheet, ${total} dòng`,
  }
}

function colIndex(ref: string) {
  let n = 0
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function word(data: Buffer): Extracted {
  const zip = unzip(data)
  const xml = zip.get("word/document.xml")?.().toString("utf8")
  if (!xml) throw new Error("not a Word document")
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml
  const para = (p: string) => texts(p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>"), "w:")
  const out: string[] = []
  // Bảng → mỗi hàng một dòng, ô cách nhau bằng " | ".
  for (const m of body.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    if (m[1] !== undefined) {
      for (const tr of m[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells = [...tr[1]!.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((tc) => [...tc[1]!.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((p) => para(p[1]!)).join(" ").trim())
        out.push(`| ${cells.join(" | ")} |`)
      }
      continue
    }
    const inner = m[2] ?? ""
    const style = /<w:pStyle w:val="([^"]*)"/.exec(inner)?.[1] ?? ""
    const text = para(inner)
    const h = /^(?:Heading|Title)(\d?)$/i.exec(style)
    out.push(h && text ? `${"#".repeat(Number(h[1] || 1))} ${text}` : text)
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  return { text, summary: `Word, ${text.split(/\s+/).filter(Boolean).length} từ` }
}
