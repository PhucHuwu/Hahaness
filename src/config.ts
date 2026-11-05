import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { OpenAIProvider } from "./provider/openai.ts"
import { ProviderRegistry } from "./provider/registry.ts"
import type { ProviderClient } from "./provider/types.ts"

const ModelInfoSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
})

const ProviderSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    baseURL: z.string().optional(),
    apiKey: z.string().optional().describe('Literal or "{env:VAR_NAME}"'),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.record(z.string(), ModelInfoSchema).optional(),
  }),
  z.object({
    type: z.literal("custom"),
    module: z.string().describe("Path to a .ts/.js module exporting default (options) => ProviderClient"),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
])

export const ConfigSchema = z.object({
  defaultModel: z.string().optional(),
  providers: z.record(z.string(), ProviderSchema).default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderSchema>

export const CONFIG_FILES = ["hahaness.json", join(".hahaness", "config.json")]

/** `{env:NAME}` → process.env.NAME; chuỗi khác giữ nguyên. */
export function expandEnv(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
}

/** Project config thắng user config (`~/.hahaness/config.json`); providers merge theo id. */
export async function loadConfig(cwd: string): Promise<{ config: Config; path?: string }> {
  const candidates = [
    ...CONFIG_FILES.map((f) => join(cwd, f)),
    join(homedir(), ".hahaness", "config.json"),
  ]
  const found = candidates.filter((p) => existsSync(p))
  if (found.length === 0) return { config: ConfigSchema.parse({}) }

  let merged: Config = { providers: {} }
  for (const path of found.reverse()) {
    const parsed = ConfigSchema.parse(JSON.parse(await readFile(path, "utf8")))
    merged = {
      defaultModel: parsed.defaultModel ?? merged.defaultModel,
      providers: { ...merged.providers, ...parsed.providers },
    }
  }
  return { config: merged, path: found[0] }
}

export async function buildProvider(id: string, cfg: ProviderConfig, cwd: string): Promise<ProviderClient> {
  switch (cfg.type) {
    case "openai": {
      const apiKey = expandEnv(cfg.apiKey) ?? process.env.OPENAI_API_KEY ?? ""
      if (!apiKey) throw new Error(`provider "${id}": apiKey is empty (set it in config or {env:...})`)
      const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expandEnv(v) ?? ""]))
      return new OpenAIProvider({ apiKey, baseURL: cfg.baseURL, headers, models: cfg.models })
    }
    case "custom": {
      const path = isAbsolute(cfg.module) ? cfg.module : resolve(cwd, cfg.module)
      if (!existsSync(path)) throw new Error(`provider "${id}": module not found: ${path}`)
      const mod = await import(pathToFileURL(path).href)
      const factory = mod.default ?? mod.create
      if (typeof factory !== "function") throw new Error(`provider "${id}": module must export default (options) => ProviderClient`)
      const client = await factory(cfg.options ?? {}, { id, cwd })
      if (typeof client?.stream !== "function" || typeof client?.info !== "function") {
        throw new Error(`provider "${id}": factory did not return a ProviderClient (needs info() and stream())`)
      }
      return client as ProviderClient
    }
  }
}

/**
 * Registry từ config. Không có config → fallback provider "openai" từ env
 * (OPENAI_API_KEY / OPENAI_BASE_URL) để chạy được ngay.
 */
export async function buildProviders(config: Config, cwd: string): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry()
  const entries = Object.entries(config.providers)
  if (entries.length === 0) {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.HAHANESS_API_KEY
    if (!apiKey) throw new Error("No providers configured. Create hahaness.json or set OPENAI_API_KEY.")
    registry.register("openai", new OpenAIProvider({ apiKey, baseURL: process.env.OPENAI_BASE_URL }), { default: true })
    return registry
  }
  const defaultProvider = config.defaultModel?.split("/")[0]
  for (const [id, cfg] of entries) {
    registry.register(id, await buildProvider(id, cfg, cwd), { default: id === defaultProvider })
  }
  return registry
}
