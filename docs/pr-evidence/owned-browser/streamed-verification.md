# Streamed browser verification

Run from `rhwp/rhwp-studio`:

```sh
node e2e/owned-browser-live.mjs
```

The final combined run passed 24 scenarios with no uncaught Studio errors. `--inbox-only` runs the document-free Home/inbox subset for focused diagnosis.

After the compact icon toolbar and in-app preview changes, `node e2e/owned-browser-live.mjs --chrome-only` passed ten affected scenarios with no uncaught Studio errors. `real-chrome-results.json` records that fresh production run. The normal-editor preview, docked, floating, optional separate-window and composer screenshots were refreshed and visually inspected; the original 24-scenario record and PDF evidence remain intact. The floating screenshot waits for the streamed frame to update after Korean typing and clipboard paste.

`real-stream-editor-pip.png` shows the draggable, resizable preview inside the main app beside the normal editor and sidebar. The check physically drags and resizes it, types text into the real document and chat draft, hides and reopens it, and verifies the same authenticated tab, form input and human controller. Docking waits for the layout transition to finish. The optional separate window opens through More and returns to the same docked tab.

The harness starts the production hub and Studio with isolated temporary app data, a fresh app-owned Chromium profile, and a controlled Pi CLI turn without model inference. The research website is a local fixture with cookie-gated PDF GET, CSRF POST, blob export, malformed PDF and bounded streaming transfers. Its exact origin is configured through `RHWP_BROWSER_WORKSPACE_TARGETS`; the owner approves fixture form operations through the real site policy. It uses no user website account, provider credentials, document, or browser profile.

`real-stream-results.json` records the actual runtime URL, source session/tab/project identities, verified scenarios and sanitized fixture request methods. Screenshots show the production Browser workbench, human control, floating and popped-out presentations, composer capture, project reference card, existing PDF viewer, general inbox and Approved Permissions. The original Chromium-delivered PDF bytes are compared with fresh authenticated reads from project and inbox viewer routes.

This evidence covers streamed browser behavior on the local laptop. Private Google Slides sign-in, account switching and MFA require a real approved account and remain outside this credential-free fixture. Native browser evidence is recorded separately.
