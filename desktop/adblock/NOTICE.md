# Browser ad blocking

Ghostery Adblocker 2.20.1, copyright Ghostery GmbH and its contributors, is distributed unmodified under MPL-2.0. Its license is in `LICENSE-Ghostery.txt` and in the installed packages. Source: https://github.com/ghostery/adblocker/tree/v2.20.1

EasyList and EasyPrivacy are copyright The EasyList authors, https://easylist.to/. These filter lists are distributed here under GPL-3.0-or-later. The license is in `LICENSE-EasyList.txt`. Upstream licensing: https://easylist.to/pages/licence.html

The complete, unmodified filter sources corresponding to `engine.bin` are included as `easylist.txt.gz` and `easyprivacy.txt.gz`. The binary is generated from those sources by Ghostery. `metadata.json` records the download time and source URLs. Run `node scripts/update-browser-adblock.mjs` to update all bundled artifacts together.

The engine and its original preload are installed through pinned npm dependencies. Request filtering and top-frame cosmetic hiding run locally. The app's filter-update button downloads only the two fixed list URLs. It sends no page addresses, forms, passwords, browsing history, or filter-match telemetry.
