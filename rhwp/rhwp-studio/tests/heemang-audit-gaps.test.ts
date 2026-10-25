import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

type Env = Awaited<ReturnType<typeof openHeemangAgent>>;

function reopenEach(env: Env, check: (format: string) => void): void {
  for (const [bytes, name] of [[env.wasm.exportHwp(), 'saved.hwp'], [env.wasm.exportHwpx(), 'saved.hwpx']] as const) {
    env.wasm.loadDocument(bytes, name);
    env.adapter.refreshLayout();
    check(name);
  }
}

const UNDERLINE = { underline: true, underlineColor: '#ff0000', underlineShape: 3 };
const FIXED = { lineSpacingType: 'Fixed', lineSpacing: 1500 };

for (const fixture of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
  test(`머리말 글자·문단 서식이 본문처럼 바뀌고 두 형식으로 다시 열린다: ${fixture}`, async t => {
    const env = await openHeemangAgent(t, fixture);
    const { wasm } = env;
    wasm.insertText(0, 0, 0, '본문');
    wasm.applyParaFormat(0, 0, JSON.stringify({ ...FIXED, marginRight: 10 }));
    wasm.createHeaderFooter(0, true, 0);
    wasm.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리말');
    wasm.applyCharFormatInHeaderFooter(0, true, 0, 0, 0, 0, 1, JSON.stringify(UNDERLINE));
    wasm.applyCharFormatInHf(0, true, 0, 0, 1, 2, JSON.stringify({ emboss: true }));
    wasm.applyParaFormatInHf(0, true, 0, 0, JSON.stringify({ ...FIXED, marginRight: 10 }));
    const check = (label: string) => {
      const first = wasm.getCharPropertiesInHf(0, true, 0, 0, 0);
      assert.deepEqual([first.underline, first.underlineColor, first.underlineShape], [true, '#ff0000', 3], label);
      assert.equal(wasm.getCharPropertiesInHf(0, true, 0, 0, 1).emboss, true, label);
      const para = wasm.getParaPropertiesInHf(0, true, 0, 0), body = wasm.getParaPropertiesAt(0, 0);
      assert.equal(para.lineSpacingType, 'Fixed', label);
      assert.ok(para.marginRight! > 0, label);
      assert.deepEqual([para.lineSpacing, para.marginRight], [body.lineSpacing, body.marginRight], label);
    };
    check('live');
    reopenEach(env, check);
  });

  test(`각주 양각·고정 줄 간격이 두 형식으로 다시 열린다: ${fixture}`, async t => {
    const env = await openHeemangAgent(t, fixture);
    const { wasm } = env;
    const note = wasm.insertFootnote(0, 0, 0);
    wasm.insertTextInFootnote(0, note.paraIdx, note.controlIdx, 0, 0, '각주');
    wasm.applyCharFormatInFootnote(0, note.paraIdx, note.controlIdx, 0, 0, 1, JSON.stringify({ emboss: true }));
    wasm.applyParaFormatInFootnote(0, note.paraIdx, note.controlIdx, 0, JSON.stringify(FIXED));
    wasm.applyParaFormat(0, 0, JSON.stringify(FIXED));
    const check = (label: string) => {
      assert.equal(wasm.getCharPropertiesInFootnote(0, note.paraIdx, note.controlIdx, 0, 0).emboss, true, label);
      const para = wasm.getParaPropertiesInFootnote(0, note.paraIdx, note.controlIdx, 0);
      assert.deepEqual([para.lineSpacingType, para.lineSpacing], ['Fixed', wasm.getParaPropertiesAt(0, 0).lineSpacing], label);
    };
    check('live');
    reopenEach(env, check);
  });
}

for (const shapeType of ['polygon', 'arc'] as const) {
  test(`도형 넣기의 ${shapeType} 은 그려지고 두 형식으로 다시 열린다`, async t => {
    const env = await openHeemangAgent(t, FIXTURES.blankHwpx);
    const { wasm } = env;
    const blank = wasm.renderPageSvg(0);
    const result = wasm.createShapeControl({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 3000, height: 2000, horzOffset: 5000, vertOffset: 4000, shapeType,
      ...(shapeType === 'polygon' ? { polygonPoints: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 1500, y: 2000 }] } : {}),
    });
    assert.equal(result.ok, true);
    const layout = () => wasm.getPageControlLayout(0).controls.map(c => [c.type, Math.round(c.w * 10) / 10, Math.round(c.h * 10) / 10]);
    assert.deepEqual(layout(), [['shape', 40, 26.7]]);
    const drawn = wasm.renderPageSvg(0);
    assert.ok(drawn.split('<path').length > blank.split('<path').length, 'nothing drawn');
    reopenEach(env, name => {
      assert.deepEqual(layout(), [['shape', 40, 26.7]], name);
      assert.equal(wasm.renderPageSvg(0), drawn, name);
    });
  });
}

test('번호 붙인 표 캡션은 자동 번호 숫자를 포함한 글을 돌려준다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 1, colCount: 1 });
  const set = (text: string, withNumber: boolean) => wasm.setTableCaptionText(0, table.paraIdx, table.controlIdx, text, withNumber).captionText;
  assert.equal(set(' 설명', true), '표  1 설명');
  assert.equal(set('설명', false), '설명');
});
