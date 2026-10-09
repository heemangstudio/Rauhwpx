# Regression review implementation

Tracks the reviewed recommendations from the private regression-review Site. Screening flags are heuristics, not a deletion policy. Source guards that protect credentials, approval, cleanup or data loss remain where an equivalent behavioral failure-path check is not yet established.

## Recommendation mapping

| ID | Action | Implementation / retained coverage |
| --- | --- | --- |
| R01 | Remove | Full editor reuses pooled canvases while resizing and toggling the sidebar. |
| R02 | Remove | Settings opens via keyboard and exposes its named region. |
| R03 | Remove | Removed cosmetic CSS requirements; import/edit/security guards remain until replaced. |
| R04 | Remove | Removed gradient/backdrop styling ban; progress and reduced-motion guards retained. |
| R05 | Remove | Close and dispose cancel a mounted merge prompt; Escape restores focus. |
| R06 | Replace | Dirty exit Apply/Discard/Continue tested in a browser; value tests retained. Credential and approval guards isolated for conservative retention. |
| R07 | Replace | Double approval sends one request; transitioning blocks draft submission. |
| R08 | Replace | Mounted permission lock/confirmation and keyboard skill payload tested; existing skill import/edit suite retained. |
| R09 | Replace | Production normalizers, HTTP capability selection and rendered hostile-data safety tested. |
| R10 | Replace | Production reconnect methods tested with controlled timers, cancellation, generations and delayed hub readiness; full editor starts a real hub. |
| R11 | Replace | Removed source-only scroll guards; mounted sidebar suite covers following output and manual scroll-away. |
| R12 | Replace | Removed CSS/source layout guards; full editor verifies pooled canvas geometry through sidebar/viewport changes. |
| R13 | Replace | Real toolbar handlers dispatch bounded and invalid font values. |
| R14 | Replace | Real toolbar/command applies line spacing; E2E checks model values, strict geometry and undo. Fixed duplicate Enter/blur dispatch. |
| R15 | Replace | Mounted version manager tests saved/enabled/blocked prerequisites, comparison invalidation, prompt cancellation and focus. |
| R16 | Replace | Full editor checks rendered accessibility tree, named controls and active editor input. |
| R17 | Replace | Full editor intercepts OS print, checks generated SVG, modal closure, cancellation, restored title and unchanged filename/text/dirty state. |
| R20 | Streamline | Typesetting asserts marks enabled, wrapped geometry, paragraph content/count and merge preservation; screenshots remain evidence. |
| R21 | Streamline | Deterministic wrapped text and identical-content pagination fixture: applied values, strict downward movement, undo layout and 1-to-4 pages. |
| R22 | Streamline | 22 inline-prompt settling sleeps replaced by named state waits or paint-cycle completion; real editor scenario passes. |
| R23 | Streamline | New-document requests report correlated completion/failure; helper waits for initialization and input readiness. |
| R24 | Streamline | Renderer entry point split into architecture/asset guards and independent production replay. Removed stale deleted-workflow guards and redundant text-method regex checks. Existing parsed CI workflow contracts retained. |
| R25 | Replace | Real CommandRegistry metadata in browser; conversion tests retained, source parsing removed. |
| R26 | Replace | Removed duplicated turn-outcome source test; production outcome/failure tests retained. Save/history guards kept conservatively. |
| R27 | Keep | Kept real zoom shortcut behavior; completion assertion now reports observed zoom. |
| R28 | Keep | Kept indexed-reference search and scope isolation; completion checks the observed excerpt. Fixed authenticated hub readiness and stale attachment-draft expectations. Clearing text preserves the draft; explicit cancellation removes it without indexing it. |
| R29 | Keep | Kept compile-time DocumentCore Send contract unchanged. |
| R30 | Keep | Kept save-target value and ownership contracts unchanged. |
| R31 | Keep | Kept real production turn-outcome tests unchanged. |
| R32 | Keep | Kept local HTTP/encryption/database failure tests unchanged. |
| R33 | Keep | Kept parsed workflow topology and selection tests unchanged. |

## Running the checks

- `npm --prefix rhwp/rhwp-studio test`: fast value and production-method checks.
- `CI=1 npm --prefix rhwp/rhwp-studio run test:browser`: mounted UI plus the full running editor/WASM check; the toolbar keyboard check now uses the discoverable `.browser.test.ts` suffix.
- `npm --prefix rhwp/rhwp-studio run test:sidebar`, `test:sidebar:skills`, `test:sidebar:skill-editor`: explicitly labeled service fixtures, including transcript follow, geometry, skill import/save/cancel and keyboard behavior.
- Run the Studio dev server, then `node e2e/{inline-prompt,line-spacing,typesetting,global-shortcut}.test.mjs --mode=headless` individually from the Studio directory. These run against the live editor; provider submission in inline-prompt is a recording boundary.
- `node e2e/renderer-contract.test.mjs`: architecture/assets and independent production replay, without browser launch.

## Live-verification rule

AGENTS.md requires agents changing observable behavior to run the application, exercise a user flow and a failure/cancellation path, and record evidence. Fixtures must be labeled. A regression suite alone is not a live-verification receipt. Native Electron and authenticated model execution have not been verified by the browser check.

## Bugs caught by replacement coverage

- Line-spacing Enter triggered a second dispatch through blur while removing its focused input. The commit is now idempotent; Escape cannot apply the draft.
- Version toolbar actions overflowed at 280px. The creation action can shrink while shared actions retain their positions.
- Grabbing a skill while its reorder animation was running lost the visible grab position when the animation was cancelled. The drag now preserves that position. Geometry tests sample the actual pointer-down event and await completed animations before unrelated gestures.
- Pi deterministic-download fixtures inherited host proxy settings and bypassed their injected registry. The fixtures now explicitly supply their environment.
