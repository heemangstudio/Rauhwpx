import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('?url')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('?url')) return { format: 'module', source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
await import('./support/ts-transform-hooks.mjs');
initSync({ module: readFileSync(new URL('../vendor/hm-wasm/hm_wasm_bg.wasm', import.meta.url)) });
const { HmCore } = await import('../src/core/hm/core.ts');
const { api } = await import('../src/core/hm/api.ts');
await import('../src/core/hm/extensions.ts');
const blank = readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url));
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));

function open(t: test.TestContext) {
  const engine = new Engine();
  const doc = engine.open(blank);
  const core = new HmCore({ documentInstance: 1, hmDoc: () => doc, hasLoadedDocument: () => true,
    applyReceipt() {}, refreshLayout() {}, getSectionCount: () => 1 } as unknown as HeemangAdapter);
  t.after(() => { doc.free(); engine.free(); });
  return { core, doc, engine };
}

test('native table edits preserve cell text, nested targets, geometry and undo history', t => {
  const { core, doc } = open(t);
  const created = api.createTable(core, 0, 0, 0, 2, 2);
  const c = created.controlIdx;
  assert.deepEqual(api.getTableDimensions(core, 0, 0, c), { rowCount: 2, colCount: 2, cellCount: 4 });
  const path = JSON.stringify([{ controlIndex: c, cellIndex: 0, cellParaIndex: 0 }]);
  api.insertTextInCellByPath(core, 0, 0, path, 0, '셀 입력', true);
  assert.equal(core.paragraph({ section: 0, steps: [{ para: 0, control: c, index: 0 }] }, 0).text, '셀 입력');
  assert.equal(api.getTableCellBboxes(core, 0, 0, c).length, 4);
  assert.equal(api.insertTableRow(core, 0, 0, c, 0, true).rowCount, 3);
  assert.equal(api.deleteTableRow(core, 0, 0, c, 1).rowCount, 2);
  assert.equal(api.mergeTableCells(core, 0, 0, c, 0, 0, 0, 1).cellCount, 3);
  assert.equal(api.getCellInfo(core, 0, 0, c, 0).colSpan, 2);
  core.mutate(d => d.undo());
  assert.equal(api.getTableDimensions(core, 0, 0, c).cellCount, 4);
  core.mutate(d => d.redo());
  assert.equal(api.getCellInfoByPath(core, 0, 0, path).colSpan, 2);
  api.splitTableCell(core, 0, 0, c, 0, 0);
  assert.equal(api.getTableDimensions(core, 0, 0, c).cellCount, 4);
  api.insertTableColumnByPath(core, 0, 0, path, 0, true);
  api.deleteTableColumnByPath(core, 0, 0, path, 1);
  assert.equal(api.getTableDimensionsByPath(core, 0, 0, path).colCount, 2);
  for (const format of ['hwp5', 'hwpx']) {
    const again = new Engine();
    const reopened = again.open(doc.serializeAs(format, false));
    try {
      const rows = JSON.parse(reopened.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0, steps: [{ para: 0, control: c, index: 0 }] } })));
      assert.equal(rows[0].text, '셀 입력');
    } finally { reopened.free(); again.free(); }
  }
});

test('table properties apply together and reject an unsupported edit atomically', t => {
  const { core } = open(t);
  const c = api.createTable(core, 0, 0, 0, 2, 2).controlIdx;
  const before = core.state().undo;
  api.setTableProperties(core, 0, 0, c, { repeatHeader: true, treatAsChar: false, horzOffset: 1200 });
  assert.equal(core.state().undo, before + 1);
  assert.equal(api.getTableProperties(core, 0, 0, c).horzOffset, 1200);
  api.setCellProperties(core, 0, 0, c, 0, { verticalAlign: 1, paddingLeft: 280, applyInnerMargin: true });
  assert.equal(api.getCellProperties(core, 0, 0, c, 0).paddingLeft, 280);
  const state = core.state();
  assert.throws(() => api.setCellProperties(core, 0, 0, c, 0, { paddingLeft: 500, invalidProperty: 'unsupported' } as never), /ENGINE_NOT_SUPPORTED|지원하지 않는/);
  assert.deepEqual(core.state(), state);
  assert.equal(api.getCellProperties(core, 0, 0, c, 0).paddingLeft, 280);
});

test('table formulas keep the dialog result contract and report a bad formula without writing', t => {
  const { core } = open(t);
  const c = api.createTable(core, 0, 0, 0, 2, 2).controlIdx;
  api.insertTextInCell(core, 0, 0, c, 0, 0, 0, '1234');
  api.insertTextInCell(core, 0, 0, c, 1, 0, 0, '5678');
  assert.deepEqual(JSON.parse(api.evaluateTableFormula(core, 0, 0, c, 1, 0, '=A1*2', false)), { ok: true, result: 2468 });
  const state = core.state();
  const bad = JSON.parse(api.evaluateTableFormula(core, 0, 0, c, 1, 0, '=A1+', true));
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');
  assert.deepEqual(core.state(), state);
});

test('picture insertion, selection geometry, move and resize survive save and undo', t => {
  const { core, doc } = open(t);
  const result = api.insertPicture(core, 0, 0, 0, '[]', png, 7200, 5400, 96, 72, 'png', '그림', 7000, 8000, 'floating');
  const c = result.controlIdx;
  assert.deepEqual(api.getControlImageData(core, 0, 0, c, '[]'), png);
  assert.equal(api.getControlImageMime(core, 0, 0, c, '[]'), 'image/png');
  const before = api.getObjectBBox(core, 'image', 0, 0, c);
  assert.ok(before.width > 0);
  assert.equal(api.getPageControlLayout(core, before.pageIndex).controls.find(o => o.controlIdx === c)?.type, 'image');
  api.setPictureProperties(core, 0, 0, c, { width: 9000, height: 6000, horzOffset: 8500, vertOffset: 8750 });
  const changed = api.getPictureProperties(core, 0, 0, c);
  assert.equal(changed.width, 9000);
  assert.equal(changed.horzOffset, 8500);
  core.mutate(d => d.undo());
  assert.equal(api.getPictureProperties(core, 0, 0, c).width, 7200);
  core.mutate(d => d.redo());
  assert.equal(api.getPictureProperties(core, 0, 0, c).width, 9000);
  for (const format of ['hwp5', 'hwpx']) {
    const engine = new Engine();
    const reopened = engine.open(doc.serializeAs(format, false));
    try {
      const at = { section: 0, para: 0, control: c };
      const props = JSON.parse(reopened.query(JSON.stringify({ kind: 'objectProperties', object: at })));
      const picture = JSON.parse(reopened.query(JSON.stringify({ kind: 'pictureData', object: at })));
      assert.equal(props.width, 9000);
      assert.deepEqual(new Uint8Array(picture.bytes), png);
    } finally { reopened.free(); engine.free(); }
  }
  api.deletePictureControl(core, 0, 0, c);
  assert.equal(api.getPageControlLayout(core, 0).controls.filter(o => o.type === 'image').length, 0);
});

test('a picture selected inside a cell edits its own control and preserves table addressing', t => {
  const { core } = open(t);
  const table = api.createTable(core, 0, 0, 0, 2, 2);
  const path = [{ controlIndex: table.controlIdx, cellIndex: 1, cellParaIndex: 0 }];
  const inserted = api.insertPicture(core, 0, 0, 0, JSON.stringify(path), png, 7200, 5400, 96, 72, 'png', '셀 그림');
  const selected = api.getPageControlLayout(core, 0).controls.find(c => c.type === 'image')!;
  api.setCellPicturePropertiesByPath(core, selected.secIdx!, selected.paraIdx!, selected.cellPath!, selected.controlIdx!, { width: 9000 });
  assert.equal(api.getCellPicturePropertiesByPath(core, 0, 0, path, inserted.controlIdx).width, 9000);
  assert.equal(api.getTableDimensions(core, 0, 0, table.controlIdx).cellCount, 4);
  core.mutate(doc => doc.undo());
  assert.equal(api.getCellPicturePropertiesByPath(core, 0, 0, path, inserted.controlIdx).width, 7200);
});

test('a hyperlink inside a table cell is found by its cell target and position', t => {
  const { core } = open(t);
  const table = api.createTable(core, 0, 0, 0, 2, 2);
  const path = [{ controlIndex: table.controlIdx, cellIndex: 1, cellParaIndex: 0 }];
  api.insertTextInCellByPath(core, 0, 0, JSON.stringify(path), 0, '셀 링크', true);
  const target = { section: 0, para: 0, cellPath: [[table.controlIdx, 1, 0]] as [number, number, number][] };
  const id = api.insertHyperlink(core, target, 2, 4, 'https://example.com');
  assert.deepEqual(api.getHyperlinkContext(core, target).links.map(l => l.text), ['링크']);
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 3, parentParaIndex: 0, cellPath: path };
  assert.equal(api.getFieldInfoAt(core, pos).fieldId, id);
  assert.equal(api.updateHyperlink(core, target, id, 'https://example.org'), true);
});

function reopenCore(t: test.TestContext, doc: { serializeAs(format: string, x: boolean): Uint8Array }, format: string) {
  const engine = new Engine();
  const reopened = engine.open(doc.serializeAs(format, false));
  const core = new HmCore({ documentInstance: 2, hmDoc: () => reopened, hasLoadedDocument: () => true,
    applyReceipt() {}, refreshLayout() {}, getSectionCount: () => 1 } as unknown as HeemangAdapter);
  t.after(() => { reopened.free(); engine.free(); });
  return core;
}

test('a turned picture keeps its drawing in place, mirrors, and a resize journal swaps it back exactly', t => {
  const { core, doc } = open(t);
  const c = api.insertPicture(core, 0, 0, 0, '[]', png, 6000, 3000, 80, 40, 'png', '그림', 9000, 9000, 'floating').controlIdx;
  const box = () => api.getPageControlLayout(core, 0).controls.find(o => o.type === 'image' && o.controlIdx === c)!;
  const before = box();
  const journal = api.capturePictureTransform(core, { sec: 0, ppi: 0, ci: c, type: 'image' });
  api.setPictureProperties(core, 0, 0, c, { rotationAngle: 90, horzFlip: true });
  const turned = api.getPictureProperties(core, 0, 0, c);
  // 틀은 돌린 그림을 감싸고, 선택 상자는 돌기 전 그림 크기 그대로 같은 가운데에 남는다.
  assert.deepEqual([turned.width, turned.height, turned.rotationAngle, turned.horzFlip], [3000, 6000, 90, true]);
  const after = box();
  assert.ok(Math.abs(after.w - before.w) < 0.5 && Math.abs(after.h - before.h) < 0.5);
  assert.ok(Math.abs(after.x + after.w / 2 - (before.x + before.w / 2)) < 0.5);
  // 돌린 그림의 틀 크기를 바꾸면 그림이 그 틀을 채운다.
  api.setPictureProperties(core, 0, 0, c, { width: 4000, height: 8000 });
  assert.deepEqual([api.getPictureProperties(core, 0, 0, c).width, api.getPictureProperties(core, 0, 0, c).height], [4000, 8000]);
  for (const format of ['hwp5', 'hwpx']) {
    const props = api.getPictureProperties(reopenCore(t, doc, format), 0, 0, c);
    assert.deepEqual([props.width, props.height, props.rotationAngle, props.horzFlip], [4000, 8000, 90, true], format);
  }
  api.swapPictureTransform(core, journal);
  const back = api.getPictureProperties(core, 0, 0, c);
  assert.deepEqual([back.width, back.height, back.rotationAngle, back.horzFlip], [6000, 3000, 0, false]);
  assert.deepEqual(box(), before);
  api.discardPictureTransform(core, journal);
  assert.throws(() => api.swapPictureTransform(core, journal));
});

test('cell and zone borders and fills apply from dialog payloads and carry to neighbors through save', t => {
  const { core, doc } = open(t);
  const c = api.createTable(core, 0, 0, 0, 3, 3).controlIdx;
  // 대화상자는 바꾸지 않은 값까지 모두 보낸다. 그대로면 문서를 건드리지 않는다.
  const undo = core.state().undo;
  api.setCellProperties(core, 0, 0, c, 4, { ...api.getCellProperties(core, 0, 0, c, 4) });
  api.setTableProperties(core, 0, 0, c, { ...api.getTableProperties(core, 0, 0, c) });
  assert.equal(core.state().undo, undo);
  const thick = { type: 1, width: 7, color: '#ff0000' };
  api.setCellProperties(core, 0, 0, c, 4, { borderLeft: thick, borderTop: { type: 0, width: 0, color: '#000000' },
    fillType: 'solid', fillColor: '#00ff00', patternColor: '#000000', patternType: 0, textDirection: 1 });
  api.setCellZoneProperties(core, 0, 0, c, { startRow: 2, startCol: 0, endRow: 2, endCol: 2 },
    { borderLeft: thick, borderRight: thick, borderTop: thick, borderBottom: thick, fillType: 'solid', fillColor: '#0000ff' });
  api.setTableProperties(core, 0, 0, c, { restrictInPage: true, allowOverlap: true });
  for (const [label, target] of [['live', core], ['hwp5', reopenCore(t, doc, 'hwp5')], ['hwpx', reopenCore(t, doc, 'hwpx')]] as const) {
    const cell = api.getCellProperties(target, 0, 0, c, 4);
    assert.deepEqual(cell.borderLeft, thick, label);
    assert.equal(cell.borderTop?.type, 0, label);
    assert.deepEqual([cell.fillType, cell.fillColor, cell.textDirection], ['solid', '#00ff00', 1], label);
    assert.deepEqual(api.getCellProperties(target, 0, 0, c, 3).borderRight, thick, label);
    assert.equal(api.getCellProperties(target, 0, 0, c, 1).borderBottom?.type, 0, label);
    const table = api.getTableProperties(target, 0, 0, c);
    assert.deepEqual([table.restrictInPage, table.allowOverlap], [true, true], label);
  }
});

test('a cell block splits cell by cell, F11 finds the nearest objects and a click in an empty cell enters it', t => {
  const { core } = open(t);
  const c = api.createTableEx(core, { sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 2, colCount: 2, treatAsChar: true }).controlIdx;
  api.splitTableCellsInRange(core, 0, 0, c, 0, 0, 1, 1, 1, 2, false);
  assert.deepEqual(api.getTableDimensions(core, 0, 0, c), { rowCount: 2, colCount: 4, cellCount: 8 });
  // 표 뒤(논리 오프셋 1)에 그림을 넣는다.
  const pic = api.insertPicture(core, 0, 0, 1, '[]', png, 3000, 3000, 40, 40, 'png', '그림', 1000, 1000, 'floating').controlIdx;
  const back = api.findNearestControlBackward(core, 0, 0, 1000);
  assert.deepEqual([back.type, back.ci], ['picture', pic]);
  const forward = api.findNearestControlForward(core, 0, 0, -1);
  assert.deepEqual([forward.type, forward.ci], ['table', c]);
  const cell = api.getTableCellBboxes(core, 0, 0, c)[5];
  const hit = api.hitTest(core, cell.pageIndex, cell.x + cell.w * 0.8, cell.y + cell.h / 2);
  assert.deepEqual([hit.parentParaIndex, hit.controlIndex, hit.cellIndex], [0, c, 5]);
});

test('zone borders, table captions and page breaks read back what the agent tools wrote', t => {
  const { core } = open(t);
  const c = api.createTable(core, 0, 0, 0, 2, 2).controlIdx;
  const red = { type: 1, width: 3, color: '#ff0000' };
  api.setCellZoneProperties(core, 0, 0, c, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    { borderBottom: red, fillType: 'solid', fillColor: '#00ff00' } as any);
  const zoned = api.getCellProperties(core, 0, 0, c, 0) as any;
  assert.deepEqual([zoned.borderBottom, zoned.fillType, zoned.fillColor], [red, 'solid', '#00ff00']);
  // 영역 밖 셀은 자기 테두리·배경을 그대로 알린다.
  assert.equal((api.getCellProperties(core, 0, 0, c, 2) as any).fillType, 'none');
  assert.equal(api.getTableProperties(core, 0, 0, c).hasCaption, false);
  api.setTableCaptionText(core, 0, 0, c, '설명', true);
  const props = api.getTableProperties(core, 0, 0, c);
  assert.deepEqual([props.hasCaption, props.captionDirection], [true, 3]);
  api.applyParaFormat(core, 0, 0, JSON.stringify({ pageBreakBefore: true }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).pageBreakBefore, true);
  api.applyParaFormat(core, 0, 0, JSON.stringify({ pageBreakBefore: false }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).pageBreakBefore, false);
});
