// 계획 실행 승인 문구 — Studio 가 앞에 안내를 붙이지 않을 문구가 허브가 승인으로 읽는 문구와 같은지 본다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlanApprovalText } from '../src/agent/plan-approval-text.ts';
import { isExplicitImplementationApproval } from '../../rhwp-agent/planning-state.mjs';

const SAMPLES = [
  '계획을 실행해 주세요', '계획을 실행해주세요', '이 계획을 실행해 주세요', '이 계획을 실행해주세요',
  '계획대로 진행해 주세요', '계획대로 진행해주세요', '이 계획대로 진행해 주세요', '이 계획대로 진행해주세요',
  '계획을 실행해 주세요.', '계획을 실행해 주세요!', '  계획을   실행해 주세요  ', '계획을 실행해 주세요。',
  'implement the plan', 'Implement this plan.', 'PLEASE IMPLEMENT THE PLAN', 'go ahead and implement this plan!',
  '계획을 실행해 주세요?', '"계획을 실행해 주세요"', '계획을 실행해 주세요 그리고 표도', '계획 실행',
  'implement the plan?', 'implement the plan now', '', '   ', '좋아요', '표를 고쳐 주세요',
  '[문서 상태] 되돌렸습니다.\n\n계획을 실행해 주세요',
];

test('Studio reads plan approval phrases exactly as the hub does', () => {
  for (const text of SAMPLES) {
    assert.equal(isPlanApprovalText(text), isExplicitImplementationApproval(text), JSON.stringify(text));
  }
  assert.equal(isPlanApprovalText('계획을 실행해 주세요.'), true);
  assert.equal(isPlanApprovalText('표를 고쳐 주세요'), false);
});
