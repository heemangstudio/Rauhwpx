/**
 * 허브가 계획 승인 대기 중의 사용자 메시지를 "계획 실행" 승인으로 읽는 문구.
 *
 * rhwp-agent/planning-state.mjs 의 isExplicitImplementationApproval 과 같은 규칙이다. Studio 는 이
 * 문구 앞에 아무것도 덧붙이지 않아야 한다 — 덧붙이면 허브가 승인이 아닌 계획 수정 요청으로 읽는다.
 * 두 쪽이 같은 답을 내는지는 tests/agent-plan-approval-text.test.ts 가 허브 함수와 견주어 본다.
 *
 * node --test 가 그대로 읽도록 import 가 없다.
 */

const ENGLISH_IMPLEMENTATION_APPROVALS = new Set([
  'implement the plan',
  'implement this plan',
  'please implement the plan',
  'please implement this plan',
  'go ahead and implement the plan',
  'go ahead and implement this plan',
]);

const KOREAN_IMPLEMENTATION_APPROVALS = new Set([
  '계획을 실행해 주세요',
  '계획을 실행해주세요',
  '이 계획을 실행해 주세요',
  '이 계획을 실행해주세요',
  '계획대로 진행해 주세요',
  '계획대로 진행해주세요',
  '이 계획대로 진행해 주세요',
  '이 계획대로 진행해주세요',
]);

/** 따로 선, 뜻이 하나뿐인 계획 실행 요청인가 (허브와 같은 정규화). */
export function isPlanApprovalText(text: string): boolean {
  const candidate = text.normalize('NFKC').trim();
  if (!candidate || /[?"'‘’“”「」『』]/u.test(candidate)) return false;
  const normalized = candidate
    .toLocaleLowerCase('en-US')
    .replace(/[.!。！]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
  return ENGLISH_IMPLEMENTATION_APPROVALS.has(normalized)
    || KOREAN_IMPLEMENTATION_APPROVALS.has(normalized);
}
