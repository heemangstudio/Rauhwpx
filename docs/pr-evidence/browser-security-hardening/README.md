# Browser security hardening

Reviewed the seven findings in the local `exploits.md` report against the browser PR implementation on 2026-10-11.

| Finding | Change and verification |
| --- | --- |
| Prototype-patched masking | Trusted selector classification and input reads; hostile `Element.prototype.matches` test runs in real Chromium and Electron. |
| Credentials copied into page content | Known private values are redacted from text observations. Model frames and chat screenshot captures are blocked while private values are present. Arbitrary website transformations remain the documented boundary. |
| Ungated typing | Unapproved-origin text input and submission fail before site input handlers run. Explicit origin approval permits the same operation. |
| Export/search approval heuristics | Arbitrary-origin export and search buttons require website-change approval. Read-only search exceptions are limited to built-in search origins and GET forms. |
| WebSocket availability | Browse/read policy allows background socket traffic. Agent typing into that page still requires origin approval. |
| Human cookie replacement | A private agent request is rejected before reaching the cookie replacement endpoint; the real browser cookie retains the human identity. Approved private reuse and explicitly shared global tabs retain their intended access. |
| Page-patched autofill setter | Managed autofill uses Playwright's isolated fill engine; native filling uses Electron's isolated world. Credential revocation fences remain in effect. |

The attack regressions failed before the fixes: prototype patching exposed the field and unapproved typing reached the site's handler. The checks use the pinned real Chromium runtime and an actual Electron guest, with isolated temporary profiles and deterministic local websites. They do not use model quota or real credentials.

Focused checks:

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned/chromium node --test \
  rhwp/rhwp-agent/tests/owned-browser-security.test.mjs \
  rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs \
  rhwp/rhwp-agent/tests/owned-browser-tool-contracts.test.mjs
node --test tests/desktop-browser-passwords-native.test.mjs
```

Final desktop relaunch found a pre-existing startup dependency: Pi and CLI initialization waited for the OS credential broker before `RHWP_HUB_READY`. Provider initialization now runs after readiness, and session startup waits for it before validating provider configuration. A real child-process regression with an unanswered credential IPC request fails on the previous implementation and passes on the fix; authenticated health remains available while approval is pending.
