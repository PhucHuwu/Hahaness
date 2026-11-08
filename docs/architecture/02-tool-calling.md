# 02 — Tool calling

## Tool definition

```ts
import { z } from "zod"

export const read = Tool.define({
  name: "read",
  description: "Read a file...",
  input: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
  permission: { action: "read", resource: (i) => i.path },
  concurrency: "parallel",            // "parallel" | "serial"
  async execute(input, ctx) {
    // ctx: { sessionID, agent, signal, ask(), emit(), cwd }
    return { output: text, metadata: { lines } }
  },
})
```

- `input` is a zod schema → `z.toJSONSchema()` → normalize (inline `$defs`, flatten `allOf`, drop `MIN/MAX_SAFE_INTEGER`) so the definition is **byte-stable** across requests (cache).
- Validation error → no throw; return `ToolResult.error` to the model with at most 5 issues + the args that were sent (from opencode). The model fixes the call itself.
- `execute` returns `{ output: string; content?: Content[]; metadata?: object }`. `content` is for images/files (data URI).

## Result pipeline

```
model emits tool-call
  → validate(input)                     error → ToolResult.error, not executed
  → permission.evaluate(action, resource)
       deny  → ToolResult.error("denied")
       ask   → ctx.ask() blocks on a Deferred; reject with feedback → typed error for the model
       allow → continue
  → hooks.before(tool, input)           can modify input / block
  → execute(input, ctx) with timeout + signal
  → hooks.after(tool, result)
  → output.truncate(result)             2000 lines / 50 KiB → spill to file, insert footer
  → store.append(ToolResult)
```

### Truncation & spill (`tool/output.ts`)

- `MAX_LINES = 2000`, `MAX_BYTES = 50 * 1024`.
- Over the limit → save the full output to the hidden document `tool-output/<callID>.txt` (via the harness's `saveOutput` callback); the output ends with `[showing lines 1-N of M; full output saved to <path>, read it with offset/limit]`. The model calls `read` again with an offset.
- The `bash` tool uses `tail` mode (`metadata.tail`): keeps the end instead of the start (errors and results are usually at the end).

## Permission (`permission/ruleset.ts`)

```ts
type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
// evaluate = findLast(rule matches action && glob(resource)) ?? { effect: "ask" }
```

- Merge order: `config.permissions` → `agent.permissions` → `session.permissions` (the user's saved "always"). A saved rule **does not override** an existing `deny` rule: `denied()` is checked first.
- Standard actions: `read`, `write`, `webfetch`, `websearch`, `mcp:<server>:<tool>` and the management group `MANAGEMENT_ACTIONS` = `delegate`, `hire`, `memory`, `question`, `knowledge`, `manage_skill`, `staff`, `mcp_manage`, `schedule` (CTO only).
- `write` has resource = path → employees have `{ write, "*", deny }` **then** `{ write, "drafts/*", allow }`: broad deny first, narrow exception after.
- `denied()` (hard block, a saved approval cannot bypass it): if a deny rule matches, the call is blocked **unless** there is an allow rule after it, with the same action, a strictly narrower resource (`drafts/*` vs `*`), that also matches. An allow before the deny, or an allow as broad as or broader than the deny (e.g. `shell * allow` after `shell git push* deny`), cannot lift the deny. Denies inherited from the parent session (`inherit`) are appended to the end of the child's ruleset, so the child has no exception after them.
- Bug encountered: the old `capabilityRules` generated `drafts/* allow` then `* deny`, so hired employees could not write anything, yet still reported "saved". `fromMarkdown` now moves `action *` denies to the top (`hoistBroadDenies`), so old `staff` rows in the DB are fixed automatically on load.
- Unattended mode (cron/background subagent with nobody to answer): `ask` → `deny`.
- Disabling a tool for an agent = rule `{ action: "<tool>", resource: "*", effect: "deny" }`; registry `snapshot(ruleset)` also removes tools denied with `deny *` from the definitions (saves tokens).

## Registry (`tool/registry.ts`)

- `register(tool)`, `snapshot(ruleset, agent) → ToolDefinition[]`.
- Namespace: MCP tools are named `<server>_<tool>`; MCP descriptions are stripped of control characters / Unicode tag characters (prompt-injection defense, from hermes).
- A tool description may be **context-dependent** (e.g. `delegate` lists the permitted agents), but it must be deterministic within a session so it does not break the cache.

## Builtin tools v0.1

No code editing. Document tools (`documentTools(docs)`) read/write the `documents` table in the DB and do not touch the filesystem; virtual paths are normalized and `..` is rejected (`normalizePath`).

| Tool | Purpose | Permission action | Who has it |
|---|---|---|---|
| `read` | read company documents | `read` | all roles |
| `list` | list document "folders" | `read` | all roles |
| `search` | find a phrase in documents (case-insensitive, including Vietnamese) | `read` | all roles |
| `write` | create/overwrite a document | `write` (resource = path, employees only `drafts/*`) | CTO, writer, marketer |
| `edit` | replace an exact text span in a document (`old` → `new`, `all?`); not found or multiple matches → error telling the model how to fix it | `write` (as above) | anyone with `write` |
| `bash` | run commands/code (Python…) in a separate working directory, env without secrets (`15-bash.md`) | `bash` (resource = command); employees only with the `bash` capability | CTO |
| `webfetch` | fetch a page → text | `webfetch` (resource = hostname) | CTO, researcher, writer, marketer |
| `websearch` | web search (DuckDuckGo HTML, no key needed) | `websearch` | researcher |
| `question` | ask the CEO one question with options | — (hard deny for employees) | CTO |
| `todo` | the session's plan list | — | all roles |
| `memory` | list/add/replace/remove MEMORY.md | `memory` | CTO |
| `delegate` | list/spawn/steer/stop employees | `delegate` | CTO |
| `hire` | create a new role (`staff` table) | `hire` | CTO |
| `staff` | show/edit/fire employees (does not touch the CTO) | `staff` (resource = id) | CTO |
| `knowledge` | tree-shaped knowledge sets `knowledge/*` (outline/save/append/move/delete), COMPANY.md, USER.md | `knowledge` (resource = action) | CTO |
| `manage_skill` | create/edit/delete skills | `manage_skill` | CTO |
| `mcp_manage` | connect/enable/disable/remove MCP servers | `mcp_manage` (resource = action; `add` is `ask`) | CTO |
| `schedule` | recurring jobs: create/edit/pause/run now/history (`09-schedules.md`) | `schedule` (resource = action) | CTO |
| `skill` | load a skill's body | `skill` | all roles |
| `<server>_<tool>` | tool from an MCP server (see `07-ui-server.md`) | `mcp:<server>:<tool>` | all roles, unless the role denies `mcp:*` |

## Permission for no-code users

- Default harness-level rule: `{ action: "*", resource: "*", effect: "allow" }`. **Never ask the CEO.**
- Safety comes from each role's ruleset (hard deny), not from dialogs. Roles created by `hire` can only choose from 4 capabilities, and `write` is always limited to `drafts/*`.
- `ask` only appears in the CTO's `mcp_manage add` (a stdio server runs commands on the CEO's machine) or if someone explicitly writes an `ask` rule into a role definition.

## MCP (v1.1)

- Config `mcp.<server> = { transport: stdio|http, command|url, enabled, lazy }`.
- Each remote tool is wrapped as `Tool.define` with `input` = raw JSON Schema; permission action `mcp:<server>:<tool>`, default `ask`.
- `notifications/tools/list_changed` → rebuild the snapshot (100ms debounce).

## Code Mode (v2, optional)

A tool `execute({ code })` runs JS in a sandbox with a `tools.*` proxy, from opencode/openclaw. Reduces round trips when the model needs to call 10 small tools. Deferred because it increases the security surface.

## Doom-loop guard

- Hash `(name, canonicalJSON(args))` of the tool call. 3 identical in a row → steer notice; 5 → fail the turn.
- Same tool returns an error 3 times in a row → steer notice "try a different approach"; 5 → fail.
