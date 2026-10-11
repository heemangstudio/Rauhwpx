// 첨부가 달린 사용자 메시지는 임시 파일 승격이 끝난 뒤에만 프로바이더로 가고, 첨부는
// 신뢰하지 않는 데이터로 감싸이며, 승격 중에 Studio 가 끊기거나 채팅을 멈추면 대기 메시지가
// 세션을 붙잡지 않는지 실제 허브 + 프롬프트를 되돌려 주는 가짜 Pi 로 확인한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { connect, startLiveHub } from './live-hub-fixture.mjs';

const NOTES = 'reference notes for the staged message gate\n';

async function stage(hub, body = NOTES) {
  const url = new URL(`http://127.0.0.1:${hub.port}/reference-staging`);
  url.searchParams.set('sessionId', hub.sessionId);
  url.searchParams.set('scopeId', hub.threadId);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hub.capabilities.reference}`,
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('notes.txt'),
    },
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload.staged;
}

async function chatReferenceIds(hub) {
  const url = new URL(`http://127.0.0.1:${hub.port}/reference-files`);
  url.search = new URLSearchParams({ sessionId: hub.sessionId, scope: 'chat', scopeId: hub.threadId }).toString();
  const response = await fetch(url, { headers: { authorization: `Bearer ${hub.capabilities.reference}` } });
  const payload = await response.json();
  return (payload.files ?? payload.references ?? payload).map((file) => file.id);
}

/**
 * 임시 파일 본문을 FIFO 로 바꿔 승격이 읽기에서 멈추게 한다. release() 가 본문을 흘려보낸다.
 * 승격 경로를 결정적으로 붙잡을 다른 이음매가 없어 저장소의 임시 파일 배치를 쓴다.
 */
async function holdPromotion(t, hub, staged) {
  const dataPath = path.join(hub.root, 'references', 'staging', `.draft-${staged.id}.bin`);
  const bytes = await fs.readFile(dataPath);
  await fs.rm(dataPath);
  execFileSync('mkfifo', [dataPath]);
  let released = false;
  const release = async () => {
    if (released) return;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const handle = await fs.open(dataPath, constants.O_WRONLY | constants.O_NONBLOCK);
        await handle.write(bytes);
        await handle.close();
        released = true;
        return;
      } catch (error) {
        // 아직 읽는 쪽이 FIFO 를 열지 않았다.
        if (error?.code !== 'ENXIO' || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  t.after(() => release().catch(() => {}));
  return release;
}

function isTurnEnd(frame) {
  return frame.type === 'agent-event' && frame.event.type === 'turn-end';
}

async function promptOn(socket, hub, text) {
  hub.message(text, {}, socket);
  const delta = await socket.next((frame) => frame.type === 'chat-error'
    || (frame.type === 'agent-event' && frame.event.type === 'text-delta'));
  assert.equal(delta.type, 'agent-event', JSON.stringify(delta));
  await socket.next(isTurnEnd);
  return JSON.parse(delta.event.text).prompt;
}

const userRequest = (prompt) => prompt.split('<user_request>').at(-1).split('</user_request>')[0].trim();

test('a staged attachment reaches the provider only after promotion, wrapped as untrusted data', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  await hub.start();
  const order = [];
  hub.studio.socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'chat-reference-status') order.push(`status:${frame.attachments[0].status}`);
    if (frame.type === 'agent-event' && frame.event.type === 'turn-start') order.push('turn-start');
  });
  const staged = await stage(hub);

  hub.message('Summarize the attached notes', { messageId: 'message-1', stagedReferenceIds: [staged.id] });
  const ready = await hub.studio.next((frame) => frame.type === 'chat-reference-status'
    && frame.attachments[0].status !== 'processing');
  assert.equal(ready.attachments[0].status, 'ready', JSON.stringify(ready));
  const file = ready.attachments[0].file;
  const delta = await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
  await hub.studio.next(isTurnEnd);
  assert.deepEqual(order.slice(0, 3), ['status:processing', 'status:ready', 'turn-start']);

  const prompt = JSON.parse(delta.event.text).prompt;
  const block = /<message_attachments trust="untrusted-data">\n(.*)\n<\/message_attachments>/.exec(prompt);
  assert.ok(block, prompt);
  assert.deepEqual(JSON.parse(block[1]), [{ fileId: file.id, name: 'notes.txt', mimeType: 'text/plain', kind: file.kind }]);
  assert.ok(prompt.indexOf(block[0]) < prompt.lastIndexOf('<user_request>'));
  assert.equal(userRequest(prompt), 'Summarize the attached notes');
  assert.deepEqual(await chatReferenceIds(hub), [file.id]);
});

test('a studio disconnect during promotion drops the staged message', { timeout: 60_000, skip: process.platform === 'win32' }, async (t) => {
  const hub = await startLiveHub(t);
  await hub.start();
  const staged = await stage(hub);
  const release = await holdPromotion(t, hub, staged);

  hub.message('Use the held attachment', { messageId: 'message-held', stagedReferenceIds: [staged.id] });
  await hub.studio.next((frame) => frame.type === 'chat-reference-status' && frame.attachments[0].status === 'processing');
  hub.studio.socket.terminate();

  const studio = await connect(hub.studioUrl.replace('instance=live-hub-test', 'instance=live-hub-reload'),
    { origin: 'http://127.0.0.1:7700' });
  t.after(() => studio.socket.close());
  // 승격이 아직 멈춰 있어도 새 탭의 메시지는 막히지 않는다.
  assert.equal(userRequest(await promptOn(studio, hub, 'second')), 'second');

  await release();
  const deadline = Date.now() + 10_000;
  while ((await chatReferenceIds(hub)).length === 0) {
    assert.ok(Date.now() < deadline, 'promotion did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // 승격이 끝난 뒤에도 끊긴 탭의 메시지는 프로바이더로 가지 않는다.
  assert.equal(userRequest(await promptOn(studio, hub, 'third')), 'third');
  assert.equal(studio.frames.some((frame) => JSON.stringify(frame).includes('Use the held attachment')), false);
});

test('stopping the chat during promotion releases the staged message gate', { timeout: 60_000, skip: process.platform === 'win32' }, async (t) => {
  const hub = await startLiveHub(t);
  await hub.start();
  const staged = await stage(hub);
  const release = await holdPromotion(t, hub, staged);

  hub.message('Use the held attachment', { messageId: 'message-held', stagedReferenceIds: [staged.id] });
  await hub.studio.next((frame) => frame.type === 'chat-reference-status' && frame.attachments[0].status === 'processing');
  hub.studio.send({ type: 'chat-stop' });
  await hub.start();
  assert.equal(userRequest(await promptOn(hub.studio, hub, 'after stop')), 'after stop');
  await release();
});
