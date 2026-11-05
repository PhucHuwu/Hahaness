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

/** Có rule deny nào match không, bất kể thứ tự. Saved approval không được vượt qua cái này. */
export function denied(rules: Ruleset, action: string, resource: string): boolean {
  return rules.some((r) => r.effect === "deny" && matches(r, action, resource))
}

/** Tool bị `deny *` cho action của nó → loại khỏi definitions gửi model. */
export function whollyDisabled(rules: Ruleset, action: string): boolean {
  return evaluate(rules, action, "*") === "deny" && !rules.some((r) => r.action === action && r.effect !== "deny")
}

/** Child không được allow thứ parent deny. */
export function inherit(parent: Ruleset, child: Ruleset): Ruleset {
  return [...child, ...parent.filter((r) => r.effect === "deny")]
}
