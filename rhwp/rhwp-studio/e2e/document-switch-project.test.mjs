/**
 * 다른 문서를 열면 그 문서의 채팅과 프로젝트가 처음부터 새 문서 이름으로 선다.
 *
 * 문서를 여는 동안 세션의 documentId 는 먼저 새 문서로 바뀌고 엔진에는 아직 앞 문서가 남는다. 그 사이에
 * 사이드바가 문맥을 읽으면 새 문서 id 와 앞 문서 이름으로 채팅을 시작해, 허브가 새 문서의 프로젝트를 앞 문서
 * 이름으로 만들었다(제보: 새 문서의 자료가 앞 문서 프로젝트에 쌓인다). 실제 Studio + 허브 + WASM 에서
 * 새 문서를 연 뒤 샘플 파일을 열고, 브리지가 그 문서 id 로 보낸 프레임과 허브의 세션·프로젝트를 본다.
 * 실행: node e2e/document-switch-project.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import {
  ensureChromePath, findAvailablePort, openSample, startHub, stopServer, studioRoot, writeFakePi,
} from './agent-bench-harness.mjs';

ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-document-switch-e2e-'));
const { piRoot } = writeFakePi(fixtureRoot);
const hubPort = await findAvailablePort(5880);
const vitePort = await findAvailablePort(7880);
const token = randomUUID();
const SAMPLE = 'text-align-2.hwp';
let hub;
let vite;

async function hubChat() {
  const response = await fetch(`http://127.0.0.1:${hubPort}/healthz`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  return snapshot.sessions.find((row) => row.studioConnected && row.session)?.session ?? null;
}

async function until(label, read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  hub = await startHub({
    hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'document-switch-project-e2e-hub.log',
  });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`;
  process.env.RHWP_AGENT_TOKEN = token;
  process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({
    configFile: path.join(studioRoot, 'vite.config.ts'),
    cacheDir: path.join(fixtureRoot, 'vite-cache'),
    server: {
      host: '127.0.0.1', port: vitePort, strictPort: true, open: false,
      fs: { allow: [studioRoot, fs.realpathSync(path.join(studioRoot, '..', 'pkg')),
        path.join(studioRoot, '..', 'samples'), path.join(studioRoot, '..', 'npm', 'editor')] },
    },
    logLevel: 'warn',
  });
  await vite.listen();
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { runTest, createNewDocument, waitForState } = await import('./helpers.mjs');

  await runTest('다른 문서를 열면 채팅과 프로젝트가 새 문서 이름으로 선다', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'chat',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'real editor and hub ready', () => Boolean(window.__wasm)
      && window.__agentBridge?.getConnectionState() === 'connected');

    await createNewDocument(page);
    const previous = await page.evaluate(() => window.__documentSessions.attached().documentId);
    await until('the new document chat on the hub', async () => (await hubChat())?.documentId === previous);

    // 브리지가 허브로 보내는 채팅·프로젝트 프레임을 모두 적는다.
    await page.evaluate(() => {
      window.__sentFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function record(data) {
        try {
          const frame = JSON.parse(String(data));
          if (['chat-start', 'project-bind', 'chat-link-document', 'chat-user-message'].includes(frame.type)) {
            window.__sentFrames.push({ type: frame.type, documentId: frame.documentId ?? null, documentName: frame.documentName ?? null });
          }
        } catch {}
        return send.call(this, data);
      };
    });

    await openSample(page, SAMPLE);
    const opened = await page.evaluate(() => window.__documentSessions.attached().documentId);
    assert.ok(opened && opened !== previous, 'the sample opened as another document');
    const session = await until('the opened document chat on the hub', async () => {
      const chat = await hubChat();
      return chat?.documentId === opened ? chat : null;
    });
    assert.equal(session.documentName, SAMPLE, 'the hub chat carries the opened document name');

    const frames = await page.evaluate((id) => window.__sentFrames.filter((frame) => frame.documentId === id), opened);
    assert.ok(frames.some((frame) => frame.type === 'chat-start'), `a chat started for the opened document: ${JSON.stringify(frames)}`);
    for (const frame of frames) {
      if (frame.type === 'chat-user-message') continue;
      assert.equal(frame.documentName, SAMPLE, `${frame.type} for the opened document carries its own name: ${JSON.stringify(frames)}`);
    }

    const project = await until('the opened document project', () => page.evaluate((id) => {
      const current = window.__agentBridge.projects?.store.get();
      return current?.members.some((member) => member.documentId === id) ? current : null;
    }, opened));
    assert.equal(project.name, SAMPLE.replace(/\.hwp$/, ''));
    assert.deepEqual(project.members.map((member) => member.name), [SAMPLE]);
  });
} finally {
  if (vite) await vite.close();
  if (hub) await stopServer(hub);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
