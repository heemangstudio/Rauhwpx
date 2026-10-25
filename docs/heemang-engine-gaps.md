# Conditional HeemangEngine feature parity

Audit of effective registered `core/hm` implementations against the old Studio bridge, 2026-10-25.

| Area | Confirmed old behavior restored |
| --- | --- |
| Cross-section selection | Copy/export HTML and atomically delete selected body content while retaining section boundaries. |
| Character formatting | Character border lines/background/reference IDs, visible outline numbering, and stable strike formatting after HWPX save. |
| Object properties | Caption creation/removal and all positions, Pattern8x8 picture effects, gradient fills, text-box margins/alignment, line ends/arrows, shadows, rounding and flipped lines. |
| Internal clipboard | Tables and objects across documents, importing referenced definitions and binary resources after source closure. Mixed text/object HTML exports include tables and embedded pictures. |
| External HTML | Tables with merged cells, nested content, cell background/borders/padding/alignment, character formatting and data URI pictures. |
| Header/footer | Native total-page and filename fields, filename templates with right-aligned tabs, and cached inactive-target drawing/caret/selection/hit testing. Templates are one history step. |
| HWPJSON | Native tables, rectangles/text boxes and embedded pictures, including nested text formatting. |
| Table/cell properties | Border-fill references, cell field names, and table-caption creation/position/alignment/removal. |
| Notes | Equation-property writes use the same atomic native path as body/cell equations. |

Page image/gradient authoring was already restricted to unchanged reference reapplication in the old engine. Its cell/table border-fill JSON writer authored solid or empty fills. Unknown fill kinds, malformed control references, unsupported object kinds and invalid enum values remain rejections.

`setNumberingRestart` still rejects outline/plain paragraphs. The old setter stored a runtime-only paragraph flag without a parser/writer representation; preserving that extra runtime behavior requires a separate numbering-state design. The ordinary numbered-list restart path works. The old last-page-master conversion capability was not established in this lane, so its existing conversion guard remains.

Native commits on `fix/studio-feature-gaps`: `1a4bb01`, `73a4076`, `036a74e`, `bc72d3f`, `2dd2704`, `5a934c9`. No generated vendor files are part of this lane.

Focused verification: 25 native object/dialog tests, 102 affected-library tests with one existing ignored test, the previously failing real-corpus strike-format roundtrip, eight real-WASM Studio tests and 26 related Studio checks passed. The full Studio suite passed 2,985 tests with two existing TODO tests. A source-model test additionally covers total-page counters in all master-page list kinds. [Live evidence](evidence/heemang-conditional-features/README.md) records the two real sample save/reopen flows.
