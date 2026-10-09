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

/** apply_list 가 쓰는 번호 정의 API 를 덧붙인 환경 */
function listEnv(body: string[]) {
  const numberings: Array<{ id: number; levelFormats: string[]; numberFormats: number[]; startNumber: number }> = [];
  return makeEnv(body, (wasm) => {
    Object.assign(wasm, {
      getNumberingList: () => numberings,
      createNumbering: (json: string) => {
        const id = numberings.length + 1;
        numberings.push({ id, ...JSON.parse(json) });
        return id;
      },
      ensureDefaultBullet: () => 100,
    });
  });
}

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

test('apply_list stripMarkers removes typed markers only at paragraph starts, in one change set that reject restores', async () => {
  const original = ['가. 첫째', '1) 둘째', '(1)셋째', '① 넷째', '  • 다섯째', '- 여섯째', '1.5배 성장', '-5도 유지', '본문'];
  const h = listEnv(original);
  const r = await h.call('apply_list', {
    sectionIdx: 0, startParaIdx: 0, endParaIdx: 7, format: '1.', stripMarkers: true,
  });
  assert.equal(r['strippedMarkers'], 6);
  assert.deepEqual(h.body, ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째', '1.5배 성장', '-5도 유지', '본문']);
  const sets = h.pending.getChangeSets().filter((set) => set.ops.length > 0);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, r['changeSetId']);
  h.pending.reject(String(r['changeSetId']));
  assert.deepEqual(h.body, original);

  // 표지가 없는 목록은 아무것도 지우지 않는다.
  const plain = await h.call('apply_list', {
    sectionIdx: 0, startParaIdx: 6, endParaIdx: 8, format: '1.', stripMarkers: true,
  });
  assert.equal(plain['strippedMarkers'], 0);
  assert.deepEqual(h.body, original);
});

test('apply_list stripMarkers works as an apply_edits item and as one undo step in 전체 mode', async () => {
  const h = listEnv(['가. 사과', '나. 배', '맺음말']);
  const batch = await h.call('apply_edits', {
    edits: [
      { tool: 'apply_list', sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: '가.', stripMarkers: true },
      { tool: 'replace_range', find: '맺음말', text: '끝' },
    ],
  });
  const [list] = batch['results'] as Array<Record<string, unknown>>;
  assert.equal(list['strippedMarkers'], 2);
  assert.deepEqual(h.body, ['사과', '배', '끝']);
  h.pending.reject(String(batch['changeSetId']));
  assert.deepEqual(h.body, ['가. 사과', '나. 배', '맺음말']);

  h.pending.setDirectApply(true);
  await h.call('apply_list', { sectionIdx: 0, startParaIdx: 0, endParaIdx: 1, format: '가.', stripMarkers: true });
  h.pending.commitOpen();
  assert.deepEqual(h.body, ['사과', '배', '맺음말']);
  assert.equal(h.recorded.length, 1, '표지 지우기와 목록 서식이 한 undo 단계다');
  h.recorded[0].undo(h.wasm);
  assert.deepEqual(h.body, ['가. 사과', '나. 배', '맺음말']);
});
