import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

// 창 닫기와 채팅 중지가 겹쳐도 공급자가 종료되기 전에는 작업 폴더를 지우지 않는다.
test('closing a hub session awaits provider cleanup already started by chat-stop', {
  timeout: 30_000,
  skip: process.platform === 'win32' ? 'POSIX graceful SIGTERM fixture' : false,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cleanup-race-'));
  const piRoot = path.join(root, 'pi');
  const running = path.join(root, 'running.json');
  const stopping = path.join(root, 'stopping');
  const release = path.join(root, 'release');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'test/plain',
    models: [{ id: 'test/plain', name: 'Plain', reasoning: false, efforts: [], defaultEffort: null,
      contextLength: 8192, supportsImages: false, pricing: { prompt: 0, completion: 0 } }],
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'fixture-key' } },
  }));
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(running)}, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(stopping)}, '');
    });
    setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);
  `);
  const token = 'cleanup-race-token';
  const launchId = 'cleanup-race-launch';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId, RHWP_WORK_DIR: path.join(root, 'work'),
      RHWP_REFERENCES_DIR: path.join(root, 'references'), RHWP_PROJECTS_DIR: path.join(root, 'projects'),
      RHWP_PI_DIR: piRoot, RHWP_TEMPLATES_DIR: path.join(root, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'), RHWP_HOME_ACCESS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  t.after(async () => {
    writeFileSync(release, '');
    if (child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub startup timed out: ${errors}`)), 10_000);
    lines.on('line', (line) => {
      if (!line.startsWith('RHWP_HUB_READY ')) return;
      clearTimeout(timer);
      resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  t.after(() => lines.close());
  const sessionId = 'cleanup-race';
  const capability = await registerHubSession({ port: ready.port, token, launchId, sessionId });
  const studio = new WebSocket(`ws://127.0.0.1:${ready.port}/studio?token=${capability.studio}&sessionId=${sessionId}`);
  const frames = [];
  studio.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(studio, 'open');
  t.after(() => studio.terminate());
  const send = (message) => studio.send(JSON.stringify({ v: 5, ...message }));
  send({ type: 'chat-start', requestId: 'start', agent: 'pi', model: 'test/plain',
    threadId: 'cleanup-thread', documentId: null });
  await until(() => frames.some((frame) => frame.type === 'chat-started'), 'chat-started missing');
  send({ type: 'chat-user-message', text: 'hold', threadId: 'cleanup-thread', documentId: null });
  await until(() => existsSync(running), 'provider did not start');
  const { cwd, pid } = JSON.parse(readFileSync(running, 'utf8'));
  send({ type: 'chat-stop' });
  await until(() => existsSync(stopping), 'provider did not receive SIGTERM');

  let deleted = false;
  const deletion = fetch(`http://127.0.0.1:${ready.port}/sessions/${sessionId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'X-Rhwp-Launch-Id': launchId },
  }).then((response) => { deleted = true; return response; });
  // 삭제가 시작돼 capability 가 폐기된 시점을 기다린 뒤 아직 살아 있는 작업 폴더를 확인한다.
  await until(async () => {
    const response = await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const health = await response.json();
    return health.sessions.every((session) => session.sessionId !== sessionId);
  }, 'owner delete did not revoke the session');
  assert.doesNotThrow(() => process.kill(pid, 0), 'fixture provider is still alive');
  assert.equal(existsSync(cwd), true, 'provider workspace must remain while cleanup is pending');
  assert.equal(deleted, false, 'owner delete must await the in-flight cleanup');
  writeFileSync(release, '');
  assert.equal((await deletion).status, 200);
  assert.equal(existsSync(cwd), false, 'workspace is removed after proven provider exit');
});
