import assert from 'node:assert/strict';
import test from 'node:test';
import { retainMissedAgentText, replayMissedAgentText } from '../agent-stream-replay.mjs';
import { replayMissedTurnEnd } from '../turn-outcome-replay.mjs';
import { createStudioFrameCoalescer } from '../studio-frame-coalescer.mjs';

const delta = (text, extra = {}) => ({ type: 'text-delta', agent: 'codex', turnId: 'turn', text, ...extra });

test('offline root and child text replays in order before the missed terminal event exactly once', () => {
  const record = { missedTurnEnd: { type: 'turn-end', turnId: 'turn', stopReason: 'completed' } };
  retainMissedAgentText(record, delta('확인 '));
  retainMissedAgentText(record, delta('완료'));
  retainMissedAgentText(record, delta('자식', { parentTaskId: 'child' }));
  const sent = [];
  const send = (_socket, frame) => { sent.push(frame.event); return true; };
  assert.equal(replayMissedAgentText(record, {}, send), true);
  replayMissedTurnEnd(record, {}, send);
  replayMissedAgentText(record, {}, send);
  assert.deepEqual(sent.map((event) => event.text ?? event.type), ['확인 완료', '자식', 'turn-end']);
});

test('a failed replay retains only unsent text for the next reconnect', () => {
  const record = {};
  retainMissedAgentText(record, delta('root'));
  retainMissedAgentText(record, delta('child', { parentTaskId: 'child' }));
  let calls = 0;
  assert.equal(replayMissedAgentText(record, {}, () => ++calls === 1), false);
  const remaining = [];
  replayMissedAgentText(record, {}, (_socket, frame) => { remaining.push(frame.event.text); return true; });
  assert.deepEqual(remaining, ['child']);
});

test('the offline UTF-8 buffer is bounded and reports overflow instead of silent truncation', () => {
  const record = {};
  retainMissedAgentText(record, delta('한글'), { maxBytes: 6 });
  retainMissedAgentText(record, delta('!'), { maxBytes: 6 });
  assert.equal(record.missedAgentText.bytes, 6);
  const sent = [];
  replayMissedAgentText(record, {}, (_socket, frame) => { sent.push(frame.event); return true; });
  assert.equal(sent[0].text, '한글');
  assert.equal(sent[1].type, 'error');
  assert.match(sent[1].message, /exceeded the replay buffer/);
});

test('a socket close returns the coalesced but unsent frame for replay', () => {
  const socket = { OPEN: 1, readyState: 1 };
  const coalescer = createStudioFrameCoalescer({ write() { assert.fail('closed socket must not send'); } });
  coalescer.pushTextDelta(socket, { event: delta('last ') });
  coalescer.pushTextDelta(socket, { event: delta('tokens') });
  socket.readyState = 3;
  const pending = coalescer.discard(socket);
  assert.equal(pending.event.text, 'last tokens');
  assert.equal(coalescer.discard(socket), undefined);
});
