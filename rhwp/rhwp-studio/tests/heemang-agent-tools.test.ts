/**
 * HeemangEngine 문서에서 에이전트 전용 브리지(수식, 셀 영역 테두리, 표 캡션, 개요, 엔진 배치 지문)가
 * 도구 실행기와 검토 흐름(미리보기 → 거절/승인 → undo)을 지나 문서에 맞게 반영되는지.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

const equations = (env: Awaited<ReturnType<typeof openHeemangAgent>>, para: number) =>
  env.adapter.paragraphs(0, [], para, 1)[0].controls.filter((c) => c.kind === 'equation');

function firstTable(env: Awaited<ReturnType<typeof openHeemangAgent>>) {
  const count = env.wasm.getParagraphCount(0);
  for (let paraIdx = 0; paraIdx < count; paraIdx++) {
    const control = env.adapter.paragraphs(0, [], paraIdx, 1)[0].controls.find((c) => c.kind === 'table');
    if (control) return { sectionIdx: 0, paraIdx, controlIdx: control.index };
  }
  throw new Error('표가 있는 문서여야 한다');
}

test('수식 넣기는 미리보기로 남고, 거절하면 사라지며 승인하면 한 번의 undo로 되돌아간다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  const before = env.text(0);
  env.pending.beginTurn('claude');
  await env.call('insert_equation', { sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'a over b' });
  const [eq] = equations(env, 0);
  assert.equal(eq?.script, 'a over b');
  const props = env.wasm.getEquationProperties(0, 0, eq.index);
  assert.equal(props.script, 'a over b');
  assert.ok(props.width > 0 && props.height > 0, '수식 크기는 조판에서 나온다');
  env.pending.endTurn('review');
  env.pending.rejectAll();
  assert.equal(equations(env, 0).length, 0);
  assert.equal(env.text(0), before);

  env.pending.beginTurn('claude');
  await env.call('insert_equation', { sectionIdx: 0, paraIdx: 0, charOffset: 0, script: 'x^2' });
  env.pending.endTurn('review');
  assert.equal(env.pending.approve(env.pending.getChangeSets()[0].id), true);
  assert.equal(equations(env, 0).length, 1);
  assert.ok(env.history.undo(env.wasm));
  assert.equal(equations(env, 0).length, 0);
});

test('수식 미리보기는 SVG와 크기를 주고 문서를 바꾸지 않는다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  const epoch = env.adapter.state().contentEpoch;
  const preview = JSON.parse(env.wasm.renderEquationPreview('sqrt {x}', 1000, 0));
  assert.match(preview.svg, /<svg/);
  assert.ok(preview.widthPx > 0 && preview.heightPx > 0);
  assert.equal(env.adapter.state().contentEpoch, epoch);
});

test('셀 영역 테두리·배경과 표 캡션은 표에 남고 저장 뒤 다시 열어도 유지된다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.cellMixed);
  const table = firstTable(env);
  env.pending.setDirectApply(true);
  env.pending.beginTurn('claude');
  await env.call('set_zone_borders', { ...table, startCell: { row: 0, col: 0 }, endCell: { row: 0, col: 0 },
    borderBottom: { type: 1, width: 2, color: '#FF0000' }, fillColor: '#FFEECC' });
  await env.call('edit_table', { ...table, op: 'set_caption', text: '표 설명' });
  assert.equal(env.pending.commitOpen(), true);
  // 셀 영역은 표의 영역 목록에 들어가 셀 자체 속성 대신 쪽 그림에 나타난다.
  const reads = async (label: string) => {
    const svg = env.wasm.renderPageSvg(0).toLowerCase();
    assert.ok(svg.includes('#ffeecc'), `${label}: 영역 배경`);
    assert.ok(svg.includes('#ff0000'), `${label}: 영역 아래 테두리`);
    // 캡션 목록은 셀 목록 다음 번호다.
    const cells = env.wasm.core.query<{ cells: unknown[] }>({ kind: 'table', table: { section: 0, steps: [], para: table.paraIdx, control: table.controlIdx } }).cells.length;
    const caption = env.adapter.paragraphs(0, [{ para: table.paraIdx, control: table.controlIdx, index: cells }], 0, 1)[0];
    assert.match(caption.text, /표 설명$/, `${label}: 캡션`);
    assert.ok(caption.controls.some((c) => c.kind === 'autoNumber'), `${label}: 표 번호`);
  };
  await reads('편집 직후');
  for (const [bytes, name] of [[env.wasm.exportHwpx(), 'saved.hwpx'], [env.wasm.exportHwp(), 'saved.hwp']] as const) {
    env.wasm.loadDocument(bytes, name);
    env.adapter.refreshLayout();
    await reads(name);
  }
});

test('개요 조회는 문단 개요 수준으로 제목 트리를 만든다', async (t) => {
  const env = await openHeemangAgent(t, 'samples/biz_plan.hwp');
  const outline = await env.read('get_outline', {}) as { mode: string; nodeCount: number; roots: Array<{ heading: string; children?: unknown[] }> };
  assert.equal(outline.mode, 'outline');
  assert.ok(outline.roots.length > 0);
  assert.ok(outline.nodeCount >= outline.roots.length);
});

test('엔진 메서드 배치는 바뀐 문단을 지문 비교로 알려 준다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  const res = await env.call('apply_engine_edits', { operations: [{ method: 'insertText', args: [0, 0, 0, 'ENG '] }] }) as { changedParagraphs?: unknown[] };
  assert.ok(env.text(0).startsWith('ENG '));
  assert.ok(Array.isArray(res.changedParagraphs) && res.changedParagraphs.length > 0);
});
