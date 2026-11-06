import { inflateRawSync } from "node:zlib"

/** Đọc file zip (xlsx/docx) chỉ bằng node:zlib. Không hỗ trợ zip64 và mã hoá. */
export function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("not a zip file")
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, () => Buffer>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip file")
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)
    out.set(name, () => {
      if (flags & 1) throw new Error("encrypted file")
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 200 * 1024 * 1024 })
      throw new Error(`unsupported zip compression ${method}`)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
