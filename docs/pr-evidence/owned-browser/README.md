# App-owned browser verification

Implementation and runtime verification use the isolated laptop worktree `feat/owned-browser`. The PR is stacked on PR #477, `fix/pr475-memo-errors`. The user's active checkout is preserved.

## Screenshot provenance

The `before-*.png` screenshots show the exact PR #477 sidebar fixture at commit `f7e6c10e1f2f3721507f978ec83a23abdf5b4e5e`. They establish the original workbench and settings entry points.

The `real-stream-*.png` screenshots show production Studio and its authenticated hub bridge with actual app-owned Chromium. The website is a deterministic cookie/CSRF/blob research fixture; the Pi provider turn is a fixture and spends no model quota. `real-stream-results.json` records the corresponding runtime, scoped identities, requests, and observed scenarios. These screenshots demonstrate browser input, human takeover, presentation continuity, captured attachments, and actual downloaded PDF bytes/cards/viewing.

`real-stream-editor-pip.png` shows the primary in-app floating panel in production Studio alongside actual document editing and a chat draft. The compact toolbar uses SVG icons; More contains the optional separate-window action. The fresh `real-chrome-results.json` run passed ten affected scenarios with zero uncaught errors.

Native Electron evidence uses a separate temporary `userData` directory, a real WebContentsView, the private CDP relay, and Playwright. `real-native-in-app-float.png` and `native-float-verification.log` show the guest inside a clearly labelled bounded editor/sidebar fixture, including hidden capture, viewport movement/resizing, presentation continuity, and browser-only cleanup. `real-native-separate-window.png` shows the optional external window. It does not access installed application profiles. Relay-owner replacement tests reconnect after a simulated hub restart; they do not spawn a second production hub process. The `fixture-*.png` screenshots exercise production UI with a typed mock backend; account forms and cleanup confirmation are separate from native OS-vault checks.

The full real Studio/Chromium run passed 24 scenarios with zero uncaught Studio errors. The full desktop suite passed 64/64 with zero skips. The pinned-Chromium full hub suite passed 1,242 tests with zero failures and one opt-in Codex CLI skip; real managed-browser tests ran. That broad run preceded the final session-provenance and GET-action changes. The final frozen-source runtime/security/cleanup suite passed 23/23 with zero skips and matching before/after source hashes. CI installs the pinned Chromium and fails if it is missing.

Studio unit checks passed 2,328 tests with two existing TODOs and zero failures. The eight existing editor smoke flows passed, including HWPX save/reopen, IME, staged agent edits, and autosave crash recovery. Studio/sidebar builds, sidebar interactions, 65 CI/package script checks, and native production dependency probes passed. Browser cleanup preserves installed Chromium, renderer configuration, research files, projects, provider credentials, and site permissions.

## Reproduction

See [Browser and research downloads](../../owned-browser.md) for runtime commands and account/profile behavior. The real streamed check is `rhwp/rhwp-studio/e2e/owned-browser-live.mjs`; its website fixture is adjacent. Native coverage is in `tests/desktop-owned-browser.test.mjs`, `tests/desktop-browser-vault.test.mjs`, and `tests/electron/owned-browser.mjs`.

Security review used temporary dummy credentials and deterministic websites. It reproduced and corrected committing-action bypasses, unknown human-session reuse, stale credential fills, clipboard/selection exposure, and in-flight permission revocation. Download review checked storage peaks, source/redirect permissions, shutdown recovery, failed inbox moves, and extraction repair.

Private Google account/MFA and private Slides reading/export have not been verified with the user's real account. The implementation offers an explicit, account-bound, unautomated full-browser sign-in handoff and subsequent confirmation; fixture tests do not substitute for that account-holder check. A release package on each supported OS and installer/uninstaller behavior require release validation.

All subsequent implementation and tests stay on the laptop after the user's instruction to leave the Mini alone. No preview service was started on the Mini.
