import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

for (const fixture of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
  test(`표 전치 복사·붙이기와 문단 복원은 원본 형식에 관계없이 저장된다: ${fixture}`, async t => {
    const { wasm, adapter } = await openHeemangAgent(t, fixture);
    const table = wasm.createTable(0, 0, 0, 2, 3);
    for (let i = 0; i < 6; i++) wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, i, 0, 0, `셀${i}😀`);
    const capture = wasm.captureParagraph(0, table.paraIdx)!;
    assert.equal(wasm.hasTableTransposeClipboard(), false);
    assert.deepEqual(wasm.copyTableCellsTransposed(0, table.paraIdx, table.controlIdx, 0, 0, 1, 2), {
      ok: true, sourceRows: 2, sourceCols: 3, targetRows: 3, targetCols: 2,
    });
    assert.equal(wasm.hasTableTransposeClipboard(), true);
    wasm.transposeTableCellsInPlace(0, table.paraIdx, table.controlIdx);
    assert.deepEqual(wasm.getTableDimensions(0, table.paraIdx, table.controlIdx), { rowCount: 3, colCount: 2, cellCount: 6 });
    const text = (i: number) => wasm.core.paragraph({ section: 0, steps: [{ para: table.paraIdx, control: table.controlIdx, index: i }] }, 0).text;
    assert.equal(text(1), '셀3😀');
    const before = adapter.hmDoc().serialize(false);
    assert.throws(() => wasm.pasteTableCellsTransposed(0, table.paraIdx, table.controlIdx, 2, 1));
    assert.deepEqual(adapter.hmDoc().serialize(false), before);
    for (const format of ['hwp5', 'hwpx'] as const) {
      const reopened = adapter.hmEngine().open(adapter.hmDoc().serializeAs(format, false));
      try {
        const cells = JSON.parse(reopened.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0, steps: [{ para: table.paraIdx, control: table.controlIdx, index: 1 }] } })));
        assert.equal(cells[0].text, '셀3😀');
      } finally { reopened.free(); }
    }
    wasm.restoreCapturedParagraph(capture, 0, table.paraIdx);
    assert.equal(text(1), '셀1😀');
    assert.equal(wasm.getTableDimensions(0, table.paraIdx, table.controlIdx).rowCount, 2);
    for (const format of ['hwp5', 'hwpx'] as const) {
      const reopened = adapter.hmEngine().open(adapter.hmDoc().serializeAs(format, false));
      try { assert.equal(JSON.parse(reopened.query(JSON.stringify({ kind: 'table', table: { section: 0, para: table.paraIdx, control: table.controlIdx } }))).rows, 2); }
      finally { reopened.free(); }
    }
    wasm.discardParagraphCapture(capture);
    assert.throws(() => wasm.restoreCapturedParagraph(capture, 0, table.paraIdx));
    const pasted = wasm.pasteTableCellsTransposedAsTable(0, table.paraIdx, 0);
    assert.equal(wasm.getTableDimensions(0, pasted.paraIdx!, pasted.controlIdx!).rowCount, 3);
  });
}

test('각주·미주와 머리말·꼬리말의 모양 ID를 이모지 범위에서 복원하고 저장한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const targets: Array<{ char: () => number; para: () => number; change: () => void; restore: (char: number, para: number) => void }> = [];
  for (const header of [true, false]) {
    wasm.createHeaderFooter(0, header, 0);
    wasm.insertTextInHeaderFooter(0, header, 0, 0, 0, 'A😀B');
    targets.push({
      char: () => wasm.getCharPropertiesInHf(0, header, 0, 0, 1).charShapeId!,
      para: () => wasm.getParaPropertiesInHf(0, header, 0, 0).paraShapeId!,
      change: () => { wasm.applyCharFormatInHf(0, header, 0, 0, 1, 2, '{"bold":true}'); wasm.applyParaFormatInHf(0, header, 0, 0, '{"alignment":"center"}'); },
      restore: (char, para) => { wasm.setCharShapeIdInHf(0, header, 0, 0, 1, 2, char); wasm.setParaShapeIdInHf(0, header, 0, 0, para); },
    });
  }
  for (const endnote of [false, true]) {
    const n = endnote ? wasm.insertEndnote(0, 0, 0) : wasm.insertFootnote(0, 0, 0);
    wasm.insertTextInFootnote(0, n.paraIdx, n.controlIdx, 0, 0, 'A😀B');
  }
  const notes = wasm.core.paragraph({ section: 0, steps: [] }, 0).controls.filter(c => c.kind === 'footnote' || c.kind === 'endnote');
  for (const n of notes) targets.push({
    char: () => wasm.getCharPropertiesInFootnote(0, 0, n.index, 0, 1).charShapeId!,
    para: () => wasm.getParaPropertiesInFootnote(0, 0, n.index, 0).paraShapeId!,
    change: () => { wasm.applyCharFormatInFootnote(0, 0, n.index, 0, 1, 2, '{"bold":true}'); wasm.applyParaFormatInFootnote(0, 0, n.index, 0, '{"alignment":"center"}'); },
    restore: (char, para) => { wasm.setCharShapeIdInFootnote(0, 0, n.index, 0, 1, 2, char); wasm.setParaShapeIdInFootnote(0, 0, n.index, 0, para); },
  });
  for (const target of targets) {
    const char = target.char(), para = target.para();
    target.change(); assert.notEqual(target.char(), char); assert.notEqual(target.para(), para);
    target.restore(char, para); assert.equal(target.char(), char); assert.equal(target.para(), para);
  }
  const before = adapter.hmDoc().serialize(false);
  assert.throws(() => wasm.setCharShapeIdInHf(0, true, 0, 0, 1, 2, 999999));
  assert.deepEqual(adapter.hmDoc().serialize(false), before);
  for (const format of ['hwp5', 'hwpx'] as const) {
    const reopened = adapter.hmEngine().open(adapter.hmDoc().serializeAs(format, false));
    try {
      const controls = JSON.parse(reopened.query('{"kind":"controls"}'));
      for (const c of controls.filter((c: { kind: string }) => ['header', 'footer', 'footnote', 'endnote'].includes(c.kind))) {
        const paragraphs = JSON.parse(reopened.query(JSON.stringify({ kind: 'paragraphs', list: c.lists[0] })));
        // 주석 글은 번호 앞(캐럿 0)에 넣었고, 새 주석의 [번호][공백] 의 공백이 뒤에 남는다(한컴 c01).
        assert.equal(paragraphs[0].text, ['footnote', 'endnote'].includes(c.kind) ? 'A😀B ' : 'A😀B');
        const context = JSON.parse(reopened.query(JSON.stringify({ kind: 'formatContext', at: { ...c.lists[0], para: 0, offset: paragraphs[0].offsets[1] } })));
        assert.equal(context.characters.bold, false); assert.notEqual(context.paragraphs.align, 'center');
      }
    } finally { reopened.free(); }
  }
});

test('연결선은 실제 개체 ID를 붙잡고 개체 이동 후 끝점을 갱신한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const a = wasm.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: 'rectangle', width: 3000, height: 2000, horzOffset: 1000, vertOffset: 2000 });
  const b = wasm.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: 'ellipse', width: 3000, height: 2000, horzOffset: 10000, vertOffset: 2000 });
  const aId = wasm.getShapeProperties(0, a.paraIdx, a.controlIdx).instanceId;
  const bId = wasm.getShapeProperties(0, b.paraIdx, b.controlIdx).instanceId;
  assert.ok(aId); assert.ok(bId); assert.notEqual(aId, bId);
  wasm.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: 'connector-stroke-arrow', width: 6000, height: 1000, horzOffset: 4000, vertOffset: 3000,
    startSubjectID: aId, startSubjectIndex: 1, endSubjectID: bId, endSubjectIndex: 3 });
  wasm.updateConnectorsInSection(0);
  wasm.setShapeProperties(0, b.paraIdx, b.controlIdx, { horzOffset: 12000, vertOffset: 3000 });
  const before = adapter.hmDoc().serialize(false);
  wasm.updateConnectorsInSection(0);
  assert.notDeepEqual(adapter.hmDoc().serialize(false), before);
  const after = adapter.hmDoc().serialize(false);
  wasm.updateConnectorsInSection(0);
  assert.deepEqual(adapter.hmDoc().serialize(false), after);
});

test('셀 블록 복사·붙이기는 서식과 표 조각을 보관하고 두 형식으로 저장한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const table = wasm.createTable(0, 0, 0, 2, 2);
  const path = JSON.stringify([{ controlIndex: table.controlIdx, cellIndex: 0, cellParaIndex: 0 }]);
  wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, '블록😀');
  wasm.applyCharFormatInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 3, '{"bold":true}');
  const copied = wasm.copyTableCellRange(0, table.paraIdx, path, 0, 0, 0, 0);
  assert.equal(copied.text, '블록😀'); assert.match(copied.html, /<table>/);
  assert.equal(wasm.hasInternalClipboard(), true); assert.equal(wasm.getClipboardText(), '블록😀');
  wasm.pasteTableCellRange(0, table.paraIdx, path, 1, 1);
  assert.equal(wasm.getCellCharPropertiesAt(0, table.paraIdx, table.controlIdx, 3, 0, 1).bold, true);
  for (const format of ['hwp5', 'hwpx'] as const) {
    const reopened = adapter.hmEngine().open(adapter.hmDoc().serializeAs(format, false));
    try {
      const list = { section: 0, steps: [{ para: table.paraIdx, control: table.controlIdx, index: 3 }] };
      const p = JSON.parse(reopened.query(JSON.stringify({ kind: 'paragraphs', list })))[0];
      assert.equal(p.text, '블록😀');
      assert.equal(JSON.parse(reopened.query(JSON.stringify({ kind: 'formatContext', at: { ...list, para: 0, offset: p.offsets[1] } }))).characters.bold, true);
    } finally { reopened.free(); }
  }
  const old = adapter.hmDoc().serialize(false);
  assert.throws(() => wasm.pasteTableCellRange(0, table.paraIdx, path, 2, 2));
  assert.deepEqual(adapter.hmDoc().serialize(false), old);
  const before = wasm.core.paragraph({ section: 0, steps: [] }, table.paraIdx).controls.filter(c => c.kind === 'table').length;
  wasm.pasteInternal(0, table.paraIdx, 0);
  assert.equal(wasm.core.paragraph({ section: 0, steps: [] }, table.paraIdx).controls.filter(c => c.kind === 'table').length, before + 1);
});
