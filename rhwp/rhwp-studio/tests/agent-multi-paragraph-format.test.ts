/**
 * 여러 문단 서식 (paras) — apply_para_format / apply_char_format / apply_style 한 항목이 문단 여럿을
 * 덮는 계약 검증. 문단마다 항목을 하나씩 보내던 배치(19개 항목, 인자 2천여 자)를 한두 항목으로 줄인다.
 *
 * 대상 해석(번호·구간·중복·한도), 주소 충돌, 오프셋 없는 문단 전체 글자 서식, 원자성·롤백,
 * apply_edits 안의 중첩, 문단별 pending op(거절 복원), 저널(리베이스·델타)을 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTable, expectErr, makeEnv } from './agent-test-env.ts';

const SIX = ['첫째 문단', '둘째 문단', '셋째 문단', '넷째 문단', '다섯째 문단', '여섯째 문단'];

type Env = ReturnType<typeof makeEnv>;
const shapeOf = (h: Env, para: number): number =>
  (h.wasm as unknown as { getParaPropertiesAt(s: number, p: number): { paraShapeId: number } })
    .getParaPropertiesAt(0, para).paraShapeId;
const shapes = (h: Env): number[] => h.body.map((_, para) => shapeOf(h, para));
const formattedParas = (h: Env): unknown[] => h.calls.filter((c) => c.m === 'applyParaFormat').map((c) => c.a[0]);
const charRanges = (h: Env): unknown[][] => h.calls.filter((c) => c.m === 'applyCharFormat').map((c) => c.a.slice(0, 4));

// ─── 대상 해석 ────────────────────────────────────────────

test('apply_para_format paras: 번호·구간·중복을 섞어도 문단마다 한 번씩, revision 은 한 번만 오른다', async () => {
  const h = makeEnv(SIX);
  const before = h.revision.revision;
  const r = await h.call('apply_para_format', { paras: [4, [1, 2], 2, [0, 1]], alignment: 'justify' });
  assert.deepEqual(formattedParas(h), [0, 1, 2, 4]);
  assert.deepEqual(shapes(h), [99, 99, 99, 13, 99, 15]);
  assert.equal(r['applied'], true);
  assert.equal(r['paragraphs'], 4);
  assert.equal(r['skippedEmpty'], undefined);
  assert.equal(r['revision'], before + 1);
  assert.equal(typeof r['changeSetId'], 'string');
  for (const call of h.calls.filter((c) => c.m === 'applyParaFormat')) {
    assert.match(String(call.a[1]), /"alignment":"justify"/);
  }
});

test('paras: 뒤집힌 구간·범위 밖 번호·잘못된 항목은 그 항목을 짚어 거절하고 아무것도 바꾸지 않는다', async () => {
  const h = makeEnv(SIX);
  const bad = async (paras: unknown, pattern: RegExp) => {
    const e = await expectErr(h.call('apply_para_format', { paras, alignment: 'center' }), 'INVALID_ARGS');
    assert.match(e.message, pattern);
  };
  await bad([0, [3, 1]], /paras\[1\] \[3, 1\] is reversed — send \[1, 3\]/);
  await bad([0, 6], /paras\[1\] 6 is out of range for section 0 \(0\.\.5\)/);
  await bad([[4, 9]], /paras\[0\] \[4,9\] is out of range for section 0 \(0\.\.5\)/);
  await bad([1, '2'], /paras\[1\] must be a paragraph index or an inclusive \[first, last\] range \(got "2"\)/);
  await bad([[1, 2, 3]], /paras\[0\] must be a paragraph index/);
  await bad([-1], /paras\[0\] must be a paragraph index/);
  await bad([], /paras must list 1\.\.64 entries/);
  await bad(3, /paras must list 1\.\.64 entries/);
  await bad(Array.from({ length: 65 }, () => 0), /paras must list 1\.\.64 entries/);
  assert.deepEqual(formattedParas(h), []);
  assert.equal(h.pending.hasPending(), false);

  const long = makeEnv(Array.from({ length: 600 }, (_, i) => `문단 ${i}`));
  const e = await expectErr(long.call('apply_para_format', { paras: [[0, 500]], alignment: 'center' }), 'INVALID_ARGS');
  assert.match(e.message, /more than 500 paragraphs/);
  // 겹친 구간은 합쳐 센다 — 500 문단까지는 받는다
  const r = await long.call('apply_para_format', { paras: [[0, 300], [200, 499]], alignment: 'center' });
  assert.equal(r['paragraphs'], 500);
});

test('paras 는 paraIdx·오프셋·anchor 와 함께 올 수 없다', async () => {
  const h = makeEnv(SIX);
  const para = await expectErr(
    h.call('apply_para_format', { paras: [1], paraIdx: 2, alignment: 'center' }), 'INVALID_ARGS',
  );
  assert.match(para.message, /paras already names the target paragraphs — drop paraIdx/);
  const offsets = await expectErr(
    h.call('apply_char_format', { paras: [1], startOffset: 0, endOffset: 2, bold: true }), 'INVALID_ARGS',
  );
  assert.match(offsets.message, /drop startOffset, endOffset/);
  const anchor = await expectErr(
    h.call('apply_char_format', { paras: [1], anchor: '둘째', bold: true }), 'INVALID_ARGS',
  );
  assert.match(anchor.message, /drop anchor/);
  assert.equal(h.calls.length, 0);
});

test('구역이 여럿이면 paras 에도 sectionIdx 가 필요하다', async () => {
  const h = makeEnv(SIX, (wasm) => { wasm['getSectionCount'] = () => 2; });
  const e = await expectErr(h.call('apply_para_format', { paras: [0], alignment: 'center' }), 'INVALID_ARGS');
  assert.match(e.message, /apply_para_format needs sectionIdx because the document has 2 sections/);
  await h.call('apply_para_format', { sectionIdx: 0, paras: [0], alignment: 'center' });
  assert.deepEqual(formattedParas(h), [0]);
});

// ─── 글자 서식: 문단 전체 ─────────────────────────────────

test('apply_char_format paras: 문단마다 전체 텍스트에 걸고 빈 문단은 건너뛴다', async () => {
  const h = makeEnv(['제목 하나', '', '제목 둘입니다', '']);
  const r = await h.call('apply_char_format', { paras: [[0, 3]], fontSizePt: 14, underline: true });
  assert.deepEqual(charRanges(h), [[0, 0, 0, 5], [0, 2, 0, 7]]);
  assert.equal(r['applied'], true);
  assert.equal(r['paragraphs'], 2);
  assert.equal(r['skippedEmpty'], 2);
  for (const call of h.calls) assert.match(String(call.a[4]), /"fontSize":1400/);

  // 빈 문단뿐이면 바뀐 것이 없다
  const before = h.revision.revision;
  const none = await h.call('apply_char_format', { paras: [1, 3], bold: true });
  assert.equal(none['applied'], false);
  assert.equal(none['paragraphs'], 0);
  assert.equal(none['skippedEmpty'], 2);
  assert.equal(none['revision'], before);
});

test('apply_char_format: 오프셋 없는 paraIdx 는 문단 전체, 오프셋 하나만 오면 거절한다', async () => {
  const h = makeEnv(SIX);
  const r = await h.call('apply_char_format', { paraIdx: 1, bold: true });
  assert.deepEqual(charRanges(h), [[0, 1, 0, 5]]);
  assert.equal(r['paragraphs'], 1);
  const half = await expectErr(h.call('apply_char_format', { paraIdx: 1, startOffset: 2, bold: true }), 'INVALID_ARGS');
  assert.match(half.message, /apply_char_format needs sectionIdx, paraIdx, startOffset, endOffset — or find or paras \(missing endOffset\)/);
  const range = await expectErr(h.call('apply_char_format', { paraIdx: 9, bold: true }), 'INVALID_ARGS');
  assert.match(range.message, /paraIdx 9 is out of range for section 0 \(0\.\.5\)/);
  // 범위 도구식 이름으로 온 문단 구간도 오프셋이 없으면 그 문단들 전체다
  h.calls.length = 0;
  const span = await h.call('apply_char_format', { startParaIdx: 2, endParaIdx: 4, italic: true });
  assert.deepEqual(charRanges(h), [[0, 2, 0, 5], [0, 3, 0, 5], [0, 4, 0, 6]]);
  assert.equal(span['paragraphs'], 3);
  // 서식 키가 없으면 대상과 무관하게 거절한다
  await expectErr(h.call('apply_char_format', { paras: [0] }), 'INVALID_ARGS');
  assert.equal(charRanges(h).length, 3);
});

// ─── 스타일 · 셀 ──────────────────────────────────────────

test('apply_style paras: 문단마다 스타일을 걸고, 없는 styleId 는 거절한다', async () => {
  const h = makeEnv(SIX, (wasm) => {
    wasm['getStyleList'] = () => [{ id: 0, name: '바탕글' }, { id: 3, name: '개요 1' }];
    wasm['applyStyle'] = (_s: number, para: number, styleId: number) => {
      (wasm['applied'] as number[][]).push([para, styleId]);
      return { ok: true };
    };
    wasm['applied'] = [];
  });
  const applied = (h.wasm as unknown as { applied: number[][] }).applied;
  await expectErr(h.call('apply_style', { paras: [[0, 1]], styleId: 77 }), 'INVALID_ARGS');
  const r = await h.call('apply_style', { paras: [[0, 1], 4], styleId: 3 });
  assert.deepEqual(applied, [[0, 3], [1, 3], [4, 3]]);
  assert.equal(r['paragraphs'], 3);
  // 단일 호출은 그대로이고, 구역이 하나면 sectionIdx 를 생략할 수 있다
  await h.call('apply_style', { paraIdx: 2, styleId: 3 });
  assert.deepEqual(applied[3], [2, 3]);
  const missing = await expectErr(h.call('apply_style', { styleId: 3 }), 'INVALID_ARGS');
  assert.equal(missing.message, 'apply_style needs sectionIdx, paraIdx — or paras (missing paraIdx)');
});

test('paras + cell: 그 셀의 문단이 대상이다', async () => {
  const h = makeEnv(['본문', '', '말미']);
  const t = addTable(h, 1, [['첫 줄', '옆 칸']]);
  t.cells[0].push('둘째 줄', '', '넷째 줄');
  const cell = { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx: 0 };
  await h.call('apply_para_format', { cell, paras: [0, [2, 3]], alignment: 'center' });
  assert.deepEqual(
    h.calls.filter((c) => c.m === 'applyParaFormatInCell').map((c) => c.a.slice(0, 5)),
    [[0, 1, 0, 0, 0], [0, 1, 0, 0, 2], [0, 1, 0, 0, 3]],
  );
  const r = await h.call('apply_char_format', { cell, paras: [[0, 3]], bold: true });
  assert.deepEqual(
    h.calls.filter((c) => c.m === 'applyCharFormatInCell').map((c) => c.a.slice(0, 7)),
    [[0, 1, 0, 0, 0, 0, 3], [0, 1, 0, 0, 1, 0, 4], [0, 1, 0, 0, 3, 0, 4]],
  );
  assert.equal(r['skippedEmpty'], 1);
  const e = await expectErr(h.call('apply_para_format', { cell, paras: [4], alignment: 'center' }), 'INVALID_ARGS');
  assert.match(e.message, /paras\[0\] 4 is out of range for cell 0 \(0\.\.3\)/);
});

// ─── 원자성 · 검토 ────────────────────────────────────────

test('paras: 중간 문단에서 실패하면 전부 되돌리고, 같은 revision 으로 다시 보내면 통과한다', async () => {
  let failAt: number | null = 2;
  const h = makeEnv(SIX, (wasm) => {
    const apply = wasm['applyParaFormat'] as (s: number, p: number, json: string) => string;
    wasm['applyParaFormat'] = (s: number, p: number, json: string) => {
      if (p === failAt) throw new Error('engine refused paragraph');
      return apply(s, p, json);
    };
  });
  const before = h.revision.revision;
  const e = await expectErr(h.call('apply_para_format', { paras: [[0, 4]], alignment: 'justify' }), 'RPC_ERROR');
  assert.match(e.message, /engine refused paragraph/);
  assert.deepEqual(shapes(h), [10, 11, 12, 13, 14, 15], '앞서 적용된 문단도 되돌아간다');
  assert.equal(h.pending.hasPending(), false);
  failAt = null;
  const r = await h.call('apply_para_format', { expectedRevision: before, paras: [[0, 4]], alignment: 'justify' });
  assert.equal(r['paragraphs'], 5);
  assert.deepEqual(shapes(h), [99, 99, 99, 99, 99, 15]);
});

test('paras: 문단마다 보통의 pending op 하나씩이라 거절하면 모든 문단이 복원된다', async () => {
  const h = makeEnv(SIX);
  const r = await h.call('apply_para_format', { paras: [[1, 3]], alignment: 'justify' });
  const ops = h.pending.getChangeSets().flatMap((set) => set.ops);
  assert.equal(ops.length, 3);
  assert.ok(ops.every((op) => op.kind === 'object'));
  h.pending.reject(String(r['changeSetId']));
  assert.deepEqual(shapes(h), [10, 11, 12, 13, 14, 15]);
  assert.equal(h.pending.hasPending(), false);

  const chars = await h.call('apply_char_format', { paras: [0, 5], bold: true });
  assert.ok(h.pending.getChangeSets().flatMap((set) => set.ops).every((op) => op.kind === 'format'));
  h.calls.length = 0;
  h.pending.reject(String(chars['changeSetId']));
  // 역서식이 문단마다 다시 걸린다
  assert.deepEqual(charRanges(h).map((a) => a[1]).sort(), [0, 5]);
});

test('apply_edits 안의 paras 항목: 한 배치로 적용되고, 뒤 항목이 실패하면 함께 되돌아간다', async () => {
  const h = makeEnv(SIX);
  const before = h.revision.revision;
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'apply_para_format', paras: [[1, 4]], alignment: 'justify' },
      { tool: 'apply_char_format', paras: [0, 5], fontSizePt: 14, underline: true },
      { tool: 'replace_range', anchor: '셋째', text: '3번째' },
    ],
  });
  assert.equal(r['applied'], 3);
  assert.equal(r['revision'], before + 1);
  const results = r['results'] as Array<Record<string, unknown>>;
  assert.equal(results[0]['paragraphs'], 4);
  assert.equal(results[1]['paragraphs'], 2);
  assert.deepEqual(shapes(h), [10, 99, 99, 99, 99, 15]);
  assert.equal(h.body[2], '3번째 문단');
  // 배치가 남긴 저널로 델타 읽기가 건드린 문단 구간만 돌려준다
  const delta = await h.call('get_structure', { sinceRevision: before, format: 'json' });
  const changes = delta['changes'] as Array<{ paraStart: number; paraEnd: number }>;
  assert.deepEqual(changes.map((c) => [c.paraStart, c.paraEnd]), [[0, 5]]);

  const again = h.revision.revision;
  const e = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'apply_para_format', paras: [0, 5], alignment: 'center' },
      { tool: 'delete_range', anchor: '없는 말' },
    ],
  }), 'INVALID_ARGS');
  assert.match(e.message, /^1 of 2 edits failed/);
  assert.deepEqual(shapes(h), [10, 99, 99, 99, 99, 15]);
  await h.call('apply_para_format', { expectedRevision: again, paras: [0, 5], alignment: 'center' });
  assert.deepEqual(shapes(h), [99, 99, 99, 99, 99, 99]);
});

// ─── 저널: 리베이스 · 델타 ────────────────────────────────

test('paras 가 건드린 문단 밖의 형제 쓰기는 stale revision 으로도 통과하고, 겹치면 충돌한다', async () => {
  const h = makeEnv(SIX);
  const shared = h.revision.revision;
  await h.call('apply_para_format', { paras: [1, [3, 4]], alignment: 'justify' });
  // 델타는 건드린 구간만 — 사이의 2번 문단은 빠진다
  const delta = await h.call('get_structure', { sinceRevision: shared, format: 'json' });
  const changes = delta['changes'] as Array<{ paraStart: number; paraEnd: number }>;
  assert.deepEqual(changes.map((c) => [c.paraStart, c.paraEnd]), [[1, 1], [3, 4]]);
  // 형제 에이전트: 대상 사이의 2번 문단과 뒤의 5번 문단은 그대로 쓴다
  await h.call('insert_text', { expectedRevision: shared, paraIdx: 2, charOffset: 0, text: '가' });
  await h.call('insert_text', { expectedRevision: shared, paraIdx: 5, charOffset: 0, text: '나' });
  assert.equal(h.body[2], '가셋째 문단');
  assert.equal(h.body[5], '나여섯째 문단');
  await expectErr(
    h.call('insert_text', { expectedRevision: shared, paraIdx: 3, charOffset: 0, text: '다' }),
    'REVISION_MISMATCH',
  );
  assert.equal(h.body[3], '넷째 문단');
});

test('stale revision 의 paras 는 항목마다 리베이스된다 — 형제가 사이에 문단을 넣으면 이동량이 항목마다 다르다', async () => {
  const h = makeEnv(SIX);
  const shared = h.revision.revision;
  // 형제가 2번 문단을 둘로 나눈다 — 그 뒤 문단은 한 칸씩 밀린다
  await h.call('insert_text', { paraIdx: 2, charOffset: 2, text: '\n' });
  const r = await h.call('apply_para_format', { expectedRevision: shared, paras: [0, [4, 5]], alignment: 'justify' });
  assert.deepEqual(formattedParas(h), [0, 5, 6]);
  assert.deepEqual(r['rebasedParaShifts'], [[0, 0, 0], [4, 5, 1]]);
  assert.equal(r['rebasedParaShift'], undefined);
});

test('stale revision 의 paras 가 형제의 문단과 겹치면 REVISION_MISMATCH', async () => {
  const h = makeEnv(SIX);
  const shared = h.revision.revision;
  await h.call('insert_text', { paraIdx: 2, charOffset: 0, text: '가' });
  await expectErr(
    h.call('apply_para_format', { expectedRevision: shared, paras: [0, [1, 3]], alignment: 'justify' }),
    'REVISION_MISMATCH',
  );
  assert.deepEqual(formattedParas(h), []);
  // 겹치지 않는 문단만 고르면 통과하고, 한결같은 이동량은 rebasedParaShift 하나로 온다
  await h.call('insert_text', { paraIdx: 0, charOffset: 2, text: '\n' });
  const r = await h.call('apply_para_format', { expectedRevision: shared, paras: [[3, 5]], alignment: 'justify' });
  assert.deepEqual(formattedParas(h), [4, 5, 6]);
  assert.equal(r['rebasedParaShift'], 1);
});
