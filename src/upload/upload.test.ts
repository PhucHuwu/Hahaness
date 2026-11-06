import { test } from "node:test"
import assert from "node:assert/strict"
import { crc32, deflateRawSync } from "node:zlib"
import { Db } from "../core/db.ts"
import { DocumentStore } from "../context/documents.ts"
import { extract, kindOf } from "./extract.ts"
import { attach, UploadError } from "./attachments.ts"
import { unzip } from "./zip.ts"

/** Zip tối giản (deflate) để dựng xlsx/docx trong test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8")
    const data = deflateRawSync(raw)
    const n = Buffer.from(name, "utf8")
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const xlsx = () =>
  zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Doanh thu" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Tháng</t></si><si><t>Doanh thu</t></si><si><r><t>Tháng </t></r><r><t>1</t></r></si><si><t>A &amp; B, "C"</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500000</v></c></row>
      <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="inlineStr"><is><t>ghi chú</t></is></c></row>
    </sheetData></worksheet>`,
  })

const docx = () =>
  zip({
    "word/document.xml": `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Kế hoạch</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Mục tiêu: </w:t></w:r><w:r><w:t>tăng 20%</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Kênh</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ngân sách</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`,
  })

/** PDF một trang có chữ, offset xref tính đúng. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

test("upload: file kinds by extension and mime", () => {
  assert.equal(kindOf("Báo cáo.PDF"), "pdf")
  assert.equal(kindOf("x.xlsx"), "excel")
  assert.equal(kindOf("x.docx"), "word")
  assert.equal(kindOf("x.csv"), "text")
  assert.equal(kindOf("photo", "image/jpeg"), "image")
  assert.equal(kindOf("x.doc"), undefined)
  assert.equal(kindOf("x.exe"), undefined)
})

test("upload: Excel → CSV per sheet with shared strings, inline strings, gaps and escaping", async () => {
  assert.ok(unzip(xlsx()).has("xl/workbook.xml"))
  const out = await extract("dt.xlsx", xlsx(), "excel")
  assert.match(out.text, /## Sheet: Doanh thu \(3 dòng\)\nTháng,Doanh thu\nTháng 1,1500000\n"A & B, ""C""",,ghi chú/)
  assert.equal(out.summary, "Excel, 1 sheet, 3 dòng")
})

test("upload: Word → headings, paragraphs and tables as text", async () => {
  const out = await extract("kh.docx", docx(), "word")
  assert.equal(out.text, "# Kế hoạch\nMục tiêu: tăng 20%\n| Kênh | Ngân sách |")
})

test("upload: PDF text is extracted page by page", async () => {
  const out = await extract("a.pdf", pdf("Revenue grew 20 percent"), "pdf")
  assert.match(out.text, /--- Trang 1 ---\nRevenue grew 20 percent/)
  assert.equal(out.summary, "PDF, 1 trang")
})

test("upload: attach saves text files under uploads/, inlines short ones, previews long ones, passes images through", async () => {
  const db = new Db(":memory:")
  try {
    const docs = new DocumentStore(db)
    const long = Array.from({ length: 3000 }, (_, i) => `row ${i},${i * 2}`).join("\n")
    const parts = await attach(docs, [
      { name: "dt.xlsx", data: xlsx() },
      { name: "../../big.csv", data: Buffer.from(long) },
      { name: "logo.png", mime: "image/png", data: Buffer.from("png-bytes") },
    ])
    assert.equal(parts.length, 2)
    const block = parts[0]!.type === "text" ? parts[0]!.text : ""
    assert.match(block, /^<attachments>/)
    assert.match(block, /<file name="dt.xlsx" path="uploads\/dt.xlsx.md" summary="Excel, 1 sheet, 3 dòng">\n## Sheet/)
    assert.match(block, /path="uploads\/big.csv.md"[\s\S]*Read the rest with read\("uploads\/big.csv.md"/)
    assert.ok(!block.includes("row 2999"), "long files are previewed, not inlined")
    assert.match(docs.get("uploads/big.csv.md")!.content, /row 2999,5998/)
    assert.deepEqual(parts[1], { type: "image", mime: "image/png", data: Buffer.from("png-bytes").toString("base64") })
    // Gửi lại cùng tên → không ghi đè.
    await attach(docs, [{ name: "dt.xlsx", data: xlsx() }])
    assert.ok(docs.has("uploads/dt.xlsx (2).md"))
    await assert.rejects(attach(docs, [{ name: "x.exe", data: Buffer.from("x") }]), UploadError)
    await assert.rejects(attach(docs, [{ name: "bad.xlsx", data: Buffer.from("not a zip") }]), /Không đọc được "bad.xlsx"/)
  } finally {
    db.close()
  }
})
