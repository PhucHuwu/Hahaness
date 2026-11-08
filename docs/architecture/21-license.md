# 21 — Licence key tied to the instance ID

Customers run the image themselves (`18-deployment.md`), so the vendor cannot switch anything off remotely and should
not try to. The licence is the one thing that distinguishes a paying customer from a GitHub self-install, and its only
effect today is to unlock paid marketplace items. Code is in `src/server/license.ts`, the vendor tool is
`scripts/license.ts`, the UI is the **Giấy phép** card in Settings and the badges on the marketplace page.

## Decisions

- **Signed offline, never phoned home.** A licence is `HH1.<payload>.<signature>` where both parts are base64url, the
  payload is JSON and the signature is Ed25519 over the base64url payload string. The vendor's public key is a constant
  in the source (`VENDOR_PUBLIC_KEY`, SPKI DER base64) and therefore baked into every image. The instance verifies the
  key with `node:crypto` and nothing else; an intranet install with no outbound network behaves exactly like one with.
- **Tied to the instance ID.** The payload carries the `instance` UUID from `19-updates.md`. `LicenseStore.set` refuses
  a key for another instance before saving anything, so a key leaked from customer A is useless to customer B. The CEO
  reads the instance ID off the Settings card (copy button), sends it to the vendor and pastes back the key.
- **Expiry blocks installs, nothing else.** `Marketplace.install` throws for `requiresLicense` items when the licence is
  absent, expired or invalid; already-installed MCP servers, the app, schedules and skills keep working. There is no
  grace period logic because nothing stops working at expiry. The marketplace stays open for public items, so a
  self-installed instance without any licence is a complete product with a smaller catalogue.
- **Status, not enforcement, in the UI.** The Settings card shows plan, customer, expiry date and days left, and a
  badge (`còn hạn` / `hết hạn` / `không hợp lệ`). The marketplace shows `cần giấy phép` on paid items and replaces the
  install button with a link to Settings. An expired key is accepted on input (so the UI can say why it is expired)
  but a key with a bad signature or wrong instance is rejected and the previous key is kept.
- **Private key stays with the vendor.** `scripts/license.ts` reads it from `HAHANESS_LICENSE_KEY` (PEM) or `--key
  <file>`; it is never in the repository, the image or the customer database. Rotating it means a new `keygen`, pasting
  the new public key into `VENDOR_PUBLIC_KEY` and re-issuing licences with the next release; old images keep accepting
  old keys.
- **Stored in `settings` under `license`.** `{ key, savedAt }`. Status is computed on every read, so the clock moving
  past `expiresAt` is noticed without a restart or a background job.

## Payload

```json
{ "instance": "7addba9d-…", "plan": "pro", "customer": "Công ty A", "issuedAt": "2026-11-09", "expiresAt": "2027-11-09" }
```

`plan` is a free string the vendor chooses; the instance does not interpret it yet (a `requiresLicense` item is
unlocked by any valid plan). Per-plan item lists can be added to the catalogue later without changing the key format.

## Vendor workflow

```sh
npx tsx scripts/license.ts keygen                                   # once; paste public key into VENDOR_PUBLIC_KEY
npx tsx scripts/license.ts sign --instance <uuid> --plan pro --expires 2027-11-09 --customer "Công ty A" --key vendor.pem
npx tsx scripts/license.ts inspect HH1.…                            # decode + verify against the key in the source
```

## Routes

| Route | Purpose |
|---|---|
| `GET /api/license` | `{ instance, state, plan, customer, expiresAt, daysLeft, error }`; `state` is `none`, `valid`, `expired` or `invalid` |
| `PUT /api/license` | `{ key }`; verifies signature and instance, saves, returns the status; 400 with a Vietnamese message otherwise |
| `DELETE /api/license` | Removes the key |
| `GET /api/marketplace` | Now includes `licensed` and `requiresLicense` per item |

Tests sign with a throwaway key pair and pass it as `startServer({ licensePublicKey })`, so they never need the vendor
key. `license.test.ts` covers round trip, tampering, foreign signer, wrong instance and expiry; `server.test.ts` covers
the routes and the install gate end to end with a `requiresLicense` echo server.

## Not done yet

- Per-plan entitlements in the catalogue (`plans: ["pro"]` on an item).
- Vendor-side record of issued licences (today: whatever the vendor keeps alongside the private key).
- Hosted MCP gateway with per-customer keys (step 5), which is what the first paid catalogue items will point at.
