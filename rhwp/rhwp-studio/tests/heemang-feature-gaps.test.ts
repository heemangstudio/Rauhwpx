import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

for (const fixture of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
  test(`글자 테두리와 개요 번호를 적용하고 두 형식으로 저장한다: ${fixture}`, async t => {
    const { wasm, adapter } = await openHeemangAgent(t, fixture);
    wasm.insertText(0, 0, 0, '테두리');
    const left = { type: 1, width: 3, color: '#ff0000' };
    wasm.applyCharFormat(0, 0, 0, 3, JSON.stringify({ borderLeft: left, fillType: 'solid', fillColor: '#ffff00' }));
    wasm.applyParaFormat(0, 0, JSON.stringify({ headType: 'Outline', paraLevel: 2, numberingId: 0 }));
    const check = () => {
      assert.deepEqual(wasm.getCharPropertiesAt(0, 0, 1).borderLeft, left);
      assert.equal(wasm.getCharPropertiesAt(0, 0, 1).fillColor, '#ffff00');
      assert.equal(wasm.getParaPropertiesAt(0, 0).headType, 'Outline');
    };
    check();
    const outputs = [[wasm.exportHwp(), 'saved.hwp'], [wasm.exportHwpx(), 'saved.hwpx']] as const;
    for (const [bytes, name] of outputs) { wasm.loadDocument(bytes, name); adapter.refreshLayout(); check(); }
  });
}

test('그림 캡션 생성과 속성 적용은 한 번에 되돌리고 캡션을 지울 수 있다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const picture = wasm.insertPicture(0, 0, 0, '', new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/bS5kAAAAASUVORK5CYII=', 'base64')), 3000, 4000, 1, 1, 'png');
  const { paraIdx, controlIdx } = picture;
  const before = adapter.state().undo;
  wasm.setPictureProperties(0, paraIdx, controlIdx, { hasCaption: true, captionDirection: 'Left', captionVertAlign: 'Bottom', captionWidth: 2000, captionSpacing: 300, effect: 'Pattern8x8' });
  assert.equal(adapter.state().undo, before + 1);
  const value = wasm.getPictureProperties(0, paraIdx, controlIdx);
  assert.deepEqual([value.hasCaption, value.captionDirection, value.captionVertAlign, value.effect], [true, 'Left', 'Bottom', 'Pattern8x8']);
  wasm.setPictureProperties(0, paraIdx, controlIdx, { hasCaption: false });
  assert.equal(wasm.getPictureProperties(0, paraIdx, controlIdx).hasCaption, false);
});

test('파일 이름 마당과 총 쪽수 필드를 만들고 한 번에 되돌린다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const before = adapter.state().undo;
  wasm.applyHfTemplate(0, true, 0, 9);
  assert.equal(adapter.state().undo, before + 1);
  const value = JSON.parse(wasm.getHeaderFooter(0, true, 0));
  assert.match(value.text, /blank_hwpx.hwpx/);
  const caret = JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, 0)).charCount;
  wasm.insertFieldInHf(0, true, 0, 0, caret, 2);
  for (const [bytes, name] of [[wasm.exportHwp(), 'saved.hwp'], [wasm.exportHwpx(), 'saved.hwpx']] as const) {
    wasm.loadDocument(bytes, name); adapter.refreshLayout();
    assert.match(JSON.parse(wasm.getHeaderFooter(0, true, 0)).text, /blank_hwpx.hwpx/);
  }
});

test('다른 문서에서 복사한 표와 한글 문서모델의 표·도형을 보존한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const result = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 1, colCount: 1 });
  wasm.insertTextInCell(0, result.paraIdx, result.controlIdx, 0, 0, 0, '옮긴 표');
  wasm.copyControl(0, result.paraIdx, result.controlIdx, '');
  const blank = await import('./heemang-agent-env.ts').then(m => m.rhwpFile(FIXTURES.blankHwpx));
  wasm.loadDocument(blank, 'target.hwpx'); adapter.refreshLayout();
  wasm.pasteInternal(0, 0, 0);
  assert.equal(wasm.getTextInCell(0, 0, result.controlIdx, 0, 0, 0, 4), '옮긴 표');
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/bS5kAAAAASUVORK5CYII=';
  const model = {
    bidt: { 'image.png': image },
    ro: { hp: 'body', body: { ru: [{ ch: [{ cc: 11, ci: 1952607264, co: 'table' }, { cc: 11, ci: 1735618336, co: 'rectangle' }, { cc: 11, ci: 1735618336, co: 'picture' }] }] } },
    cs: { table: { rc: 1, cco: 2, swi: 12000, she: 3000, pta: true, tr: [[{ so: 'a' }, { so: 'b' }]] }, rectangle: { swi: 3000, she: 3000, pta: true, rc: { ci: 611476835, rra: 20, fb: { wb: { fc: 255 } } } }, picture: { swi: 3000, she: 3000, pta: true, rc: { img: { bi: 'image.png' } } } },
    sl: { a: { hp: 'pa', tc: { ar: 0, ac: 0, sr: 1, sc: 1 } }, b: { hp: 'pb', tc: { ar: 0, ac: 1, sr: 1, sc: 1 } }, pa: { ru: [{ ch: [{ t: '첫 칸' }] }] }, pb: { ru: [{ ch: [{ t: '둘째 칸' }] }] } },
  };
  wasm.loadDocument(blank, 'model.hwpx'); adapter.refreshLayout();
  wasm.pasteHwpJson(0, 0, 0, JSON.stringify(model));
  const controls = adapter.paragraphs(0, [], 0, 1)[0].controls;
  const table = controls.find(c => c.kind === 'table')!;
  assert.equal(wasm.getTextInCell(0, 0, table.index, 1, 0, 0, 4), '둘째 칸');
  assert.equal(controls.filter(c => c.kind === 'object').length, 2);
  assert.deepEqual(wasm.getControlImageData(0, 0, controls.filter(c => c.kind === 'object').at(-1)!.index, ''), new Uint8Array(Buffer.from(image, 'base64')));
  const outputs = [[wasm.exportHwp(), 'model.hwp'], [wasm.exportHwpx(), 'model.hwpx']] as const;
  for (const [bytes, name] of outputs) { wasm.loadDocument(bytes, name); adapter.refreshLayout(); assert.equal(wasm.getTextInCell(0, 0, table.index, 0, 0, 0, 3), '첫 칸'); }
});

test('주석 안 수식의 속성을 바꾸고 두 저장 형식으로 다시 연다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const note = wasm.insertFootnote(0, 0, 0);
  const at = { section: 0, steps: [{ para: note.paraIdx, control: note.controlIdx, index: 0 }], para: 0, offset: 8 };
  // 코어를 거쳐야 문단 캐시가 새 수식을 본다.
  (wasm as any).core.transact([{ op: 'insertEquation', at, script: 'x+1', size: 1000 }]);
  const paragraphs = JSON.parse(adapter.hmDoc().query(JSON.stringify({ kind: 'paragraphs', list: { section: 0, steps: at.steps }, count: 1 })));
  const equation = paragraphs[0].controls.find((c: any) => c.kind === 'equation');
  const ref = { kind: 'footnote' as const, sectionIdx: 0, paraIdx: note.paraIdx, controlIdx: note.controlIdx, noteParaIdx: 0, innerControlIdx: equation.index };
  wasm.setNoteEquationProperties(ref, { script: 'y+2', fontSize: 1600, color: 255 });
  assert.equal(wasm.getNoteEquationProperties(ref).script, 'y+2');
  for (const [bytes, name] of [[wasm.exportHwp(), 'note.hwp'], [wasm.exportHwpx(), 'note.hwpx']] as const) { wasm.loadDocument(bytes, name); adapter.refreshLayout(); assert.equal(wasm.getNoteEquationProperties(ref).fontSize, 1600); }
});

test('표시되지 않는 짝수 쪽 머리말도 커서·선택·클릭 좌표를 갖는다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  wasm.createHeaderFooter(0, true, 1);
  wasm.insertTextInHeaderFooter(0, true, 1, 0, 0, '짝수 머리말');
  const caret = wasm.getCursorRectInHeaderFooter(0, true, 1, 0, 0, 0);
  assert.ok(caret.height > 0);
  const selected = wasm.getSelectionRectsInHeaderFooter(0, true, 1, 0, 0, 0, 0, 2);
  assert.ok(selected.some(rect => rect.width > 0));
  const hit = wasm.hitTestInHeaderFooterTarget(0, 0, true, 1, caret.x + 1, caret.y + 1);
  assert.equal(hit.hit, true);
});


test('표 캡션의 위치·세로 정렬을 적용하고 지운다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const table = wasm.createTable(0, 0, 0, 1, 1);
  const before = adapter.state().undo;
  wasm.setTableProperties(0, table.paraIdx, table.controlIdx, { hasCaption: true, captionDirection: 0, captionVertAlign: 2, captionWidth: 2000, captionSpacing: 300 });
  assert.equal(adapter.state().undo, before + 1);
  const outputs = [[wasm.exportHwp(), 'caption.hwp'], [wasm.exportHwpx(), 'caption.hwpx']] as const;
  for (const [bytes, name] of outputs) {
    wasm.loadDocument(bytes, name); adapter.refreshLayout();
    const p = wasm.getTableProperties(0, table.paraIdx, table.controlIdx);
    assert.deepEqual([p.hasCaption, p.captionDirection, p.captionVertAlign], [true, 0, 2]);
  }
  wasm.setTableProperties(0, table.paraIdx, table.controlIdx, { hasCaption: false });
  assert.equal(wasm.getTableProperties(0, table.paraIdx, table.controlIdx).hasCaption, false);
});

test('개요와 일반 문단의 세션 번호 다시 시작은 되돌릴 수 있고 파일에는 남지 않는다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  wasm.insertText(0, 0, 0, '첫째');
  wasm.splitParagraph(0, 0, 2);
  wasm.insertText(0, 1, 0, '둘째');
  const id = wasm.ensureDefaultNumbering();
  for (const headType of ['Outline', 'None', 'Number']) {
    wasm.applyParaFormat(0, 1, JSON.stringify({ headType, numberingId: id }));
    const before = adapter.state().undo;
    wasm.setNumberingRestart(0, 1, 2, 7);
    assert.equal(adapter.state().undo, before + 1);
    assert.equal(wasm.getParaPropertiesAt(0, 1).numberingStartNum, 7);
    adapter.hmDoc().undo();
    wasm.refreshLayout();
    assert.equal(wasm.getParaPropertiesAt(0, 1).numberingRestartMode, 0);
    adapter.hmDoc().redo();
    wasm.refreshLayout();
    if (headType === 'None') wasm.applyParaFormat(0, 1, JSON.stringify({ headType: 'Number', numberingId: id }));
    assert.equal(wasm.getParaPropertiesAt(0, 1).numberingStartNum, 7);
    const original = wasm.exportHwpx();
    for (const [bytes, name] of [[wasm.exportHwp(), 'saved.hwp'], [original, 'saved.hwpx']] as const) {
      wasm.loadDocument(bytes, name);
      assert.equal(wasm.getParaPropertiesAt(0, 1).numberingRestartMode, 0);
    }
  }
});

test('파일 바이트로 연 문서만 파일에서 열린 문서로 알린다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  assert.equal(wasm.openedFromFile, true);
  const bytes = wasm.exportHwpx();
  wasm.createNewDocument(wasm.prepareNewDocument(bytes));
  assert.equal(wasm.openedFromFile, false);
  wasm.replaceContentFromBytes(bytes);
  assert.equal(wasm.openedFromFile, false);
  wasm.adoptPreparedDocument(wasm.prepareDocument(bytes, 'opened.hwpx'));
  assert.equal(wasm.openedFromFile, true);
  wasm.releaseDocument();
  assert.equal(wasm.openedFromFile, false);
  wasm.loadDocument(bytes, 'loaded.hwpx');
  assert.equal(wasm.openedFromFile, true);
});
