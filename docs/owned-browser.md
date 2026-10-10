# Browser and research downloads

HamaEditor's browser runs on your own agent hub. Desktop and paired web clients use the same browser tools and approved login profile. Browserbase credentials and a hosted browser service are no longer needed.

## Open and control a browser

Open **Browser** from the sidebar workbench, the chat toolbar, or Home. A document or project is optional. Agents receive their own tabs; approved saved logins are shared across projects on that hub.

The compact icon toolbar offers navigation, reload, control, capture, downloads, and presentation. **Float** opens a draggable PiP panel inside the editor window. It keeps the document and chat available underneath. The separate-window option lives in **More**.

**Take control** pauses agent input for the selected tab. **Return to agent** deliberately hands it back. Navigation, text input, Korean composition, clipboard text, and bounded human-selected uploads use the same tab. Closing the preview hides it; closing the tab ends it. Dock, Float, and the optional separate window preserve page state. The floating panel can be moved or resized with its handles and arrow keys; Shift + arrow resizes it.

The expandable connection panel identifies the runtime, tab, controller, and recovery state. After a browser crash, recover the tab and request a fresh snapshot. Uncertain clicks and submissions are never automatically replayed.

Managed Chromium is the default for desktop and web. **Settings → Browser → Configuration** also offers native Electron rendering on desktop. Close live tabs before switching. Native and managed modes have separate browser profiles.

## Accounts and permissions

**Settings → Browser → Accounts** manages website accounts. Agents request save/use approval through the chat permission interaction. Password entry uses a dedicated authenticated form and is never sent as a chat message. Agents fill approved accounts by opaque account ID and fresh field references; password and username values are masked from browser observations.

Desktop uses the owner's OS vault through private IPC. Standalone hubs use macOS Keychain, Windows Credential Manager, or Linux Secret Service. A locked or unavailable secure store reports a recoverable error. Website passwords have no plaintext fallback. Credential storage is lazy so an unused browser does not interrupt editor startup.

Approved account reuse survives chat/project changes and restarts. Human-created login sessions require an exact account/origin confirmation before agents may inspect them. Changing account identity, revoking approval, signing out, and forgetting an account invalidate stale access. The Google setup preset visibly includes the exact Accounts, www.google.com Search, Docs/Slides, and Drive origins in its first account approval. Approval does not extend to every Google service.

**Approved Permissions** controls public reading, downloads, additive research imports, exact-origin rules, and separate website changes. Google Search, Google Docs/Slides reading, Wikipedia, PubMed/PMC, and arXiv are seeded once. Your later blocks remain in effect. Ordinary publisher links use the public research defaults; private/local destinations require a configured workspace target. Purchases, external messages, deletion, and other committing website actions require their own approval.

The browser uses a dedicated app-owned profile. It never imports your ordinary Chrome or Safari profile. Chromium profile files have private directory permissions; encrypted checkpoints and OS-stored passwords do not mean every active Chromium profile file is encrypted. OS account and disk protection still protect that directory.

Private Google sign-in and MFA need the account holder. The account sign-in control pauses automation and opens the pinned Chromium executable without remote debugging or automation flags, using the same app-owned profile. Confirmation closes that window, restarts managed browsing, and asks you to confirm the exact account and selected origins before agents can reuse the session. Verify a private deck, export, restart, cross-project reuse, and revocation with your account; fixture checks do not establish private Google Slides compatibility.

**Configuration → Forget browser accounts and history** removes browser passwords, login sessions, cookies, history, and encrypted checkpoints after stopping browser owners. It preserves downloaded files, projects, provider credentials, and research permissions. A failed cleanup stays visible for retry. Use this control before uninstalling when you want to remove saved browser access; deleting the application bundle alone does not run an OS-vault cleanup hook.

## Downloaded PDFs

PDF downloads keep the actual browser-delivered bytes, including authenticated GET, CSRF-protected POST, and blob downloads. They become available inside the app automatically. The destination is captured when the download starts; changing projects while it runs does not redirect it.

Project downloads create a durable Kanban reference card and open through the existing Documents/PDF viewer. Downloading without a project puts the file in the general **Downloads** inbox. You can view it immediately or move it into a project from the saved bytes. Failed moves keep the inbox entry available.

Text extraction and librarian organization run after the PDF is safely stored. An extraction failure retains the PDF and card, with a retry action. Identical bytes deduplicate within a project while preserving bounded source provenance. Downloads support cancellation, byte limits, disk reserve checks, interrupted-job recovery, and authenticated serving. Source query strings and fragments are removed from stored provenance.

## Development checks

Install the matching Chromium revision through the locked Playwright package when running real runtime checks:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/owned-browser-chromium" node rhwp/rhwp-agent/node_modules/playwright/cli.js install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/owned-browser-chromium" node --test rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/owned-browser-chromium" node rhwp/rhwp-studio/e2e/owned-browser-live.mjs
node --test tests/desktop-owned-browser.test.mjs tests/desktop-browser-vault.test.mjs
```

The live research check uses isolated temporary hub/profile/project storage and a deterministic website. Its provider is a fixture, so it spends no model quota. Sidebar preview checks are frontend fixtures and are labelled separately from these real browser and Electron checks.
