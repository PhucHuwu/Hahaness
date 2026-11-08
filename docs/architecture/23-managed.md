# 23 — Managed tier: the vendor runs instances for customers who will not

Some customers will not run Docker. The managed tier serves them the same product with the vendor doing the
hosting: one container, one volume and one subdomain per customer on a vendor machine, created and maintained with
a small CLI. Nothing in the server changes; this is deployment and operations, built on `18-deployment.md`. The
files are `managed/` (compose project), `src/managed/tenants.ts` (pure generator) and `scripts/tenant.ts` (CLI).

## Decisions

- **Same image as self-host.** A managed tenant runs `ghcr.io/…/hahaness:stable` (or whatever `image` says in
  `tenants.json`) with the same `/data` volume layout. Moving a customer from managed to self-host or back is a
  volume archive (`tenant.ts backup`, then restore per `18-deployment.md`). There is no "SaaS build".
- **One container per tenant, not one database with tenant columns.** Isolation falls out of Docker: the `bash`
  tool, uploads, MCP processes and SQLite file of one customer cannot touch another's. The cost is memory per
  tenant (one Node process each), which is fine for tens of customers on one machine and is the only model that
  keeps the self-host code path identical.
- **`tenants.json` is the source of truth; compose and Caddy files are generated.** `tenants.json` holds
  `domain`, `image`, `tz`, optional `catalogUrl` and the tenant map. `scripts/tenant.ts` renders `tenants.yml`
  (one service + one named volume per tenant, included by `managed/docker-compose.yml`) and `Caddyfile` (one site
  per tenant, `reverse_proxy hahaness-<name>:7331`). Generated files are gitignored; the JSON is committed to the
  vendor's private ops repo. Hand-editing YAML for thirty customers is how outages happen.
- **Caddy for HTTPS.** Caddy issues Let's Encrypt certificates per subdomain automatically and sets
  `X-Forwarded-Proto`/`X-Forwarded-For`, which `16-auth.md` needs for the `Secure` cookie and lockout. A wildcard
  DNS record `*.<domain>` pointing at the machine is the only DNS work. When `domain` is `localhost` or ends in
  `.localhost`, `auto_https` is off and sites are `http://`, so the whole stack can be tried on a laptop.
- **Update check is off for tenants.** The vendor upgrades everyone with `tenant.ts upgrade` (pull + recreate),
  so `HAHANESS_UPDATE_URL=off` is set and the "Có bản mới" notice never nags a customer who cannot act on it.
- **Per-tenant env file is optional.** `managed/env/<name>.env` (gitignored) lets the vendor preset a provider key
  or `HAHANESS_MODEL` for a customer; usually the customer enters keys in Settings and the file does not exist.
- **Setup code is read from the container log.** `tenant.ts add` waits for `Mã cài đặt: …` in the log and prints
  it with the URL, so onboarding is one command and a message to the customer. The code changes on every restart
  until a password is set, as it does for self-host.
- **Licence is still per instance.** A managed tenant gets its instance ID on first start like any other; the
  vendor reads it from `/api/health` or Settings and signs a licence (`21-license.md`). Future: pre-seed the
  licence through the env file so paid items work from day one.
- **Backups stop the container.** `tenant.ts backup` does `compose stop`, archives the volume with an `alpine`
  container to `managed/backups/<name>-<stamp>.tgz`, then `compose start`. A few seconds of downtime beats a torn
  SQLite copy; scheduled jobs catch up on restart (`09-schedules.md`).

## Commands

```sh
cd managed
npx tsx ../scripts/tenant.ts add cong-ty-a --customer "Công ty A"   # URL + setup code
npx tsx ../scripts/tenant.ts list
npx tsx ../scripts/tenant.ts backup cong-ty-a [--out /mnt/backups]
npx tsx ../scripts/tenant.ts upgrade [cong-ty-a]                     # all tenants when omitted
npx tsx ../scripts/tenant.ts remove cong-ty-a [--purge]              # volume kept unless --purge
npx tsx ../scripts/tenant.ts render                                  # regenerate files only
```

`HAHANESS_MANAGED_DIR` points the CLI at another directory (the vendor's ops checkout).

## Verified

On a laptop with `domain: localhost` and `image: hahaness:local`: `add demo` created the container, volume and
Caddy site and printed the setup code; `curl --resolve demo.localhost:80:127.0.0.1` through Caddy served the UI,
`/api/auth/setup`, `/api/health` (own instance ID, `/data/hahaness.db`), `/api/updates` (`enabled: false`) and the
marketplace (6 items from the remote catalog); `backup demo` produced a `.tgz` containing `hahaness.db`;
`remove demo --purge` left no tenant, container or volume behind. `src/managed/tenants.test.ts` covers the
generator and validates the committed `tenants.json`.

## Not done yet

- Billing and self-service sign-up; today the vendor runs `add` after a sales conversation.
- Pre-seeding the licence and provider key at `add` time.
- Resource limits per tenant (`mem_limit`, `cpus`) and a disk quota on the volume.
- Off-machine backup rotation; `backup` writes to a local directory.
- Multi-machine placement; one compose project is one host.
