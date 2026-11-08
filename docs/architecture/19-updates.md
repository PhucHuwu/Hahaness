# 19 — Instance ID and update notice

Customers self-host Hahaness (`18-deployment.md`), so the vendor cannot push a new version; it can only tell the
instance that one exists. This document covers the instance identity and the "new version available" notice. Code is in
`src/server/updates.ts`; UI in `ui/src/App.tsx` (nav footer) and the **Phiên bản** card in `ui/src/pages/Settings.tsx`.

## Decisions

- **Instance ID.** A random UUID generated on first start and stored in `settings` (key `instance`, with
  `createdAt`). It lives in the DB, so it survives image upgrades and moves with a backup, and a restored copy keeps the
  same ID (which is what a license check wants). `GET /api/health` returns it as `instance`. Nothing else is derived from
  hardware or the hostname.
- **Version** is read from `package.json` at startup (`VERSION` in `src/server/index.ts`) and returned by
  `/api/health` and `/api/updates`. The Docker image therefore reports whatever `package.json` says at build time;
  release tags must match it.
- **Check, do not install.** The server asks one URL for the latest release: 15 seconds after start (so startup is
  never blocked) and then every 24 hours, with a 10-second timeout. The result is kept in memory only; a restart checks
  again. Installing stays a manual `docker compose pull && docker compose up -d` run by whoever administers the server,
  because that is also the moment to take a backup. An automatic sidecar can come later without changing this.
- **Request shape:** `GET <url>?channel=<stable|beta>&v=<current>&instance=<id>` with
  `user-agent: hahaness/<version>`. The query parameters are enough for a vendor endpoint to answer per channel, count
  active instances and, later, look up a license. The default URL is the GitHub Releases API for this repository, so
  the feature works before any vendor endpoint exists; a 404 there (no release published yet) counts as "no update", not
  an error.
- **Response shape:** either GitHub's (`tag_name`, `html_url`, `body`) or a minimal own format
  (`version`, `url`, `notes`). `parseRelease` accepts both; a leading `v` is stripped. Versions compare numerically
  per part, and a pre-release suffix sorts below the plain version (`1.0.0-beta.1 < 1.0.0`).
- **Opt out.** `HAHANESS_UPDATE_URL=off` disables the check entirely (air-gapped or intranet installs). The UI then
  says so instead of showing an error. `HAHANESS_UPDATE_CHANNEL` defaults to `stable`.
- **Errors are shown, not retried early.** A failed check keeps the previous `latest` and sets `error`; the next
  attempt is the scheduled one or the **Kiểm tra ngay** button (`POST /api/updates/check`).
- **UI.** When `available` is true the nav footer shows a "Có bản mới x.y.z" link to Settings, where the card shows the
  running and latest versions, the release notes link and the upgrade command. The UI polls `/api/updates` hourly; the
  server's own cadence is daily, so this is just to refresh a tab left open.
- Tests run `startServer({ updates: false })` so no network is touched; `updates.test.ts` uses an injected `fetch`.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok, version, instance, db, providerError, clients }` |
| `GET /api/updates` | Current `UpdateState` (`current`, `channel`, `enabled`, `latest`, `available`, `checkedAt`, `error`) |
| `POST /api/updates/check` | Check now and return the new state |

## Not done yet

- Vendor endpoint (`updates.<domain>/latest`) and signed responses; today the default is GitHub Releases over HTTPS.
- License key tied to the instance ID (step 4 of the roadmap).
- Automatic upgrades with a pre-upgrade SQLite backup.
