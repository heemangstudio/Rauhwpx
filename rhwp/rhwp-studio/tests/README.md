# Studio tests

Run `npm test` for the Node suite and editor transport tests. It does not launch
Chrome or the agent hub. Several tests run the real engine, so run
`npm run build:wasm` from the repository root first; without `rhwp/pkg` those
tests fail with that instruction. A few tests use Vite's module loader with
application plugins disabled. Test files are discovered automatically.

Undo and edit-history coverage lives in `edit-history-*.test.ts` and
`dialog-edit-history.browser.test.ts`. `support/edit-history-env.ts` loads the real
commands, `CommandHistory`, and `InputHandler` router against the WASM engine.

Run `npm run test:browser` for `*.browser.test.ts`. These tests launch Chrome and
isolated Vite servers. Install Chrome or Chromium, or set
`PUPPETEER_EXECUTABLE_PATH`. Engine-backed tests also require `npm run build:wasm` from
the repository root. `RHWP_WASM_PACKAGE_DIR` can select an existing generated package.
Missing prerequisites fail this explicit suite.

Use assertions on returned values, persisted state, emitted events, or DOM
interactions. Do not lock CSS measurements, comment markers, source ordering, or
the number of call sites. Existing source guards for security, edit history, and
data-loss regressions should be replaced with behavioral coverage before removal.

The separate [E2E scripts](../e2e/README.md) exercise the running application.
