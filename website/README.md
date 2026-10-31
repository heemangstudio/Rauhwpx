# Website

The public site at [heemangstudios.com](https://heemangstudios.com/) lives here. GitHub Pages publishes this directory when website changes land on `main`. Repository checks validate local links and assets on pull requests, and Pages runs the same check before deployment.

To preview it locally, run `python3 website/preview.py` from the repository root. The website runs at http://127.0.0.1:7716 and the asset gallery at http://127.0.0.1:7717. Both reload when local files change. The preview binds only to this Mac and adds its reload script in memory; deployed pages stay static. Run `python3 website/check.py` before submitting site changes.

## Purchase flow

The editor is free. Paid plans add AI on top of it:

- **무료**: open, edit and save HWP/HWPX. No AI agent; the app locks it on this plan.
- **Basic**: monthly or yearly subscription on Groble. Adds the AI agent on the user's own Codex, Claude or OpenRouter account, and hosted Rau-0.1 under a monthly fair-use cap (`site-api` handles the cap).
- **Hama**: shown as 준비 중 with no buy button. Everything in Basic, plus the hosted AI agent.

Older yearly (GLJFC9), one-time and beta keys keep working; their products stay in `CHECKOUT_URLS` because the license server still validates them.

- `pricing.html` (served at `/pricing`) shows the three plans, a 월간/연간 switch on Basic, and an FAQ. `#basic` is the anchor the license server's `BASIC_UPGRADE_URL` points at; an empty `#pro` anchor keeps the links in shipped apps working. Every price on the page carries `data-price="<key>"` and is filled from `CONFIG.PRICES`; the static text is the no-JS fallback, and `purchase.test.cjs` fails if it drifts. A buy button whose `CHECKOUT_URLS` entry is empty stays a disabled 곧 출시 button with its consent box hidden. Once a link is set, the button needs the consent box ticked, makes a random `ref` (`^[A-Za-z0-9\-_.:=~]{1,128}$`), saves it in `localStorage` under `hamaeditor.purchase.ref`, and opens the Groble checkout with `?ref=`.
- `success.html` (served at `/success`) reads `?ref=` or the saved ref and polls `GET {API_BASE}/v1/license/by-ref?ref=` until it answers `{status:'issued', key}`. When the answer carries `licenseExpiresAt`, the page shows the next renewal date, monthly or yearly by the answer's `plan`. A 404 counts as pending. It stops with an error after 5 failed requests in a row and with a timeout after 3 minutes, and both offer a retry and a support email.
- `download.html` (served at `/download`) is where every download button leads. It picks macOS or Windows from `?os=mac|windows`, else from the user agent, and starts that file once on arrival (skipped for 10 minutes after that in the same tab, and with `?nodl`). It offers a manual link, a link to the other OS's file and that OS's install steps. Each download sends `{platform, version}` to `POST {API_BASE}/v1/downloads` with `sendBeacon` (no cookies or identifiers), at most once per file per tab every 10 minutes, so the manual link after the automatic download is not counted twice. Counting never blocks or delays the download.
- `install.html` (served at `/install`) and `trial.html` (served at `/trial`) redirect to `download.html` with the same query string, so old links keep working.
- Every page footer names the operator (하태욱) and the phone number in static HTML, so it shows without JavaScript.
- Every setting lives in `CONFIG` at the top of `assets/purchase.js`: `PRICES` (won, VAT included; `hama: null` shows 미정), `CHECKOUT_URLS` (the Basic entries `basicMonthly` and `basicYearly` are empty placeholders until the Groble products exist), `PLAN` (legacy default checkout, unused by any page button), `API_BASE`, and the installer links `MAC_DMG_URL` and `WIN_EXE_URL` that the download page uses. Both point at the latest release, so they need no bump per version.

Run `node --test website/purchase.test.cjs` after changing `assets/purchase.js`.
