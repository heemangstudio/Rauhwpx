# site-api

Small Node service behind the website beta form and the desktop install counter. It has no dependencies and stores everything as JSON files in one data directory.

## Routes

- `POST /v1/waitlist` takes `{ email }` from the website's 체험 신청 form. The body is sent as `text/plain` so the cross-origin call needs no preflight. CORS is open, and each IP may submit 10 times per 10 minutes. Each email is stored once.
- `GET /v1/waitlist` lists signups for `Authorization: Bearer $RAU_WAITLIST_ADMIN_TOKEN`. Without that variable the list stays closed.
- `POST /v1/unique-installs` records the first launch of a desktop install. `desktop/unique-install.mjs` signs the ping with the shared key in `unique-installs.mjs`.
- `GET /v1/unique-installs` returns the public total, and `GET /unique-installs` renders it as a page.
- `POST /v1/downloads {platform, version}` counts a download start from the website (`navigator.sendBeacon`, `text/plain`, CORS open). `platform` is one of `mac-arm64`, `mac-x64`, `win-x64`, `win-arm64`, `linux-x64`; `version` is `latest` or `x.y.z[-tag]`. 30 per IP per 10 minutes in memory. `downloads.json` keeps counts only, by KST day and `platform|version` (64 pairs a day, 400 days); no IP, user agent or identifier is stored. `GET /v1/admin/downloads?days=30` (`ADMIN_TOKEN`) and `license-admin.mjs downloads [--days N]` read them.
- `GET /healthz`, `GET /rau.png` and `GET /favicon.ico`.

### License keys (HamaEditor for Mac, ₩9,900 on Groble)

Two Groble products sell keys: the one-time product (`GROBLE_ONETIME_PRODUCT_IDS`, default `uRshdR`) issues **lifetime** keys, and the 12-month auto-renewing subscription (`GROBLE_SUBSCRIPTION_PRODUCT_IDS`, default `GLJFC9`) issues **annual** keys with `expiresAt`. Records without `expiresAt` (every key issued before subscriptions, beta, grandfathered and manual keys) are lifetime. Event names and fields follow [Groble's event reference](https://groble.im/help/guides/webhook-events).

- `POST /v1/groble/webhook` receives Groble events (register `https://rau-credits-production.up.railway.app/v1/groble/webhook` in Groble 내 스토어 → 연동, events `payment.completed`, `payment.cancel_requested`, `payment.refunded`, `subscription_payment.completed`, `subscription_payment.refunded`, `subscription_payment.failed`, `subscription.cancel_requested`, `subscription.terminated`). It checks `X-Groble-Signature` (or `X-Groble-Signature-Previous`) = HEX(HMAC-SHA256(secret, `${X-Groble-Timestamp}.${rawBody}`)) in constant time against `GROBLE_WEBHOOK_SECRET` and `GROBLE_WEBHOOK_SECRET_PREVIOUS`, rejects timestamps more than 5 minutes off, and dedupes on `X-Groble-Idempotency-Key`.
  - `payment.completed` issues one key per `merchantUid` after checking `content.id == GROBLE_CONTENT_ID`, `pricing.originalAmount == GROBLE_EXPECTED_PRICE` and `pricing.finalAmount >= GROBLE_MIN_AMOUNT`. An order that fails a check is **held** (no key) for `orders --status held` and `release`.
  - `payment.cancel_requested` is recorded only. `payment.refunded` revokes on a full refund (or when partial refunds add up to the paid amount) and records partial refunds. A refund that arrives before its completion means no key is ever issued.
  - `subscription_payment.completed` with `billingReason: INITIAL` issues one key per `merchantUid` (same product and price checks, `paymentType == SUBSCRIPTION`) with `expiresAt` = the end of the KST day `billingCycleMonths` (default 12) after the payment. Its `sellerReference` links the subscription to the key. `RENEWAL` finds that key by `sellerReference` (else the one live subscription key with the buyer's email) and extends it by one cycle from its current expiry, or from the day it was paid if it lapsed (a late retry or re-payment starts a new year on its payment day). Each round's `merchantUid` is recorded, so a replay never extends twice. A renewal checks product and currency only, so a later price change never holds old subscribers. An unmatched renewal is held: `extend` the key (a held renewal cannot be `release`d).
  - `subscription_payment.failed` puts the key in `past_due` and keeps it **fully usable past `expiresAt`** through Groble's retry and grace window (3 daily attempts, then 7 days; groble.im/legal/refund 제6조 제13항): until `failure.gracePeriodEndsAt` when the event carries it (the final attempt does), else `expiresAt` + `GROBLE_PAYMENT_GRACE_DAYS` (default 10). `subscription.terminated` or the window's end stops it; a paid retry renews as usual and clears it.
  - `subscription.cancel_requested` and `subscription.terminated` are recorded on the key (`subscription.status` `cancel_requested` / `terminated`, `autoRenew: false`). They never shorten the paid year: an immediate termination (`SELLER_CANCELLED`, `CONTENT_DELETED`) still runs to `expiresAt`. `subscription_payment.refunded` takes back the refunded round's time, and revokes once every paid round of the key is refunded.
  - Unknown event types, events with no `merchantUid` and subscription events with no matching key answer 200 (so Groble stops retrying) and are recorded as held in `webhook-log.json`.
  - Replies (Groble retries 408/429/5xx for about 44 hours and treats other 4xx as final; it never gets 3xx or 410):

    | Status | `error` | Why |
    | --- | --- | --- |
    | 200 | | Handled, held or ignored |
    | 503 | `not_configured`, `missing_headers`, `bad_timestamp`, `bad_signature`, `body_too_large` | The signature could not be checked or did not match. Groble keeps retrying while the secret or setup is fixed |
    | 401 | `timestamp_out_of_window` | Signed, but more than 5 minutes off. Replay protection, final |
    | 400 | `json_invalid`, `payload_invalid` | Signed, but the body is unreadable. Final |
    | 500 | `store_error` | Saving failed. Groble retries |
    | 429 | `rate_limited` | More than 30 rejections per IP (300 overall) in 10 minutes. Not recorded |

  - Every rejected webhook and every held order is recorded in `webhook-log.json` (newest 200) with the time, reason, status, whether the signature matched, the request headers without `X-Groble-Signature*`, `Authorization` or `Cookie`, `X-Groble-Timestamp`, `X-Groble-Idempotency-Key`, and the event type, id and `merchantUid` when the body is JSON. For an unverified request those body fields are whatever the sender claimed.
  - Every rejection also emails `management@heemangstudios.com` through Resend after the reply, at most once per reason per 15 minutes; the next email for that reason counts the ones in between. It carries the reason, time and status only. Without `RESEND_API_KEY` the alert is skipped with a log line.
- `GET /v1/groble/webhook` answers 200 when the webhook secret is set and 503 when it is not. The deploy workflow polls it.
- `GET /v1/license/by-ref?ref=` returns `{status:'pending'}`, `{status:'issued', key, licenseExpiresAt}` (epoch ms, `null` for lifetime) or `{status:'revoked'}` for the success page. No buyer data. CORS echoes only `LICENSE_ALLOWED_ORIGINS`. 120 requests per minute per IP.
- `POST /v1/license/activate {key, deviceId, appVersion, platform}`, `POST /v1/license/validate {key, deviceId}`, `POST /v1/license/deactivate {key, deviceId}`. Two devices per paid key; beta keys carry their own limit. Success: `{ok:true, lease, keyId, tier ('paid'|'beta'), expiresAt (lease end, epoch ms), licenseExpiresAt (key end, epoch ms, null = lifetime), autoRenew (null for lifetime), licenseState ('active' | 'payment_failed'), paymentGraceEndsAt (epoch ms while payment_failed, else null), paymentFixUrl (annual keys only: Groble's buyer page where the payment is fixed), devicesUsed, deviceLimit}`. All of these are additions; older apps ignore them. Errors: `{ok:false, error}` with `invalid_key` (404), `revoked` (403, with `tier`), `expired` (403, an annual key past `expiresAt` and any payment grace, with `tier`, `licenseExpiresAt` and `paymentFixUrl`; deactivate still works), `device_limit` (409), `not_activated` (404, validate on a device that never activated), `device_id_invalid` (400), `server_not_configured` (503).
- A lease is `payload.signature`: `payload = base64url(JSON {v:1, kid, keyId, keyHash, deviceId, issuedAt, expiresAt[, licenseExpiresAt]})`, where `licenseExpiresAt` appears only for annual keys so lifetime leases are unchanged, and `signature = base64url(Ed25519 over the ASCII payload segment)`. Times are epoch ms, valid 7 days (3 days for beta keys). `kid` is `LICENSE_SIGNING_KEY_ID` (default `hama-prod-1`). `keyHash` is hex SHA-256 of the key as the app sent it, trimmed, uppercased and without whitespace, so the app's own normalization of its stored key matches. `license-lease.mjs` `verifyLease(lease, {kid: publicKey}, {deviceId, key})` mirrors the app's check and only needs `node:crypto`. `GET /v1/license/public-key` returns `{alg, kid, rawBase64, spkiDerBase64}`; the app pins `rawBase64` under `kid`.
- `POST /v1/license/grandfather {installId}` returns a free key, once per install, when `sha256(installId)` is in `unique-installs.json` with `os` in `GRANDFATHER_PLATFORMS` (default `darwin`) and `firstSeenAt` before `GRANDFATHER_CUTOFF`. Without the cutoff it answers `grandfather_disabled`.
- Admin (`Authorization: Bearer $ADMIN_TOKEN`): `GET /v1/admin/licenses?key=|keyId=|merchantUid=|email=|ref=`, `GET /v1/admin/orders?status=held|issued|refunded`, `GET /v1/admin/webhooks?kind=rejected|held&limit=50`, `GET /v1/admin/licenses/betas`, and `POST /v1/admin/licenses/{issue,issue-beta,revoke,restore,reset-devices,resend-email,extend}` and `POST /v1/admin/orders/release`. License views carry `plan` (`lifetime`|`annual`), `expiresAt`, `subscription` and `extensions`. `scripts/license-admin.mjs` wraps them:

```sh
export SITE_API_BASE=https://rau-credits-production.up.railway.app ADMIN_TOKEN=...
node scripts/license-admin.mjs issue --email buyer@example.com --merchant-uid <Groble 주문번호> --note "paid before webhook" [--send-email] [--years 1 | --until 2027-10-20]
node scripts/license-admin.mjs lookup --email buyer@example.com   # last lines: <key> lifetime · active · 평생, or annual · active · 2027-10-20까지 · 자동 갱신
node scripts/license-admin.mjs extend HAMA-XXXXX-... [--years 1 | --until 2027-12-31] [--note "..."]   # or the success-page ref instead of the key
node scripts/license-admin.mjs beta --name "홍길동" [--devices 5] [--email tester@example.com] [--note "..."]
node scripts/license-admin.mjs betas
node scripts/license-admin.mjs revoke --key HAMA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX --reason refund
node scripts/license-admin.mjs webhooks --rejected        # or --held, or neither for both; --limit 200
```

  After fixing a `bad_signature` or `not_configured` alert, Groble's retries issue the keys on their own. A final rejection (401/400) never comes back: find its `merchantUid` with `webhooks --rejected`, take the buyer email from Groble and run `issue --merchant-uid ... --email ... --send-email`.

  Beta-tester keys (`beta`, `POST /v1/admin/licenses/issue-beta {name, email?, devices?, note?}`) work like paid keys on macOS and Windows but allow `devices` simultaneous devices (default 5, clamped to 1..50) and get 3-day leases, so a `revoke` locks an online app at its next daily check and an offline one within 3 days. They are never emailed: `beta` prints the key on its last line. `betas` lists each key with its tester, status, devices (platform, last seen) and revocation time. Records without `tier` or `deviceLimit` are paid keys on two devices.

  For the same calls in a browser, run `npm --prefix site-api run admin-ui` and open http://127.0.0.1:8790 (`--port` or `PORT` to change). It creates, lists, revokes, restores and resets beta keys and looks up any key by key or email. It listens on 127.0.0.1 only and forwards a fixed set of admin routes to `SITE_API_BASE` (default production) with the token added server-side. The token comes from `ADMIN_TOKEN`, else the macOS Keychain item `hamaeditor-license-admin`, which the page fills in once if both are missing. Requests need this server's `Host`, a per-launch session token from the page and no foreign `Origin`. To open it from another tailnet device, put `tailscale serve` in front and set `ADMIN_UI_PUBLIC_ORIGIN=https://<ts.net name>:<port>`; it stays bound to 127.0.0.1.

  A manual key with a `merchantUid` is reused if the Groble webhook for that order arrives later, and a later refund webhook still revokes it. `issue --years N` (or `--until DATE`) makes the manual key an annual key, for a subscription order whose webhook never arrived. `extend` adds N years (default 1) to an annual key from its expiry, or from now if it lapsed; `--until YYYY-MM-DD` sets the end of that KST day. Lifetime keys answer `lifetime_key`. Each extension is kept in the key's `extensions`.
- Key email goes out after the webhook reply through Resend (`RESEND_API_KEY`, `LICENSE_EMAIL_FROM`). Without the API key the attempt is logged and marked `skipped`; the webhook still succeeds and the success page still shows the key. Failed sends retry up to 3 times, including after a restart. Every email is built on `email-layout.mjs` (banner, key card, download button, footer); its images live in `website/assets/email/` on GitHub Pages, and the deploy workflow waits for them to go live before it deploys the server. The key email's copy follows why it went out: a purchase or released hold, a subscription renewal, an admin `resend-email`, or an admin `issue --send-email` with no payment behind it. Annual keys get one line under the key card with the next renewal date (or the end date once auto-renewal is off); the card itself holds only the key, and lifetime keys get no date.

### Gift credits (SPECIAL EVENT)

A one-time gift of `GIFT_AMOUNT_USD` of Claude usage for Pi, one per beta license key (`tier: 'beta'`, shared by its devices) and macOS only. Paid and grandfathered keys do not get it. The app authenticates with its license lease as `Authorization: Bearer <lease>`; the server checks its own signature, expiry, that the license is active, that the lease's device is still activated, and the key hash. Anything else is `unauthorized` (401). A valid lease is `not_eligible` unless the key is a beta key and the device's `platform` is in `GIFT_PLATFORMS`; this is checked on every status, claim and proxy call.

- `GET /v1/gift/status` → `{ok, event:{id, amountUsd, endsAt, active}, eligible, claimed, remainingUsd, usedUsd, claimedAt}`. Balances come from the key's `limit_remaining` on OpenRouter (BYOK spend plus OpenRouter fees), cached 15 s, and are `null` when it does not answer.
- `POST /v1/gift/claim` (body `{}`) is idempotent. The first call creates one OpenRouter key named `hama-gift-<event>-<keyId>` with `limit = GIFT_AMOUNT_USD` and `include_byok_in_limit: true`, and keeps the key in `gifts.json`; it is never sent to the app. Errors: `unauthorized` 401, `not_eligible` 403, `event_inactive` 410 (event not configured or past `GIFT_ENDS_AT`), `budget_exhausted` 409 (the created limits would pass `GIFT_TOTAL_BUDGET_USD`), `upstream_unavailable` 502. A claim interrupted after OpenRouter created the key leaves a `provisioning` record; the next claim deletes keys with that name before creating a new one.
- OpenAI-compatible proxy at `/v1/gift/openrouter` (Pi `baseUrl`, lease in place of the API key). Errors use OpenRouter's `{error:{code,message}}` shape: 401 `unauthorized`, 403 `not_eligible` or `gift_not_claimed`, 410 `event_inactive`, 402 `Insufficient credits: ...` once the key limit is spent or the gift is disabled.
  - `POST /chat/completions` streams SSE through as it arrives, and a client disconnect aborts the upstream request. Models must start with one of `GIFT_MODEL_PREFIXES` (also every entry of `models`); `max_tokens`/`max_completion_tokens` are clamped to `GIFT_MAX_OUTPUT_TOKENS` and `max_tokens` is set when neither is given. Bodies up to 16 MiB, 4 concurrent requests and 60 per minute per license.
  - `GET /models` is the OpenRouter catalog filtered to the allowed prefixes, cached 10 minutes. `GET /auth/key` (and `/key`) and `GET /credits` answer OpenRouter-shaped balances for the gift.
- Admin: `GET /v1/admin/gifts?status=&eventId=` lists grants without their keys plus `committedUsd`; `POST /v1/admin/gifts/disable {keyId, reason}` disables the OpenRouter key (`PATCH /keys/{hash} {disabled:true}`) and marks the grant `revoked`. A revoked license loses the gift at once because its lease no longer authenticates.

```sh
node scripts/license-admin.mjs gifts [--status active]
node scripts/license-admin.mjs gift-disable --key-id lic_... --reason abuse
```

Owner setup on OpenRouter, so gift usage bills to Anthropic Console credit:

1. OpenRouter → Settings → Integrations → Anthropic: add the Anthropic Console API key as a BYOK key in the **Prioritized** section, and set **Shared capacity fallback** to "Never use shared capacity for any model on this provider". Without that, a rate-limited or failing Anthropic key falls back to OpenRouter credits.
2. Keep a small OpenRouter credit balance. BYOK requests cost 5% of the normal OpenRouter price from OpenRouter credits, after a monthly fee-free allowance ($25,000 of list-price usage on pay-as-you-go). A gift key's limit counts both the Anthropic spend and that fee.
3. Create a management key at openrouter.ai/settings/management-keys and set it as `OPENROUTER_PROVISIONING_KEY`. If it has an expiration, replace the variable before that date; an expired key makes claims fail with `upstream_unavailable`.

Deploy checks: Railway's edge must keep long SSE responses open (idle and maximum request duration), so try a long streamed completion against production after the first deploy.

Keys look like `HAMA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (125 random bits, Crockford base32). The server assumes **one replica**: all license writes go through one in-process lock and an atomic temp-file rename.

## Data

| File | Contents |
| --- | --- |
| `waitlist.json` | `{ entries: { [lowercased email]: { email, joinedAt } } }` |
| `unique-installs.json` | `{ installs: { [sha256(installId)]: { official, firstSeenAt, appVersion, os, arch } } }` |
| `licenses.json` | `{ licenses, keyIndex, orders, refs, webhookEvents, grandfathered }`: keys (annual ones with `expiresAt` and `subscription`), devices, Groble orders by `merchantUid` (each paid subscription round is one order with `kind`, `grantFrom`, `grantTo`), `ref → merchantUid` of the first round, 8 days of webhook delivery keys |
| `webhook-log.json` | `{ entries: [...] }`: the newest 200 rejected or held Groble webhooks |
| `downloads.json` | `{ days: { [KST day]: { ['platform|version']: count } } }` |
| `gifts.json` | `{ events: { [eventId]: { grants: { [keyId]: { status, name, limitUsd, openrouterHash, openrouterKey, claimedAt, ... } } } } }` |

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
| `GROBLE_ONETIME_PRODUCT_IDS` | Comma list of one-time products that issue lifetime keys, default `uRshdR`. `GROBLE_CONTENT_ID` (the old single-product name) is used when this is unset |
| `GROBLE_PAYMENT_GRACE_DAYS` | Days an annual key stays usable past its expiry after a failed renewal when Groble's event has no grace end, default 10 |
| `GROBLE_PAYMENT_FIX_URL` | Groble buyer page sent to the app for fixing a failed payment (must be `https://groble.im/...`), default `https://groble.im/manage/purchase` (주문조회) |
| `GROBLE_SUBSCRIPTION_PRODUCT_IDS` | Comma list of 정기결제 products that issue annual keys, default `GLJFC9`. A product in both lists fails startup |
| `GROBLE_EXPECTED_PRICE`, `GROBLE_MIN_AMOUNT` | List price and lowest accepted paid amount in KRW, default 9900 and 9900. Lower `GROBLE_MIN_AMOUNT` before running a coupon |
| `LICENSE_SIGNING_PRIVATE_KEY` | Ed25519 private key (one-line base64 PKCS#8 DER, or PEM) from `node scripts/generate-license-keypair.mjs`. Required for activate/validate |
| `LICENSE_SIGNING_KEY_ID` | Lease `kid`, default `hama-prod-1`. Change it only together with a new key pinned in the app |
| `ADMIN_TOKEN` | Bearer token for the admin routes. Without it they stay closed |
| `RESEND_API_KEY`, `LICENSE_EMAIL_FROM`, `LICENSE_EMAIL_REPLY_TO` | Key email and webhook alerts. Optional; without the API key emails are skipped |
| `GRANDFATHER_CUTOFF` | ISO-8601 time; Mac installs first seen before it get a free key. Unset disables grandfathering |
| `GRANDFATHER_PLATFORMS` | Comma list of `os` values, default `darwin` |
| `LICENSE_ALLOWED_ORIGINS` | CORS origins for by-ref, default `https://heemangstudios.com,https://www.heemangstudios.com,https://heemangstudio.github.io` |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter management key that creates the gift keys (BYOK setup above). With `GIFT_EVENT_ID` it turns the gift routes on |
| `GIFT_EVENT_ID` | Event id, e.g. `special-2026-10`. One gift per license per event |
| `GIFT_AMOUNT_USD` | Limit of each gift key, default 20 |
| `GIFT_ENDS_AT` | Optional ISO-8601 time after which no new gifts are claimed. Claimed gifts keep working |
| `GIFT_TOTAL_BUDGET_USD` | Cap on the sum of created gift limits. Unset means no cap |
| `GIFT_MODEL_PREFIXES` | Comma list of allowed model id prefixes, default `anthropic/` |
| `GIFT_PLATFORMS` | Comma list of device platforms where beta keys get the gift, default `darwin` |
| `GIFT_MAX_OUTPUT_TOKENS` | Output token cap per request, default 32000 |
| `OPENROUTER_API_BASE` | OpenRouter API base, default `https://openrouter.ai/api/v1`. Only for local tests |
| `LICENSE_DOWNLOAD_URL` | Download button in the key email. Unset or the homepage means the latest Mac dmg |

## Run and deploy

```sh
npm test
npm start          # http://127.0.0.1:5180
```

Production is the Railway project `rau-credits`, service `rau-credits` (`https://rau-credits-production.up.railway.app`), with a volume mounted at `/data`. Deploys go through the GitHub Actions workflow below. Keep the service's GitHub source disconnected (Railway → rau-credits → Settings → Source) so a merge deploys once. For a manual deploy, link this directory once with `railway link` and run `railway up` from `site-api/`. `railway.toml` sets the start command and the `/healthz` health check.

On main, `.github/workflows/site-api-deploy.yml` does this automatically for any change under `site-api/`: it runs the tests, runs `railway up site-api --path-as-root --service rau-credits --environment production --ci` with the `RAILWAY_TOKEN` repository secret (a Railway **project** token for the production environment), then waits up to 10 minutes for `GET /v1/groble/webhook` to answer 200 (404 = the old deployment is still live, 503 = webhook secret missing) and checks that `/v1/license/public-key` answers 200 (503 = signing key missing). Roll back with Railway → service → Deployments → previous deployment → Redeploy; `licenses.json` on the volume is untouched by a rollback.
