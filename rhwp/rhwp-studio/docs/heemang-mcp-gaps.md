# MCP tools on HeemangEngine: remaining gaps

What the agent tools in `rhwp/rhwp-agent/tools.mjs` still cannot do on HeemangEngine, and what each gap needs.

## How this was measured (2026-10-25)

On `feat/heemang-engine-only` with every Studio lane merged (dialogs, widgets, objects, agent tools) and hm-wasm built
from HeemangEngine `feat/studio-integrate` `f9528d9` (see `vendor/hm-wasm/README.md`).

- `e2e/heemang-verify/mcp-parity.mjs` on `biz_plan.hwp`: 64 parity, 1 better (`apply_style` is read back), no candidate-only failures. 6 tools fail on both engines (no
  template selected, missing field by design); `edit_header_footer` is not read back on either engine.
- Live sidebar run (fake Pi, real hub, Vite on 7715) on `biz_plan.hwp` and `표-텍스트.hwpx`: 29/29 checks. 채팅 and 플랜
  reject writes, a stale `expectedRevision` gets `REVISION_MISMATCH`, 에이전트 writes show as a live preview, reject
  restores the document, approve keeps it and one undo/redo round-trips the change set, `commit_version` records a
  version, 전체 gives one undo step per write call, and save → reopen keeps the text and the equation in HWP and HWPX.

## Gaps

None of the tools fails on HeemangEngine where the old engine succeeds. The four earlier gaps are closed:
`commit_version` (versions use the compare-snapshot manifest when the engine has no structural merge),
`insert_page_break` (engine `pageBreak` op, read back from `formatRuns`), `edit_table set_caption` and
`set_zone_borders` (the engine `tableProperties` query reports the caption and cell zones; cell properties show a
zone's fill and its outer edges).

Version merge between branches still needs structural merge in the engine (`merge.worker.ts`); until then merging
versions reports `문서 구조 병합` as unsupported.

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

Conditional property/clipboard parity is tracked in [the engine-gap inventory](../../../docs/heemang-engine-gaps.md).
It covers cross-document object resources, cross-section selections, character borders/outline numbering, shape and
caption variants, native filename/total-page furniture fields, inactive-furniture coordinates and note-equation writes.
