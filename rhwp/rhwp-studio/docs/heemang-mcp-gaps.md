# MCP tools on HeemangEngine: remaining gaps

What the agent tools in `rhwp/rhwp-agent/tools.mjs` still cannot do on HeemangEngine, and what each gap needs.

## How this was measured (2026-10-25)

The agent lane runs on the other Studio lanes' bridge methods, so the checks ran on a local integration of
`feat/heemang-only-agent` with `feat/heemang-only-{dialogs,widgets,objects}` and an hm-wasm built from
`feat/studio-agent-api` merged with `feat/studio-{objects,dialogs,widgets}` (see `vendor/hm-wasm/README.md`).

- `e2e/heemang-verify/mcp-parity.mjs` on `biz_plan.hwp`: 60 parity, 1 better, 6 fail on both engines (no template
  selected, missing field by design), 2 candidate failures, 2 writes not read back. No page errors.
- Live sidebar run (fake Pi, real hub, Vite on 7711) on `biz_plan.hwp` and `표-텍스트.hwpx`: 27/27 checks. 채팅 and 플랜
  reject writes, a stale `expectedRevision` gets `REVISION_MISMATCH`, 에이전트 writes (text, equation, char format)
  show as a live preview, reject restores the document, approve keeps it and one undo/redo round-trips the change
  set, 전체 gives one undo step per write call, and save → reopen keeps the text and the equation in HWP and HWPX.

## Gaps

| Tool | What fails | Owner | What it needs |
| --- | --- | --- | --- |
| `commit_version` | `VERSIONING_DISABLED`: version history never starts on HeemangEngine | core (versioning) | `merge/merge.worker.ts` throws "문서 구조 병합" for `buildDocumentManifest`, which `versioning/controller.ts` needs to create a repository. Either an hm document manifest, or create the repository with empty merge manifest entries when structural merge is unavailable. |
| `insert_page_break` | `ENGINE_NOT_SUPPORTED: 문단 서식: pageBreakBefore` | widgets (`format-widgets.ts`) | The tool sets `pageBreakBefore` through `applyParaFormat`. Map it to the engine's existing `{op:"pageBreak", at, on}` and report it from `getParaPropertiesAt`. |
| `edit_table` `set_caption` | Caption is written (with the "표 N" auto number) but `get_table_properties` reports `caption.enabled: false` | objects (`table-properties.ts`) | `getTableProperties` returns `hasCaption: false` unconditionally. Report the caption from the model (side, width, gap); the caption list is `steps + {para, control, index: cellCount}`. |
| `set_zone_borders` | Zone is written and painted, not visible in `get_table_properties` | objects | The engine `tableProperties` query does not list the table's cell zones. Report zones (range, lines, fill) so reads reflect the write. |

## Smaller differences

- `template_insert_block` copies through the engine fragment, so it replaces the user's internal clipboard.
- `setTableCaptionText` returns `captionText` without the auto number's digits ("표  설명"); the `paragraphs` query does not
  expand auto numbers. The dialogs lane's `controls` query reports them.
- `get_outline` in `outline` mode treats outline and numbered paragraphs as headings (level = list level + 1), as the old
  engine did; `clause` mode uses the article patterns (편·장·절·관·조, ①, 1., 가.). Paragraph bodies and the preamble
  are not collected because the tool drops them.
- `apply_engine_edits` finds changed paragraphs by digest (text, controls, style, para shape, char shape runs).
  Paragraph capture (`captureParagraph`) is not implemented; object staging falls back to document snapshots, which
  is correct but heavier.
- Agent offsets are Unicode scalars and core/hm offsets are UTF-16. `src/agent/engine-coordinates.ts` converts at the
  agent boundary; text outside the BMP (emoji) is the only case where the two differ.
- The objects lane's d.ts redeclares `fill`/`borderFill` in `ObjectProperties`, `TableProperties` and
  `CellProperties` with types that conflict with their patch types (strict `tsc` on the d.ts alone reports TS2430;
  Studio's own `tsc` passes).
