import test from 'node:test';
import assert from 'node:assert/strict';
import { commandServices, startEditEngine } from './support/edit-history-env.ts';

// 한컴 단 모양 · 한글 문서모델 붙여넣기 · 표만 고른 복사/잘라내기를 실제 HeemangEngine 으로 확인한다.

const env = await startEditEngine();
test.after(() => env.close());
const { pageCommands } = await env.load('/src/command/commands/page.ts');

const reopened = (wasm: any) => [
  env.openDocument(wasm.exportHwp(), 'saved.hwp'),
  env.openDocument(wasm.exportHwpx(), 'saved.hwpx'),
];

test('단 왼쪽·오른쪽은 한쪽 단이 다른 단의 절반이고 저장 뒤에도 남는다', () => {
  for (const [id, narrowFirst] of [['page:col-left', true], ['page:col-right', false]] as const) {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '본문');
    pageCommands.find((c: any) => c.id === id).execute(commandServices(env.createHost(wasm), {}));
    const def = wasm.getColumnDef(0);
    assert.equal(def.sameWidth, false);
    const [a, b] = def.widths;
    assert.ok(Math.abs((narrowFirst ? b : a) - 2 * (narrowFirst ? a : b)) <= 2, `${id}: ${a}:${b}`);
    for (const doc of reopened(wasm)) assert.deepEqual(doc.getColumnDef(0), def);
  }
});

test('한글 문서모델은 글자 모양과 둘째 문단부터의 문단 모양을 옮긴다', () => {
  const model = JSON.stringify({
    ro: {
      hp: 'p0',
      p0: { np: 'p1', pp: 'a', ru: [{ cp: 'b', ch: [{ t: '굵게' }] }, { cp: 'n', ch: [{ t: '보통' }, { cc: 9 }, { t: '끝' }] }] },
      p1: { pp: 'c', ru: [{ cp: 'n', ch: [{ t: '가운데' }] }] },
    },
    cp: {
      b: { id: 0, he: 1400, bo: true, tc: 255, f1: '함초롬바탕' },
      n: { id: 1, he: 1000, tc: 0 },
    },
    pp: { a: { id: 0, ah: 0 }, c: { id: 1, ah: 3, ml: 2000, lt: 0, lv: 180 } },
  });
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '앞뒤');
  const result = JSON.parse(wasm.pasteHwpJson(0, 0, 1, model));
  assert.equal(result.ok, true);
  assert.equal(wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0)), '앞굵게보통\t끝');
  assert.equal(wasm.getTextRange(0, 1, 0, wasm.getParagraphLength(0, 1)), '가운데뒤');
  const bold = wasm.getCharPropertiesAt(0, 0, 2);
  assert.equal(bold.bold, true);
  assert.equal(bold.fontSize, 1400);
  assert.equal(bold.textColor, '#ff0000');
  assert.equal(wasm.getCharPropertiesAt(0, 0, 4).bold, false);
  const second = wasm.getParaPropertiesAt(0, 1);
  assert.equal(second.alignment, 'center');
  assert.equal(second.marginLeft, 13.3, '모델 여백 2000 은 1000 HU(0.1px 반올림)다');
  assert.equal(second.lineSpacing, 180);
  assert.throws(() => wasm.pasteHwpJson(0, 0, 0, JSON.stringify({ ro: { hp: 'p', p: { ru: [{ ch: [{ cc: 11, co: 't' }] }] } } })));
});

test('표만 고른 복사는 셀 글자와 HTML 을 내주고, 잘라낸 표는 다시 붙여넣을 수 있다', () => {
  const wasm = env.newDocument();
  const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 1, colCount: 2 });
  wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, '가');
  wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, '나');
  wasm.copyControl(0, table.paraIdx, table.controlIdx, '');
  assert.equal(wasm.getClipboardText(), '가\t나');
  assert.match(wasm.exportControlHtml(0, table.paraIdx, table.controlIdx, ''), /<table>.*가.*나/);
  wasm.deleteTableControl(0, table.paraIdx, table.controlIdx);
  assert.throws(() => wasm.getTableDimensions(0, table.paraIdx, table.controlIdx), '잘라낸 표는 문서에서 빠진다');
  JSON.parse(wasm.pasteControl(0, table.paraIdx, 0));
  assert.equal(wasm.getTextInCell(0, table.paraIdx, table.controlIdx, 1, 0, 0, 1), '나');
  for (const doc of reopened(wasm)) assert.equal(doc.getTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 1), '가');
});
