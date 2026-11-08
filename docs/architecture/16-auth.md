# 16 — Web UI login

The server runs on a VPS and agents can run commands (`15-bash.md`), so anyone who can open the web page can control
the server. From now on every `/api/*` requires login. Code is in `src/server/auth.ts`; UI in `ui/src/pages/Login.tsx`.

## Decisions

- **One person, one password.** No accounts or roles: the system has one CEO. The password is hashed with
  `scrypt` with its own salt and stored in `settings` (key `auth`). No new library.
- **Setting the password the first time requires the setup code** ("mã cài đặt") printed in the server log (`Mã cài đặt: …`, regenerated on every startup
  while no password exists). Without this code, whoever finds the VPS IP before the owner could set the password and take over
  the system. The person setting up the VPS reads the code from the log (`journalctl`, `docker logs`, terminal).
- **The login session is a cookie** `hh_session`: a random 32-byte token, `HttpOnly`, `SameSite=Lax` flags,
  plus `Secure` when running behind HTTPS (`X-Forwarded-Proto: https`). A session expires 30 days after last
  use. The DB stores only the sha256 of the token. At most 20 sessions are kept at a time.
  - Because a cookie is used, SSE (`EventSource`) is protected without a custom header.
- **CSRF protection:** non-GET requests with an `Origin` header that differs from the host are rejected with 403, even when
  logged in. The `SameSite=Lax` cookie blocks the rest. The Vite dev proxy preserves `Host`
  (`changeOrigin: false`) so this check is correct in dev.
- **Brute-force protection:** 5 failures (password, setup code, or current password when changing it) from one IP
  lock that IP for 15 minutes. Lock state is in memory. Behind a reverse proxy on the same machine, the IP is taken from
  `X-Forwarded-For`.
- **Changing the password logs out all other devices.** There is also a "Log out other devices" (Đăng xuất thiết bị khác) button (**Settings** (Cài đặt)
  page → **Account** (Tài khoản)).
- Routes open without login: `GET /api/auth`, `POST /api/auth/{setup,login,logout,password,logout-others}`.
  `password` and `logout-others` check the session or password themselves. The UI's static files are also open, because the UI queries
  `/api/auth` itself and then shows the login screen.
- When the API returns 401 mid-use (session expired), the UI reloads the page and returns to the login screen.
- Tests disable login with `startServer({ auth: false })`.

## Forgotten password

Delete the `auth` key in the `settings` table and restart; the server will print a new setup code:

```sh
sqlite3 .hahaness/hahaness.db "DELETE FROM settings WHERE key = 'auth'"
```

## VPS deployment

- By default the server only listens on `127.0.0.1`. Set `HOST=0.0.0.0` to expose it, but put a reverse proxy with
  HTTPS (Caddy or nginx) in front, because without HTTPS the password and cookie travel in plain text.
- Telegram is not affected: that channel uses its own pairing code (`13-telegram.md`).
