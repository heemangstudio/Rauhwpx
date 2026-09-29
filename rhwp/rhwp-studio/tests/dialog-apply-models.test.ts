import test from 'node:test';
import assert from 'node:assert/strict';

import type { DocumentPosition, PageBorderFillSettings, PageDef, SearchHit, SearchResult } from '../src/core/types.ts';
import { isTopModal, openModalCount, popModal, pushModal } from '../src/ui/modal-stack.ts';
import { isLiveFindHit } from '../src/ui/find-dialog.ts';
import {
  applyLangArrayEdit,
  applyLangFontEdit,
  clampCharOffset,
  clampRelativeSize,
  clampShadowOffset,
  resolveCharShapeFontChange,
  sameLangArray,
} from '../src/ui/char-shape-model.ts';
import {
  changedRawValue,
  formatPtFromPx,
  ptToRaw,
  ptToRaw2x,
} from '../src/ui/para-shape-model.ts';
import { buildPageBorderPatch, type PageBorderForm } from '../src/ui/page-border-model.ts';
import { buildCellBorderFillPatch } from '../src/ui/cell-border-bg-model.ts';
import { buildPageDefFromForm, formatPageMm, PAGE_MARGIN_KEYS, type PageSetupFields } from '../src/ui/page-setup-model.ts';
import { mergeShapeModsJson } from '../src/ui/style-shape-mods.ts';

// ── 모달 스택 ──────────────────────────────────────────────────────────────

test('modal stack: only the most recently opened dialog owns the keyboard', () => {
  const base = {};
  const nested = {};
  pushModal(base);
  pushModal(nested);
  assert.equal(isTopModal(nested), true);
  assert.equal(isTopModal(base), false);

  popModal(nested);
  popModal(nested);
  assert.equal(isTopModal(base), true, 'pop is idempotent and uncovers the dialog below');

  pushModal(nested);
  pushModal(base);
  assert.equal(isTopModal(base), true, 're-showing an open dialog moves it to the top');
  assert.equal(openModalCount(), 2, 're-showing does not duplicate the entry');
  popModal(base);
  popModal(nested);
  assert.equal(openModalCount(), 0);
});

// ── 찾아 바꾸기 ─────────────────────────────────────────────────────────────

const body = (paragraphIndex: number, charOffset: number): DocumentPosition => ({
  sectionIndex: 0, paragraphIndex, charOffset,
});
const hit: SearchResult = { found: true, sec: 0, para: 1, charOffset: 3, length: 3 };
const liveHits: SearchHit[] = [
  { sec: 0, para: 0, charOffset: 0, length: 3 },
  { sec: 0, para: 1, charOffset: 3, length: 3 },
];

test('replace validates the remembered hit against the live document and selection', () => {
  const selection = { start: body(1, 3), end: body(1, 6) };
  assert.equal(isLiveFindHit(liveHits, hit, selection), true, 'unchanged hit and selection');

  const shifted: SearchHit[] = [{ sec: 0, para: 1, charOffset: 5, length: 3 }];
  assert.equal(isLiveFindHit(shifted, hit, selection), false, 'text typed before the match moved it');
  assert.equal(isLiveFindHit([], hit, selection), false, 'the query no longer matches (edited or other document)');
  assert.equal(isLiveFindHit(liveHits, hit, { start: body(1, 4), end: body(1, 6) }), false, 'selection moved');
  assert.equal(isLiveFindHit(liveHits, hit, null), false, 'selection cleared by a click');
  const inCell = { start: { ...body(1, 3), parentParaIndex: 1, cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 1 }] }, end: body(1, 6) };
  assert.equal(isLiveFindHit(liveHits, hit, inCell), false, 'cell coordinates never match a body hit');
  const cellHit: SearchHit[] = [{ ...liveHits[1], cellContext: { parentPara: 1, ctrlIdx: 0, cellIdx: 0, cellPara: 0 } }];
  assert.equal(isLiveFindHit(cellHit, hit, selection), false, 'a cell match at the same numbers is not the body hit');
  assert.equal(isLiveFindHit(liveHits, { found: false }, selection), false);
});

// ── 글자 모양: 언어별 값 ─────────────────────────────────────────────────────

test('char shape: 대표 edits fill every language, a single language edits one slot', () => {
  const ratios = [100, 95, 90, 100, 100, 100, 100];
  assert.deepEqual(applyLangArrayEdit(ratios, 'ratios', 0, 80), [80, 80, 80, 80, 80, 80, 80]);
  assert.deepEqual(applyLangArrayEdit(ratios, 'ratios', 2, 120), [100, 120, 90, 100, 100, 100, 100]);
  assert.deepEqual(ratios, [100, 95, 90, 100, 100, 100, 100], 'the source array is not mutated');
  assert.deepEqual(applyLangArrayEdit(undefined, 'spacings', 3, -5), [0, 0, -5, 0, 0, 0, 0]);
  assert.equal(sameLangArray(ratios, [...ratios]), true, 'untouched arrays produce no mod');
  assert.equal(sameLangArray(ratios, applyLangArrayEdit(ratios, 'ratios', 1, 100)), true,
    'writing a slot with its own value is not a change');
  assert.equal(sameLangArray(ratios, applyLangArrayEdit(ratios, 'ratios', 0, 100)), false,
    'a 대표 edit flattens the mixed array, so it must only happen when the 대표 field was edited');
});

test('char shape: out-of-range values are clamped to what the engine arrays can hold', () => {
  assert.equal(clampRelativeSize(300), 250);
  assert.equal(clampRelativeSize(1), 10);
  assert.equal(clampCharOffset(-200), -100);
  assert.equal(clampCharOffset(150), 100);
  assert.equal(clampShadowOffset(128), 100);
  assert.equal(clampShadowOffset(-128), -100);
});

test('char shape: a per-language font keeps the other languages', () => {
  const families = ['함초롬바탕', 'Arial', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕'];
  assert.deepEqual(resolveCharShapeFontChange([], families), { kind: 'none' });
  assert.deepEqual(resolveCharShapeFontChange(applyLangFontEdit([], 2, 'Arial'), families), { kind: 'none' },
    'choosing the font already shown is not a change');
  assert.deepEqual(resolveCharShapeFontChange(applyLangFontEdit([], 0, '돋움'), families), { kind: 'all', name: '돋움' });
  assert.deepEqual(resolveCharShapeFontChange(applyLangFontEdit([], 2, 'Times'), families), {
    kind: 'perLanguage',
    names: ['함초롬바탕', 'Times', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕', '함초롬바탕'],
  });
});

// ── 문단 모양: 표시값 판정 ───────────────────────────────────────────────────

/** 엔진 getParaPropertiesAt 이 여백(2배 저장)을 px 0.1 로 반올림해 보고하는 방식 */
function engineMarginPx(raw2x: number): number {
  return Number((raw2x / 2 * 96 / 7200).toFixed(1));
}
function engineSpacingPx(raw: number): number {
  return Number((raw * 96 / 7200).toFixed(1));
}

test('para shape: untouched margins and spacing never produce a mod, edits are exact', () => {
  let lossyRoundTrips = 0;
  for (let raw = 0; raw <= 20000; raw += 1) {
    const marginShown = formatPtFromPx(engineMarginPx(raw));
    assert.equal(changedRawValue(marginShown, marginShown, ptToRaw2x), undefined);
    assert.equal(changedRawValue(marginShown, `${Number(marginShown)}`, ptToRaw2x), undefined,
      'the same number typed without trailing zeros is still untouched');
    const spacingShown = formatPtFromPx(engineSpacingPx(raw));
    assert.equal(changedRawValue(spacingShown, spacingShown, ptToRaw), undefined);
    // 예전 판정(되돌린 raw vs 보고된 px 환산)은 손대지 않은 이런 값을 "바뀜"으로 보았다.
    if (ptToRaw2x(parseFloat(marginShown)) !== Math.round(engineMarginPx(raw) * 150)) lossyRoundTrips++;
  }
  assert.ok(lossyRoundTrips > 1000, `the old raw round-trip flagged ${lossyRoundTrips} untouched margins`);
  assert.equal(changedRawValue('10.0', '12.5', ptToRaw2x), 2500);
  assert.equal(changedRawValue('10.0', '12.5', ptToRaw), 1250);
  assert.equal(changedRawValue('10.0', '', ptToRaw), 0, 'an emptied field is an explicit 0');
  // 10pt 문단 간격(1000) → 13.3px → "10.0": 예전 판정은 pxToRaw(13.3)=998 과 비교해 바뀜으로 보았다.
  assert.equal(formatPtFromPx(engineSpacingPx(1000)), '10.0');
  assert.notEqual(Math.round(engineSpacingPx(1000) * 75), 1000);
});

// ── 쪽 테두리/배경 ──────────────────────────────────────────────────────────

const noBorder = { type: 0, width: 0, color: '#000000' };
function pageBorderSettings(overrides: Record<string, unknown>): PageBorderFillSettings {
  return {
    attr: 0, basis: 'paper', spacingLeft: 1417, spacingRight: 1417, spacingTop: 1417, spacingBottom: 1417,
    borderFillId: 3, headerInside: false, footerInside: false, fillArea: 'paper', hideBorder: false, hideFill: false,
    borderLeft: noBorder, borderRight: noBorder, borderTop: noBorder, borderBottom: noBorder,
    fillType: 'none', fillColor: '#ffffff', patternColor: '#000000', patternType: 0,
    ...overrides,
  } as PageBorderFillSettings;
}
function pageBorderForm(settings: PageBorderFillSettings, overrides: Partial<PageBorderForm> = {}): PageBorderForm {
  return {
    basis: settings.basis, spacingLeft: settings.spacingLeft, spacingRight: settings.spacingRight,
    spacingTop: settings.spacingTop, spacingBottom: settings.spacingBottom,
    borderLeft: settings.borderLeft, borderRight: settings.borderRight,
    borderTop: { type: 1, width: 2, color: '#123456' }, borderBottom: settings.borderBottom,
    // 대화상자는 그림/그러데이션 배경을 '없음'으로 보여 준다.
    fillType: settings.fillType === 'solid' ? 'solid' : 'none',
    fillColor: settings.fillColor, patternColor: settings.patternColor, patternType: settings.patternType,
    fillArea: settings.fillArea, hideBorder: false, hideFill: false, applyPage: 'all',
    ...overrides,
  };
}

test('page border: an untouched image or gradient background is left to the engine to keep', () => {
  for (const fillType of ['image', 'gradient']) {
    const settings = pageBorderSettings({
      fillType, fillAlpha: 0, imageFillMode: 'total', imageBinDataId: 1, gradientType: 2, gradientColors: ['#ffffff'],
    });
    const patch = buildPageBorderPatch(settings, pageBorderForm(settings), false);
    assert.equal(patch.borderFillId, 3, 'the current border fill stays the base');
    assert.deepEqual(patch.borderTop, { type: 1, width: 2, color: '#123456' });
    for (const key of ['fillType', 'fillColor', 'patternColor', 'patternType', 'fillAlpha',
      'imageFillMode', 'imageBinDataId', 'gradientType', 'gradientColors']) {
      assert.equal(key in patch, false, `${fillType}: ${key} must not be sent`);
    }
  }
});

test('page border: an explicit background choice is sent as picked', () => {
  const settings = pageBorderSettings({ fillType: 'image', imageBinDataId: 1 });
  const patch = buildPageBorderPatch(settings, pageBorderForm(settings, { fillType: 'solid', fillColor: '#ff0000' }), true);
  assert.equal(patch.fillType, 'solid');
  assert.equal(patch.fillColor, '#ff0000');
  assert.equal('imageBinDataId' in patch, false);

  const solid = pageBorderSettings({ fillType: 'solid', fillColor: '#eeeeee', fillAlpha: 128 });
  const untouched = buildPageBorderPatch(solid, pageBorderForm(solid), false);
  assert.equal('fillType' in untouched, false, 'an untouched solid fill keeps its alpha too');
  const cleared = buildPageBorderPatch(solid, pageBorderForm(solid, { fillType: 'none' }), true);
  assert.equal(cleared.fillType, 'none');
});

// ── 셀 테두리/배경 ──────────────────────────────────────────────────────────

const thick = { type: 1, width: 6, color: '#000000' };
const thin = { type: 1, width: 0, color: '#000000' };

test('cell border: a fill-only change keeps each cell\'s own border fill and borders', () => {
  const edits = { borders: [null, null, null, null], fill: { fillType: 'solid' as const, fillColor: '#ff0000', patternColor: '#000000', patternType: 0 }, diagonal: null };
  const patch = buildCellBorderFillPatch(edits, { borderFillId: 7, borderTop: thick });
  assert.deepEqual(patch, { borderFillId: 7, fillType: 'solid', fillColor: '#ff0000', patternColor: '#000000', patternType: 0 });
});

test('cell border: nothing changed means no mutation', () => {
  assert.equal(buildCellBorderFillPatch({ borders: [null, null, null, null], fill: null, diagonal: null }, { borderFillId: 2 }), null);
});

test('cell border: one edited side keeps the target cell\'s other sides', () => {
  const edits = { borders: [null, null, thick, null], fill: null, diagonal: null };
  const patch = buildCellBorderFillPatch(edits, {
    borderFillId: 4, borderLeft: thin, borderRight: { type: 2, width: 1, color: '#ff0000' }, borderTop: thin,
  });
  assert.deepEqual(patch, {
    borderFillId: 4,
    borderLeft: thin,
    borderRight: { type: 2, width: 1, color: '#ff0000' },
    borderTop: thick,
    borderBottom: { type: 0, width: 0, color: '#000000' },
  });
  assert.equal('fillType' in patch!, false);
  assert.equal('diagonalLine' in patch!, false);
});

// ── 편집 용지 ───────────────────────────────────────────────────────────────

const a4: PageDef = {
  width: 59528, height: 84188, marginLeft: 8504, marginRight: 8504, marginTop: 5669, marginBottom: 4252,
  marginHeader: 4252, marginFooter: 4252, marginGutter: 0, landscape: false, binding: 0,
};
function shownFields(def: PageDef): PageSetupFields {
  const margins = {} as PageSetupFields['margins'];
  for (const key of PAGE_MARGIN_KEYS) margins[key] = formatPageMm(def[key]);
  const [w, h] = def.landscape ? [def.height, def.width] : [def.width, def.height];
  return { width: formatPageMm(w), height: formatPageMm(h), margins };
}

test('page setup: untouched fields keep the exact original HWPUNIT values', () => {
  const odd: PageDef = { ...a4, width: 59531, marginLeft: 8513, marginTop: 5671 };
  const shown = shownFields(odd);
  const result = buildPageDefFromForm(odd, shown, { ...shown, landscape: false, binding: 0 });
  assert.deepEqual(result, { ok: true, pageDef: odd });

  // 방향만 바꾸면 폭/길이 칸이 서로 바뀐다 — 원래 값을 그대로 옮긴다.
  const flipped = buildPageDefFromForm(odd, shown, {
    ...shown, width: shown.height, height: shown.width, landscape: true, binding: 0,
  });
  assert.deepEqual(flipped, { ok: true, pageDef: { ...odd, landscape: true } });
});

test('page setup: an empty size or margins that exceed the paper are rejected', () => {
  const shown = shownFields(a4);
  const empty = buildPageDefFromForm(a4, shown, { ...shown, width: '', landscape: false, binding: 0 });
  assert.equal(empty.ok, false);
  const wide = buildPageDefFromForm(a4, shown, {
    ...shown, margins: { ...shown.margins, marginLeft: '150', marginRight: '70' }, landscape: false, binding: 0,
  });
  assert.equal(wide.ok, false);
  const tall = buildPageDefFromForm(a4, shown, {
    ...shown, margins: { ...shown.margins, marginTop: '200', marginBottom: '100' }, landscape: false, binding: 0,
  });
  assert.equal(tall.ok, false);
  const edited = buildPageDefFromForm(a4, shown, {
    ...shown, margins: { ...shown.margins, marginLeft: '25' }, landscape: false, binding: 0,
  });
  assert.equal(edited.ok && edited.pageDef.marginLeft, Math.round(25 * 7200 / 25.4));
  assert.equal(edited.ok && edited.pageDef.marginRight, a4.marginRight);
});

// ── 스타일 편집: 하위 대화상자 변경분 합치기 ─────────────────────────────────

test('style edit: a second 글자 모양 pass keeps the first pass', () => {
  let pending = '{}';
  pending = mergeShapeModsJson(pending, { bold: true });
  pending = mergeShapeModsJson(pending, { textColor: '#ff0000' });
  assert.deepEqual(JSON.parse(pending), { bold: true, textColor: '#ff0000' });

  pending = mergeShapeModsJson(pending, { bold: false });
  assert.deepEqual(JSON.parse(pending), { bold: false, textColor: '#ff0000' }, 'later values win');

  pending = mergeShapeModsJson(mergeShapeModsJson('{}', { fontIds: [1, 2, 3, 4, 5, 6, 7] }), { fontId: 9 });
  assert.deepEqual(JSON.parse(pending), { fontId: 9 }, 'an all-language font replaces per-language fonts');
  pending = mergeShapeModsJson(pending, { fontIds: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(JSON.parse(pending), { fontIds: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(JSON.parse(mergeShapeModsJson('not json', { italic: true })), { italic: true });
});
