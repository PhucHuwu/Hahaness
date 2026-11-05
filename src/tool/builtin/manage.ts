import { z } from "zod"
import { define } from "../define.ts"
import type { DocumentStore } from "../../context/documents.ts"
import { FILES, KNOWLEDGE_DIR } from "../../context/workspace.ts"
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
    description: `Manage the company's reference library (knowledge/*) and the company profile.
- list: all knowledge documents with titles.
- save: create or replace a document. Use a descriptive slug path (e.g. "pricing-2026"); the first line should be a "# Title" because it is shown in the index every employee sees.
- append: add text to the end of an existing document.
- delete: remove a document.
- company: replace COMPANY.md (what the company does, products, customers, voice). Read it first and keep what is still true.
- ceo: replace USER.md (who the CEO is, how they like reports).
Use this when the CEO gives you material to keep ("remember this price list", "here is our brand guide"). ${NOTE}`,
    input: z.object({
      action: z.enum(["list", "save", "append", "delete", "company", "ceo"]),
      path: z.string().optional().describe('Document name inside knowledge/, e.g. "pricing.md"'),
      content: z.string().optional(),
    }),
    permission: { action: "knowledge", resource: (i) => i.action },
    concurrency: "serial",
    async execute({ action, path, content }, ctx) {
      const target = () => {
        if (!path) throw new Error(`${action} requires path`)
        const name = path.replace(/^\/?knowledge\//, "")
        return `${KNOWLEDGE_DIR}/${/\.\w+$/.test(name) ? name : `${name}.md`}`
      }
      switch (action) {
        case "list": {
          const files = docs.list(KNOWLEDGE_DIR)
          return { output: files.map((f) => `- ${f.path} — ${f.title || "(untitled)"} (${f.size} chars)`).join("\n") || "(no knowledge documents)" }
        }
        case "save": {
          if (content === undefined) return { output: "save requires content", isError: true }
          const p = target()
          const existed = docs.has(p)
          docs.put(p, content, ctx.agent)
          return { output: `${existed ? "Updated" : "Saved"} ${p} (${content.length} chars). ${NOTE}` }
        }
        case "append": {
          if (!content) return { output: "append requires content", isError: true }
          const p = target()
          const prev = docs.read(p)
          if (prev === undefined) return { output: `No document ${p}. Use save to create it.`, isError: true }
          docs.put(p, `${prev.replace(/\s+$/, "")}\n\n${content}`, ctx.agent)
          return { output: `Appended to ${p}.` }
        }
        case "delete": {
          const p = target()
          return docs.delete(p) ? { output: `Deleted ${p}.` } : { output: `No document ${p}.`, isError: true }
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
