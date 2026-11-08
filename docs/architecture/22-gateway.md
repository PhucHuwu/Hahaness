# 22 — Vendor MCP gateway: paid tools behind the licence

Paid catalogue items (`20-marketplace.md`) have to point at something the vendor controls, otherwise "paid" is just
a label. The gateway is that something: a small HTTP service the vendor runs that forwards MCP traffic to upstream
servers (Exa, Firecrawl, the vendor's own tools) using the vendor's API keys, and lets through only requests that
carry a valid licence. Code is in `src/gateway/gateway.ts` (library) and `src/gateway/index.ts` (entry);
deployment files are in `gateway/`.

## Decisions

- **The licence is the API key.** Customers authenticate to the gateway with `Authorization: Bearer <licence>`,
  the same `HH1.…` string they pasted into Settings (`21-license.md`). The gateway verifies signature, expiry and
  plan with the vendor public key and needs no database, no per-customer secret and no issuance step beyond
  signing the licence. Revocation is expiry: a licence that is not renewed stops working at the gateway on the day
  it stops unlocking installs. Instance ID is in the payload, so the vendor's log attributes usage per customer.
- **Placeholders, not secrets, in the customer database.** The catalogue config for a paid item is
  `{ "type": "http", "url": "https://gateway…/mcp/exa", "headers": { "Authorization": "Bearer {{license}}" } }`.
  `McpManager` fills `{{license}}` at connect time from `LicenseStore`; `mcp_servers` and the MCP page keep the
  placeholder. Renewing the licence therefore means pasting the new key once, after which `PUT /api/license`
  calls `McpManager.reconnectUsing("license")` and every gateway server reconnects. If the licence is missing or
  expired the server shows `Server này cần giấy phép còn hạn…` with a link to Settings instead of sending an empty
  bearer. Placeholders are generic (`{{name}}` resolved from a map), so a later `{{instance}}` costs nothing.
- **Pure forwarder.** The gateway does not speak MCP. It copies the JSON-RPC body, `content-type`, `accept` and
  `mcp-session-id` to the upstream, adds the upstream's headers from `upstreams.json`, and streams the response
  back with the same status and `mcp-session-id`. SSE responses pass through unchanged because the body is piped.
  Session state lives in the upstream and the customer's client, not in the gateway, so it can run several replicas
  behind one hostname.
- **Upstream secrets come from the environment.** `upstreams.json` is committed and contains `${EXA_API_KEY}`
  style references; `loadUpstreams` substitutes them at start and refuses to start when one is missing. The
  customer's licence is never forwarded upstream and the upstream key never reaches the customer.
- **Plans per upstream.** `"plans": ["pro", "enterprise"]` on an upstream returns 403 for other plans. This is the
  first place `plan` is interpreted; the instance still treats any valid licence as "licensed".
- **Errors are Vietnamese sentences.** `McpClient` now appends the JSON `error` of a non-2xx response to its
  message, so `401 {"error":"Giấy phép đã hết hạn ngày …"}` from the gateway shows up verbatim on the MCP page
  and in the marketplace install error.
- **Not in the customer image.** The gateway has its own `gateway/Dockerfile` (same `src/`, no UI, no python) and
  `gateway/docker-compose.yml`. Customers never run it; the shared code is `license.ts` and `zod`.

## Request flow

```
instance ──POST /mcp/exa──▶ gateway ──POST https://mcp.exa.ai/mcp──▶ Exa
  Authorization: Bearer HH1.…    verify licence       x-api-key: ${EXA_API_KEY}
  mcp-session-id: …              check plan           mcp-session-id: …
◀── status, content-type, mcp-session-id, body (JSON or SSE) streamed back ──
```

| Response | Meaning |
|---|---|
| 401 `{error}` | No bearer, bad signature, or expired (message says which, in Vietnamese) |
| 403 `{error}` | Licence valid but plan not allowed for this upstream |
| 404 `{error}` | Unknown upstream name |
| 502 `{error}` | Upstream unreachable |
| anything else | Passed through from the upstream |

`GET /` answers `{ ok, upstreams }` for health checks and reveals no keys.

## Vendor workflow

```sh
cp gateway/.env.example gateway/.env   # fill EXA_API_KEY etc.
cd gateway && docker compose up -d     # or: npm run gateway (reads gateway/upstreams.json)
```

Then publish a catalogue item with `requiresLicense: true` whose URL is `https://<gateway host>/mcp/<name>` and
whose headers are `{ "Authorization": "Bearer {{license}}" }`. Adding an upstream is a line in `upstreams.json`
and a restart.

## Tests

`src/gateway/gateway.test.ts` runs a fake upstream that demands the vendor header, a gateway in front of it, and
checks: missing/forged/expired/foreign-signer licences are rejected before anything reaches the upstream, plan
gating, the upstream key is added and the licence is not forwarded, `mcp-session-id` round-trips, `McpClient`
can initialise/list/call through it, and `McpManager` fills `{{license}}` at connect time, stores only the
placeholder, reconnects after `set`, and drops the tools when the licence expires.

## Not done yet

- Rate limits and per-instance quotas (the log line per request is the input for that).
- A real gateway hostname: the demo catalogue item `exa-pro` points at `gateway.hahaness.example` and will show a
  connection error until the vendor deploys and edits the URL.
- Revocation before expiry (would need a small denylist the gateway reloads).
