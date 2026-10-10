import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createCodexSession } from '../agents/codex.mjs';
import { buildCopyLayoutWorkerPrompt } from '../template-perfection.mjs';

// 실제 CLI의 모델 메타데이터와 code-mode 호스트를 검사한다. 모델 응답은 로컬
// HTTP fixture가 제공하므로 계정·제공자 네트워크·추론 비용은 필요하지 않다.
// RHWP_TEST_CODEX_BIN=/path/to/codex node --test tests/codex-copy-layout-runtime.test.mjs
test('Codex copy-layout worker reaches MCP through code mode without native write access', {
  skip: !process.env.RHWP_TEST_CODEX_BIN && 'Set RHWP_TEST_CODEX_BIN to run the offline CLI check',
  timeout: 20_000,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-worker-runtime-'));
  const home = path.join(root, 'home');
  mkdirSync(home);
  const attemptedWrite = path.join(root, 'native-write-must-fail.txt');
  const jobId = '11111111-1111-4111-8111-111111111111';
  const calls = [], requests = [], events = [];
  const hub = http.createServer();
  const sockets = new WebSocketServer({ server: hub });
  sockets.on('connection', (socket) => socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString());
    calls.push(message);
    socket.send(JSON.stringify({
      v: 1, type: 'tool-result', id: message.id, ok: true,
      result: { jobId, action: message.args?.action, outcome: message.args?.outcome },
    }));
  }));
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const script = `
text(await tools.mcp__rhwp__update_copy_layout_job({jobId:${JSON.stringify(jobId)},phase:"inspecting",activity:"Offline fixture"}));
try { text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${attemptedWrite}\n+forbidden\n*** End Patch`)})); }
catch (error) {
  if (!String(error).includes("patch rejected: writing is blocked by read-only sandbox")) throw error;
  text(String(error));
}
text(await tools.mcp__rhwp__run_copy_layout_helper({jobId:${JSON.stringify(jobId)},action:"inspect"}));
text(await tools.mcp__rhwp__complete_copy_layout_job({jobId:${JSON.stringify(jobId)},outcome:"failed",sourceDocumentId:"fixture-document",sourceDigest:"fixture-digest",summary:"Fixture diagnostic completion",warnings:[]}));`;
  const model = http.createServer(async (request, response) => {
    let body = '';
    for await (const bytes of request) body += bytes;
    const payload = JSON.parse(body);
    requests.push(payload);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const item = requests.length === 1
      ? { type: 'custom_tool_call', id: 'exec-fixture', call_id: 'call-fixture', namespace: 'functions', name: 'exec', input: script }
      : { type: 'message', id: 'message-fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture settled.', annotations: [] }] };
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit('response.created', { response: { id: `response-${requests.length}`, object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: `response-${requests.length}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
    response.end();
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  let backend;
  t.after(async () => {
    await backend?.dispose();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await Promise.all([hub, model].map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  });
  let finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  backend = createCodexSession({
    rootDir: root, workDir: root, isolatedHome: home, codexHome: home,
    codexBin: process.env.RHWP_TEST_CODEX_BIN,
    mcpScriptPath: fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url)),
    hubPort: hub.address().port, token: 'offline-worker-fixture', sessionId: 'fixture-session',
    model: 'gpt-6.1-sol', permissionProfile: 'safe', workflow: 'direct', phase: 'implementing',
    capabilityEpoch: 1, toolProfile: 'copy-layout-worker', agentRole: `copy-layout-worker:${jobId}:fixture`,
    providerEnv: { PATH: process.env.PATH },
    systemPromptOverride: buildCopyLayoutWorkerPrompt({ jobId, binding: { documentId: 'fixture-document', digest: 'fixture-digest' }, jobDir: root }),
    onEvent: (event) => { events.push(event); if (event.type === 'turn-end') finish(event); },
  }, {
    spawnProcess: (command, argv, options) => {
      const args = [...argv];
      args.splice(args.length - 1, 0,
        '-c', 'model_provider="fixture"',
        '-c', `model_providers.fixture={name="Offline fixture",base_url="http://127.0.0.1:${model.address().port}/v1",wire_api="responses",requires_openai_auth=false}`);
      return spawn(command, args, options);
    },
  });
  backend.sendUserMessage('Begin the autonomous copy-layout workflow now.');
  const end = await ended;
  assert.equal(end.stopReason, 'completed');
  assert.deepEqual(calls.map((call) => call.tool), [
    'update_copy_layout_job', 'run_copy_layout_helper', 'complete_copy_layout_job',
  ], JSON.stringify(events));
  assert.equal(calls.every((call) => call.args.jobId === jobId), true);
  assert.equal(events.some((event) => event.type === 'tool-result' && event.ok === false), false);
  assert.equal(existsSync(attemptedWrite), false, 'Code mode must retain the native read-only sandbox');
  const advertised = requests[0].input.find((item) => item.type === 'additional_tools');
  assert.ok(advertised?.tools.some((namespace) => namespace.name === 'functions'
    && namespace.tools.some((tool) => tool.name === 'exec')));
  const outputs = requests[1].input.filter((item) => item.type === 'custom_tool_call_output');
  assert.ok(outputs.length > 0);
  assert.match(JSON.stringify(outputs), /patch rejected: writing is blocked by read-only sandbox/);
});
