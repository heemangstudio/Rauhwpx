# Website links in the floating browser

Foreground `target="_blank"` links loaded a native destination tab, but the floating preview filtered against its original tab ID. The new destination stayed hidden. The floating view now follows foreground children of its selected page and returns to their opener when they close. Background links and unrelated pages do not take selection.

A separate fresh-open check found that a late detach could leave the UI caching an attached native page that was actually hidden. Unexpected hidden-presentation events now invalidate that cache and schedule reattachment. Intentional overlays and manually sleeping tabs retain their existing behavior.

## Live Electron verification

Runtime: `/Users/hataewook/projects/hobbies/Rauhwpx-pr475`, branch `fix/browser-interaction-latency`, Studio `http://127.0.0.1:7745/`, Electron CDP 9475, document `adsf.hwpx`. Frontend changes were loaded through Vite's renderer reload.

- Clicked Muxy's actual GitHub website link (`target="_blank"`, `rel="noreferrer"`) in the native floating guest. Before the fix, GitHub loaded with presentation mode `hidden`.
- Repeated after integration and a fresh preview open. The destination URL was `https://github.com/muxy-app/muxy`, presentation mode was `float`, and loading completed. The school page remained docked in the sidebar.
- Closed the verification destination. The original Muxy page returned to `float` at the saved rectangle `(469, 295, 515, 476)`.

No personal website content or credentials were captured for this evidence. A final additional forced-detach live check could not be completed after the live tab set changed; automatic detach recovery is covered by the behavioral production-UI fixture below.

## Focused checks

- Studio `tsc --noEmit`: passed.
- Browser projection, controller, and OAuth popup Studio tests: 18 passed. The production UI uses fixture-backed native/hub services; its unexpected-detach case failed before the cache fix and passed afterward, alongside manual sleep and overlay checks.
- `node --test tests/desktop-browser-oauth-popup.test.mjs`: passed. Its real Electron fixture exercises foreground and background popup links, opener preservation, OAuth redirects and closure, a new-window POST form with a 303 redirect, and password protection. Destination URL assertions prevent an `about:blank` result.
- `git diff --check`: passed.

## New-tab homepage and immediate focus

The workbench's new-tab action explicitly opened `about:blank`. It now uses the configured Google, DuckDuckGo, Bing, or Naver homepage. Explicit website destinations retain their URL. The browser service sends a request-correlated tab-created event immediately after native binding; the requesting controller selects that tab before navigation and account bookkeeping finish. Events from other windows cannot take that selection, and late open responses respect subsequent user selection.

Live verification additionally found that collapsed-review CSS could give the open browser workbench zero width. The desktop workbench grid now retains its width when the review pane is collapsed.

After integrating and restarting the Electron-owned hub, the live wire trace showed a matching new-tab-created event and selected tab approximately 135 ms after the launcher action. Clicked the workbench plus and Browser again with Electron visible: the newly selected native tab navigated to `https://www.google.com/`, appeared in `dock` mode, and the browser pane measured 708 pixels wide. Earlier animation-frame polling attempts timed out while Electron was occluded; verification used bounded interval polling and checked the actual native presentation after restoring the app.

The controller suite passed all 18 tests, including all four homepage preferences, configuration-read fallback, explicit destinations, early selection, unrelated event rejection, and preserving user selection after a late response. The focused service test passed with navigation held pending, proving the correlated creation event arrives before navigation completion. Studio type checking passed.
