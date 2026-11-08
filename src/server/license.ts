import { createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto"
import type { Db } from "../core/db.ts"

/**
 * Giấy phép: chuỗi `HH1.<payload>.<chữ ký>` (base64url), payload JSON ký Ed25519 bằng khoá riêng của
 * nhà cung cấp; khoá công khai nhúng trong image nên instance kiểm tra offline, không gọi về đâu.
 * - Gắn với mã cài đặt (`instance`, xem `19-updates.md`): key của khách này không dùng được cho khách khác.
 * - Hết hạn chỉ khoá nút Cài các mục `requiresLicense` trong chợ, không khoá app hay tool đã cài.
 * - Ký key bằng `npx tsx scripts/license.ts sign …` (khoá riêng không nằm trong repo).
 * Xem `docs/architecture/21-license.md`.
 */

export const PREFIX = "HH1"

/** Khoá công khai của nhà cung cấp (SPKI DER, base64). Đổi bằng `scripts/license.ts keygen` rồi dán vào đây. */
export const VENDOR_PUBLIC_KEY = "MCowBQYDK2VwAyEAGSBaapoJlv9Mi24hduxwfN+uBnn4hTpbfOia1tRQuQg="

export interface LicensePayload {
  /** Mã cài đặt mà key này cấp cho. */
  instance: string
  plan: string
  customer?: string
  issuedAt: string
  /** ISO date; sau ngày này key hết hạn. */
  expiresAt: string
}

export interface LicenseStatus {
  /** `none`: chưa nhập; `invalid`: sai chữ ký hoặc khác mã cài đặt; `expired`; `valid`. */
  state: "none" | "valid" | "expired" | "invalid"
  plan: string | null
  customer: string | null
  expiresAt: string | null
  /** Số ngày còn lại (âm khi đã hết hạn). */
  daysLeft: number | null
  error: string | null
}

const b64u = {
  encode: (b: Buffer | string) => Buffer.from(b).toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url"),
}

export function publicKeyFrom(base64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" })
}

export function privateKeyFrom(pem: string): KeyObject {
  return createPrivateKey(pem)
}

/** Sinh cặp khoá: public (base64 SPKI, dán vào VENDOR_PUBLIC_KEY) và private (PEM, giữ kín). */
export function keygen() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  }
}

export function signLicense(payload: LicensePayload, privateKey: KeyObject): string {
  const body = b64u.encode(JSON.stringify(payload))
  const sig = sign(null, Buffer.from(body), privateKey)
  return `${PREFIX}.${body}.${b64u.encode(sig)}`
}

/** Giải mã và kiểm chữ ký; ném lỗi (tiếng Việt, hiện thẳng cho CEO) khi key hỏng. Không kiểm hạn hay instance. */
export function parseLicense(key: string, publicKey: KeyObject): LicensePayload {
  const parts = key.trim().split(".")
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error("Mã giấy phép không đúng định dạng.")
  const [, body, sig] = parts as [string, string, string]
  if (!verify(null, Buffer.from(body), publicKey, b64u.decode(sig))) throw new Error("Chữ ký giấy phép không hợp lệ.")
  let p: unknown
  try {
    p = JSON.parse(b64u.decode(body).toString("utf8"))
  } catch {
    throw new Error("Nội dung giấy phép hỏng.")
  }
  const o = p as Record<string, unknown>
  if (typeof o.instance !== "string" || typeof o.plan !== "string" || typeof o.expiresAt !== "string" || Number.isNaN(Date.parse(o.expiresAt))) {
    throw new Error("Nội dung giấy phép thiếu trường.")
  }
  return { instance: o.instance, plan: o.plan, customer: typeof o.customer === "string" ? o.customer : undefined, issuedAt: typeof o.issuedAt === "string" ? o.issuedAt : "", expiresAt: o.expiresAt }
}

export interface LicenseStoreOptions {
  db: Db
  instance: string
  /** Base64 SPKI; mặc định VENDOR_PUBLIC_KEY (test dùng khoá riêng). */
  publicKey?: string
  now?: () => Date
}

/** Lưu key trong settings (`license`) và tính trạng thái. */
export class LicenseStore {
  private readonly pub: KeyObject
  constructor(private opts: LicenseStoreOptions) {
    this.pub = publicKeyFrom(opts.publicKey ?? VENDOR_PUBLIC_KEY)
  }

  key(): string | undefined {
    return this.opts.db.getSetting<{ key: string }>("license")?.key
  }

  status(): LicenseStatus {
    const none: LicenseStatus = { state: "none", plan: null, customer: null, expiresAt: null, daysLeft: null, error: null }
    const key = this.key()
    if (!key) return none
    try {
      return this.evaluate(parseLicense(key, this.pub))
    } catch (e) {
      return { ...none, state: "invalid", error: (e as Error).message }
    }
  }

  /** Chợ chỉ mở mục trả phí khi còn hạn. */
  active() {
    return this.status().state === "valid"
  }

  /** Kiểm tra rồi mới lưu: key của instance khác hay chữ ký sai bị từ chối ngay, không ghi đè key cũ. */
  set(key: string): LicenseStatus {
    const payload = parseLicense(key, this.pub)
    if (payload.instance !== this.opts.instance) throw new Error("Giấy phép này cấp cho mã cài đặt khác.")
    this.opts.db.setSetting("license", { key: key.trim(), savedAt: new Date().toISOString() })
    return this.evaluate(payload)
  }

  clear() {
    this.opts.db.sql.prepare("DELETE FROM settings WHERE key = 'license'").run()
  }

  private evaluate(p: LicensePayload): LicenseStatus {
    const now = (this.opts.now ?? (() => new Date()))()
    const base = { plan: p.plan, customer: p.customer ?? null, expiresAt: p.expiresAt, error: null }
    if (p.instance !== this.opts.instance) return { ...base, state: "invalid", daysLeft: null, error: "Giấy phép này cấp cho mã cài đặt khác." }
    const daysLeft = Math.ceil((Date.parse(p.expiresAt) - now.getTime()) / 86_400_000)
    return { ...base, state: daysLeft >= 0 ? "valid" : "expired", daysLeft }
  }
}
