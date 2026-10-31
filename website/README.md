# Website

The public site at [heemangstudios.com](https://heemangstudios.com/) lives here. GitHub Pages publishes this directory when website changes land on `main`. Repository checks validate local links and assets on pull requests, and Pages runs the same check before deployment.

To preview it locally, run `python3 website/preview.py` from the repository root. The website runs at http://127.0.0.1:7716 and the asset gallery at http://127.0.0.1:7717. Both reload when local files change. The preview binds only to this Mac and adds its reload script in memory; deployed pages stay static. Run `python3 website/check.py` before submitting site changes.

## Purchase flow

The editor is free. Two paid plans add the AI agent on top of it:

- **무료**: open, edit and save HWP/HWPX. No AI agent; the app locks it on this plan. The pricing page mentions it in one line, without a card.
- **Hama** (내 AI 연결, ₩3,900/month or ₩39,000/year): the AI agent on the user's own AI accounts. No hosted AI.
- **Rau** (AI 포함, ₩14,900/month or ₩149,000/year): the hosted Rau agent and Rau mode (Rau-0.1 learning), with a monthly credit allowance that refills every month (`site-api` meters it). A 7-day trial runs once per account after signing in to the app; it takes no payment details.

Plan copy never names a model or AI vendor; `purchase.test.cjs` checks the pricing page. Older yearly (GLJFC9), one-time, Signature and beta keys keep working as Hama; their products stay in `CHECKOUT_URLS` because the license server still validates them.

- `pricing.html` (served at `/pricing`) shows the Hama and Rau cards, each with a 월간/연간 switch, and an FAQ. `#rau` is the default `upgradeUrl` from the license server and `#hama` the other card; empty `#basic` and `#pro` anchors keep older links working. Every price on the page carries `data-price="<plan><Monthly|Yearly|YearlyPerMonth|YearlySaving>"` and is filled from `CONFIG.PRICES`; the static text is the no-JS fallback, and `purchase.test.cjs` fails if it drifts. A buy button whose sku has no `CHECKOUT_URLS` entry, or is `false` in `ON_SALE`, stays a disabled 곧 출시 button with its consent box hidden. Once on sale, the button needs the consent box ticked, makes a random `ref` (`^[A-Za-z0-9\-_.:=~]{1,128}$`), saves it in `localStorage` under `hamaeditor.purchase.ref`, and opens the Groble checkout with `?ref=`.
- `success.html` (served at `/success`) reads `?ref=` or the saved ref and polls `GET {API_BASE}/v1/license/by-ref?ref=` until it answers `{status:'issued', key}`. When the answer carries `licenseExpiresAt`, the page shows the next renewal date, monthly or yearly by the answer's `plan`. A 404 counts as pending. It stops with an error after 5 failed requests in a row and with a timeout after 3 minutes, and both offer a retry and a support email.
- `download.html` (served at `/download`) is where every download button leads. It picks macOS or Windows from `?os=mac|windows`, else from the user agent, and starts that file once on arrival (skipped for 10 minutes after that in the same tab, and with `?nodl`). It offers a manual link, a link to the other OS's file and that OS's install steps. Each download sends `{platform, version}` to `POST {API_BASE}/v1/downloads` with `sendBeacon` (no cookies or identifiers), at most once per file per tab every 10 minutes, so the manual link after the automatic download is not counted twice. Counting never blocks or delays the download.
- `install.html` (served at `/install`) and `trial.html` (served at `/trial`) redirect to `download.html` with the same query string, so old links keep working.
- Every page footer names the operator (하태욱) and the phone number in static HTML, so it shows without JavaScript.
- Every setting lives in `CONFIG` at the top of `assets/purchase.js`: `PRICES` (won, VAT included), `CHECKOUT_URLS` (the plan skus `hamaMonthly`, `hamaYearly`, `rauMonthly`, `rauYearly` point at their Groble products), `ON_SALE` (all four are `false` until launch; flip one to `true` to open its buy button), `PLAN` (legacy default checkout, unused by any page button), `API_BASE`, and the installer links `MAC_DMG_URL` and `WIN_EXE_URL` that the download page uses. Both point at the latest release, so they need no bump per version.

Run `node --test website/purchase.test.cjs` after changing `assets/purchase.js`.
