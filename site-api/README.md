# site-api

Small Node service behind the website beta form and the desktop install counter. It has no dependencies and stores everything as JSON files in one data directory.

## Routes

- `POST /v1/waitlist` takes `{ email }` from the website's 체험 신청 form. The body is sent as `text/plain` so the cross-origin call needs no preflight. CORS is open, and each IP may submit 10 times per 10 minutes. Each email is stored once.
- `GET /v1/waitlist` lists signups for `Authorization: Bearer $RAU_WAITLIST_ADMIN_TOKEN`. Without that variable the list stays closed.
- `POST /v1/unique-installs` records the first launch of a desktop install. `desktop/unique-install.mjs` signs the ping with the shared key in `unique-installs.mjs`.
- `GET /v1/unique-installs` returns the public total, and `GET /unique-installs` renders it as a page.
- `GET /healthz`, `GET /rau.png` and `GET /favicon.ico`.

### License keys (HamaEditor for Mac, ₩9,900 on Groble)

- `POST /v1/groble/webhook` receives Groble events (register `https://rau-credits-production.up.railway.app/v1/groble/webhook` in Groble 내 스토어 → 연동, events `payment.completed`, `payment.cancel_requested`, `payment.refunded`). It checks `X-Groble-Signature` (or `X-Groble-Signature-Previous`) = HEX(HMAC-SHA256(secret, `${X-Groble-Timestamp}.${rawBody}`)) in constant time against `GROBLE_WEBHOOK_SECRET` and `GROBLE_WEBHOOK_SECRET_PREVIOUS`, rejects timestamps more than 5 minutes off, and dedupes on `X-Groble-Idempotency-Key`.
  - `payment.completed` issues one key per `merchantUid` after checking `content.id == GROBLE_CONTENT_ID`, `pricing.originalAmount == GROBLE_EXPECTED_PRICE` and `pricing.finalAmount >= GROBLE_MIN_AMOUNT`. An order that fails a check is **held** (no key) for `orders --status held` and `release`.
  - `payment.cancel_requested` is recorded only. `payment.refunded` revokes on a full refund (or when partial refunds add up to the paid amount) and records partial refunds. A refund that arrives before its completion means no key is ever issued.
  - Replies: 200 when handled or ignored, 401 for a bad signature or timestamp, 503 when the secret is not configured, 500 on a storage error (Groble retries 408/429/5xx). It never answers 3xx or 410.
- `GET /v1/license/by-ref?ref=` returns `{status:'pending'}`, `{status:'issued', key}` or `{status:'revoked'}` for the success page. No buyer data. CORS echoes only `LICENSE_ALLOWED_ORIGINS`. 120 requests per minute per IP.
- `POST /v1/license/activate {key, deviceId, appVersion, platform}`, `POST /v1/license/validate {key, deviceId}`, `POST /v1/license/deactivate {key, deviceId}`. Two devices per key. Success: `{ok:true, lease, keyId, expiresAt (epoch ms), devicesUsed, deviceLimit}`. Errors: `{ok:false, error}` with `invalid_key` (404), `revoked` (403), `device_limit` (409), `not_activated` (404, validate on a device that never activated), `device_id_invalid` (400), `server_not_configured` (503).
- A lease is `payload.signature`: `payload = base64url(JSON {v:1, kid, keyId, keyHash, deviceId, issuedAt, expiresAt})` and `signature = base64url(Ed25519 over the ASCII payload segment)`. Times are epoch ms, valid 7 days. `kid` is `LICENSE_SIGNING_KEY_ID` (default `hama-prod-1`). `keyHash` is hex SHA-256 of the key as the app sent it, trimmed, uppercased and without whitespace, so the app's own normalization of its stored key matches. `license-lease.mjs` `verifyLease(lease, {kid: publicKey}, {deviceId, key})` mirrors the app's check and only needs `node:crypto`. `GET /v1/license/public-key` returns `{alg, kid, rawBase64, spkiDerBase64}`; the app pins `rawBase64` under `kid`.
- `POST /v1/license/grandfather {installId}` returns a free key, once per install, when `sha256(installId)` is in `unique-installs.json` with `os` in `GRANDFATHER_PLATFORMS` (default `darwin`) and `firstSeenAt` before `GRANDFATHER_CUTOFF`. Without the cutoff it answers `grandfather_disabled`.
- Admin (`Authorization: Bearer $ADMIN_TOKEN`): `GET /v1/admin/licenses?key=|keyId=|merchantUid=|email=|ref=`, `GET /v1/admin/orders?status=held|issued|refunded`, and `POST /v1/admin/licenses/{issue,revoke,restore,reset-devices,resend-email}` and `POST /v1/admin/orders/release`. `scripts/license-admin.mjs` wraps them:

```sh
export SITE_API_BASE=https://rau-credits-production.up.railway.app ADMIN_TOKEN=...
node scripts/license-admin.mjs issue --email buyer@example.com --merchant-uid <Groble 주문번호> --note "paid before webhook" [--send-email]
node scripts/license-admin.mjs lookup --email buyer@example.com
node scripts/license-admin.mjs revoke --key HAMA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX --reason refund
```

  A manual key with a `merchantUid` is reused if the Groble webhook for that order arrives later, and a later refund webhook still revokes it.
- Key email goes out after the webhook reply through Resend (`RESEND_API_KEY`, `LICENSE_EMAIL_FROM`). Without the API key the attempt is logged and marked `skipped`; the webhook still succeeds and the success page still shows the key. Failed sends retry up to 3 times, including after a restart. Every email is built on `email-layout.mjs` (banner, key card, download button, footer); its images live in `website/assets/email/` on GitHub Pages, and the deploy workflow waits for them to go live before it deploys the server. The key email's copy follows why it went out: a purchase or released hold, an admin `resend-email`, or an admin `issue --send-email` with no payment behind it.

Keys look like `HAMA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (125 random bits, Crockford base32). The server assumes **one replica**: all license writes go through one in-process lock and an atomic temp-file rename.

## Data

| File | Contents |
| --- | --- |
| `waitlist.json` | `{ entries: { [lowercased email]: { email, joinedAt } } }` |
| `unique-installs.json` | `{ installs: { [sha256(installId)]: { official, firstSeenAt, appVersion, os, arch } } }` |
| `licenses.json` | `{ licenses, keyIndex, orders, refs, webhookEvents, grandfathered }`: keys, devices, Groble orders by `merchantUid`, `ref → merchantUid`, 8 days of webhook delivery keys |

All files live in `RAU_SITE_DATA`. On Railway it defaults to the `/data` volume; locally it defaults to the current directory.

## Variables

| Name | Purpose |
| --- | --- |
| `RAU_SITE_DATA` | Data directory (`/data` on Railway) |
| `RAU_WAITLIST_ADMIN_TOKEN` | Bearer token for reading the waitlist |
| `RAU_WAITLIST_TELEGRAM_BOT_TOKEN`, `RAU_WAITLIST_TELEGRAM_CHAT_ID` | Optional Telegram message for each new signup |
| `RAU_UNIQUE_INSTALL_PING_KEY` | Optional override of the desktop ping key |
| `GROBLE_WEBHOOK_SECRET` | Groble webhook secret (shown once in 내 스토어 → 연동). Required for the webhook |
| `GROBLE_WEBHOOK_SECRET_PREVIOUS` | Old secret for 24 h after a rotation. Optional |
| `GROBLE_CONTENT_ID` | Groble product id, default `uRshdR` |
| `GROBLE_EXPECTED_PRICE`, `GROBLE_MIN_AMOUNT` | List price and lowest accepted paid amount in KRW, default 9900 and 9900. Lower `GROBLE_MIN_AMOUNT` before running a coupon |
| `LICENSE_SIGNING_PRIVATE_KEY` | Ed25519 private key (one-line base64 PKCS#8 DER, or PEM) from `node scripts/generate-license-keypair.mjs`. Required for activate/validate |
| `LICENSE_SIGNING_KEY_ID` | Lease `kid`, default `hama-prod-1`. Change it only together with a new key pinned in the app |
| `ADMIN_TOKEN` | Bearer token for the admin routes. Without it they stay closed |
| `RESEND_API_KEY`, `LICENSE_EMAIL_FROM`, `LICENSE_EMAIL_REPLY_TO` | Key email. Optional; without the API key emails are skipped |
| `GRANDFATHER_CUTOFF` | ISO-8601 time; Mac installs first seen before it get a free key. Unset disables grandfathering |
| `GRANDFATHER_PLATFORMS` | Comma list of `os` values, default `darwin` |
| `LICENSE_ALLOWED_ORIGINS` | CORS origins for by-ref, default `https://heemangstudios.com,https://www.heemangstudios.com,https://heemangstudio.github.io` |
| `LICENSE_DOWNLOAD_URL` | Download button in the key email. Unset or the homepage means the latest Mac dmg |

## Run and deploy

```sh
npm test
npm start          # http://127.0.0.1:5180
```

Production is the Railway project `rau-credits`, service `rau-credits` (`https://rau-credits-production.up.railway.app`), with a volume mounted at `/data`. Deploys go through the GitHub Actions workflow below. Keep the service's GitHub source disconnected (Railway → rau-credits → Settings → Source) so a merge deploys once. For a manual deploy, link this directory once with `railway link` and run `railway up` from `site-api/`. `railway.toml` sets the start command and the `/healthz` health check.

On main, `.github/workflows/site-api-deploy.yml` does this automatically for any change under `site-api/`: it runs the tests, runs `railway up site-api --path-as-root --service rau-credits --environment production --ci` with the `RAILWAY_TOKEN` repository secret (a Railway **project** token for the production environment), then waits up to 10 minutes for `/v1/license/public-key` to answer 200 (404 = the old deployment is still live, 503 = signing key missing) and that an unsigned webhook gets 401 (= secret set). Roll back with Railway → service → Deployments → previous deployment → Redeploy; `licenses.json` on the volume is untouched by a rollback.
