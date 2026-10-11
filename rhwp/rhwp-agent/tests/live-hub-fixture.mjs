// 실제 server.mjs 를 띄우고 가짜 Pi CLI 로 턴을 돌리는 테스트 하네스.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

export const HUB_TOKEN = 'live-hub-test';
const LAUNCH_ID = 'live-hub-launch';

/** 받은 프롬프트를 되돌려 주고, 사용자 요청이 HOLD 면 턴을 붙잡아 두는 기본 가짜 Pi. */
export const ECHO_PI_SCRIPT = `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const prompt = require('node:fs').readFileSync(0, 'utf8').trim();
  const emit = (text) => console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
  if (prompt.split('<user_request>').at(-1).split('</user_request>')[0].trim() === 'HOLD') {
    emit('HOLD_READY');
    setInterval(() => {}, 1000);
  } else {
    emit(JSON.stringify({ prompt }));
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }
`;

export async function connect(url, options = {}) {
  const socket = new WebSocket(url, options);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  return {
    socket, frames,
    send: (frame) => socket.send(JSON.stringify({ v: 5, ...frame })),
    async next(predicate) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Missing frame. Received: ${JSON.stringify(frames).slice(-4000)}`);
    },
  };
}

/** 업그레이드가 거부되면 HTTP 상태 코드를, 열리면 'open' 을 돌려준다. */
export function upgradeOutcome(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.once('open', () => { socket.close(); resolve('open'); });
    socket.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); socket.terminate(); });
    socket.once('error', () => resolve('error'));
  });
}

/**
 * 허브와 Studio 소켓을 띄우고 Pi 채팅을 시작하는 도우미를 돌려준다.
 * piScript 는 가짜 Pi 본문이다. 템플릿 문자열 안에서 root 경로를 쓸 수 있게 root 를 받는 함수도 된다.
 * env 는 허브 프로세스 환경을 덮어쓴다(예: NODE_ENV=production 으로 마스터 토큰 우회를 끈다).
 */
export async function startLiveHub(t, {
  piScript = ECHO_PI_SCRIPT, threadId = 'thread-live', documentId = 'document-live', env = {},
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-live-hub-'));
  const piRoot = path.join(root, 'pi');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'test/plain',
    models: [{
      id: 'test/plain', name: 'Plain', reasoning: false, efforts: [], defaultEffort: null,
      contextLength: 8192, supportsImages: false, pricing: { prompt: 0, completion: 0 },
    }],
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'fixture-key' } } }));
  writeFakeCliBin(
    path.join(piRoot, 'prefix/node_modules/.bin'),
    'pi',
    typeof piScript === 'function' ? piScript(root) : piScript,
  );
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: HUB_TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID, RHWP_WORK_DIR: root, RHWP_PI_DIR: piRoot,
      RHWP_TEMPLATES_DIR: path.join(root, 'templates'), RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'),
      RHWP_REFERENCES_DIR: path.join(root, 'references'),
      ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      // 정상 종료가 막히면(예: 멈춘 파일 읽기) 강제로 끝내 테스트가 매달리지 않게 한다.
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub startup timed out: ${errors}`)), 20_000);
    lines.on('line', (line) => {
      if (!line.startsWith('RHWP_HUB_READY ')) return;
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  const port = ready.port;
  const sessionId = 'live-hub';
  const capabilities = await registerHubSession({ port, token: HUB_TOKEN, launchId: LAUNCH_ID, sessionId });
  const studioUrl = `ws://127.0.0.1:${port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=live-hub-test`;
  // production 허브는 허용된 Studio Origin 을 요구한다.
  const studio = await connect(studioUrl, { origin: 'http://127.0.0.1:7700' });
  t.after(() => studio.socket.close());
  let seq = 0;
  const start = async (selection = {}, socket = studio) => {
    const requestId = `start-${++seq}`;
    socket.send({ type: 'chat-start', requestId, agent: 'pi', model: 'test/plain',
      threadId, documentId, documentName: 'live.hwpx', ...selection });
    const started = await socket.next((frame) => frame.requestId === requestId);
    assert.equal(started.type, 'chat-started', JSON.stringify(started));
    return started;
  };
  const message = (text, extra = {}, socket = studio) => socket.send({
    type: 'chat-user-message', text, threadId, documentId, ...extra,
  });
  /** 한 턴을 돌리고 프로바이더가 받은 프롬프트를 돌려준다. */
  const promptOf = async (text, extra = {}) => {
    message(text, extra);
    const delta = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
    await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
    return JSON.parse(delta.event.text).prompt;
  };
  return { root, studio, studioUrl, start, message, promptOf, port, sessionId, capabilities, threadId };
}
