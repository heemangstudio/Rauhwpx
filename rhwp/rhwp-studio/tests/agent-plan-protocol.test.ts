import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_PROTOCOL_VERSION, isStructuredPlan } from '../src/agent/types.ts';

test('planning and user-input protocol uses v5 and validates the complete structured plan', () => {
  assert.equal(AGENT_PROTOCOL_VERSION, 5);
  const plan = {
    planId: 'plan-1',
    title: '정리 계획',
    goal: '문서 정리',
    summary: '구조와 서식을 정리한다.',
    assumptions: ['내용은 유지'],
    decisions: ['제목 스타일 통일'],
    steps: [{ title: '검토', details: '문서 구조를 읽는다.', files: ['a.hwpx'] }],
    files: ['a.hwpx'],
    validation: ['페이지 렌더'],
    risks: ['줄바꿈 변경'],
    exclusions: ['내용 추가'],
    createdAt: '2026-08-07T00:00:00.000Z',
    epoch: 2,
  };
  assert.equal(isStructuredPlan(plan), true);
  assert.equal(isStructuredPlan({ ...plan, risks: undefined }), false);
  // 단계는 한 줄 todo 다 — details 없이도 유효하다.
  assert.equal(isStructuredPlan({ ...plan, steps: [{ title: '문서 구조 검토' }] }), true);
  assert.equal(isStructuredPlan({ ...plan, steps: [{ details: '제목 없음' }] }), false);
  const executing = {
    ...plan,
    revision: 2,
    previousPlanId: 'plan-0',
    changeSummary: '도입부를 간결하게 수정합니다.',
    documentRevision: 12,
    sources: [{ title: '참고자료', url: 'https://example.com/report', note: '문서 구성의 근거' }],
    steps: [{ id: 'step-1', title: '검토', details: '문서 구조를 읽는다.', target: '도입부', preview: '제안 문구' }],
    execution: { status: 'running', steps: [{ stepId: 'step-1', status: 'in-progress' }] },
  };
  assert.equal(isStructuredPlan(executing), true);
  for (const execution of [
    { status: 'running', steps: [] },
    { status: 'completed', steps: [{ stepId: 'todo-1', title: 7, status: 'completed' }] },
    { status: 'running', steps: [{ stepId: 'step-1', status: 'unknown' }] },
    { status: ['running'], steps: [{ stepId: 'step-1', status: 'pending' }] },
  ]) assert.equal(isStructuredPlan({ ...executing, execution }), false);
  // update_todos 는 계획에 없던 할 일을 더할 수 있다.
  assert.equal(isStructuredPlan({ ...executing, execution: { status: 'running', steps: [
    { stepId: 'step-1', status: 'completed' }, { stepId: 'todo-1', title: '맞춤법 다시 확인', status: 'in-progress' },
  ] } }), true);
  assert.equal(isStructuredPlan({ ...executing, revision: -1 }), false);
  assert.equal(isStructuredPlan({ ...executing, sources: [{ title: '자료', url: {} }] }), false);
  assert.equal(isStructuredPlan({ ...executing,
    steps: [...executing.steps, { ...executing.steps[0], id: 'step-2' }],
    execution: { status: 'running', steps: [executing.execution.steps[0], executing.execution.steps[0]] },
  }), false);
});
