import type { ModelInfo, ProviderClient } from "./types.ts"

export interface Resolved {
  providerID: string
  client: ProviderClient
  model: string
  info: ModelInfo
}

/**
 * Model được tham chiếu dạng `providerID/modelID`. modelID có thể chứa `/`
 * (vd `openrouter/anthropic/claude-sonnet-4.5`) nên chỉ tách ở dấu `/` đầu tiên.
 * Không có `/` → dùng provider mặc định.
 */
export class ProviderRegistry {
  private clients = new Map<string, ProviderClient>()
  private defaultID?: string

  register(id: string, client: ProviderClient, opts?: { default?: boolean }) {
    this.clients.set(id, client)
    if (opts?.default || !this.defaultID) this.defaultID = id
    return this
  }

  has(id: string) {
    return this.clients.has(id)
  }

  ids() {
    return [...this.clients.keys()]
  }

  resolve(ref: string): Resolved {
    const idx = ref.indexOf("/")
    let providerID: string
    let model: string
    if (idx > 0 && this.clients.has(ref.slice(0, idx))) {
      providerID = ref.slice(0, idx)
      model = ref.slice(idx + 1)
    } else {
      if (!this.defaultID) throw new Error(`no provider registered for model "${ref}"`)
      providerID = this.defaultID
      model = ref
    }
    const client = this.clients.get(providerID)
    if (!client) throw new Error(`unknown provider "${providerID}" in "${ref}" (known: ${this.ids().join(", ")})`)
    return { providerID, client, model, info: client.info(model) }
  }
}
