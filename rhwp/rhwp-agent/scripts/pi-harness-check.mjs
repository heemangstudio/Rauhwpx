#!/usr/bin/env node
// 실제 pi 바이너리로 rhwp 하니스를 점검한다 — 네트워크 없이 로컬 스텁 provider 와 가짜 허브만 쓴다.
//
//   node scripts/pi-harness-check.mjs            # 앱이 설치한 pi (defaultPiRoot()/prefix)
//   RHWP_PI_CHECK_BIN=/path/to/pi node scripts/pi-harness-check.mjs
//
// 확인하는 것: provider 가 받는 시스템 프롬프트가 rhwp 것인지, 읽기 호출은 겹쳐 돌고 쓰기는
// 차례로 도는지, 빠진 expectedRevision 채우기와 stale 앵커 쓰기 재시도, 마무리 점검 메모가
// 다음 요청에 실리는지, 이미 본 이미지가 빠지는지, 시작부터 첫 provider 요청까지 걸린 시간.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import { buildPiArgv, buildPiEnv } from '../agents/pi.mjs';
import { PI_PREAMBLE, availableReadOnlyBuiltins } from '../agents/pi-prompt.mjs';
import { defaultPiRoot } from '../pi-manager.mjs';
import { piToolDefinitions } from '../pi/tool-schema.mjs';

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI_BIN = process.env.RHWP_PI_CHECK_BIN
  ?? path.join(defaultPiRoot(), 'prefix', 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');
const MODEL_ID = 'stub/doc-model';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ─── 스텁 OpenAI 호환 provider ───────────────────────────────────────────────

function sse(spec) {
  const base = { id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: MODEL_ID };
  const chunks = [];
  if (spec.text) chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: spec.text }, finish_reason: null }] });
  (spec.calls ?? []).forEach((call, index) => chunks.push({
    ...base,
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index, id: `call_${spec.step}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
      finish_reason: null,
    }],
  }));
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: spec.calls?.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  });
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function startProvider(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const step = requests.length;
      requests.push({ body, at: Date.now() });
      const spec = script[Math.min(step, script.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse({ ...(typeof spec === 'function' ? spec(body) : spec), step }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

// ─── 가짜 허브 (/pi/tool-definitions + /mcp WS) ──────────────────────────────

function startHub(onCall) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://hub');
    if (url.pathname !== '/pi/tool-definitions') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(piToolDefinitions(url.searchParams.get('profile') ?? 'direct')));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', async (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type !== 'tool-call') return;
      const call = { tool: frame.tool, args: frame.args, start: Date.now(), end: null };
      calls.push(call);
      const outcome = await onCall(call);
      call.end = Date.now();
      ws.send(JSON.stringify(outcome.ok
        ? { type: 'tool-result', id: frame.id, ok: true, result: outcome.result }
        : { type: 'tool-result', id: frame.id, ok: false, error: { code: outcome.code, message: outcome.message } }));
    });
  }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, calls, port: server.address().port })));
}

// ─── pi 실행 ─────────────────────────────────────────────────────────────────

async function runPi({ providerPort, hubPort, prompt, opts = {}, env = {} }) {
  const piRoot = await mkdtemp(path.join(os.tmpdir(), 'rhwp-pi-check-'));
  const agentDir = path.join(piRoot, 'agent');
  const work = path.join(piRoot, 'work');
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(work, { recursive: true }), mkdir(path.join(piRoot, 'sessions'))]);
  await mkdir(path.join(agentDir, 'skills'), { recursive: true });
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      openrouter: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: 'openai-completions',
        models: [{ id: MODEL_ID, name: 'Stub', reasoning: false, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 8_000 }],
      },
    },
  }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    defaultProjectTrust: 'never',
    enableSkillCommands: false,
    enableInstallTelemetry: false,
    extensions: [path.join(AGENT_DIR, 'pi', 'extension', 'rhwp.ts'), path.join(AGENT_DIR, 'pi', 'extension', 'subagents.ts')],
  }));
  const backendOpts = {
    rootDir: work,
    mcpScriptPath: '/unused',
    hubPort,
    token: 'check-token',
    sessionId: 'check-session',
    piBin: PI_BIN,
    piRoot,
    model: MODEL_ID,
    reasoning: false,
    permissionProfile: 'safe',
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    openRouterApiKey: 'sk-or-check-dummy',
    onEvent() {},
    ...opts,
  };
  const sourceEnv = { ...process.env, ...env };
  const argv = buildPiArgv(backendOpts, `check-${Date.now()}`, sourceEnv);
  const childEnv = buildPiEnv(backendOpts, sourceEnv);
  const started = Date.now();
  const child = spawn(PI_BIN, argv, { cwd: work, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(prompt);
  const code = await new Promise((resolve) => child.on('close', resolve));
  await rm(piRoot, { recursive: true, force: true });
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  return { code, stderr, events, started };
}

const textOf = (message) => (typeof message.content === 'string'
  ? message.content
  : (message.content ?? []).map((part) => part.text ?? '').join(''));
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// ─── 시나리오 1: 에이전트 모드 편집 턴 ───────────────────────────────────────

async function checkEditingTurn() {
  let mismatchSent = false;
  const hub = await startHub(async (call) => {
    if (['get_structure', 'find_text', 'render_page'].includes(call.tool)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (call.tool === 'render_page') return { ok: true, result: { revision: 12, page: 0, image: { data: PNG, mimeType: 'image/png' } } };
      return { ok: true, result: { revision: 12, text: 'p0 2023년 계획' } };
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (call.tool === 'replace_range' && call.args.expectedRevision === 11 && !mismatchSent) {
      mismatchSent = true;
      return { ok: false, code: 'REVISION_MISMATCH', message: 'Document is now at revision 13; you expected 11. The text match re-resolves on retry — resend the same call with expectedRevision=13; no re-read needed.' };
    }
    const next = call.args.expectedRevision + 1;
    return { ok: true, result: { revision: next, after: { paragraphs: [], pageCountBefore: 1, pageCount: 1, pages: [0] } } };
  });
  const provider = await startProvider([
    { calls: [
      { name: 'get_structure', args: { pages: [0, 0] } },
      { name: 'find_text', args: { query: '2023' } },
      { name: 'render_page', args: { pageIndex: 0 } },
    ] },
    { calls: [
      // expectedRevision 없이 보낸 쓰기 → live_document 의 12 로 채워진다.
      { name: 'replace_range', args: { find: '2023년', text: '2024년' } },
      // 낡은 11 + 텍스트 앵커 → 허브가 13 으로 거절하면 13 으로 한 번 다시 보낸다.
      { name: 'replace_range', args: { expectedRevision: 11, find: '계획', text: '계획안' } },
    ] },
    { text: '' },
    { text: '2023년을 2024년으로, 계획을 계획안으로 바꿨습니다.' },
  ]);
  try {
    const prompt = '<live_document revision="12" unchanged="true"/>\n\n연도를 고쳐 줘';
    const run = await runPi({ providerPort: provider.port, hubPort: hub.port, prompt });
    assert.equal(run.code, 0, run.stderr);
    const [first, second, third, fourth] = provider.requests;

    const system = first.body.messages[0];
    assert.equal(system.role, 'system');
    assert.ok(textOf(system).startsWith(PI_PREAMBLE), 'the provider sees the rhwp preamble first');
    assert.doesNotMatch(textOf(system), /expert coding assistant|Pi documentation/);
    const toolNames = first.body.tools.map((tool) => tool.function.name);
    const searchTools = availableReadOnlyBuiltins({ pathEnv: process.env.PATH ?? '' });
    for (const name of [...searchTools, 'read', 'apply_edits', 'subagent_spawn']) assert.ok(toolNames.includes(name), name);
    assert.equal(toolNames.includes('bash'), false, 'safe mode has no shell');

    const reads = hub.calls.filter((call) => ['get_structure', 'find_text', 'render_page'].includes(call.tool));
    assert.ok(overlaps(reads[0], reads[1]) && overlaps(reads[1], reads[2]), 'reads in one message run together');
    const writes = hub.calls.filter((call) => call.tool === 'replace_range');
    assert.equal(writes.length, 3, 'two writes plus one automatic retry');
    assert.ok(writes.every((call, index) => index === 0 || writes[index - 1].end <= call.start), 'writes run one at a time');
    assert.equal(writes[0].args.expectedRevision, 12, 'missing expectedRevision filled from live_document');
    assert.deepEqual(writes.slice(1).map((call) => call.args.expectedRevision), [11, 13]);

    const toolTexts = third.body.messages.filter((message) => message.role === 'tool').map(textOf);
    assert.ok(toolTexts.some((text) => text.includes('note: expectedRevision filled with 12')));
    assert.ok(toolTexts.some((text) => text.includes('note: retried at revision 13 after your stale expectedRevision 11')));

    const imageParts = (request) => request.body.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === 'image_url');
    assert.equal(imageParts(second).length, 1, 'the fresh render reaches the model once');
    assert.equal(imageParts(third).length, 0, 'an already-seen render is pruned');
    assert.ok(third.body.messages.some((message) => textOf(message).includes('[image from render_page omitted')));

    assert.equal(provider.requests.length, 4, 'one settle continuation, then the turn ends');
    const lastUser = fourth.body.messages.filter((message) => message.role === 'user').at(-1);
    assert.match(textOf(lastUser), /no reply was written for the user/);
    const settled = run.events.filter((event) => event.type === 'agent_settled');
    assert.equal(settled.length, 1);
    return { firstRequestMs: first.at - run.started };
  } finally {
    provider.server.close();
    hub.wss.close();
    hub.server.close();
  }
}

if (!existsSync(PI_BIN)) {
  console.log(`pi binary not found at ${PI_BIN}; set RHWP_PI_CHECK_BIN`);
  process.exit(2);
}
const started = Date.now();
const editing = await checkEditingTurn();
console.log(`ok editing turn (first provider request ${editing.firstRequestMs} ms after spawn)`);
console.log(`pi harness check passed in ${Date.now() - started} ms`);
