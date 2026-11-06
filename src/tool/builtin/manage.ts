import { z } from "zod"
import { define } from "../define.ts"
import type { DocumentStore } from "../../context/documents.ts"
import { FILES } from "../../context/workspace.ts"
import { findNode, knowledgeTree, nodeLine, nodeMarkdown, normalizeNodeID, outline, subtreeDocs } from "../../context/knowledge.ts"
import { parseSkill, skillMarkdown, slug, type SkillStore } from "../../context/skills.ts"
import { CAPABILITIES, capabilitiesOf, type AgentRegistry } from "../../agent/registry.ts"
import type { McpManager, McpServerStatus } from "../../mcp/manager.ts"
import type { McpServerConfig } from "../../mcp/client.ts"

/**
 * Tool quản trị cho CTO. CEO chỉ ra lệnh ("ghi nhớ bảng giá này", "tạo quy trình
 * báo cáo tuần", "cho bạn SEO nghỉ"); CTO thực hiện bằng các tool này.
 * Nhân viên luôn bị deny (xem MANAGEMENT_ACTIONS và Harness.spawn).
 */

const NOTE = "Changes apply to conversations started after this one; the current system context does not change."

export function knowledgeTool(docs: DocumentStore) {
  return define({
    name: "knowledge",
    description: `Manage the company's knowledge library and the company profile.
The library is a set of knowledge trees. Each top-level node is one knowledge set (e.g. "brand", "products", "pricing-2026"); its sub-nodes split it into parts ("brand/voice", "brand/logo", "products/tea/menu"). Agents see every set with its first-level branches, then read only the node they need, so:
- One node = one topic an agent would look up on its own. Split long material into sub-nodes instead of one big node; keep each node short.
- Give every node a clear "title" and a one-line "summary" of what it covers: that line is what agents use to decide where to go.
- The set's root node gives the overview of the whole set.
Actions:
- outline: the tree. No path = all sets; with path = that node's whole subtree.
- save: create or replace one node (path, title, summary, content = the body without the title). Missing parents become group nodes; give them a title/summary with save later.
- append: add content to the end of an existing node.
- move: rename or move a node with its whole subtree to "to".
- delete: remove a node; a node with sub-nodes needs recursive: true.
- company: replace COMPANY.md (what the company does, products, customers, voice). Read it first and keep what is still true.
- ceo: replace USER.md (who the CEO is, how they like reports).
Use this when the CEO gives you material to keep ("remember this price list", "here is our brand guide"). Before saving, check the outline: extend the set that already covers the topic instead of creating a near-duplicate. ${NOTE}`,
    input: z.object({
      action: z.enum(["outline", "save", "append", "move", "delete", "company", "ceo"]),
      path: z.string().optional().describe('Node path, e.g. "brand" (a set) or "brand/voice" (a node inside it); the knowledge/ prefix is optional'),
      title: z.string().optional().describe("save: node title"),
      summary: z.string().optional().describe("save: one line saying what this node covers"),
      content: z.string().optional().describe('save: node body; append: text to add; company/ceo: the whole document. For save without title, content must start with "# Title"'),
      to: z.string().optional().describe("move: new node path"),
      recursive: z.boolean().optional().describe("delete: also delete every sub-node"),
    }),
    permission: { action: "knowledge", resource: (i) => i.action },
    concurrency: "serial",
    async execute({ action, path, title, summary, content, to, recursive }, ctx) {
      const node = (p: string | undefined) => {
        if (!p) throw new Error(`${action} requires path`)
        return normalizeNodeID(p)
      }
      switch (action) {
        case "outline": {
          const forest = knowledgeTree(docs)
          if (!path) return { output: forest.length ? outline(forest, Infinity).join("\n") : "(no knowledge sets yet)" }
          const n = findNode(forest, node(path))
          if (!n) return { output: `No knowledge node ${node(path)}.`, isError: true }
          return { output: [nodeLine(n), ...outline(n.children, Infinity, "  ")].join("\n") }
        }
        case "save": {
          const id = node(path)
          if (content === undefined && !title) return { output: "save requires title and content", isError: true }
          const text = title ? nodeMarkdown(title, summary, content ?? "") : content!
          if (!title && !/^#\s+\S/.test(text.trimStart())) return { output: 'save requires a title (or content starting with "# Title")', isError: true }
          const p = `${id}.md`
          const existed = docs.has(p)
          docs.put(p, text, ctx.agent)
          const set = id.split("/").slice(0, 2).join("/")
          return { output: `${existed ? "Updated" : "Saved"} ${p} (${text.length} chars), node ${id} in set ${set}. ${NOTE}` }
        }
        case "append": {
          if (!content) return { output: "append requires content", isError: true }
          const p = `${node(path)}.md`
          const prev = docs.read(p)
          if (prev === undefined) return { output: `No knowledge node ${node(path)}. Use save to create it.`, isError: true }
          docs.put(p, `${prev.replace(/\s+$/, "")}\n\n${content}`, ctx.agent)
          return { output: `Appended to ${p}.` }
        }
        case "move": {
          const from = node(path)
          if (!to) return { output: "move requires to", isError: true }
          const dest = normalizeNodeID(to)
          if (dest === from || dest.startsWith(from + "/")) return { output: "cannot move a node into itself", isError: true }
          const paths = subtreeDocs(docs, from)
          if (paths.length === 0) return { output: `No knowledge node ${from}.`, isError: true }
          const target = (p: string) => dest + p.slice(from.length)
          const clash = paths.map(target).filter((p) => docs.has(p))
          if (clash.length) return { output: `Target already exists: ${clash.join(", ")}. Move or delete it first.`, isError: true }
          for (const p of paths) {
            const doc = docs.get(p)!
            docs.put(target(p), doc.content, ctx.agent)
            docs.delete(p)
          }
          return { output: `Moved ${from} → ${dest} (${paths.length} document${paths.length > 1 ? "s" : ""}).` }
        }
        case "delete": {
          const id = node(path)
          const paths = subtreeDocs(docs, id)
          if (paths.length === 0) return { output: `No knowledge node ${id}.`, isError: true }
          const below = paths.filter((p) => p.startsWith(id + "/"))
          if (below.length && !recursive) return { output: `${id} has ${below.length} document(s) below it. Pass recursive: true to delete them too, or move them first.`, isError: true }
          for (const p of paths) docs.delete(p)
          return { output: `Deleted ${id}${below.length ? ` and ${below.length} sub-node document(s)` : ""}.` }
        }
        case "company":
        case "ceo": {
          if (!content) return { output: `${action} requires content`, isError: true }
          const p = action === "company" ? FILES.company : FILES.user
          docs.put(p, content, ctx.agent)
          return { output: `Updated ${p}. ${NOTE}` }
        }
      }
    },
  })
}

export function manageSkillTool(skills: SkillStore) {
  return define({
    name: "manage_skill",
    description: `Create, edit or delete skills: reusable procedures any employee can load with \`skill\` (e.g. "weekly report", "blog post checklist").
- list / show: see existing skills.
- save: create or replace. "description" says WHEN to use it (one sentence, shown in every system prompt); "instructions" are the step-by-step procedure.
- delete: remove a skill.
Create a skill when the CEO describes a repeatable way of working. ${NOTE}`,
    input: z.object({
      action: z.enum(["list", "show", "save", "delete"]),
      id: z.string().optional().describe("Slug, e.g. weekly-report"),
      name: z.string().optional(),
      description: z.string().optional(),
      instructions: z.string().optional(),
    }),
    permission: { action: "manage_skill", resource: (i) => i.id ?? "*" },
    concurrency: "serial",
    async execute({ action, id, name, description, instructions }) {
      if (action === "list") {
        const all = await skills.list()
        return { output: all.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join("\n") || "(no skills)" }
      }
      if (!id) return { output: `${action} requires id`, isError: true }
      if (action === "show") {
        const content = await skills.read(slug(id))
        return content ? { output: content } : { output: `No skill "${id}".`, isError: true }
      }
      if (action === "delete") return (await skills.remove(slug(id))) ? { output: `Deleted skill ${slug(id)}.` } : { output: `No skill "${id}".`, isError: true }
      const prev = await skills.read(slug(id))
      const old = prev ? parseSkill(prev) : undefined
      const d = description ?? old?.meta.description
      const body = instructions ?? old?.body
      if (!d || !body) return { output: "save requires description and instructions for a new skill", isError: true }
      const saved = await skills.write(id, skillMarkdown(name ?? old?.meta.name ?? id, d, body))
      return { output: `${prev ? "Updated" : "Created"} skill ${saved}. ${NOTE}` }
    },
  })
}

export function mcpTool(mcp: McpManager) {
  return define({
    name: "mcp_manage",
    description: `Connect the company to external tools via MCP servers (e.g. Google Drive, Notion, a database). Their tools appear as <server>_<tool> in conversations started afterwards.
- list: servers, connection state and their tools.
- add: register a server. type "stdio" runs a local command (command + args); type "http" connects to a URL. Adding asks the CEO for approval.
- enable / disable / reconnect / remove: manage an existing server.
Only add servers the CEO asked for or approved; never invent package names.`,
    input: z.object({
      action: z.enum(["list", "add", "enable", "disable", "reconnect", "remove"]),
      id: z.string().optional().describe("Server id, e.g. notion"),
      type: z.enum(["stdio", "http"]).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    permission: { action: "mcp_manage", resource: (i) => i.action },
    concurrency: "serial",
    timeoutMs: 60_000,
    async execute(input) {
      const render = (s: McpServerStatus) =>
        `- ${s.id}: ${s.state}${s.error ? ` (${s.error})` : ""}${s.tools.length ? `\n  tools: ${s.tools.map((t) => t.toolName).join(", ")}` : ""}`
      if (input.action === "list") return { output: mcp.list().map(render).join("\n") || "(no MCP servers)" }
      if (!input.id) return { output: `${input.action} requires id`, isError: true }
      switch (input.action) {
        case "add": {
          const cfg: McpServerConfig | undefined =
            input.type === "http" && input.url
              ? { type: "http", url: input.url, headers: input.headers }
              : input.type === "stdio" && input.command
                ? { type: "stdio", command: input.command, args: input.args, env: input.env }
                : undefined
          if (!cfg) return { output: 'add requires type "stdio" with command, or type "http" with url', isError: true }
          const st = await mcp.add(input.id, cfg)
          return { output: render(st), isError: st.state === "error" }
        }
        case "enable":
        case "disable":
          return { output: render(await mcp.setEnabled(input.id, input.action === "enable")) }
        case "reconnect":
          return { output: render(await mcp.reconnect(input.id)) }
        case "remove":
          if (!mcp.get(input.id)) return { output: `No MCP server "${input.id}".`, isError: true }
          await mcp.remove(input.id)
          return { output: `Removed MCP server ${input.id}.` }
      }
    },
  })
}

export function staffTool(agents: AgentRegistry) {
  return define({
    name: "staff",
    description: `Manage existing employees (use \`hire\` to add one).
- show: full job description and capabilities of an employee.
- edit: change name, description, job description (system) and/or capabilities. Only the fields you pass change.
- fire: remove an employee permanently. Do it only when the CEO asks or the role is clearly obsolete.
You cannot edit or fire yourself.`,
    input: z.object({
      action: z.enum(["show", "edit", "fire"]),
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      system: z.string().optional(),
      capabilities: z.array(z.enum(CAPABILITIES)).optional(),
    }),
    permission: { action: "staff", resource: (i) => i.id },
    concurrency: "serial",
    async execute({ action, id, name, description, system, capabilities }) {
      if (!agents.has(id)) return { output: `No employee "${id}". Use delegate(action: "list") to see staff.`, isError: true }
      const def = agents.get(id)
      if (def.mode === "primary" && action !== "show") return { output: `${id} is a primary role and cannot be ${action === "fire" ? "fired" : "edited"}.`, isError: true }
      switch (action) {
        case "show":
          return { output: `${def.name} (${def.id}): ${def.description}\nCapabilities: ${capabilitiesOf(def).join(", ") || "(none)"}\n\nJob description:\n${def.system}` }
        case "edit": {
          if ([name, description, system, capabilities].every((v) => v === undefined)) return { output: "edit requires at least one field to change", isError: true }
          const next = await agents.edit(id, { name, description, system, capabilities })
          return { output: `Updated ${next.name} (${id}). Capabilities: ${capabilitiesOf(next).join(", ") || "(none)"}. New assignments use the new definition.` }
        }
        case "fire":
          await agents.fire(id)
          return { output: `${def.name} (${id}) has left the company.` }
      }
    },
  })
}
