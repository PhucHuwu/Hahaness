export type Effect = "allow" | "ask" | "deny"

export interface Rule {
  action: string
  resource: string
  effect: Effect
}

export type Ruleset = Rule[]

function glob(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$")
  return re.test(value)
}

function matches(rule: Rule, action: string, resource: string) {
  return glob(rule.action, action) && glob(rule.resource, resource)
}

/** Last-match-wins; không rule nào match → ask. */
export function evaluate(rules: Ruleset, action: string, resource: string): Effect {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!
    if (matches(r, action, resource)) return r.effect
  }
  return "ask"
}

/**
 * Có rule deny nào match không. Deny chỉ bị gỡ bởi một rule allow ĐỨNG SAU, cùng action
 * và hẹp hơn hẳn (`write * deny` rồi `write drafts/* allow`) — đó là ngoại lệ có chủ ý.
 * Allow rộng hơn hoặc đứng trước không gỡ được. Saved approval không vượt qua cái này.
 */
export function denied(rules: Ruleset, action: string, resource: string): boolean {
  return rules.some(
    (r, i) =>
      r.effect === "deny" &&
      matches(r, action, resource) &&
      !rules.slice(i + 1).some((a) => a.effect === "allow" && a.action === r.action && narrower(a.resource, r.resource) && matches(a, action, resource)),
  )
}

/** `inner` là pattern hẹp hơn hẳn `outer` dạng `prefix*`. */
function narrower(inner: string, outer: string): boolean {
  if (inner === outer || !outer.endsWith("*") || outer.slice(0, -1).includes("*")) return false
  return inner.startsWith(outer.slice(0, -1))
}

/**
 * Deny toàn phần (`action * deny`) đặt lên đầu, để các allow hẹp hơn cùng action trong
 * cùng file làm ngoại lệ. Sửa dữ liệu cũ kiểu `drafts/* allow` rồi `* deny` (allow chết).
 */
export function hoistBroadDenies(rules: Ruleset): Ruleset {
  const broad = (r: Rule) => r.effect === "deny" && r.resource === "*" && r.action !== "*"
  return [...rules.filter(broad), ...rules.filter((r) => !broad(r))]
}

/** Tool bị `deny *` cho action của nó → loại khỏi definitions gửi model. */
export function whollyDisabled(rules: Ruleset, action: string): boolean {
  return evaluate(rules, action, "*") === "deny" && !rules.some((r) => r.action === action && r.effect !== "deny")
}

/** Child không được allow thứ parent deny. */
export function inherit(parent: Ruleset, child: Ruleset): Ruleset {
  return [...child, ...parent.filter((r) => r.effect === "deny")]
}
