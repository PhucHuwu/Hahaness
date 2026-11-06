/**
 * Cron 5 trường (phút giờ ngày tháng thứ) theo giờ máy chủ. Hỗ trợ `*`, `a-b`, `*\/n`, `a-b/n`,
 * danh sách `a,b`, tên tháng/thứ (jan, mon…), 7 = Chủ nhật, và @hourly/@daily/@weekly/@monthly/@yearly.
 * Ngày-trong-tháng và thứ cùng bị giới hạn → khớp một trong hai (như Vixie cron).
 */
export interface Cron {
  expr: string
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const FIELDS = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day of month", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12, names: MONTHS, base: 1 },
  { name: "day of week", lo: 0, hi: 7, names: DAYS, base: 0 },
] as const

function parseField(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>()
  const num = (s: string) => {
    const names = "names" in f ? f.names : undefined
    const i = names?.indexOf(s.toLowerCase() as never) ?? -1
    if (i >= 0) return i + ("base" in f ? f.base : 0)
    if (!/^\d+$/.test(s)) throw new Error(`invalid ${f.name} "${s}"`)
    return Number(s)
  }
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/")
    if (extra !== undefined || !range) throw new Error(`invalid ${f.name} "${part}"`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${f.name} "${part}"`)
    let a: number
    let b: number
    if (range === "*") [a, b] = [f.lo, f.hi]
    else if (range.includes("-")) {
      const [x, y] = range.split("-")
      a = num(x!)
      b = num(y!)
    } else {
      a = num(range)
      b = stepText === undefined ? a : f.hi
    }
    if (a < f.lo || b > f.hi || a > b) throw new Error(`${f.name} "${part}" out of range ${f.lo}-${f.hi}`)
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): Cron {
  const text = expr.trim().replace(/\s+/g, " ")
  const fields = (ALIASES[text.toLowerCase()] ?? text).split(" ")
  if (fields.length !== 5) throw new Error(`cron needs 5 fields "minute hour day-of-month month day-of-week" (e.g. "0 2 * * *" = every day at 02:00), got "${expr}"`)
  const [minute, hour, dom, month, dow] = fields.map((t, i) => parseField(t, FIELDS[i]!))
  if (dow!.delete(7)) dow!.add(0)
  return {
    expr: text,
    minute: minute!,
    hour: hour!,
    dom: dom!,
    month: month!,
    dow: dow!,
    domRestricted: !fields[2]!.startsWith("*"),
    dowRestricted: !fields[4]!.startsWith("*"),
  }
}

function dayMatches(c: Cron, d: Date) {
  const dom = c.dom.has(d.getDate())
  const dow = c.dow.has(d.getDay())
  if (c.domRestricted && c.dowRestricted) return dom || dow
  if (c.domRestricted) return dom
  if (c.dowRestricted) return dow
  return true
}

/** Lần khớp đầu tiên SAU `after` (ms), theo giờ địa phương. */
export function nextRun(cron: Cron | string, after: number): number {
  const c = typeof cron === "string" ? parseCron(cron) : cron
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = after + 5 * 366 * 86_400_000
  for (let guard = 0; guard < 100_000 && d.getTime() <= limit; guard++) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
    } else return d.getTime()
  }
  throw new Error(`cron "${c.expr}" never matches`)
}

export function upcoming(cron: Cron | string, from: number, n = 3): number[] {
  const c = typeof cron === "string" ? parseCron(cron) : cron
  const out: number[] = []
  let t = from
  for (let i = 0; i < n; i++) out.push((t = nextRun(c, t)))
  return out
}

export function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** "2026-11-07 02:00 (Asia/Ho_Chi_Minh)" — cho model và log, không phụ thuộc locale. */
export function formatLocal(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
