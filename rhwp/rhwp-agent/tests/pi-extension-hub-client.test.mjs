// pi 확장 팩토리(default export)를 가짜 pi 와 가짜 허브(HTTP 도구 정의 + /mcp WS)에 붙여,
// 등록된 도구가 실제로 허브를 부르는 경로의 타임아웃과 이미지 경로 정책을 확인한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import rhwpPiExtension from '../pi/extension/rhwp.ts';

const DEFINITIONS = ['get_document_info', 'ask_user_question', 'insert_image'].map((name) => ({
  name, description: name, inputSchema: { type: 'object', properties: {} },
}));

async function fakeHub(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(DEFINITIONS));
  });
  const wss = new WebSocketServer({ server, path: '/mcp' });
  const calls = [];
  let socket = null;
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => calls.push(JSON.parse(String(data))));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(resolve));
  }));
  return {
    port: server.address().port,
    calls,
    reply: (frame) => socket.send(JSON.stringify(frame)),
  };
}

async function loadExtension(t, hub, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    RHWP_HUB_HTTP: `http://127.0.0.1:${hub.port}`,
    RHWP_WS_URL: `ws://127.0.0.1:${hub.port}/mcp`,
    RHWP_AGENT_TOKEN: 'pi-extension-token',
    RHWP_SESSION_ID: 'pi-extension-session',
    RHWP_AGENT_WORKFLOW: 'direct',
    ...env,
  });
  const tools = new Map();
  const handlers = new Map();
  try {
    await rhwpPiExtension({
      on: (event, handler) => handlers.set(event, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  t.after(() => handlers.get('session_shutdown')?.());
  assert.deepEqual([...tools.keys()].sort(), DEFINITIONS.map((definition) => definition.name).sort());
  return tools;
}

/** 180 초 호출 타임아웃만 50 ms 로 줄인다. */
function shortenCallTimeout(t) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => real(fn, ms === 180_000 ? 50 : ms, ...rest);
  t.after(() => { globalThis.setTimeout = real; });
}

async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Pi user questions outlive the ordinary tool-call timeout', { timeout: 20_000 }, async (t) => {
  const hub = await fakeHub(t);
  const tools = await loadExtension(t, hub);
  shortenCallTimeout(t);

  await assert.rejects(tools.get('get_document_info').execute('call-1', {}), /TOOL_TIMEOUT/);

  const question = tools.get('ask_user_question').execute('call-2', { questions: [] });
  await until(() => hub.calls.some((call) => call.tool === 'ask_user_question'), 'question call');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const call = hub.calls.find((entry) => entry.tool === 'ask_user_question');
  hub.reply({ type: 'tool-result', id: call.id, ok: true, result: { answers: [{ id: 'q1', selected: ['A'] }] } });
  const result = await question;
  assert.match(result.content[0].text, /"selected"/);
});

test('Pi insert_image applies the safe image path policy before reading or calling the hub', { timeout: 20_000 }, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'rhwp-pi-image-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  const outsideImage = path.join(temp, 'secret.png');
  await writeFile(outsideImage, Buffer.from('not read'));
  const hub = await fakeHub(t);
  const tools = await loadExtension(t, hub, { RHWP_ROOT_DIR: workspace, RHWP_PERMISSION_PROFILE: 'safe' });

  await assert.rejects(
    tools.get('insert_image').execute('call-1', { imagePath: outsideImage }),
    /IMAGE_PATH_NOT_APPROVED/,
  );
  assert.equal(hub.calls.length, 0);
});
