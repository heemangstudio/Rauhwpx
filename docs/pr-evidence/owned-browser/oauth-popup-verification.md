# Native OAuth popup verification

The previous native host returned `action: 'deny'` for every `window.open()` and created an independent tab. The controlled Electron fixture reproduced `window.open()` returning `null`, which prevents an OAuth opener from keeping its popup handle and completion callback.

The host now adopts Chromium's guest WebContents through Electron's [`createWindow` hook](https://www.electronjs.org/docs/latest/api/structures/window-open-handler-response). This preserves the real WindowProxy, named-window reuse, opener messaging and script closure. The guest remains a sandboxed WebContentsView in the owned session and guarded proxy. Existing password protection is copied into protected descendants before their debugger attaches; the password-vault follow-up handles protection applied after a descendant already exists.

CDP initialization runs on the next event-loop turn. Attaching the debugger from the synchronous guest-creation callback caused Electron 43.4.0 to crash during a nonblank initial navigation. Deferred background guests first load `about:blank`, following Electron's [custom-view navigation guidance](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler).

## Verification

`node --test tests/desktop-browser-oauth-popup.test.mjs tests/desktop-browser-cdp.test.mjs rhwp/rhwp-agent/tests/hub-owned-browser-protocol.test.mjs rhwp/rhwp-agent/tests/owned-browser-security.test.mjs` passed 21 checks. The final native popup fixture rerun also passed after adding immediate helper closure and stable parent references.

The native fixture uses two temporary loopback HTTP origins, an authenticated guarded proxy, a fresh profile and a hidden Electron window. It checks an initial named `about:blank` popup, a cross-origin 302 redirect, `postMessage` completion, `window.close()`, retained opener form data, cancellation, named-window reuse, direct nonblank provider popups, ordinary target-blank links, native middle-click background links, transient helper closure and rejection of another chat's access. It also checks the inherited session and sandbox preferences. No account credentials or third-party login are used.

`node --test --experimental-strip-types rhwp/rhwp-studio/tests/browser-oauth-popup.browser.test.ts rhwp/rhwp-studio/tests/browser-controller.test.ts` passed 16 checks. The headless Chrome fixture mounts the production workbench and browser UI through an isolated Vite route `/oauth-fixture`; hub events and native placement use fixtures. Clicking the workbench tabs confirms popup closure returns to its opener when active and preserves a different tab selected by the user.

The user's running application and active sign-in were left untouched. Third-party OAuth completion remains to be checked in the integrated application.
