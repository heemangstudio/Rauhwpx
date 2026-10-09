// 실제 허브 + 가짜 Pi 로 연구 프로젝트 연결을 고정한다: 채팅 시작 → project-bound, HTTP 업로드 →
// project-changed, 턴 안의 MCP project_* 호출, 다음 턴 프롬프트의 research_project 블록.
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

const token = 'research-project-test';
const launchId = 'research-project-launch';
const THREAD = 'thread-research';
const DOCUMENT = 'document-research';

async function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  return {
    socket,
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

test('a chat binds its document project, and project tools, HTTP and prompt context share it', { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-research-'));
  const piRoot = path.join(root, 'pi');
  const release = path.join(root, 'release-turn');
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
  // 사용자 요청이 HOLD 면 release 파일이 생길 때까지 턴을 붙잡고, 아니면 받은 프롬프트를 되돌려 준다.
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const fs = require('node:fs');
    const prompt = fs.readFileSync(0, 'utf8').trim();
    const emit = (text) => console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
    if (prompt.split('<user_request>').at(-1).split('</user_request>')[0].trim() === 'HOLD') {
      emit('HOLD_READY');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        fs.unlinkSync(${JSON.stringify(release)});
        console.log(JSON.stringify({ type: 'agent_settled' }));
      }, 20);
    } else {
      emit(JSON.stringify({ prompt }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }
  `);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token, RHWP_LAUNCH_ID: launchId,
      RHWP_WORK_DIR: root, RHWP_REFERENCES_DIR: path.join(root, 'references'), RHWP_PROJECTS_DIR: path.join(root, 'projects'),
      RHWP_PI_DIR: piRoot, RHWP_TEMPLATES_DIR: path.join(root, 'templates'), RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'),
      RHWP_HOME_ACCESS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
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
  const base = `http://127.0.0.1:${ready.port}`;
  const sessionId = 'research-project';
  const capabilities = await registerHubSession({ port: ready.port, token, launchId, sessionId });
  // Studio 의 referenceUrl 처럼 sessionId 를 쿼리로, capability 를 Bearer 로 보낸다.
  const http = (route, init = {}) => fetch(`${base}${route}${route.includes('?') ? '&' : '?'}sessionId=${sessionId}`, {
    ...init,
    headers: { Authorization: `Bearer ${capabilities.reference}`, ...(init.headers ?? {}) },
  });

  // 정리 도우미는 실제 공급자를 부르므로 끈다(설정 경로도 함께 확인).
  const settings = await http('/project-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { librarian: { enabled: false } } }),
  });
  assert.equal(settings.status, 200, await settings.clone().text());
  assert.equal((await http('/projects/current')).status, 409);

  const studio = await connect(`ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=research`);
  t.after(() => studio.socket.close());
  studio.send({ type: 'chat-start', requestId: 'start-1', agent: 'pi', model: 'test/plain', workflow: 'direct',
    threadId: THREAD, documentId: DOCUMENT, documentName: '사업 계획.hwpx' });
  const started = await studio.next((frame) => frame.requestId === 'start-1');
  assert.equal(started.type, 'chat-started', JSON.stringify(started));
  const bound = await studio.next((frame) => frame.type === 'project-bound');
  assert.equal(bound.projectId, started.projectId);
  assert.equal(bound.project.name, '사업 계획');
  assert.deepEqual(bound.project.members.map((member) => member.documentId), [DOCUMENT]);
  const projectId = bound.projectId;

  const upload = await http(`/projects/${projectId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('예산 근거.txt') },
    body: '2026년 예산은 3억 원으로 편성한다. 인건비가 절반이다.',
  });
  assert.equal(upload.status, 201);
  const { item } = await upload.json();
  const changed = await studio.next((frame) => frame.type === 'project-changed' && frame.project.items.some((entry) => entry.id === item.id));
  assert.equal(changed.projectId, projectId);

  studio.send({ type: 'chat-user-message', text: 'HOLD', threadId: THREAD, documentId: DOCUMENT });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'text-delta');
  const mcp = await connect(`ws://127.0.0.1:${ready.port}/mcp?token=${token}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => mcp.socket.close());
  let callId = 0;
  const call = async (tool, args) => {
    const id = ++callId;
    mcp.send({ type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch: started.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === id);
  };

  const edited = await call('project_edit', {
    ops: [{ op: 'note', name: '예산 메모', body: `[[${item.id}#c0|예산은 3억 원]] 기준으로 쓴다.` }, { op: 'goal', body: '사업 계획서 근거' }],
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const noteId = edited.result.created[0];
  const summary = await call('project_read', { view: 'summary' });
  assert.equal(summary.result.counts.notes, 1);
  assert.equal(summary.result.goal, '사업 계획서 근거');
  const searched = await call('search_reference_files', { query: '예산' });
  assert.equal(searched.result.results[0].itemId, item.id);
  assert.equal(searched.result.notes[0].itemId, noteId);
  const chunk = await call('read_reference_chunk', { itemId: item.id, chunkId: 'c0' });
  assert.match(chunk.result.text, /3억 원/);
  const imported = await call('project_import', { text: '인건비 세부 내역', name: '인건비.md' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal((await call('find_home_files', { query: '예산' })).error.code, 'HOME_SEARCH_DISABLED');
  writeFileSync(release, '');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');

  studio.send({ type: 'chat-user-message', text: '예산 근거를 요약해 주세요', threadId: THREAD, documentId: DOCUMENT, mentions: [noteId] });
  const delta = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'text-delta' && frame.event.text.startsWith('{'));
  const prompt = JSON.parse(delta.event.text).prompt;
  const block = /<research_project trust="untrusted-data">\n(.*)\n<\/research_project>/.exec(prompt);
  assert.ok(block, prompt.slice(0, 2000));
  const payload = JSON.parse(block[1]);
  assert.equal(payload.project.goal, '사업 계획서 근거');
  assert.equal(payload.project.counts.files, 2);
  assert.equal(payload.mentioned[0].id, noteId);
  assert.ok(payload.excerpts.some((excerpt) => excerpt.itemId === item.id));

  const current = await (await http('/projects/current')).json();
  assert.equal(current.project.id, projectId);
  assert.equal(current.project.links.find((link) => link.origin === 'note').to, item.id);
  const activity = await (await http(`/projects/${projectId}/activity?limit=10`)).json();
  assert.ok(activity.entries.some((entry) => entry.actor.kind === 'agent'));
});
