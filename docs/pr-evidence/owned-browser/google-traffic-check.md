# Google traffic check and T3 browser research

The reported Google search returned `browser_open ok:true` while its final tab URL was `https://www.google.com/sorry/index`. Navigation had succeeded, but search results were unavailable. Repeated opens consumed the agent's three-tab allowance.

## Shipped T3 evidence

Inspected `/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar`, SHA-256 `042364d672bf44d8b5cb41e90bfa6428032f264dc4d859febe71295aaad80fd3`. These are static code observations. T3 was not driven against Google and its ability to pass a traffic check was not established.

- `apps/desktop/dist-electron/main.cjs`, region `src/preview/DesktopBrowserHost.ts`, lines 86053–86198: `relayFor` exposes one desktop guest through `createCdpRelayConnection`, forwarding commands to its Electron debugger. It reads the guest's actual URL, title and user agent.
- Same bundle, `src/preview/BrowserSession.ts`, lines 86200–86431: `BrowserSession.getPartition` derives persistent or ephemeral partitions from a scope; `BrowserSession.getSession` reuses `electron.session.fromPartition`. It configures permission handlers and separate storage/cache clearing.
- `apps/server/dist/binCli-CqbuIhnk.mjs`, `src/preview/ServerBrowserContexts.ts`, lines 289970–290182: `presentAsChrome` uses `Emulation.setUserAgentOverride`; `ServerBrowserContexts.launchOptions` disables `AutomationControlled` and ignores `--enable-automation` for its headless server Chromium. `createContext` uses persistent human profiles and isolated agent contexts. These identity masking options were not copied into HamaEditor.
- Same server bundle, lines 290545–290554: page setup invokes `prepareContext` and `presentAsChrome` only when `!desktop`. `connectDesktopPage` attaches Playwright through the desktop CDP endpoint and retains the existing page, storage and window.
- A bounded search of those desktop/server bundles found no `sorry/index`, `unusual traffic` or CAPTCHA-specific handling. That search does not establish absence from every shipped dependency or remotely supplied code.

REA full-ASAR analysis first rejected an unpacked native passkey member integrity mismatch, and record-and-continue ended with a closed transport. The CLI fallback successfully parsed exact extracted browser regions as inert syntax: `ev_95a4a799973831402db38618be3f4b69cd2145fe3757b87fa0a853d0b6bee282`, three files, zero parse failures. This scoped analysis does not attest to the complete package or its runtime behavior. No credentials or browser cookies were inspected.

## Implementation

- Exact Google `.com`, `.co.kr` and `.co.uk` hosts and their `/sorry` endpoints produce a tab challenge descriptor. An agent response returns `ok:false`, `BROWSER_CHALLENGE_REQUIRED`, `retryable:false` and continuation guidance instead of claiming usable results.
- Repeated Google research opens reuse the actor's challenged tab without another navigation or allocation. Agent challenge input/reload is held; an explicit alternate destination can use `browser_navigate` on the same tab. Tool guidance tells agents to stop automatic retries.
- The workbench shows a same-tab human-control action and a DuckDuckGo fallback using the original query. There is no automatic provider switch. Returning to a normal page clears the challenge descriptor.
- Google search queries are saved as bounded strings in the existing private tab metadata and restored only for the recognized Google research URLs. The fallback URL is rebuilt with `encodeURIComponent` on the fixed DuckDuckGo origin, never trusted from a stored fallback URL. A retained-context restart test confirms the original guest identity and query survive a hub replacement.
- The existing destination policy, guarded proxy, ownership, controller epochs and session provenance remain in force. Revoked access redacts the challenge from agent inventory. An alternate provider retains its normal website/account permission checks.

## Verification

- `PLAYWRIGHT_BROWSERS_PATH=/Users/hataewook/Library/Caches/ms-playwright node --test rhwp/rhwp-agent/tests/owned-browser-challenge.test.mjs rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs rhwp/rhwp-agent/tests/browser-policy.test.mjs`: 15 passed, zero skips. The new behavioral check uses real Chromium with deterministic provider pages and a controlled Google navigation destination; it exercises challenge detection, retry suppression, same-tab fallback, revoked site access, cross-agent ownership, human continuation, and lookalike-host exclusion. It does not contact public Google or DuckDuckGo.
- `PLAYWRIGHT_BROWSERS_PATH=/Users/hataewook/Library/Caches/ms-playwright node --test rhwp/rhwp-agent/tests/owned-browser-security.test.mjs`: 17 passed, zero skips, including credential revocation, human-session quarantine, cookie provenance, unsafe website mutations and proxy runtime policy.
- Followup `owned-browser-challenge.test.mjs` alone: 2 passed, including retained-context hub restoration and rebuilding the fallback without trusting a tampered saved fallback URL.
- Studio `node --experimental-strip-types --test tests/browser-controller.test.ts`: 5 passed.
- Studio `node sidebar-preview/check.mjs browser-workbench`: passed production sidebar fixture interactions, screenshots in `sidebar-preview/artifacts`.
- `npm run build:sidebar`: passed.
- Full Studio `tsc --noEmit`: passed using copies of the live checkout generated WASM declaration files in this isolated ignored `rhwp/pkg` directory. No Rust build or runtime profile sharing was needed.

The parent session owns live Electron integration and actual provider verification. Google human checks depend on the provider's acceptance of that session; alternate search availability must be observed in the live runtime. Detection intentionally covers the observed Google challenge endpoints, not every vendor's challenge page.
