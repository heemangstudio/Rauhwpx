# Browser screen capture recovery

The running Electron capture button returned `BROWSER_ACTION_FAILED` on the public Muxy page. Password-save opt-in had armed the native password shield before any password existed. Capture attempted a raw CDP viewport query, which the shield correctly rejected, before reaching the image code.

Viewport reads now use the native isolated world without replacing agent element references. A shielded tab with no entered or saved password can capture its current viewport through Electron after masking form controls and child frames. Masking is checked before and after capture. Navigation, zoom, control, runtime ownership and newly protected passwords invalidate the result. Cleanup restores visibility. Saved-password pages retain the image export restriction, and capture failures show their specific reason instead of a generic connection error.

## Verification

- Before the fix, the live capture button returned `BROWSER_ACTION_FAILED` (`browser-61`). The expanded native password fixture reproduced the same failure.
- `node --test tests/desktop-browser-passwords.test.mjs tests/desktop-browser-cdp.test.mjs rhwp/rhwp-agent/tests/owned-browser-viewport-capture.test.mjs`: 24 passed.
- `node --test tests/desktop-browser-passwords-native.test.mjs` with the running checkout's Electron binary: passed. Includes save-armed capture, masking failure, unsaved and saved password rejection, secret activation during capture, visibility cleanup and usable element references after capture.
- Studio `./node_modules/.bin/tsc --noEmit`: passed.
- Live Electron: `Rauhwpx-pr475`, Studio `http://127.0.0.1:7745/`, CDP 9475, document `adsf.hwpx`.
- Actual floating preview capture on `https://muxy.app/` succeeded (`browser-19`) and created a chat attachment.
- Docked the page, enabled the UI's local password-save opt-in without entering credentials, confirmed native `passwordProtected: true`, and clicked capture. It succeeded (`browser-25`), hid the error and persisted a JPEG attachment. The reopened attachment decoded to 718 × 910 pixels, 31,386 bytes; see [captured viewport](protected-public-capture.jpg).
- Disabled the temporary password-save opt-in and removed only the two verification attachments. No chat message was sent. The original document and other tabs remain available.

Implementation commit: `4a5bfb80`. Integrated into the running `fix/browser-interaction-latency` branch and restarted that Electron build.
