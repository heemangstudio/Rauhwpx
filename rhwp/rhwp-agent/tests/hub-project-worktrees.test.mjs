// 실제 허브 두 세션: 같은 문서의 두 작업 공간 채팅이 한 프로젝트를 함께 쓰고, 동시에 고쳐도
// 둘 다 반영되며 양쪽이 같은 변경 이벤트를 받는다. 허브가 다시 뜬 뒤에는 project-bind 만으로
// 다음 메시지 없이 프로젝트 HTTP 가 다시 통한다. 프롬프트에는 다른 작업 공간 항목의 wt 가 실린다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

const token = 'project-worktrees-test';
const launchId = 'project-worktrees-launch';
const REPOSITORY = 'repo-worktrees';
const WORKTREES = [
  { id: 'wt-main', branch: 'main', primary: true, documentId: 'doc-main' },
  { id: 'wt-variant', branch: '요약본', primary: false, documentId: 'doc-variant' },
];
const repositoryFields = (current) => ({
  repositoryId: REPOSITORY,
  worktree: (({ id, branch, primary }) => ({ id, branch, primary }))(WORKTREES.find((entry) => entry.id === current)),
  worktrees: WORKTREES,
});

async function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify({ v: 5, ...frame })),
    async next(predicate) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Missing frame. Received: ${JSON.stringify(frames).slice(-3000)}`);
    },
  };
}

function writeFakePi(piRoot) {
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
  // 받은 프롬프트를 그대로 돌려준다.
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const prompt = require('node:fs').readFileSync(0, 'utf8').trim();
    console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify({ prompt }) } }));
    console.log(JSON.stringify({ type: 'agent_settled' }));
  `);
}

async function startHub(t, root) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token, RHWP_LAUNCH_ID: launchId,
      RHWP_WORK_DIR: root, RHWP_REFERENCES_DIR: path.join(root, 'references'), RHWP_PROJECTS_DIR: path.join(root, 'projects'),
      RHWP_PI_DIR: path.join(root, 'pi'), RHWP_TEMPLATES_DIR: path.join(root, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'), RHWP_HOME_ACCESS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const stop = async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  };
  t.after(stop);
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
  const base = `http://127.0.0.1:${ready.port}`;
  const session = async (sessionId) => {
    const capabilities = await registerHubSession({ port: ready.port, token, launchId, sessionId });
    const http = (route, init = {}) => fetch(`${base}${route}${route.includes('?') ? '&' : '?'}sessionId=${sessionId}`, {
      ...init,
      headers: { Authorization: `Bearer ${capabilities.reference}`, ...(init.headers ?? {}) },
    });
    const studio = await connect(`ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=${sessionId}`);
    t.after(() => studio.socket.close());
    return { http, studio };
  };
  return { session, stop };
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('worktree chats share one project, edit it concurrently, and rebind after a hub restart', { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-worktrees-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFakePi(path.join(root, 'pi'));
  let hub = await startHub(t, root);
  const main = await hub.session('worktree-main');
  const settings = await main.http('/project-settings', { ...json({ settings: { librarian: { enabled: false } } }), method: 'PUT' });
  assert.equal(settings.status, 200);

  // 기본 작업 공간 채팅이 프로젝트를 만든다.
  main.studio.send({ type: 'chat-start', requestId: 'start-main', agent: 'pi', model: 'test/plain', workflow: 'direct',
    threadId: 'thread-main', documentId: 'doc-main', documentName: '보고서.hwpx', ...repositoryFields('wt-main') });
  assert.equal((await main.studio.next((frame) => frame.requestId === 'start-main')).type, 'chat-started');
  const { projectId } = await main.studio.next((frame) => frame.type === 'project-bound');

  // 변형 작업 공간 채팅은 메시지 없이 project-bind 만으로 같은 프로젝트에 묶인다.
  const variant = await hub.session('worktree-variant');
  assert.equal((await variant.http('/projects/current')).status, 409);
  variant.studio.send({ type: 'project-bind', threadId: 'thread-variant', documentId: 'doc-variant', documentName: '보고서.hwpx', ...repositoryFields('wt-variant') });
  assert.equal((await variant.studio.next((frame) => frame.type === 'project-bound')).projectId, projectId);

  // 두 작업 공간이 동시에 고친다 — 프로젝트 쓰기 줄이 하나씩 차례로 반영한다.
  const notes = (who, count) => Array.from({ length: count }, (_, index) => ({ op: 'note', name: `${who} 메모 ${index}`, body: `${who} ${index}` }));
  const results = await Promise.all([
    ...[0, 1, 2].map((batch) => main.http(`/projects/${projectId}/ops`, json({ ops: notes(`main-${batch}`, 3) }))),
    ...[0, 1, 2].map((batch) => variant.http(`/projects/${projectId}/ops`, json({ ops: notes(`variant-${batch}`, 3) }))),
  ]);
  for (const response of results) assert.equal(response.status, 200, await response.clone().text());
  const revisions = (await Promise.all(results.map((response) => response.json()))).map((result) => result.revision).sort((a, b) => a - b);
  assert.equal(new Set(revisions).size, 6, 'every batch got its own revision');
  const { project } = await (await variant.http('/projects/current')).json();
  assert.equal(project.items.length, 18);
  for (const item of project.items) {
    const expected = item.title.startsWith('main') ? 'wt-main' : 'wt-variant';
    assert.equal(item.origin?.worktreeId, expected, `${item.title} is labeled with the worktree that made it`);
  }
  for (const studio of [main.studio, variant.studio]) {
    await studio.next((frame) => frame.type === 'project-changed' && frame.project.revision === revisions.at(-1) && frame.project.items.length === 18);
  }

  // 변형 쪽 사용자가 기본 쪽 메모를 공통으로 돌린다.
  const mainNote = project.items.find((item) => item.title === 'main-0 메모 0');
  const variantNote = project.items.find((item) => item.title === 'variant-0 메모 0');
  const relabeled = await variant.http(`/projects/${projectId}/ops`, json({ ops: [{ op: 'label', id: mainNote.id, origin: 'shared' }] }));
  assert.equal(relabeled.status, 200, await relabeled.clone().text());

  // 기본 쪽 프롬프트: 지금 작업 공간과, 변형에서 모은 항목의 wt.
  main.studio.send({ type: 'chat-user-message', text: '정리해 주세요', threadId: 'thread-main', documentId: 'doc-main', mentions: [variantNote.id] });
  const delta = await main.studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'text-delta' && frame.event.text.startsWith('{'));
  const block = /<research_project trust="untrusted-data">\n(.*)\n<\/research_project>/.exec(JSON.parse(delta.event.text).prompt);
  assert.ok(block);
  const payload = JSON.parse(block[1]);
  assert.deepEqual(payload.worktree, { branch: 'main', primary: true });
  assert.equal(payload.mentioned[0].wt, '요약본');
  const top = payload.project.board.flatMap((column) => column.top ?? []);
  assert.ok(top.length > 0 && top.every((entry) => (entry.id === mainNote.id || entry.title.startsWith('main') ? !entry.wt : entry.wt === '요약본')));

  // 허브가 다시 뜬다. 새 세션 기록은 비어 있고, Studio 가 다시 붙으며 보내는 project-bind 로 곧장 묶인다.
  await hub.stop();
  hub = await startHub(t, root);
  const reattached = await hub.session('worktree-variant');
  assert.equal((await reattached.http('/projects/current')).status, 409);
  reattached.studio.send({ type: 'project-bind', threadId: 'thread-variant', documentId: 'doc-variant', documentName: '보고서.hwpx', ...repositoryFields('wt-variant') });
  const rebound = await reattached.studio.next((frame) => frame.type === 'project-bound');
  assert.equal(rebound.projectId, projectId);
  const current = await reattached.http('/projects/current');
  assert.equal(current.status, 200);
  assert.equal((await current.json()).project.items.length, 18);
  const blob = await reattached.http(`/projects/${projectId}/notes/${variantNote.id}`);
  assert.equal(blob.status, 200);
});
