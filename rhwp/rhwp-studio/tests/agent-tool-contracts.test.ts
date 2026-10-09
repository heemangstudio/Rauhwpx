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
import { expectErr, makeEnv } from './agent-test-env.ts';

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
