/**
 * 쓰기 인자 관용 — 모델의 의도가 분명한 배치는 첫 호출에 통과하고, 실패한 배치는 고칠 항목을
 * 한 번에 알려 주는 계약 검증. 실패한 배치마다 모델 왕복이 하나씩 들기 때문이다.
 *
 * apply_edits 항목 꼴(평평한 꼴·섞인 꼴·JSON 문자열 args), 좌표 별칭, sectionIdx 기본값,
 * 누락 좌표 안내, 다중 실패 보고와 롤백을 본다. 앵커 쪽 관용은 agent-text-anchors.test.ts 에 있다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetEngineTrapForTests } from '../src/core/engine-trap.ts';
import { addTable, expectErr, makeEnv } from './agent-test-env.ts';

// ─── apply_edits 항목 꼴 ──────────────────────────────────

test('apply_edits: 평평한 {tool, …인자} 와 감싼 {tool, args} 를 한 배치에서 받는다', async () => {
  const h = makeEnv(['alpha beta', 'gamma']);
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', anchor: { text: 'alpha' }, text: 'delta' },
      { tool: 'insert_text', args: { anchor: { text: 'gamma' }, text: '!' } },
      { tool: 'apply_char_format', sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 5, bold: true },
    ],
  });
  assert.deepEqual(h.body, ['delta beta', 'gamma!']);
  assert.equal(r['applied'], 3);
  assert.deepEqual(h.calls.find((c) => c.m === 'applyCharFormat')!.a.slice(0, 4), [0, 0, 0, 5]);
});

test('apply_edits: args 옆에 떨어진 인자는 합쳐지고 args 안쪽 값이 우선한다', async () => {
  const h = makeEnv(['alpha beta', 'gamma']);
  await h.call('apply_edits', {
    edits: [
      // 중괄호를 일찍 닫아 text 가 args 밖에 놓인 꼴
      { tool: 'replace_range', args: { anchor: { text: 'alpha' } }, args2: {}, text: 'delta' },
      { tool: 'insert_text', args: { anchor: { text: 'gamma' }, text: '!' }, text: '?' },
    ],
  });
  assert.deepEqual(h.body, ['delta beta', 'gamma!']);
});

test('apply_edits: JSON 문자열 args 는 풀어서 받고, 객체가 아닌 문자열은 INVALID_ARGS', async () => {
  const h = makeEnv(['alpha beta']);
  await h.call('apply_edits', {
    edits: [{ tool: 'replace_range', args: JSON.stringify({ anchor: { text: 'alpha' }, text: 'delta' }) }],
  });
  assert.equal(h.body[0], 'delta beta');
  for (const args of ['anchor=delta', '[1]', '"delta"']) {
    const e = await expectErr(h.call('apply_edits', { edits: [{ tool: 'delete_range', args }] }), 'INVALID_ARGS');
    assert.match(e.message, /edits\[0\] \(delete_range\): args must be an object of delete_range arguments/);
  }
  assert.equal(h.body[0], 'delta beta');
});

test('read_batch 도 평평한 항목을 받는다', async () => {
  const h = makeEnv(['alpha beta']);
  const r = await h.call('read_batch', { reads: [{ tool: 'find_text', query: 'beta' }] });
  const item = (r['results'] as Array<Record<string, unknown>>)[0];
  assert.equal((item['matches'] as unknown[]).length, 1);
});

// ─── 좌표 별칭 ────────────────────────────────────────────

test('범위 도구는 paraIdx·startOffset·endOffset 을 받고 endParaIdx 를 startParaIdx 로 채운다', async () => {
  const h = makeEnv(['0123456789', 'abcdefghij']);
  // apply_char_format 식 이름으로 보낸 delete_range
  await h.call('apply_edits', {
    edits: [{ tool: 'delete_range', args: { sectionIdx: 0, paraIdx: 1, startCharOffset: 2, endCharOffset: 4 } }],
  });
  assert.equal(h.body[1], 'abefghij');
  await h.call('replace_range', { sectionIdx: 0, paraIdx: 0, startOffset: 0, endOffset: 2, text: 'AB' });
  assert.equal(h.body[0], 'AB23456789');
  await h.call('delete_range', { sectionIdx: 0, startParaIdx: 0, startCharOffset: 8, endCharOffset: 10 });
  assert.equal(h.body[0], 'AB234567');
  // 시작 문단만 별칭으로 오고 끝 문단이 따로 오면 여러 문단 범위 그대로다
  await h.call('delete_range', { sectionIdx: 0, paraIdx: 0, startOffset: 6, endParaIdx: 1, endOffset: 2 });
  assert.deepEqual(h.body, ['AB2345efghij']);
});

test('apply_char_format 은 startCharOffset·endCharOffset·startParaIdx 를 받는다', async () => {
  const h = makeEnv(['첫 문단', '강조할 부분']);
  await h.call('apply_char_format', {
    sectionIdx: 0, startParaIdx: 1, endParaIdx: 1, startCharOffset: 4, endCharOffset: 6, bold: true,
  });
  assert.deepEqual(h.calls.find((c) => c.m === 'applyCharFormat')!.a.slice(0, 4), [0, 1, 4, 6]);
  const e = await expectErr(h.call('apply_char_format', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, startCharOffset: 0, endCharOffset: 2, bold: true,
  }), 'INVALID_ARGS');
  assert.match(e.message, /formats one paragraph: paraIdx 0 and endParaIdx 1 disagree/);
});

test('정식 키와 별칭이 다른 값이면 두 키를 짚어 거절하고, 같은 값이면 받는다', async () => {
  const h = makeEnv(['0123456789', 'abcdefghij']);
  const para = await expectErr(h.call('delete_range', {
    sectionIdx: 0, startParaIdx: 0, paraIdx: 1, startCharOffset: 0, endCharOffset: 1,
  }), 'INVALID_ARGS');
  assert.match(para.message, /startParaIdx 0 and paraIdx 1 disagree — send only startParaIdx/);
  const offset = await expectErr(h.call('apply_char_format', {
    sectionIdx: 0, paraIdx: 0, startOffset: 1, startCharOffset: 2, endOffset: 3, bold: true,
  }), 'INVALID_ARGS');
  assert.match(offset.message, /startOffset 1 and startCharOffset 2 disagree — send only startOffset/);
  assert.deepEqual(h.body, ['0123456789', 'abcdefghij']);
  await h.call('delete_range', {
    sectionIdx: 0, startParaIdx: 0, paraIdx: 0, startCharOffset: 0, startOffset: 0, endCharOffset: 1,
  });
  assert.equal(h.body[0], '123456789');
});

test('별칭 좌표도 stale revision 에서 정식 좌표처럼 리베이스된다', async () => {
  const h = makeEnv(['형제 문단', '내 문단 0123']);
  const shared = h.revision.revision;
  // 형제 에이전트가 앞 문단을 둘로 나눠 내 문단이 한 칸 밀린다
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '\n' });
  const r = await h.call('delete_range', {
    expectedRevision: shared, sectionIdx: 0, paraIdx: 1, startOffset: 5, endOffset: 9,
  });
  assert.equal(r['rebasedParaShift'], 1);
  assert.deepEqual(h.body, ['형제', ' 문단', '내 문단 ']);
});

// ─── sectionIdx 기본값과 누락 안내 ────────────────────────

test('구역이 하나뿐인 문서는 sectionIdx 를 생략할 수 있다', async () => {
  const h = makeEnv(['0123456789']);
  await h.call('apply_edits', {
    edits: [
      { tool: 'delete_range', startParaIdx: 0, startCharOffset: 0, endCharOffset: 2 },
      { tool: 'insert_text', paraIdx: 0, charOffset: 0, text: 'ab' },
      { tool: 'apply_char_format', paraIdx: 0, startOffset: 0, endOffset: 2, bold: true },
      { tool: 'apply_para_format', paraIdx: 0, alignment: 'center' },
    ],
  });
  assert.equal(h.body[0], 'ab23456789');
});

test('구역이 여럿이면 sectionIdx 가 필요하다', async () => {
  const h = makeEnv(['0123456789'], (wasm) => { wasm['getSectionCount'] = () => 2; });
  const e = await expectErr(
    h.call('delete_range', { startParaIdx: 0, startCharOffset: 0, endCharOffset: 2 }),
    'INVALID_ARGS',
  );
  assert.match(e.message, /missing sectionIdx; sectionIdx is required because the document has 2 sections/);
  assert.equal(h.body[0], '0123456789');
  await h.call('delete_range', { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endCharOffset: 2 });
  assert.equal(h.body[0], '23456789');
});

test('좌표가 빠지면 그 도구에 필요한 좌표 전체를 알려 준다', async () => {
  const h = makeEnv(['0123456789']);
  const range = await expectErr(h.call('delete_range', { sectionIdx: 0, startParaIdx: 0 }), 'INVALID_ARGS');
  assert.equal(
    range.message,
    'delete_range needs sectionIdx, startParaIdx, startCharOffset, endParaIdx, endCharOffset — or an anchor (missing startCharOffset, endCharOffset)',
  );
  const format = await expectErr(h.call('apply_char_format', { bold: true }), 'INVALID_ARGS');
  assert.equal(
    format.message,
    'apply_char_format needs sectionIdx, paraIdx, startOffset, endOffset — or an anchor (missing paraIdx, startOffset, endOffset)',
  );
});

// ─── 다중 실패 보고 ───────────────────────────────────────

test('apply_edits: 실패한 항목을 전부 한 번에 알리고 되돌린다 — 고친 배치는 같은 expectedRevision 으로 통과한다', async () => {
  const h = makeEnv(['alpha beta', 'gamma delta', 'epsilon']);
  const before = h.revision.revision;
  const e = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', anchor: '없는 말', text: 'x' },
      { tool: 'replace_range', anchor: 'alpha', text: 'ALPHA' },
      { tool: 'insert_text', anchor: 'gamma', text: '!' },
      { tool: 'delete_range', paraIdx: 2, startOffset: 0, endOffset: 99 },
      { tool: 'apply_char_format', anchor: 'epsilon', bold: true },
    ],
  }), 'INVALID_ARGS');
  assert.match(e.message, /^2 of 5 edits failed — the whole batch was rolled back, nothing was applied\. /);
  assert.match(e.message, /edits\[0\] \(replace_range\): anchor "없는 말" matched nothing/);
  assert.match(e.message, /; edits\[3\] \(delete_range\): charOffset 99 out of range/);
  assert.match(e.message, /Fix these items and resend the whole batch/);
  assert.doesNotMatch(e.message, /edits\[[124]\]/);
  assert.deepEqual(h.body, ['alpha beta', 'gamma delta', 'epsilon'], '성공한 항목도 되돌아간다');
  assert.equal(h.pending.hasPending(), false);
  assert.equal(h.calls.some((c) => c.m === 'applyCharFormat'), true, '실패 뒤의 항목도 실행해 오류를 모은다');
  // 되돌린 배치는 저널에 편집으로 남지 않는다 — 롤백이 올린 revision 은 내용 불변으로 덮인다.
  const untouched = await h.call('get_structure', { sinceRevision: before, format: 'json' });
  assert.deepEqual(untouched['changes'], []);

  // 그래서 읽었던 revision 그대로 고친 배치를 다시 보낼 수 있다.
  const r = await h.call('apply_edits', {
    expectedRevision: before,
    edits: [
      { tool: 'replace_range', anchor: 'beta', text: 'BETA' },
      { tool: 'replace_range', anchor: 'alpha', text: 'ALPHA' },
      { tool: 'insert_text', anchor: 'gamma', text: '!' },
      { tool: 'delete_range', paraIdx: 2, startOffset: 0, endOffset: 3 },
    ],
  });
  assert.equal(r['applied'], 4);
  assert.deepEqual(h.body, ['ALPHA BETA', 'gamma! delta', 'ilon']);
});

test('apply_edits: 오류 코드는 첫 실패의 것이고 표 보호 가드는 배치 안에서도 그대로다', async () => {
  const h = makeEnv(['위 문단', '', '아래 문단']);
  addTable(h, 1, [['셀']]);
  const e = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'delete_range', startParaIdx: 0, startCharOffset: 0, endParaIdx: 2, endCharOffset: 1 },
      { tool: 'set_bookmark', name: '' },
      { tool: 'insert_image', path: '/tmp/a.png' },
    ],
  }), 'TABLE_IN_BODY_RANGE');
  assert.match(e.message, /^3 of 3 edits failed/);
  assert.match(e.message, /edits\[0\] \(delete_range\): The body text range crosses a table/);
  assert.match(e.message, /edits\[2\] \(insert_image\): tool must be one of insert_text\|/);
  assert.deepEqual(h.body, ['위 문단', '', '아래 문단']);
});

test('apply_edits: 실패는 여섯 개까지 싣고 나머지는 개수만 알린다', async () => {
  const h = makeEnv(['본문']);
  const e = await expectErr(h.call('apply_edits', {
    edits: Array.from({ length: 8 }, (_, i) => ({ tool: 'delete_range', anchor: `없음${i}` })),
  }), 'INVALID_ARGS');
  assert.match(e.message, /^8 of 8 edits failed/);
  assert.match(e.message, /edits\[5\] \(delete_range\)/);
  assert.doesNotMatch(e.message, /edits\[6\]/);
  assert.match(e.message, /; and 2 more\. Fix these items/);
});

test('apply_edits: 항목 하나만 실패하면 그 항목만 짚는다', async () => {
  const h = makeEnv(['alpha beta']);
  const e = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', anchor: 'alpha', text: 'zeta' },
      { tool: 'delete_range', anchor: 'alpha' },
    ],
  }), 'INVALID_ARGS');
  assert.match(e.message, /^1 of 2 edits failed — the whole batch was rolled back, nothing was applied\. edits\[1\] \(delete_range\): /);
  assert.match(e.message, /Fix this item and resend the whole batch\.$/);
  assert.equal(h.body[0], 'alpha beta');
});

test('apply_edits: 엔진 trap 은 남은 항목을 돌리지 않고 즉시 중단한다', async (t) => {
  t.after(() => resetEngineTrapForTests());
  const h = makeEnv(['alpha beta', 'gamma'], (wasm) => {
    wasm['deleteRange'] = () => { throw new WebAssembly.RuntimeError('unreachable'); };
  });
  const e = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'delete_range', anchor: 'alpha' },
      { tool: 'apply_char_format', anchor: 'gamma', bold: true },
    ],
  }), 'ENGINE_TRAPPED');
  assert.doesNotMatch(e.message, /edits failed/);
  assert.equal(h.calls.some((c) => c.m === 'applyCharFormat'), false);
});
