import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { replayMissedTurnEnd } from '../turn-outcome-replay.mjs';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

// release 파일이 생길 때까지 턴을 붙잡는 가짜 Pi.
const heldPi = (root) => `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  fs.readFileSync(0, 'utf8');
  console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'HELD' } }));
  const release = ${JSON.stringify(path.join(root, 'release'))};
  const timer = setInterval(() => {
    if (!fs.existsSync(release)) return;
    clearInterval(timer);
    fs.rmSync(release);
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }, 20);
`;

test('missed terminal outcome is delivered before reconnect welcome', () => {
  const event = { type: 'turn-end', outcome: 'success' };
  const record = { missedTurnEnd: event };
  const frames = [];
  const sendJson = (_socket, frame) => {
    frames.push(frame);
    return true;
  };

  assert.equal(replayMissedTurnEnd(record, {}, sendJson), true);
  sendJson({}, { v: 1, type: 'welcome' });

  assert.equal(frames[0].type, 'agent-event');
  assert.equal(frames[0].event, event);
  assert.equal(frames[1].type, 'welcome');
  assert.equal(record.missedTurnEnd, null);
});

test('failed replay keeps the terminal outcome for the next reconnect', () => {
  const event = { type: 'turn-end', outcome: 'failed' };
  const record = { missedTurnEnd: event };

  assert.equal(replayMissedTurnEnd(record, {}, () => false), false);
  assert.equal(record.missedTurnEnd, event);

  const frames = [];
  assert.equal(replayMissedTurnEnd(record, {}, (_socket, frame) => {
    frames.push(frame);
    return true;
  }), true);
  assert.equal(frames[0].event, event);
  assert.equal(record.missedTurnEnd, null);
});

test('a turn that ends while Studio is away is replayed before the reconnect welcome', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { piScript: heldPi });
  await hub.start();
  hub.message('work');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HELD');
  hub.studio.socket.terminate();

  writeFileSync(path.join(hub.root, 'release'), '');
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${hub.port}/healthz`, { headers: { authorization: `Bearer ${HUB_TOKEN}` } });
    const summary = (await response.json()).sessions.find((entry) => entry.sessionId === hub.sessionId);
    if (!existsSync(path.join(hub.root, 'release')) && summary?.studioConnected === false
      && summary?.session?.status === 'idle') break;
    assert.ok(Date.now() < deadline, `turn did not settle: ${JSON.stringify(summary)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const studio = await connect(hub.studioUrl, { origin: 'http://127.0.0.1:7700' });
  t.after(() => studio.socket.close());
  const isTurnEnd = (frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end';
  const first = await studio.next((frame) => frame.type === 'welcome' || isTurnEnd(frame));
  assert.ok(isTurnEnd(first), `the missed outcome must precede welcome: ${first.type}`);
  await studio.next((frame) => frame.type === 'welcome');
});
