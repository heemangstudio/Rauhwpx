import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';
import { formatPtFromPx, ptToRaw2x } from '../src/ui/para-shape-model.ts';

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
  // 번호 뒤 글은 한컴 저장본처럼 받은 그대로 둔다("<그림 1> 제목", "표 1. 제목").
  assert.equal(set('설명', true), '표  1설명');
  assert.equal(set('. 설명', true), '표  1. 설명');
  assert.equal(set('설명', false), '설명');
});

const shownPt = (env: Env, para = 0) => formatPtFromPx(env.wasm.getParaPropertiesAt(0, para).lineSpacing!);

for (const fixture of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
  test(`고정 줄 간격은 대화상자에 넣은 pt 로 다시 보이고 두 형식으로 다시 열린다: ${fixture}`, async t => {
    const env = await openHeemangAgent(t, fixture);
    env.wasm.insertText(0, 0, 0, '줄 간격');
    env.wasm.applyParaFormat(0, 0, JSON.stringify({ lineSpacingType: 'Fixed', lineSpacing: ptToRaw2x(15) }));
    assert.equal(shownPt(env), '15.0');
    // 종류를 그대로 두고 값만 바꿔도 같은 단위다.
    env.wasm.applyParaFormat(0, 0, JSON.stringify({ lineSpacing: ptToRaw2x(12) }));
    assert.equal(shownPt(env), '12.0');
    reopenEach(env, name => assert.equal(shownPt(env), '12.0', name));
  });
}

test('에이전트 고정 줄 간격은 검토 거절·승인·되돌리기를 지나도 pt 가 맞다', async t => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  const before = env.wasm.getParaPropertiesAt(0, 0);
  const read = async () => (await env.read('get_para_format', { sectionIdx: 0, paraIdx: 0 })) as Record<string, unknown>;
  const format = async () => { const r = await read(); return (r.format ?? r) as Record<string, unknown>; };
  env.pending.beginTurn('claude');
  await env.call('apply_para_format', { sectionIdx: 0, paraIdx: 0, lineSpacingType: 'fixed', lineSpacingPt: 15 });
  assert.equal((await format()).lineSpacingPt, 15);
  assert.equal(shownPt(env), '15.0');
  env.pending.endTurn('review');
  env.pending.rejectAll();
  assert.deepEqual([env.wasm.getParaPropertiesAt(0, 0).lineSpacingType, env.wasm.getParaPropertiesAt(0, 0).lineSpacing], [before.lineSpacingType, before.lineSpacing]);
  env.pending.beginTurn('claude');
  await env.call('apply_para_format', { sectionIdx: 0, paraIdx: 0, lineSpacingType: 'atLeast', lineSpacingPt: 20 });
  env.pending.endTurn('review');
  assert.equal(env.pending.approve(env.pending.getChangeSets()[0].id), true);
  assert.deepEqual([(await format()).lineSpacingType, (await format()).lineSpacingPt], ['atLeast', 20]);
  assert.ok(env.history.undo(env.wasm));
  assert.equal(env.wasm.getParaPropertiesAt(0, 0).lineSpacing, before.lineSpacing);
});

const controls = (env: Env) => JSON.parse(env.adapter.hmDoc().query(JSON.stringify({ kind: 'controls' }))) as Array<Record<string, unknown>>;

for (const fixture of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
  test(`새 각주·미주 표시는 주석 모양의 뒤 장식을 받는다: ${fixture}`, async t => {
    const env = await openHeemangAgent(t, fixture);
    env.wasm.insertText(0, 0, 0, '본문');
    env.wasm.insertFootnote(0, 0, 2);
    env.wasm.insertEndnote(0, 0, 1);
    const marks = () => controls(env).filter(c => c.kind === 'footnote' || c.kind === 'endnote').map(c => [c.kind, c.suffix]).sort();
    assert.deepEqual(marks(), [['endnote', 41], ['footnote', 41]]);
    reopenEach(env, name => assert.deepEqual(marks(), [['endnote', 41], ['footnote', 41]], name));
  });
}

test('표 만들기는 구 엔진처럼 제 문단에 한컴 기본 표를 놓는다', async t => {
  const env = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const { wasm } = env;
  const texts = () => Array.from({ length: wasm.getParagraphCount(0) }, (_, p) =>
    (env.adapter.paragraphs(0, [], p, 1)[0].controls.some(c => c.kind === 'table') ? '[표]' : '') + env.text(p));
  const empty = wasm.createTable(0, 0, 0, 1, 2);
  assert.deepEqual([empty.paraIdx, texts()], [0, ['[표]', '']]);
  const table = wasm.getPageControlLayout(0).controls.find(c => c.type === 'table')!;
  assert.deepEqual([table.x, table.w, table.h, table.rowCount, table.colCount], [117.2, 559.4, 17.1, 1, 2]);
  const props = wasm.getTableProperties(0, empty.paraIdx, empty.controlIdx);
  assert.deepEqual([props.treatAsChar, props.textWrap, props.outerLeft, props.paddingLeft, props.paddingTop], [false, 'TopAndBottom', 283, 510, 141]);
  // 캡션이 없는 표는 캡션 칸을 알리지 않는다(구 엔진과 같다). 캡션을 달면 알린다.
  assert.deepEqual(Object.keys(props).filter(k => k.startsWith('caption')), []);
  wasm.setTableCaptionText(0, empty.paraIdx, empty.controlIdx, '설명', true);
  assert.equal(wasm.getTableProperties(0, empty.paraIdx, empty.controlIdx).captionDirection, 3);

  for (const [offset, expected, at] of [[0, ['abc', '[표]', ''], 1], [1, ['a', '[표]', '', 'bc'], 1], [3, ['abc', '[표]', '', ''], 1]] as const) {
    wasm.loadDocument(await import('./heemang-agent-env.ts').then(m => m.rhwpFile(FIXTURES.blankHwpx)), 'blank.hwpx');
    env.adapter.refreshLayout();
    wasm.insertText(0, 0, 0, 'abc');
    const made = wasm.createTable(0, 0, offset, 1, 1);
    assert.deepEqual([made.paraIdx, made.controlIdx, texts()], [at, 0, expected], `offset ${offset}`);
  }
  const inline = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 1, rowCount: 1, colCount: 1, treatAsChar: true });
  assert.equal(inline.paraIdx, 0);
  assert.equal(wasm.getTableProperties(0, 0, inline.controlIdx).treatAsChar, true);
});

test('개체 배치 상자는 0.1px 로 반올림하고 저장된 배치를 알린다', async t => {
  const { wasm } = await openHeemangAgent(t, FIXTURES.blankHwpx);
  wasm.insertText(0, 0, 0, '가나다라');
  const shape = wasm.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 3001, height: 2003, shapeType: 'rectangle', horzOffset: 1234, vertOffset: 4321 });
  const item = wasm.getPageControlLayout(0).controls.find(c => c.type === 'shape')!;
  assert.deepEqual([item.x, item.y, item.w, item.h, item.wrap], [16.5, 57.6, 40, 26.7, 'square']);
  assert.deepEqual(wasm.getShapeBBox(0, shape.paraIdx, shape.controlIdx), { pageIndex: 0, x: 16.5, y: 57.6, width: 40, height: 26.7 });
});
