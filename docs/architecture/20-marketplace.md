# 20 — Marketplace: a static catalog the instance installs from

The vendor's recurring value is not the app (customers run it themselves, `18-deployment.md`) but the tools it can be
connected to. The **Chợ ứng dụng** page lists those tools and installs them with one click. Code is in
`src/server/marketplace.ts`, the catalog is `catalog.json` at the repository root, the UI is `ui/src/pages/Market.tsx`.

## Decisions

- **The catalog is a static JSON file, not an API.** `catalog.json` is published at a URL (today: the file in this
  repository on GitHub raw; later: the vendor's CDN) and every instance pulls it. No vendor server needs to be up for
  the marketplace to work, the file can be cached and signed later, and editing it is a commit. `HAHANESS_CATALOG_URL`
  overrides the URL (`file://` works for an intranet copy; `off` disables fetching).
- **Bundled fallback.** The image ships the `catalog.json` it was built with. If the remote fetch fails the instance uses
  the bundled copy and shows a warning; if a previous remote fetch succeeded it keeps that one. The marketplace therefore
  works offline, just possibly stale. The fetch is cached for one hour; **Tải lại danh mục** bypasses the cache.
- **One item kind for now: `mcp`.** An item carries a ready `McpServerConfig` (`http` with URL and optional headers,
  or `stdio` with command and args). Installing is exactly `McpManager.add(id, config)`: the server lands in
  `mcp_servers` like a hand-added one, so disable/reconnect/remove stay on the MCP page and the harness needs no new
  code path. The item `id` becomes the server id, so tool names are `<id>_<tool>` and stable across customers, which
  matters for skills and docs that mention them. Skills and agent templates as catalog kinds are later steps.
- **Hosted `http` servers first.** The demo catalog lists only remote servers that answer `initialize` without a key
  (verified with the project's own `McpClient`): Exa search, Hugging Face Hub, Microsoft Learn, Context7, Cloudflare
  Docs. These need no local process, no package install and no sandboxing, so a non-technical CEO can install them
  safely. `stdio` items are allowed by the schema but should only be published once packages are signed.
- **Secrets never live in the catalog.** Paid items point at the vendor gateway with
  `"Authorization": "Bearer {{license}}"`; the instance fills the placeholder from its own licence at connect time
  (`22-gateway.md`). Nothing customer-specific is in the shared JSON.
- **Schema is strict and versioned.** `version: 1`; `id` must be a slug (it is also the MCP server id); unknown
  `kind` values fail validation so an older instance ignores a newer catalog instead of half-installing it. The repo's
  own `catalog.json` is validated in `marketplace.test.ts`.
- **UI.** Search box, tag filter, one card per item with publisher, homepage and the endpoint it will connect to.
  Installed items show the MCP connection state and link to the MCP page instead of an install button. The MCP page
  links back to the marketplace.

## Catalog format

```json
{
  "version": 1,
  "updatedAt": "2026-11-09",
  "items": [
    {
      "id": "exa",
      "kind": "mcp",
      "title": "Exa – tìm kiếm web",
      "description": "…",
      "tags": ["tìm kiếm", "web"],
      "publisher": "Exa",
      "homepage": "https://exa.ai",
      "config": { "type": "http", "url": "https://mcp.exa.ai/mcp" }
    }
  ]
}
```

Titles and descriptions are in Vietnamese because the CEO reads them. An item may carry `"requiresLicense": true`
(default `false`); see `21-license.md`.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/marketplace` | `MarketplaceView`: `source` (`remote`/`bundled`/`off`), `url`, `updatedAt`, `fetchedAt`, `error`, `items[]` with `installed` and MCP `state` |
| `POST /api/marketplace/refresh` | Same, bypassing the one-hour cache |
| `POST /api/marketplace/:id/install` | Installs the item; returns the `McpServerStatus`; 400 if the id is not in the catalog |

Tests pass `startServer({ catalogUrl: "file://…" })` pointing at a temporary catalog that uses the stdio echo server, so
no network is needed.

## Not done yet

- Signed catalog (detached signature checked against a key baked into the image).
- `skill` and `agent` item kinds (markdown written into the skill store / staff table).

Licence gating is done (`21-license.md`): items with `requiresLicense: true` install only while the instance holds a
valid key; the view carries `licensed` so the UI can show `cần giấy phép` and link to Settings.
