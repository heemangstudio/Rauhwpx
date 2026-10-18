# Website

The public site at [heemangstudios.com](https://heemangstudios.com/) lives here. GitHub Pages publishes this directory when website changes land on `main`. Repository checks validate local links and assets on pull requests, and Pages runs the same check before deployment.

To preview it locally, run `python3 -m http.server 8000 --directory website` from the repository root and open `http://localhost:8000`. Run `python3 website/check.py` before submitting site changes.

## Purchase flow

HamaEditor sells as a one-time 9,900원 (VAT included) purchase for macOS (Apple Silicon) and Windows (x64) through Groble.

- `pricing.html` (served at `/pricing`) shows the price, the supported platforms, the trial (3 days from first launch), the refund rule and the download link. The buy button needs the consent box ticked, makes a random `ref` (`^[A-Za-z0-9\-_.:=~]{1,128}$`), saves it in `localStorage` under `hamaeditor.purchase.ref`, and opens the Groble checkout with `?ref=`.
- `success.html` (served at `/success`) reads `?ref=` or the saved ref and polls `GET {API_BASE}/v1/license/by-ref?ref=` until it answers `{status:'issued', key}`. A 404 counts as pending. It stops with an error after 5 failed requests in a row and with a timeout after 3 minutes, and both offer a retry and a support email.
- `download.html` (served at `/download`) is where every download button leads. It picks macOS or Windows from `?os=mac|windows`, else from the user agent, and starts that file once on arrival (skipped for 10 minutes after that in the same tab, and with `?nodl`). It offers a manual link, a link to the other OS's file and that OS's install steps.
- `install.html` (served at `/install`) redirects to `download.html` with the same query string, so old links keep working.
- Every setting lives in `CONFIG` at the top of `assets/purchase.js`: the Groble checkout URL, `API_BASE`, and the installer links `MAC_DMG_URL` and `WIN_EXE_URL` that the download page uses. Both point at the latest release, so they need no bump per version.

Run `node --test website/purchase.test.cjs` after changing `assets/purchase.js`.
