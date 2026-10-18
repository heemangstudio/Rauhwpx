# Equation and rendering implementation map

This map separates recovered behavior, the changes in this PR, and unresolved work. It is not a recovered Hancom source tree or a claim of complete engine equivalence.

## Corpus and reference

The local batch contains ten 2024 mathematics mock exams, 188 reference pages and 10,700 Version60 inline equation records. All use HYhwpEQ and baseUnit 1100; all captured equation AffectLSpacing flags are false. There are 1,747 equations containing OVER, 459 containing SQRT, 1,564 containing a subscript, 1,345 containing a superscript, 101 containing an integral, 62 containing CASES and 30 containing PILE. These lexical counts overlap.

The reference is Windows Hancom 12.0.0.4426. Original PAGE_DEF records describe A3 portrait, 84188 by 119052 HWP units. Explicit native-paper, 100%, one-up PDF output has integer 841 by 1190 point page boxes. At 200 DPI, the source renderer produces 2339 by 3307 pixels and the reference PDF raster produces 2337 by 3306. A source-derived, strictly white edge exception accounts for this bounded quantization. It does not permit resizing, translation, cropping or removal of ink.

The earlier A4 SaveAs PDFs reduced content to about 70.8% and are retained as an older baseline. They are not the acceptance reference for this implementation.

## Behavior to implementation

| Area | Recovered or observed behavior | PR implementation | Boundary |
| --- | --- | --- | --- |
| Provider selection | HwpApp host service 17 reaches the HwpPlugin equation interface through the engine factory | Identifies the relevant modern backend for the evidence | No vendor backend is executed or included by this PR |
| Script sizing | Parser AST parameter propagation uses 64%; modern visual script measurement separately uses Windows MulDiv(size, 68, 100) | Carries resolved visual size through LayoutBox and every painter, preventing a second scale | A matching ratio does not establish identical native integer quantization for every command |
| Fraction and radical paint | Modern fraction bars use a scaled U+E06D glyph; radical helper uses U+E05C and U+E06D | Studio preserves atomic outline replay and resolved composite size; native/SVG consumers receive the same size | Complete operator algebra and downstream glyph transforms remain partial |
| Integral | Current modern provider paints the equation-font integral glyph | Studio selects HY U+E05B at the required size before the STIX fallback | Actual selected font and metrics still depend on registered coverage |
| Baseline | Modern host computes a signed percentage from service metric and clamped height, then adds one to the stored baseline percentage | Keeps occupied height, percentage-spacing basis and baseline inputs distinct | The PR does not replace every provider metric with a fully reconstructed service implementation |
| Fallback font | Name substitution and codepoint-tested fallback are different paths; ordinary mode-1 lookup has its own sign domain | Native and Studio match physical face/style, coverage, advance and ink; known width survives unavailable exact ink | Runtime system font datasets, legacy HFT edge cases and shaping are separate frontiers |
| Host line flow | Original line records carry authored vertical geometry; full equation height need not equal percentage-spacing basis | Keeps authored LINE_SEG on the admitted path and preserves percent spacing during fresh flow | Edited and incomplete source caches retain existing fallback behavior |
| Notes | Original source control slots carry marker styling; continuous stored solution line ladders can disagree with a generic compact-note override | Resolves marker style from raw UTF-16 slots and emits final font size once; certified note spacing is used for both fitting and painting | Certificate rejects unsupported controls, malformed ladders and edited/generated profiles |
| Inline frames | Column-relative percentage width was treated as a raw HWP-unit occupied slot, while painting used the wider resolved frame | Shares live-context physical width with final inline placement, including textless hosts without stored lines | Fresh wrapping still lacks sufficient context for every relative-size criterion |
| Page geometry | Import compatibility changed bottom margin even though that margin also controls footer placement and serialization | Preserves source PAGE_DEF and uses an internal pagination allowance with the same admission rule | Broader legacy compatibility is supported by sampled regressions and counts, not an all-document proof |

## Remaining extraction frontiers

Full grammar and malformed-input behavior, complete matrix/operator algebra, complete page traversal, some render-receiver and advance-consumer paths, system shaping behavior, and runtime font dataset/cache lifetime are unresolved. The extraction's selected-function and bounded-byte counts are not a percentage of the complete engine.

Exact disassembly ties a decoded instruction range to a hashed vendor binary. Behavioral reconstruction adds a contract derived from those instructions and their callers. An implementation test shows whether Rauhwpx satisfies the tested contract. A visual comparison shows whether particular documents match their reference output. These are different kinds of evidence.

## Validation policy

The frozen scorer uses 200 DPI, ink threshold 200, 4-pixel tolerance and ten bands per page. Acceptance requires matching page counts and an unrounded integer mismatch-to-ink ratio strictly below 1% in every required band, plus geometry acceptance. A failed geometry check must remain separate from numerical mismatch. Synthetic font fixtures establish selection and paint behavior; they are not corpus acceptance or a live Studio check.

The initial native-paper round matched all 188 page counts but failed acceptance on every page, with 1,041 of 1,880 failing bands and four actual edge-overflow pages. Candidate r1 also matched all 188 page counts and passed every geometry check, closing the four edge failures. It still failed numerical acceptance on every page, with 921 failing bands. The independent gate rejected the numerical acceptance errors before independent pixel recomputation. Do not describe a passing focused suite as completion of the parity target.

No proprietary vendor executable, font byte stream, decompiled body or source document is included in this map.
