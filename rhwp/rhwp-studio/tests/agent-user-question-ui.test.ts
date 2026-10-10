import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

test('an answer sent while offline is resent with the same responseId after reconnecting', () => {
  const sent: any[] = [];
  let online = false;
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    requestSeq: 0,
    pendingQuestionAnswer: null,
    sendJson: (frame: unknown) => { if (online) sent.push(frame); return online; },
  });
  const answers = { q1: { selectedOptionIds: ['a'] } };
  const responseId = bridge.answerUserQuestion('interaction-1', answers);
  assert.equal(sent.length, 0);

  online = true;
  bridge.flushPendingQuestionAnswer();
  bridge.flushPendingQuestionAnswer();
  assert.equal(sent.length, 2);
  for (const frame of sent) {
    assert.equal(frame.type, 'user-question-answer');
    assert.equal(frame.interactionId, 'interaction-1');
    assert.equal(frame.responseId, responseId, 'the hub dedupes a resent answer by responseId');
    assert.deepEqual(frame.answers, answers);
  }
});
