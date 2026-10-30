# Studio trim plan for the HeemangEngine-only cutover

Scope: `rhwp/rhwp-studio`. Paths below are relative to `rhwp/rhwp-studio/` unless noted. Line counts are approximate (`wc -l`). Evidence comes from an import graph of `src/`, `tests/`, `bench/`, `e2e/` and `scripts/`, from `ts-prune` filtered against a whole-repo `git grep`, and from reading the call sites.

## Baseline

- Heemang is opt-in today: `new WasmBridge()` returns `createStudioEngine('heemang')` only for `?engine=heemang` (`src/core/wasm-bridge.ts:397-400`). `createStudioEngine` wraps `HeemangAdapter` in a Proxy that throws `EngineNotSupportedError` for any `WasmBridge` member the adapter lacks (`wasm-bridge.ts:4296-4318`).
- Heemang paints pages with `HeemangAdapter.renderPageToCanvas` (`page-renderer.ts:175`). Its own `Player` draws canvas2d from packets. `main.ts:1609-1612` forces canvas2d for heemang.
- Heemang input runs through `view/heemang-reader.ts` and `ui/heemang-edit-dialogs.ts`. `main.ts` disables the legacy `InputHandler` (`main.ts:778, 865, 921, 1714`).
- `command/dispatcher.ts:76-90` (`isBlockedByEngine`) whitelists commands for heemang: `format:*`, `table:*`, clipboard and find, file open and save, undo and redo, `view:zoom-*`, `view:theme-*`, `view:toolbox-*` and `help:*`. Everything else is blocked before it reaches the engine.
- Only three modules are reachable exclusively through `wasm-bridge.ts`: `core/selection-page-hints.ts`, `core/char-shape-runs.ts` and `core/pagination-batch.ts`. Everything else that serves rhwp is also wired into `main.ts`, `canvas-view.ts`, `page-renderer.ts` or the agent. Most of the trim therefore depends on the core cutover removing the `engineKind` branches in `main.ts` first.

## 1. Code that only serves the rhwp engine

### 1a. CanvasKit/Skia renderer (about 9.1k lines, dead once heemang is the only engine)

| File | Lines | Evidence |
| --- | --- | --- |
| `view/canvaskit-renderer.ts` | 4843 | Dynamic import at `main.ts:1645`. Type imports in `renderer-session.ts`, `page-renderer.ts:4` and `canvas-view.ts:14` |
| `view/canvaskit/*` (bounded-response, css-color, diagnostics, image-replay, policy, replay-plane, resource-key, text-variant-selection) | ~1100 | Imported only by `canvaskit-renderer.ts`, plus `replay-plane` from `page-renderer.ts:3` and `flow-image-clip.ts` |
| `view/canvaskit-font-style.ts`, `view/canvaskit-wasm-url.ts` | 70 | `canvaskit-renderer.ts` only |
| `view/static-svg-path-layers.ts` | 1287 | `canvaskit-renderer.ts` and `canvaskit/text-variant-selection.ts` only |
| `view/glyph-outline-payload-status.ts` | 498 | `canvaskit-renderer.ts` only |
| `view/renderer-session.ts` | 472 | Chooses between CanvasKit and canvas2d. `main.ts:261`, `canvas-view.ts:17` |
| `core/canvaskit-document-preflight.ts` | 115 | `main.ts:48`, `wasm-bridge.ts:15` |
| `core/skia-font.ts`, `core/image-sampling.ts`, `core/sfnt-glyphs.ts` | 83 | Set up only by `WasmBridge.initialize` (`wasm-bridge.ts:441-451`) and consumed by `canvaskit-renderer.ts` |
| `package.json` `canvaskit-wasm` | dep | Imported only by `canvaskit-wasm-url.ts` and `canvaskit-renderer.ts` |

Keep `view/canvaskit/image-header.ts`, which is a generic image-header parser. It is imported by `command/commands/insert.ts`, `main.ts:34` and the picture input handlers. Move it to `core/` when its directory goes.

Partly dead:
- `view/render-backend.ts` (180). Delete `resolveRenderBackend*`, `resolveCanvasKitRenderMode*`, `resolveCanvasKitSurfaceRequest`, `persistCanvasKitRenderMode`, `persistRenderProfile` and the CanvasKit types. Keep `clampRenderScale` and the `MAX_*` limits (`canvas-view.ts:609, 834`).
- `view/canvas-view.ts` (1527, about 300 lines go). Remove the `rendererSession` field and calls (227, 375, 414), `applyRendererSelection` (426), the CanvasKit readiness gate and fallback (869-930) and the diagnostics getters (1512-1521). Keep `MutationRefreshQueue`, which the heemang `changedPages` path uses (`canvas-view.ts:173`).
- `main.ts:1901-1907` exposes `__rendererSession` and `__canvaskitRenderMode` as dev hooks. This file is owned by core.

### 1b. Legacy canvas2d layered render path (about 1.6k lines)

- `view/page-renderer.ts` (1335). Only lines 166-179 serve heemang. About 1000 lines die: `renderPageCanvasKit` (305), the CanvasKit diagnostics maps (270-300), the filtered and flow-layer canvases, the layer-plane summaries (840-928), `drawMarginGuides` (929), the re-render scheduler (981-1160) and every `renderPageToCanvasFiltered` call (225, 637, 766, 812-828, 1102-1141).
- `view/flow-image-clip.ts` (293), `view/raw-svg-prefetch.ts` (194) and `view/image-prefetch.ts` (111) are imported only by `page-renderer.ts` on the non-heemang branch.
- `heemang-player.ts` `Pictures` and `patchImage` (197-229, 440) are the heemang replacement for these prefetchers.

### 1c. Font, glyph and HFT plumbing for the old renderer

- `core/hft-glyphs.ts` (79): its API is installed only by `wasm-bridge.ts:455-466` (`setHftWasmApi`). After cutover, `registerHftOutlines` always returns false. Its call sites are `main.ts:161, 1385, 4898, 5015`, `desktop-fonts.ts:48, 1841-1867` (`registerDesktopHftOutlines`), `local-fonts.ts:10, 863-867, 971` and `ui/agent-sidebar/settings-editing.ts`. Heemang reads HFT natively through `engine.addFontFile` and `hftinfo.dat` (`heemang-adapter.ts:65-76`).
- `core/hft-font.ts` (288, HFT to sfnt): its only importer is `local-fonts.ts`. It is dead if nothing else needs browser `FontFace` previews of HFT faces. Verify in the font dialog before deleting.
- `core/sfnt-subset.ts`: `desktop-fonts.ts` and `local-fonts.ts` use it to feed metric subsets into rhwp's `RuntimeFontMetricsApi`. Heemang's `getRuntimeFontMetricsApi` (`heemang-adapter.ts:187`) receives whole files through `receiveEngineFonts` instead. `sfnt-repair.ts` may stay for `FontFace` registration.
- `desktop-fonts.ts` (2116) is shared, because heemang uses `getSystemFontHost` and `loadDesktopFontIndex`. Dead parts: `prepareDesktopFontsForDocument`, `syncImportedFontMetrics`, `prepareLocalFontAccessMetrics`, `registerDesktopHftOutlines`, the subset logic and the `metrics?:` option (`main.ts:1302`).
- `font-loader.ts` (534) is shared. `getWebFontSubstituteFamilies` has one importer, `wasm-bridge.ts:245`, and dies. `resolveCanvasKitFontPlan` is used by `heemang-adapter.ts:207`; rename it to a neutral name (`resolveBundledFontPlan`).
- `equation-font.ts` (217): its measurer and resolver factories are rhwp and CanvasKit only. `equationFontFamilies` is shared with the UI.
- `font-metrics-policy.ts` (7): used by `wasm-bridge.ts` and the thumbnail and preflight workers, so it goes with batch 8.

### 1d. Engine guards and dev runtime

- `core/subsecond-runtime.ts` (142): `wasm-bridge.ts` and the `SubsecondRevisionWatcher` in `canvas-view.ts:34`. Also remove package.json `subsecond:install`, `subsecond:serve`, `subsecond:sync` and `dev:subsecond`, and in `vite.config.ts` the `subsecondWasmDir`/`RHWP_SUBSECOND` variables (12-24), the `/_dioxus` and `/wasm` proxies, the `fs.allow` entry and the `ignore-subsecond-patch-artifacts` plugin.
- `core/rhwp-dev.ts` (256): `initRhwpDev(wasm)` is called only from `main.ts:126`.
- `core/pagination-batch.ts`, `core/char-shape-runs.ts`, `core/selection-page-hints.ts`: exclusive to `wasm-bridge.ts`.
- `core/engine-trap.ts` (152): `guardEngineCalls(HwpDocument.prototype)` is rhwp-specific (`wasm-bridge.ts:441`). But `engineTrap()` and `engineMutationEpoch()` are read by 12 `src/` modules (canvas-view, ruler, page-renderer, content-hash, versioning, save-document-format, agent tool-executor, foreign-documents, sidebar). `recovery/trap-recovery*.ts` (1341) is the user-facing recovery UI. **Do not delete.** Point the guard at the Heemang `Doc` prototype instead, since hm-wasm can trap too.
- `core/mutation-method-registry.ts` (125): lists rhwp mutating methods. Its only importer is `agent/engine-edit.ts`, which belongs to studio-agent.

### 1e. `wasm-bridge.ts` members no caller needs

These 9 of 429 `WasmBridge` members have no reference anywhere outside `wasm-bridge.ts` (searched across src, tests, e2e, bench, scripts and npm), and no internal `this.` use:
`getSubsecondProbeValue` (:506), `getFontMetricsPolicy` (:708), `getCanvasKitReplayPlan` (:1265), `debugDumpStableIds` (:1613), `getTextBoxControlIndex` (:1621), `findNextEditableControl` (:1627), `getHeaderFooterList` (:3960), `getFieldValue` (:3995), `getFormValue` (:4178). This is relevant only if core keeps any of the class.

### 1f. hwpctl compatibility layer

Removed with the app-only trim, together with `hwpctl-test.html`, its tests and the embed runtime.

### 1g. Legacy input stack `src/engine/` (about 26k lines, dead after cutover except where the agent depends on it)

- Dead: `input-handler*.ts` (about 16.4k), `cursor.ts` (2288), `caret-renderer`, `selection-renderer`, `cell-selection-renderer`, `field-marker-renderer`, `table-object-renderer`, `table-resize-*`, `table-border-*`, `table-bbox-cache`, `table-cell-selection`, `selection-table-lift`, `picture-*`, `object-*`, `ime-session`, `word-selection`, `line-start-affinity`, `office-clipboard-images`, `office-html-sanitize`, `deferred-pagination-runner`, `input-edit-invalidation` and `initial-caret-focus`. Their only external importer is `main.ts:35, 253-255`.
- Keep `navigation-keymap.ts`, which the menus, palette, context menu and shortcut map use. Keep `header-footer-mode.ts` (`canvas-view.ts:40`, `commands/page.ts:9`).
- Blocked on studio-agent:
  - `agent/types.ts:11, 15, 1306` uses the `InputHandler` type and `OperationDescriptor` from `engine/command.ts`.
  - `agent/inline-prompt.ts:10-14` uses `selected-tables` and `table-selection-rects`.
  - `agent/pending-edits.ts:5` uses `prepared-snapshot-command`.
  - `document-session.ts:11-12` builds `CommandHistory` and `HeadlessEditorHost` for each session.
  - `command/types.ts:107` uses `getInputHandler`.

### 1h. Command implementations that call rhwp-only methods

These bodies call `WasmBridge` methods the adapter does not have. Keep the registry entries, toolbar entries and menus. Disable them with a capability list (replace `isBlockedByEngine`), and delete or port each body per feature:
- `commands/table.ts` (1188, about 40 rhwp calls)
- `commands/insert.ts` (717: pictures, shapes, equations, notes, click-here fields)
- `commands/page.ts` (687: header/footer, columns, breaks)
- `commands/hyperlink.ts` (114)
- `commands/format.ts`: styles, bullets and document paragraph spacing
- parts of `commands/view.ts` and `commands/edit.ts`

`format:*` and `table:*` are already routed to the reader, but `heemang-reader.ts:499-508` implements only char shape, para shape, bold, italic, underline, align, line spacing and text color. Everything else is dropped silently.

### 1i. Workers and modules outside the bridge that use `@wasm/rhwp.js`

| Module | Use |
| --- | --- |
| `home/thumbnail.worker.ts:6` | `HwpDocument` |
| `merge/merge.worker.ts:3-4` | rhwp module |
| `agent/document-preflight.worker.ts:7` | `HwpDocument` (studio-agent) |
| `agent/foreign-documents.ts:530` | dynamic import (studio-agent) |
| `compare/diff-engine.ts`, `versioning/*` | rhwp document queries through the bridge (`buildSnapshotFromWasm`) |

Versioning is disabled under heemang today (`main.ts:2377`, `commands/file.ts:545`).

`scripts/generate-agent-edit-capabilities.mjs:6` parses `src/core/wasm-bridge.ts` on every `npm run build` and `npm test`. It hard-fails the moment the bridge file goes. Its output is `src/agent/engine-edit-capabilities.generated.ts`, which belongs to studio-agent.

### 1j. Old-engine tests, benches and e2e

- Delete with batch 2:
  - the 18 `tests/canvaskit-*.test.ts` files (one of them, `canvaskit-image-sampling.browser.test.ts`, is a browser test);
  - `static-svg-path-layers`, `render-backend` and `renderer-session` tests.
- Delete with batches 1 to 4:
  - `hft-font`, `sfnt-subset`, `sfnt-run-metrics`, `equation-skia-font`, `subsecond-runtime`, `pagination-batch`, `flow-image-clip`, `layer-image-prefetch`, `page-image-prefetch.browser` and `page-layer-churn.browser` tests;
- Rewrite rather than delete. They use `RendererSession` or `engine-trap` but test live behavior:
  - `canvas-view-initial-load-race`, `canvas-view-page-lifecycle`, `canvas-prefetch-budget`;
  - `engine-trap`, `autosave-manager`, `save-document-format`, `agent-turn-interruption`, `trap-chat-notice`.
- About 60 tests import `src/engine/` (`table-*`, `ime-*`, `edit-history-*`, `issue-*`, `picture-resize`, `cross-table-selection` and similar) and go with batch 5.
- About 36 tests load `@wasm/rhwp.js` or construct `WasmBridge`. Many of them, such as the `version-*` browser tests, use rhwp only as a document source, so port them.
- About 35 tests are source-text guards (`readFileSync` on `.ts`) over rhwp paths. Audit them individually in each batch.
- Benches to delete or port, with their package.json scripts:
  - `typing-latency-bench`, `typing-latency-bigdoc`, `typeset-line-width-bench`, `canvaskit-image-cache-budget`, `long-document-image-cache`, `preview-frame-bench`;
  - port `doc-switch-bench` and `app-memory-bench`.
- e2e:
  - `e2e/engine-trap-recovery.test.mjs` (629) and its script go. Rewrite it against a Heemang trap if the guard is moved.
  - `e2e/smoke/09-hover-zoom.mjs` and `smoke/lib.mjs`, `02`, `03`, `05` and `08` drive `window.__wasm` and `__inputHandler` (`main.ts:693, 1899`). Port them, because `e2e:smoke` runs nightly (`.github/workflows/nightly.yml:320`).

## 2. Duplicates added by the Heemang integration

| Heemang path | Old path it duplicates | Survivor |
| --- | --- | --- |
| `ui/heemang-edit-dialogs.ts` (292): `showHeemangCharacterFormat`, `showHeemangParagraphFormat`, `showHeemangFind` | `ui/char-shape-dialog.ts` (1211), `ui/para-shape-dialog.ts` (954) and their tabs, `ui/find-dialog.ts` (445) | The full dialogs are the designed UI. Feed `CharPatch`/`ParaPatch` and `search`/`replaceMatch` from them, then delete `heemang-edit-dialogs.ts` |
| `view/heemang-reader.ts` clipboard (`:10-11`), IME (`:269-288`), caret and selection overlay (`:119-156`), navigation (`:240-247`) | `engine/input-handler*`, `ime-session`, `caret-renderer`, `selection-renderer`, `cursor` | heemang-reader |
| `HeemangAdapter.undoEdit/redoEdit/canUndo/canRedo` (`heemang-adapter.ts:617-620`), Ctrl+Z/Y in `heemang-reader.ts:235` | `engine/history.ts` `CommandHistory`, `commands/edit.ts:36` bridge | Adapter history. `CommandHistory` stays only while the agent needs it |
| Heemang font registration (`heemang-adapter.ts:39-134`, `/__heemang-fonts` manifest, `decodeWebFont`) | `font-loader.loadWebFonts`, `local-fonts` and `desktop-fonts` metric feeding, `hft-glyphs` | Heemang registration. `FontFace` registration stays for UI previews only |
| `Pictures` and `patchImage` (`heemang-player.ts:197-229, 440`) | `image-prefetch`, `raw-svg-prefetch`, `canvaskit/image-replay` | heemang-player |
| `HeemangAdapter.renderPageToCanvas` | `page-renderer.renderPage` layered and CanvasKit paths | heemang |
| `StudioEngineId`, `engineKind` and `createStudioEngine` Proxy (`wasm-bridge.ts:397-400, 4296-4318`), about 60 `engineKind` branches in `main.ts`, branches in `ui/toolbar.ts:40, 48, 324, 410-413, 652` and `isBlockedByEngine` | — | Collapse to a single engine plus an explicit capability list |

BLAKE3 is not a duplicate. Both engines install into the shared `content-hash.ts`, so only the `wasm-bridge.ts:449` call goes.

## 3. Must not be removed (UI and design depend on it)

- All CSS: `src/style.css`, `src/styles/`, the sidebar CSS and the theme presets. `npm run lint:css-tokens` guards the tokens.
- Dialogs in `src/ui/`: char-shape, para-shape, style, style-edit, numbering, page setup, table create, endnote shape, symbols, equation editor, find, grid settings, history and compare. Many are rhwp-backed today. Port them; do not delete them.
- `ui/toolbar.ts`, the command `registry`, `shortcut-map`, the menus, `ui/menu-shortcut-labels.ts`, the command palette and the context menu.
- The sidebar, `ui/agent-sidebar/`, and the sidebar preview, `src/sidebar-preview/`.
- Status bar widgets `ui/status-paper-size.ts` and `ui/status-character-count.ts`, which are skipped under heemang (`main.ts:1112-1173`). Port them.
- `view/ruler.ts`, skipped under heemang (`main.ts:1693`). Port it.
- Version lanes and autosave (`main.ts:2377, 4652, 5389`), `ui/spacing-preset-menu.ts` (`main.ts:1749`), and the font and style dropdowns (`main.ts:3543, 4923`). These are features to port.
- Zoom, `virtual-scroll`, `viewport-manager`, `grid-overlay`, `grid-settings`, `canvas-pool`, `pixel-snap`, `coordinate-system`.
- `recovery/trap-recovery*` (rewire to heemang), `core/engine-support.ts`, `core/content-hash.ts`, `view/canvaskit/image-header.ts` (move), `core/numbering-defaults.ts` `BULLET_PRESETS`, `core/hwp-constants.ts` unit constants, `engine/navigation-keymap.ts` and `engine/header-footer-mode.ts`.
- `public/print.html`, `boot-screen.js`, `theme-init.js`, `public/fonts` and `vite-plugin-heemang-fonts.mjs`.

## 4. Deletion order

Phase 1 (done on this branch, no engine dependency):
- `56220564`: unused Hancom constants and outline and paragraph-number presets (`core/hwp-constants.ts`, `core/numbering-defaults.ts`, -507 lines).
- `bdbeabd0`: exports with zero references in the repo (-69 lines): `CHEVRON_SVG_HTML`, `calculateVersionStats`, `compactVersionDiff`, `buildCheckpointTitleSummary`, `OP_ICON`, `isKnownTool`, `MERGE_ANALYSIS_VERSION`, `isLocalFontSupported`, `shouldPromptLocalFontAccess`, `getLastDesktopFontReport` and `clearRecoverableAutosaveDrafts`.
- `509e35a5`: `cdp_screenshot.cjs`, a WSL one-off with a hardcoded CDP address (-20 lines).

Phase 2 batches run after the core cutover lands. Each batch must pass `npm --prefix rhwp/rhwp-studio run build` and `npm --prefix rhwp/rhwp-studio test`. Batches 2 and 3 also need a live Studio check of page rendering, zoom and scrolling at `http://127.0.0.1:7700`.

1. **Dev and compat leftovers.** Delete:
   - `core/subsecond-runtime.ts`, the subsecond scripts and the subsecond `vite.config.ts` bits;
   - `core/rhwp-dev.ts`.

   Independent of the others. It needs one-line removals in `main.ts:126` and `canvas-view.ts:34`.
2. **CanvasKit renderer.** Delete everything in 1a, plus the `canvaskit-wasm` dependency, the CanvasKit tests and `bench/canvaskit-image-cache-budget.mjs`. Move `image-header.ts` first. Pin the `rpc-router` fields.
3. **Layered canvas2d path.** Trim `page-renderer.ts` to the heemang call and delete `flow-image-clip`, `raw-svg-prefetch`, `image-prefetch` and their tests. Rewrite the `canvas-view-*` lifecycle tests.
4. **Old font plumbing.**
   - Delete the `hft-glyphs` wiring, `sfnt-subset` metric feeding, the dead `desktop-fonts` and `local-fonts` functions, `getWebFontSubstituteFamilies` and the equation measurer factories.
   - Rename `resolveCanvasKitFontPlan`.
   - Verify with `heemang-font-flow.test.ts` and a live document that uses HFT and desktop fonts.
5. **Legacy input stack** (`src/engine/`, 1g). Blocked until studio-agent drops the `InputHandler`, `OperationDescriptor`, `selected-tables` and `prepared-snapshot-command` dependencies, and until `document-session.ts` stops building `HeadlessEditorHost` and `CommandHistory`. Delete the about 60 matching tests in the same batch.
6. **Command capability list.** Replace `isBlockedByEngine` with an engine capability list. Delete or port the rhwp-only command bodies (1h) per feature, keeping the registry, toolbar and menu entries.
7. **Dialog convergence.** Port the full char, para and find dialogs to the adapter, then delete `ui/heemang-edit-dialogs.ts`. This is UI-visible, so it needs before and after screenshots.
8. **Remove `@wasm` entirely.**
   - Port or replace the thumbnail and merge workers, the agent preflight worker and `foreign-documents` (with studio-agent), and the compare and versioning snapshots.
   - Replace `scripts/generate-agent-edit-capabilities.mjs`.
   - Delete `font-metrics-policy.ts`, the `@wasm/*` alias (`tsconfig.json:18`, `vite.config.ts:120-123`, `vite.sidebar.config.ts:23`), `warn-debug-wasm`, `serve-samples-dir` and the `../pkg` `fs.allow`.
   - Update the root `build:studio` (which runs `build:wasm`) and the AGENTS.md setup notes. This must be the last batch.
9. **Benches and e2e.** Delete the old-engine benches and their scripts. Port `doc-switch` and `app-memory`. Port the smoke flows off `window.__wasm` and `__inputHandler`, and drop or rewrite `e2e/engine-trap-recovery`. This can run in parallel with 2 to 4 once the hooks are settled.

## Risks

- `scripts/generate-agent-edit-capabilities.mjs` reads `wasm-bridge.ts` during `build` and `test`. If core deletes the bridge file before that script is replaced, CI (`checks.yml:117, 120`) breaks.
- The workers and the agent still load `@wasm/rhwp.js` outside the bridge (1i). Removing `build:wasm` or the alias early breaks thumbnails, merge and agent preflight.
- The Proxy in `createStudioEngine` hides gaps: a missing method throws only when it is called. Add a check of every `wasm.X` call in `command/`, `ui/` and `agent/` against the adapter surface before deleting the rhwp class.
- `engine-trap` is shared state (mutation epoch, trap flag) read across save, versioning and the agent. Delete only the rhwp prototype guard.
- Removing `src/engine/` drops table and picture hit-testing, resize and drag, which heemang has no equivalent for yet. That is a feature regression, not cleanup.
