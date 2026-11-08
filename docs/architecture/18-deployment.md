# 18 — Deployment: Docker image and compose file

Hahaness is self-hosted: each customer runs it on their own server, and the only supported way to do that is
Docker. The image is built from `Dockerfile`; `docker-compose.yml` is the reference way to run it. The
vendor-side pieces (update channel, marketplace catalog, licensing) are later steps and build on what is decided here.

## Decisions

- **One image, one container, one volume.** The container runs the Node server; the web UI is built into the image
  (`ui/dist`) and served by the same process, so the cookie and CSRF rules in `16-auth.md` hold unchanged. Everything
  the company owns (SQLite file, `workspace/` of the `bash` tool, uploads, pip caches) lives under `/data`, mounted from
  the `hahaness-data` volume. Backup, move and upgrade are therefore operations on that one volume.
- **Multi-stage build.** Stage 1 installs all dependencies and runs `npm run ui:build`. Stage 2 is
  `node:22-bookworm-slim` with production dependencies only. `tsx` is a runtime dependency (not dev) because the server
  is run from TypeScript source: `node --import tsx src/server/index.ts`. There is no compile step to maintain.
- **The `bash` tool needs a real shell and Python.** The image installs `bash`, `python3`, `pip`, `pandas` and
  `openpyxl` (Debian packages), since analysing the CEO's spreadsheets is the main reason the tool exists. Agents may add
  packages with `pip install --user`; because `HOME` is the workspace (`15-bash.md`), they land in
  `/data/workspace/.local` and survive image upgrades. `/etc/pip.conf` sets `break-system-packages` so Debian's PEP 668
  guard does not block this.
- **Runs as the unprivileged `node` user.** `/data` is created and chowned at build time. This is the "separate
  low-privilege user or container" mitigation `15-bash.md` asks for: code the agent runs can damage `/data` but not the
  host.
- **Defaults set by the image:** `HOST=0.0.0.0` (the container must listen on all interfaces to be reachable),
  `PORT=7331`, `HAHANESS_DB=/data/hahaness.db`. `HAHANESS_WORKDIR` keeps its default (`workspace/` next to the DB).
- **The compose file binds the port to `127.0.0.1`.** Without HTTPS the password and session cookie travel in plain
  text, so the expected setup is Caddy or nginx on the same host, forwarding to `127.0.0.1:7331` with
  `X-Forwarded-Proto` and `X-Forwarded-For` set. `auth.ts` uses the first for the `Secure` cookie flag and the second for
  brute-force lockout. Change to `"7331:7331"` only on a trusted private network.
- **Time zone is an environment variable.** Schedules (`09-schedules.md`) resolve cron expressions in the process time
  zone, which inside a container is UTC unless set. `docker-compose.yml` defaults `TZ` to `Asia/Ho_Chi_Minh`; the image
  ships `tzdata` so any IANA name works.
- **Health check** calls `GET /api/auth`, the only GET that answers without a login session, so the check works before
  the password is set. `docker ps` shows `healthy`/`unhealthy`; the later update sidecar will use the same signal.
- **Version is reported.** `GET /api/health` includes `version` (from `package.json`) and `instance`, and the startup
  log prints `Hahaness <version>: <url>`. The daily update check (`19-updates.md`) compares this against the latest
  release and the UI shows "Có bản mới".
- **Secrets stay out of the image.** `.env` (gitignored, listed in `.dockerignore`) is read by compose through
  `env_file` and is optional; API keys can equally be entered in Settings and are then stored in the DB inside the volume.
  `.env.example` documents the variables.

## First start

```sh
cp .env.example .env            # optional
docker compose up -d --build
docker compose logs hahaness    # "Mã cài đặt: xxxxxxxx"
```

Open `http://localhost:7331` (or the proxy's domain), set the password with the setup code, then configure a provider in
Settings. The setup code is regenerated on every restart until a password exists.

## Backup and restore

All state is the volume. The SQLite file is the important part; `workspace/` is scratch space and pip caches.

```sh
docker compose exec hahaness sqlite3 /data/hahaness.db ".backup /data/backup.db"   # if sqlite3 is installed, or:
docker compose stop && docker run --rm -v hahaness_hahaness-data:/data -v "$PWD":/out alpine \
  tar czf /out/hahaness-backup.tgz -C /data . && docker compose start
```

Restore by extracting the archive into an empty volume before the first start. Copying `hahaness.db` while the server is
running is safe only if the `-wal` and `-shm` files are copied with it; stopping the container first is simpler.

## Upgrade

```sh
docker compose pull            # or: docker compose build --pull, when building locally
docker compose up -d
```

The schema migrates itself on start (`SCHEMA_VERSION` in `src/core/db.ts`). Take a backup first; downgrading after a
schema bump is not supported. Automatic upgrades (a Watchtower-style sidecar and the `stable`/`beta` channels) are the
next step and will reuse this exact image and volume layout.

## Forgotten password

```sh
docker compose exec hahaness node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/hahaness.db').exec(\"DELETE FROM settings WHERE key = 'auth'\")"
docker compose restart hahaness   # prints a new setup code
```

## Not done yet

- Published images on a registry with `stable`/`beta` tags; today the compose file builds locally (`build: .`).
  The managed tier (`23-managed.md`) already references `ghcr.io/phuchuwu/hahaness:stable` in `tenants.json`
  and needs the image published to run outside a laptop.
- Running `bash` commands in a nested sandbox (`--network none`); inside the container they still run with the
  server's permissions, as `15-bash.md` describes.
