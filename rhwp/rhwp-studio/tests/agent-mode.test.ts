import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentModeFor, agentModeTarget, writesApplyDirectly } from '../src/agent/types.ts';

test('네 모드는 와이어의 (workflow, permissionProfile) 쌍으로 오가며 되돌아온다', () => {
  assert.deepEqual(agentModeTarget('chat'), { workflow: 'question', permissionProfile: 'safe' });
  assert.deepEqual(agentModeTarget('plan'), { workflow: 'plan', permissionProfile: 'safe' });
  assert.deepEqual(agentModeTarget('agent'), { workflow: 'direct', permissionProfile: 'safe' });
  assert.deepEqual(agentModeTarget('full'), { workflow: 'direct', permissionProfile: 'unrestricted' });
  assert.equal(agentModeFor('question', 'questioning', 'unrestricted'), 'chat');
  assert.equal(agentModeFor('plan', 'awaiting-approval', 'unrestricted'), 'plan');
  assert.equal(agentModeFor('direct', 'direct', 'safe'), 'agent');
  assert.equal(agentModeFor('direct', 'direct', 'unrestricted'), 'full');
});

test('승인된 계획은 승인 때 고른 프로필의 모드로 실행되고, 전체만 쓰기를 바로 반영한다', () => {
  assert.equal(agentModeFor('plan', 'implementing', 'safe'), 'agent');
  assert.equal(agentModeFor('plan', 'implementing', 'unrestricted'), 'full');
  assert.equal(writesApplyDirectly('plan', 'implementing', 'unrestricted'), true);
  assert.equal(writesApplyDirectly('plan', 'implementing', 'safe'), false);
  assert.equal(writesApplyDirectly('plan', 'planning', 'unrestricted'), false);
  assert.equal(writesApplyDirectly('direct', 'direct', 'unrestricted'), true);
  assert.equal(writesApplyDirectly('direct', 'direct', 'safe'), false);
  assert.equal(writesApplyDirectly('question', 'questioning', 'unrestricted'), false);
  assert.equal(writesApplyDirectly('question', 'implementing', 'unrestricted'), false);
});
