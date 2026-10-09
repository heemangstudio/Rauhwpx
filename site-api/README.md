# site-api

Small Node service behind the website beta form and the desktop install counter. It has no dependencies and stores everything as JSON files in one data directory.

## Routes

- `POST /v1/waitlist` takes `{ email }` from the website's 체험 신청 form. The body is sent as `text/plain` so the cross-origin call needs no preflight. CORS is open, and each IP may submit 10 times per 10 minutes. Each email is stored once.
- `GET /v1/waitlist` lists signups for `Authorization: Bearer $RAU_WAITLIST_ADMIN_TOKEN`. Without that variable the list stays closed.
- `POST /v1/unique-installs` records the first launch of a desktop install. `desktop/unique-install.mjs` signs the ping with the shared key in `unique-installs.mjs`.
- `GET /v1/unique-installs` returns the public total, and `GET /unique-installs` renders it as a page.
- `GET /healthz`, `GET /rau.png` and `GET /favicon.ico`.

## Data

| File | Contents |
| --- | --- |
| `waitlist.json` | `{ entries: { [lowercased email]: { email, joinedAt } } }` |
| `unique-installs.json` | `{ installs: { [sha256(installId)]: { official, firstSeenAt, appVersion, os, arch } } }` |

Both files live in `RAU_SITE_DATA`. On Railway it defaults to the `/data` volume; locally it defaults to the current directory.

## Variables

| Name | Purpose |
| --- | --- |
| `RAU_SITE_DATA` | Data directory (`/data` on Railway) |
| `RAU_WAITLIST_ADMIN_TOKEN` | Bearer token for reading the waitlist |
| `RAU_WAITLIST_TELEGRAM_BOT_TOKEN`, `RAU_WAITLIST_TELEGRAM_CHAT_ID` | Optional Telegram message for each new signup |
| `RAU_UNIQUE_INSTALL_PING_KEY` | Optional override of the desktop ping key |

## Run and deploy

```sh
npm test
npm start          # http://127.0.0.1:5180
```

Production is the Railway project `rau-credits`, service `rau-credits` (`https://rau-credits-production.up.railway.app`), with a volume mounted at `/data`. Link this directory to that service once with `railway link`, then deploy from `site-api/` with `railway up`. `railway.toml` sets the start command and the `/healthz` health check.
