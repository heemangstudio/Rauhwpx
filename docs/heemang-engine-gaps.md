# Conditional HeemangEngine feature parity

Audit of effective registered `core/hm` implementations against the old Studio bridge, 2026-10-25.

| Area | Confirmed old behavior restored |
| --- | --- |
| Cross-section selection | Copy/export HTML and atomically delete selected body content while retaining section boundaries. |
| Character formatting | Character border lines/background/reference IDs, visible outline numbering, stable strike formatting after HWPX save, and session-only restart/continue on numbered, outline and plain paragraphs. |
| Object properties | Caption creation/removal and all positions, Pattern8x8 picture effects, gradient fills, text-box margins/alignment, line ends/arrows, shadows, rounding and flipped lines. |
| Internal clipboard | Tables and objects across documents, importing referenced definitions and binary resources after source closure. Mixed text/object HTML exports include tables and embedded pictures. |
| External HTML | Tables with merged cells, nested content, cell background/borders/padding/alignment, character formatting and data URI pictures. |
| Header/footer | Native total-page and filename fields, filename templates with right-aligned tabs, cached inactive-target drawing/caret/selection/hit testing, and last-page masters across HWP/HWPX conversion. Templates are one history step. |
| HWPJSON | Native tables, rectangles/text boxes and embedded pictures, including nested text formatting. |
| Table/cell properties | Border-fill references, cell field names, and table-caption creation/position/alignment/removal. |
| Notes | Equation-property writes use the same atomic native path as body/cell equations. |

Page image/gradient authoring was already restricted to unchanged reference reapplication in the old engine. Its cell/table border-fill JSON writer authored solid or empty fills. Unknown fill kinds, malformed control references, unsupported object kinds and invalid enum values remain rejections.

Numbering restart is editor session state, matching the old engine: outline/numbered paragraphs visibly change from `1,2,3` to `1,7,8`; a plain paragraph remembers the override until numbering is applied. Undo/redo and checkpoints keep it. HWP/HWPX writers and the opt-in merge snapshot view omit it, so reopening returns to the file's original numbering rules. Zero starts at one. Bridge mode 0 and unrecognized modes clear the override, as in the baseline; malformed typed requests are rejected. Explicit continuation retains an already-used numbering definition's counters. Ordinary file numbering keeps the engine's Hancom corpus rules.

The last-page master is a confirmed file feature: the baseline renders the generated two-page fixture's marker on page two and preserves it in both export formats. Native writers now materialize the typed list and replace HWP5's original trailing raw copy once. Conversion measures inactive variants and preserves their line membership. [Follow-up evidence](evidence/heemang-session-parity/README.md) includes matching visible labels, UI cancellation and both Save As/reopen flows.

The final assigned-branch audit leaves input errors and unchanged unsupported authoring cases: unknown object/effect/fill enums, missing control references or source pictures, unknown paragraph line-spacing/underline enums, out-of-range table dimensions, absent header/footer targets and invalid endnote formats. Clipboard `dropped` guards protect a failed native fragment capture; native table/object fragments now retain these payloads. HWPJSON section/column/page-position controls use code 2 and are deliberately skipped, as the baseline paste keeps the destination section. No additional baseline-supported conditional rejection was found.

Native commits on `fix/studio-feature-gaps`: `1a4bb01`, `73a4076`, `036a74e`, `bc72d3f`, `2dd2704`, `5a934c9`. No generated vendor files are part of this lane.

Focused verification: 25 native object/dialog tests, 102 affected-library tests with one existing ignored test, the previously failing real-corpus strike-format roundtrip, eight real-WASM Studio tests and 26 related Studio checks passed. The full Studio suite passed 2,985 tests with two existing TODO tests. A source-model test additionally covers total-page counters in all master-page list kinds. [Live evidence](evidence/heemang-conditional-features/README.md) records the two real sample save/reopen flows.

Follow-up checks passed: nine focused native API/snapshot tests, one numbering-head test, nine real-WASM Studio checks, TypeScript, and 103 affected-library tests with one existing ignored test. The live baseline and candidate runs both paint `1,7,8`, retain restart on plain-then-numbered paragraphs, reset on file reopen, and retain the last-page master after UI Save As HWP and HWPX. Servers were stopped.
