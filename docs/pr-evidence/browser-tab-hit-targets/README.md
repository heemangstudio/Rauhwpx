# Browser tab hit targets

The fullscreen chat header used minimum grid tracks totaling more than its available width beside a wide browser pane. Its trailing region covered the first two browser tabs and intercepted pointer input. The title now shrinks to its available space, and the corner-button padding belongs to the browser header when that pane is open.

- Live Electron at `http://127.0.0.1:7745`, `adsf.hwpx`: both first-tab hit tests failed before the fix because the hit element was `ag-workspace-trailing`. After the update, real pointer clicks selected each of the first two tabs. Their close-button hit targets were reachable. The original selected school tab was restored; no user tabs were closed.
- `node --test rhwp/rhwp-studio/tests/workbench-tabs.browser.test.ts`: two passed. The new production-layout test failed before the CSS change, then verified pointer selection and close with expanded and collapsed thread lists. Existing pointer drag, cancellation, keyboard selection, and close coverage passed too.
- `git diff --check`: passed. The running build picked up the CSS update through Vite.
