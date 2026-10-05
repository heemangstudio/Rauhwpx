import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requireWasmPackage } from './browser-support.ts';
import type { CellProperties, PageBorderFillSettings, SearchHit } from '../src/core/types.ts';
import { buildPageBorderPatch, type PageBorderForm } from '../src/ui/page-border-model.ts';
import { buildCellBorderFillPatch } from '../src/ui/cell-border-bg-model.ts';
import { isLiveFindHit } from '../src/ui/find-dialog.ts';
import { changedRawValue, formatPtFromPx, ptToRaw2x } from '../src/ui/para-shape-model.ts';

// 대화상자가 만든 패치를 실제 엔진에 적용해, 사용자가 건드리지 않은 값이 보존되는지 확인한다.
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
type Document = InstanceType<typeof HwpDocument>;

function withDocument(document: Document, run: (document: Document) => void): void {
  try {
    run(document);
  } finally {
    document.free();
  }
}

function pageBorder(document: Document): PageBorderFillSettings & Record<string, unknown> {
  return JSON.parse(document.getPageBorderFill(0));
}

/** 대화상자가 확인 시점에 만드는 폼 — 그림 배경은 '없음'으로 보이고 윗 테두리만 바꿨다 */
function borderOnlyForm(settings: PageBorderFillSettings): PageBorderForm {
  return {
    basis: settings.basis,
    spacingLeft: settings.spacingLeft,
    spacingRight: settings.spacingRight,
    spacingTop: settings.spacingTop,
    spacingBottom: settings.spacingBottom,
    borderLeft: settings.borderLeft,
    borderRight: settings.borderRight,
    borderTop: { type: 1, width: 3, color: '#123456' },
    borderBottom: settings.borderBottom,
    fillType: 'none',
    fillColor: settings.fillColor,
    patternColor: settings.patternColor,
    patternType: settings.patternType,
    fillArea: settings.fillArea,
    hideBorder: false,
    hideFill: false,
    applyPage: 'all',
  };
}

const imageBackground = readFileSync(new URL('../../samples/issue2816/imgbrush_total_page_fill.hwpx', import.meta.url));

test('page border OK with an untouched image background keeps the image and applies the border', () => {
  withDocument(new HwpDocument(new Uint8Array(imageBackground)), (document) => {
    const before = pageBorder(document);
    assert.equal(before.fillType, 'image');

    const patch = buildPageBorderPatch(before, borderOnlyForm(before), false);
    document.setPageBorderFill(0, JSON.stringify(patch));

    const after = pageBorder(document);
    assert.equal(after.fillType, 'image', 'the page background image survives');
    assert.equal(after.imageBinDataId, before.imageBinDataId);
    assert.equal(after.imageFillMode, before.imageFillMode);
    assert.deepEqual(after.borderTop, { type: 1, width: 3, color: '#123456' });
  });
});

test('the payload the dialog used to send wipes that image background', () => {
  // 회귀 기준: 설정값을 펼치고 보이는 fillType('none')을 그대로 보내면 엔진이 채우기를 기본값으로 바꾼다.
  withDocument(new HwpDocument(new Uint8Array(imageBackground)), (document) => {
    const before = pageBorder(document);
    document.setPageBorderFill(0, JSON.stringify({ ...before, ...borderOnlyForm(before) }));
    assert.equal(pageBorder(document).fillType, 'none');
  });
});

function tableDocument(): { document: Document; paraIdx: number; controlIdx: number } {
  const document = HwpDocument.createEmpty();
  const table = JSON.parse(document.createTableEx(JSON.stringify({
    sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 2, colCount: 2,
  })));
  return { document, paraIdx: table.paraIdx, controlIdx: table.controlIdx };
}

function ownCell(document: Document, paraIdx: number, controlIdx: number, cellIdx: number): CellProperties {
  return JSON.parse(document.getCellOwnProperties(0, paraIdx, controlIdx, cellIdx));
}

test('a fill-only 각 셀마다 적용 keeps every cell\'s own borders', () => {
  const { document, paraIdx, controlIdx } = tableDocument();
  withDocument(document, () => {
    const thick = { type: 1, width: 6, color: '#0000ff' };
    const first = ownCell(document, paraIdx, controlIdx, 0);
    document.setCellProperties(0, paraIdx, controlIdx, 0, JSON.stringify({
      borderFillId: first.borderFillId,
      borderLeft: first.borderLeft, borderRight: first.borderRight,
      borderTop: thick, borderBottom: first.borderBottom,
    }));
    const edits = {
      borders: [null, null, null, null],
      fill: { fillType: 'solid' as const, fillColor: '#ff0000', patternColor: '#000000', patternType: 0 },
      diagonal: null,
    };
    // 대화상자처럼 캐럿 셀(3)에서 열어 모든 셀에 배경만 적용한다.
    for (let cellIdx = 0; cellIdx < 4; cellIdx++) {
      const patch = buildCellBorderFillPatch(edits, ownCell(document, paraIdx, controlIdx, cellIdx));
      assert.ok(patch);
      document.setCellProperties(0, paraIdx, controlIdx, cellIdx, JSON.stringify(patch));
    }
    const after = [0, 1, 2, 3].map((cellIdx) => ownCell(document, paraIdx, controlIdx, cellIdx));
    assert.deepEqual(after[0].borderTop, thick, 'the edited cell keeps its thick top border');
    for (const cell of after) {
      assert.equal(cell.fillType, 'solid');
      assert.equal(cell.fillColor, '#ff0000');
    }
  });
});

test('the payload the dialog used to send stamps the caret cell\'s borders on every cell', () => {
  // 회귀 기준: 캐럿 셀의 borderFillId·네 변·배경을 모든 셀에 보내면 다른 셀의 테두리가 사라진다.
  const { document, paraIdx, controlIdx } = tableDocument();
  withDocument(document, () => {
    const thick = { type: 1, width: 6, color: '#0000ff' };
    const first = ownCell(document, paraIdx, controlIdx, 0);
    document.setCellProperties(0, paraIdx, controlIdx, 0, JSON.stringify({
      borderFillId: first.borderFillId,
      borderLeft: first.borderLeft, borderRight: first.borderRight,
      borderTop: thick, borderBottom: first.borderBottom,
    }));
    const caret = ownCell(document, paraIdx, controlIdx, 3);
    const stamped = {
      borderFillId: caret.borderFillId,
      borderLeft: caret.borderLeft, borderRight: caret.borderRight,
      borderTop: caret.borderTop, borderBottom: caret.borderBottom,
      fillType: 'solid', fillColor: '#ff0000', patternColor: '#000000', patternType: 0,
    };
    for (let cellIdx = 0; cellIdx < 4; cellIdx++) {
      document.setCellProperties(0, paraIdx, controlIdx, cellIdx, JSON.stringify(stamped));
    }
    assert.notDeepEqual(ownCell(document, paraIdx, controlIdx, 0).borderTop, thick);
  });
});

test('a remembered find hit goes stale when text is typed before it', () => {
  withDocument(HwpDocument.createEmpty(), (document) => {
    document.insertText(0, 0, 0, 'xx abc');
    const [hit] = JSON.parse(document.searchAllText('abc', false, false)) as SearchHit[];
    const found = { found: true, ...hit };
    const selection = {
      start: { sectionIndex: 0, paragraphIndex: hit.para, charOffset: hit.charOffset },
      end: { sectionIndex: 0, paragraphIndex: hit.para, charOffset: hit.charOffset + hit.length },
    };
    assert.equal(isLiveFindHit(JSON.parse(document.searchAllText('abc', false, false)), found, selection), true);

    document.insertText(0, 0, 0, '12');
    const liveHits = JSON.parse(document.searchAllText('abc', false, false)) as SearchHit[];
    assert.equal(isLiveFindHit(liveHits, found, selection), false, 'replacing now would overwrite "x a"');
    assert.equal(document.getTextRange(0, 0, hit.charOffset, hit.length), 'x a');
  });
});

test('paragraph margins reported by the engine round-trip through the dialog untouched', () => {
  withDocument(HwpDocument.createEmpty(), (document) => {
    document.insertText(0, 0, 0, 'paragraph');
    for (const raw of [2000, 1995, 3333, 1417, 7, 12345]) {
      document.applyParaFormat(0, 0, JSON.stringify({ marginLeft: raw }));
      const reported = JSON.parse(document.getParaPropertiesAt(0, 0));
      const shown = formatPtFromPx(reported.marginLeft);
      assert.equal(changedRawValue(shown, shown, ptToRaw2x), undefined, `margin ${raw} stays untouched`);
      if (raw === 2000) {
        // 예전 판정: 10pt(2000) → 13.3px → 되돌리면 1995 — 손대지 않은 여백이 바뀐 것으로 잡혔다.
        assert.notEqual(Math.round(reported.marginLeft * 150), ptToRaw2x(parseFloat(shown)));
      }
    }
  });
});
