// Pi 자식 에이전트 권한을 실제 허브 + 가짜 Pi 로 고정한다. 마스터 토큰 우회가 없는
// production 모드에서 루트 프로바이더 토큰만 자식을 등록할 수 있고, 자식은 프로필 밖 도구를
// 부를 수 없으며, 턴이 끝나면 자식 권한이 즉시 회수되는지 본다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { connect, startLiveHub, upgradeOutcome } from './live-hub-fixture.mjs';

// HOLD 턴이면 자기 환경(루트 토큰 등)을 알리고, release 파일이 생길 때까지 턴을 붙잡는다.
const capabilityPi = (root) => `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  const prompt = fs.readFileSync(0, 'utf8');
  const emit = (text) => console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
  emit('ENV:' + JSON.stringify({
    token: process.env.RHWP_AGENT_TOKEN,
    sessionId: process.env.RHWP_SESSION_ID,
    hubHttp: process.env.RHWP_HUB_HTTP,
    workflow: process.env.RHWP_AGENT_WORKFLOW,
    epoch: process.env.RHWP_CAPABILITY_EPOCH,
  }));
  const release = ${JSON.stringify(path.join(root, 'release'))};
  const timer = setInterval(() => {
    if (!fs.existsSync(release)) return;
    clearInterval(timer);
    fs.rmSync(release);
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }, 20);
`;

async function registerChild(env, { childId = randomUUID(), token = env.token, role = 'general', taskId = 'sa-1' } = {}) {
  const target = new URL(`/pi/subagents/${childId}`, env.hubHttp);
  target.searchParams.set('sessionId', env.sessionId);
  target.searchParams.set('taskId', taskId);
  target.searchParams.set('role', role);
  const response = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json(), childId };
}

function childSocketUrl(port, env, child) {
  const query = new URLSearchParams({
    token: child.body.token, sessionId: env.sessionId, agent: 'pi', role: child.body.agentRole,
    workflow: env.workflow, subagentId: child.childId, capabilityEpoch: env.epoch,
  });
  return `ws://127.0.0.1:${port}/mcp?${query}`;
}

async function childCatalogStatus(env, child) {
  const target = new URL('/pi/tool-definitions', env.hubHttp);
  target.search = new URLSearchParams({
    token: child.body.token, sessionId: env.sessionId, role: child.body.agentRole, subagentId: child.childId,
  }).toString();
  const response = await fetch(target);
  return { status: response.status, body: await response.json() };
}

async function holdTurn(hub) {
  hub.message('HOLD');
  const delta = await hub.studio.next((frame) => frame.type === 'agent-event'
    && frame.event.type === 'text-delta' && frame.event.text.startsWith('ENV:'));
  return JSON.parse(delta.event.text.slice('ENV:'.length));
}

test('only the active root provider identity can register a Pi child, and the child stays inside its profile', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { piScript: capabilityPi, env: { NODE_ENV: 'production' } });
  await hub.start();
  const env = await holdTurn(hub);

  // Studio 권한이나 마스터 토큰으로는 자식을 만들 수 없다.
  assert.equal((await registerChild(env, { token: hub.capabilities.studio })).status, 401);
  assert.equal((await registerChild(env, { token: 'live-hub-test' })).status, 401);

  const child = await registerChild(env);
  assert.equal(child.status, 201, JSON.stringify(child.body));
  assert.notEqual(child.body.token, env.token);

  // 자식 토큰은 손자를 만들 수 없다.
  assert.equal((await registerChild(env, { token: child.body.token, taskId: 'sa-2' })).status, 401);

  // 자식 카탈로그에는 루트 전용 도구가 없다.
  const catalog = await childCatalogStatus(env, child);
  assert.equal(catalog.status, 200);
  const names = JSON.stringify(catalog.body);
  assert.match(names, /get_document_info/);
  assert.doesNotMatch(names, /ask_user_question|update_todos/);

  // 다른 역할을 사칭한 업그레이드는 거부된다.
  const spoofed = new URL(childSocketUrl(hub.port, env, child));
  spoofed.searchParams.set('role', 'chat');
  assert.equal(await upgradeOutcome(spoofed.toString()), 401);

  const socket = await connect(childSocketUrl(hub.port, env, child));
  t.after(() => socket.socket.close());
  socket.send({ type: 'tool-call', id: 1, tool: 'ask_user_question', workflow: env.workflow, capabilityEpoch: env.epoch,
    args: { questions: [{ question: 'Pick one', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] } });
  const denied = await socket.next((frame) => frame.type === 'tool-result' && frame.id === 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PI_SUBAGENT_TOOL_DENIED');

  // 허용된 읽기 도구는 Studio 로 전달된다.
  socket.send({ type: 'tool-call', id: 2, tool: 'get_document_info', workflow: env.workflow, capabilityEpoch: env.epoch, args: {} });
  const forwarded = await hub.studio.next((frame) => frame.type === 'tool-request');
  assert.equal(forwarded.tool, 'get_document_info');
});

test('a settled turn revokes the Pi child capability and closes its socket', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { piScript: capabilityPi, env: { NODE_ENV: 'production' } });
  await hub.start();
  const env = await holdTurn(hub);
  const child = await registerChild(env);
  assert.equal(child.status, 201, JSON.stringify(child.body));
  const socket = await connect(childSocketUrl(hub.port, env, child));
  const closed = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still open'), 5_000);
    socket.socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });

  const release = path.join(hub.root, 'release');
  writeFileSync(release, '');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  assert.equal(existsSync(release), false);

  assert.equal(await closed, 4003);
  assert.equal((await childCatalogStatus(env, child)).status, 401);
  assert.equal(await upgradeOutcome(childSocketUrl(hub.port, env, child)), 401);
  // 턴 밖에서는 루트 토큰으로도 새 자식을 만들 수 없다.
  const late = await registerChild(env, { taskId: 'sa-2' });
  assert.ok([401, 409].includes(late.status), JSON.stringify(late));
});
