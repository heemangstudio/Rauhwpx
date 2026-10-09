/**
 * 에이전트 벤치마크에서 드러난 도구 계약 — executor → 실제 PendingEditManager → 가짜 wasm.
 *
 * - replace_range text "" = 지우기 (단독·apply_edits 항목, 거절 시 복원)
 * - cell 없이 최상위 controlIdx/cellIdx 를 보낸 셀 편집은 표가 놓인 문단을 고치지 않고 거절된다
 * - apply_edits 의 occurrence 초과 오류는 앞 항목이 매치를 먹었다고 짚는다
 * - apply_list stripMarkers 는 손으로 친 표지를 같은 change set 에서 지우고, 거절하면 되살린다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTable, expectErr, makeEnv } from './agent-test-env.ts';

test('replace_range text "" deletes the range, alone and inside apply_edits, and reject restores it', async () => {
  const h = makeEnv(['첫 문장입니다. 지울 부분 남는 부분', '둘째 문단']);
  const r = await h.call('replace_range', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 9, endParaIdx: 0, endCharOffset: 15, text: '',
  });
  assert.equal(h.body[0], '첫 문장입니다. 남는 부분');
  assert.equal(r['deletedText'], '지울 부분 ');
  h.pending.reject(String(r['changeSetId']));
  assert.equal(h.body[0], '첫 문장입니다. 지울 부분 남는 부분');

  const batch = await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', find: '지울 부분 ', text: '' },
      { tool: 'replace_range', find: '둘째', text: '두 번째' },
    ],
  });
  assert.equal(batch['applied'], 2);
  assert.deepEqual(h.body, ['첫 문장입니다. 남는 부분', '두 번째 문단']);
});

test('top-level controlIdx/cellIdx without cell is rejected with the corrected call and leaves the host paragraph alone', async () => {
  const h = makeEnv(['머리', '', '꼬리']);
  addTable(h, 1, [['이름', '값']]);
  // 배치 롤백은 표를 스냅샷 사본으로 바꾼다 — 매번 새로 읽는다.
  const cells = () => h.tables[0].cells;
  const err = await expectErr(
    h.call('insert_text', { sectionIdx: 0, paraIdx: 1, controlIdx: 0, cellIdx: 1, charOffset: 0, text: '42' }),
    'INVALID_ARGS',
  );
  assert.match(err.message, /cell:\{paraIdx:1,controlIdx:0,cellIdx:1\}/);
  assert.deepEqual(h.body, ['머리', '', '꼬리']);
  assert.deepEqual(cells()[1], ['값']);

  // apply_edits 항목도 같은 검사를 지나 배치 전체가 되돌아간다.
  const batchErr = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', find: '머리', text: '제목' },
      { tool: 'replace_range', sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 1, endCharOffset: 1, controlIdx: 0, cellIdx: 0, cellParaIdx: 0, text: '성명' },
    ],
  }), 'INVALID_ARGS');
  assert.match(batchErr.message, /edits\[1\] \(replace_range\).*cell:\{paraIdx:1,controlIdx:0,cellIdx:0\}.*startParaIdx\/endParaIdx/);
  assert.deepEqual(h.body, ['머리', '', '꼬리']);

  // 읽기 배치는 그 항목만 오류로 돌려준다.
  const read = await h.call('read_batch', {
    reads: [{ tool: 'get_text_range', sectionIdx: 0, paraIdx: 1, cellIdx: 0, charOffset: 0, count: 5 }],
  });
  const [item] = read['results'] as Array<{ error?: { code: string } }>;
  assert.equal(item.error?.code, 'INVALID_ARGS');

  // 올바른 cell 주소는 그대로 셀에 쓴다.
  await h.call('insert_text', { cell: { paraIdx: 1, controlIdx: 0, cellIdx: 1 }, paraIdx: 0, charOffset: 0, text: '42 ' });
  assert.deepEqual(cells()[1], ['42 값']);
});

test('an occurrence past the matches left by earlier batch items says those items changed the text', async () => {
  const h = makeEnv(['회사 규정과 회사 문화']);
  const err = await expectErr(h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', find: '회사', occurrence: 1, text: '기업' },
      { tool: 'replace_range', find: '회사', occurrence: 2, text: '조직' },
    ],
  }), 'INVALID_ARGS');
  assert.match(err.message, /edits\[1\] \(replace_range\): occurrence 2 but only 1 match\(es\) for "회사"/);
  assert.match(err.message, /Earlier items in this apply_edits batch already changed the text/);
  assert.match(err.message, /1 remain; edits\[0\] \(replace_range\) already rewrote a match/);
  assert.deepEqual(h.body, ['회사 규정과 회사 문화'], 'occurrence 의미는 그대로 — 배치는 통째로 되돌아간다');

  // 단독 호출의 오류에는 배치 설명이 붙지 않는다.
  const single = await expectErr(h.call('replace_range', { find: '회사', occurrence: 3, text: 'x' }), 'INVALID_ARGS');
  assert.doesNotMatch(single.message, /Earlier items/);
});
