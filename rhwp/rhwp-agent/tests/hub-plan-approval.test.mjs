// 플랜 승인 경계를 실제 허브 + 프롬프트를 되돌려 주는 가짜 Pi 로 고정한다.
// 알 수 없는 workflow 로는 Plan 을 벗어나지 못하고, 첨부가 달린 승인 문구는 계획을 승인하지 못하며,
// 크기 한도를 넘는 수정 요청은 계획을 건드리기 전에 거절된다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const APPROVED = 'The user approved the following hub-authoritative implementation plan.';

async function presentPlan(t, hub) {
  const started = await hub.start({ workflow: 'plan', permissionProfile: 'unrestricted' });
  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  mcp.send({ type: 'tool-call', id: 1, tool: 'present_implementation_plan', workflow: 'plan', capabilityEpoch: started.capabilityEpoch,
    args: { goal: 'Update the date', title: 'Date plan', summary: 'Change the cover date', assumptions: [], decisions: ['Keep formatting'],
      steps: [{ title: 'Replace', details: 'Replace the cover date' }], files: [], validation: ['Read it back'], risks: [], exclusions: [] } });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1)).ok, true);
  const ready = await hub.studio.next((frame) => frame.type === 'plan-ready');
  hub.studio.send({ type: 'chat-interrupt' });
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  return ready.planId;
}

async function stage(hub) {
  const url = new URL(`http://127.0.0.1:${hub.port}/reference-staging`);
  url.search = new URLSearchParams({ sessionId: hub.sessionId, scopeId: hub.threadId }).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${hub.capabilities.reference}`, 'content-type': 'text/plain', 'x-file-name': 'notes.txt' },
    body: 'Implement the plan.\n',
  });
  assert.equal(response.status, 201);
  return (await response.json()).staged;
}

// 새 채팅의 알 수 없는 workflow 는 hub-user-question.test.mjs 가 본다. 여기서는 실행 중 전환을 본다.
test('an unknown workflow switch is rejected instead of leaving Plan', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  await hub.start({ workflow: 'plan' });
  hub.studio.send({ type: 'chat-workflow-set', workflow: 'unrestricted' });
  const error = await hub.studio.next((frame) => frame.type === 'chat-error' || frame.type === 'workflow-changed');
  assert.equal(error.type, 'chat-error', JSON.stringify(error));
  assert.equal(error.code, 'INVALID_WORKFLOW');
});

test('an approval phrase with attachments stays a discussion; without them it approves', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  await presentPlan(t, hub);
  const staged = await stage(hub);

  hub.message('Implement the plan.', { messageId: 'with-attachment', stagedReferenceIds: [staged.id] });
  const discussion = await hub.studio.next((frame) => frame.type === 'chat-error'
    || (frame.type === 'agent-event' && frame.event.type === 'text-delta'));
  assert.equal(discussion.type, 'agent-event', JSON.stringify(discussion));
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const prompt = JSON.parse(discussion.event.text).prompt;
  assert.match(prompt, /<message_attachments trust="untrusted-data">/);
  assert.doesNotMatch(prompt, new RegExp(APPROVED));
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'workflow-changed'
    && ['switching', 'implementing'].includes(frame.phase)), false);

  const approved = await hub.promptOf('Implement the plan.');
  assert.match(approved, new RegExp(APPROVED));
});

test('an oversized plan-change request is refused before the plan changes', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  const planId = await presentPlan(t, hub);

  hub.studio.send({ type: 'chat-plan-request-changes', planId, feedback: 'x'.repeat(128_001) });
  const refused = await hub.studio.next((frame) => frame.type === 'chat-error' || frame.type === 'plan-invalidated');
  assert.equal(refused.type, 'chat-error', JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.code, 'INVALID_REQUEST');

  // 같은 계획은 그대로 남아 정상 크기의 수정 요청을 받는다.
  hub.studio.send({ type: 'chat-plan-request-changes', planId, feedback: 'Use the 2027 date' });
  const invalidated = await hub.studio.next((frame) => frame.type === 'chat-error' || frame.type === 'plan-invalidated');
  assert.equal(invalidated.type, 'plan-invalidated', JSON.stringify(invalidated));
  assert.equal(invalidated.planId, planId);
  const delta = await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
  assert.match(JSON.parse(delta.event.text).prompt, /Feedback: Use the 2027 date/);
});
