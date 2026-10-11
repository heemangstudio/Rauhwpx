# Shared sidebar browser access

Agents can list and control user-opened global tabs alongside their own scoped research tabs. `browser_status.activeTabId` identifies the tab selected in the current Studio sidebar. The authenticated UI reports actual selection changes; tool callers cannot supply the selected tab through MCP. The same metadata is included in every provider's shared browser instructions and the browser skill.

Agent activity stays docked when a sidebar is already visible, locks the page controls during the turn, and adds a faint orange outline. Turn completion restores human input without closing the sidebar. Activity events are routed to the controlling chat, including when another document originally created the shared tab.

## Checks

- `node --test rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs rhwp/rhwp-agent/tests/owned-browser-tool-contracts.test.mjs rhwp/rhwp-agent/tests/owned-browser-security.test.mjs`: 38 passed, none skipped. Real managed Chromium checks include agent typing/clicking in a user-opened tab, masking password values, rejecting another agent's private tab, and routing preview activity to the controlling session.
- Studio `node --test tests/browser-projection.browser.test.ts`: passed. Production UI with fixture native IPC retains the dock, avoids a duplicate float, reports the selected tab, and restores input at turn end.
- `npm run test:sidebar -- browser-workbench`, `npm run build:sidebar`, Studio `npx tsc --noEmit`, and `git diff --check`: passed.
- `node e2e/owned-browser-live.mjs --sidebar-reuse-only`: passed against the real editor at `http://127.0.0.1:7940`, authenticated hub, and actual app-owned Chromium. The website and Pi provider turn were deterministic fixtures, with no model inference. Authenticated MCP status followed two user tab selections; semantic tools signed into the fixture, typed, searched, and preserved the same docked tab. Turn completion restored human input. See `shared-sidebar-results.json` and `shared-sidebar-agent-control.png`.
- Live native Electron at `http://127.0.0.1:7745`, `adsf.hwpx`: refreshed its owned hub after confirming no provider turn was running. The selected Google tab remained docked; the authenticated hub returned the same tab ID as the selected sidebar resource and listed it as global. The packaged HamaEditor and unrelated hubs were left running.
