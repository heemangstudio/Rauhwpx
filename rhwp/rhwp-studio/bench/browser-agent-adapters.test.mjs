// Provider stdout fixtures only. These tests never launch a model or contact the hub.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { measureBrowserFailures } from './browser-agent-suite.mjs';
import { createClaudeSession } from '../../rhwp-agent/agents/claude.mjs';
import { createCodexSession, createLegacyCodexSession } from '../../rhwp-agent/agents/codex.mjs';

class FakeStream extends EventEmitter {
  constructor(onWrite) { super(); this.onWrite = onWrite; }
  write(chunk, callback) { this.onWrite?.(String(chunk)); callback?.(); return true; }
  end() {}
}
class FakeChild extends EventEmitter {
  constructor(responder) {
    super();
    this.exitCode = null; this.signalCode = null;
    this.stdout = new FakeStream(); this.stderr = new FakeStream();
    this.stdin = new FakeStream(text => {
      if (responder) for (const line of text.split('\n').filter(Boolean)) queueMicrotask(() => responder(JSON.parse(line), this));
    });
  }
  send(...frames) { this.stdout.emit('data', frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'); }
  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal;
    queueMicrotask(() => { this.emit('exit', null, signal); this.emit('close', null, signal); });
    return true;
  }
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Fake provider did not reach the expected state');
}
function responder(frame, child) {
  const reply = result => child.send({ id: frame.id, result });
  if (frame.method === 'initialize') return reply({ userAgent: 'fake-codex' });
  if (frame.method === 'initialized') return;
  if (frame.method === 'collaborationMode/list') return reply({ data: [{ name: 'Default', mode: 'default', model: null, reasoning_effort: null }] });
  if (frame.method === 'experimentalFeature/list') return reply({ data: [{ name: 'default_mode_request_user_input', enabled: true, defaultEnabled: false, stage: 'underDevelopment' }], nextCursor: null });
  if (frame.method === 'thread/start') return reply({ thread: { id: 'browser-test-thread' } });
  if (frame.method === 'turn/start') {
    child.send({ method: 'turn/started', params: { threadId: 'browser-test-thread', turn: { id: 'browser-test-turn', status: 'inProgress' } } });
    return reply({ turn: { id: 'browser-test-turn', status: 'inProgress' } });
  }
  if (frame.method === 'turn/interrupt') return reply({});
}
async function harness(t, mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'browser-adapters-'));
  const events = [], children = [];
  const opts = { rootDir: root, isolatedHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex'),
    mcpScriptPath: '/fake/no-hub-mcp.mjs', hubPort: 1, token: 'fake-token', model: 'fake-model', permissionProfile: 'safe',
    workflow: 'direct', phase: 'implementing', agentRole: 'chat', requestUserInput: async () => ({ status: 'cancelled', reason: 'test' }),
    onEvent: event => events.push(event) };
  if (mode === 'claude') delete opts.requestUserInput;
  const deps = {
    queryAgent() { throw new Error('Real Claude SDK is forbidden in adapter fixtures'); },
    spawnProcess(command, argv) { const child = new FakeChild(argv[0] === 'app-server' ? responder : null); children.push(child); return child; },
    terminateProcess: child => child.kill(), waitForExit: async () => true,
    createRolloutWatcher: () => ({ start() {}, stop() {}, finalize() {} }),
  };
  const factory = mode === 'claude' ? createClaudeSession : mode === 'codex-exec' ? createLegacyCodexSession : createCodexSession;
  const session = factory(opts, deps);
  t.after(async () => { await session.dispose(); rmSync(root, { recursive: true, force: true }); });
  session.sendUserMessage('Fixture: click a missing browser reference');
  await until(() => children.length === 1 && events.some(e => e.type === 'turn-start'));
  return { events, child: children[0] };
}
const failure = { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'BROWSER_REF_NOT_FOUND', message: 'Reference btn-missing is absent' }) }] };
function assertFailedPair(events, id, code) {
  const call = events.find(e => e.type === 'tool-call' && e.callId === id);
  const result = events.find(e => e.type === 'tool-result' && e.callId === id);
  assert.ok(call, 'tool call must survive normalization');
  assert.equal(call.tool, 'browser_click');
  assert.deepEqual(JSON.parse(call.argsJson), { ref: 'btn-missing' });
  assert.ok(result, 'error result must match the tool-call ID');
  assert.equal(result.ok, false, 'tool errors must remain failures in provider metrics');
  assert.match(result.resultPreview, new RegExp(code));
}

test('Claude stdout preserves browser errors and schema rejections before hub execution', async t => {
  const h = await harness(t, 'claude');
  for (const [id, code] of [['claude-click', 'BROWSER_REF_NOT_FOUND'], ['claude-schema', 'Invalid arguments for tool browser_click']]) {
    h.child.send(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__rhwp__browser_click', input: { ref: 'btn-missing' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text: code }] }] } },
    );
    assertFailedPair(h.events, id, code);
  }
});

test('Codex app-server failed MCP status preserves browser error and matching call ID', async t => {
  const h = await harness(t, 'codex');
  const item = { type: 'mcpToolCall', id: 'codex-click', server: 'rhwp', tool: 'browser_click', arguments: { ref: 'btn-missing' } };
  h.child.send(
    { method: 'item/started', params: { threadId: 'browser-test-thread', turnId: 'browser-test-turn', item: { ...item, status: 'inProgress' } } },
    { method: 'item/completed', params: { threadId: 'browser-test-thread', turnId: 'browser-test-turn', item: { ...item, status: 'failed', error: failure } } },
  );
  assertFailedPair(h.events, item.id, 'BROWSER_REF_NOT_FOUND');
});

test('Codex exec failed MCP status preserves browser error and matching call ID', async t => {
  const h = await harness(t, 'codex-exec');
  const item = { type: 'mcp_tool_call', id: 'exec-click', server: 'rhwp', tool: 'browser_click', arguments: { ref: 'btn-missing' } };
  h.child.send({ type: 'item.started', item: { ...item, status: 'in_progress' } }, { type: 'item.completed', item: { ...item, status: 'failed', error: failure } });
  assertFailedPair(h.events, item.id, 'BROWSER_REF_NOT_FOUND');
});

test('benchmark counts structured MCP isError even when the baseline Codex adapter reports success', async t => {
  const h = await harness(t, 'codex');
  const item = { type: 'mcpToolCall', id: 'codex-is-error', server: 'rhwp', tool: 'browser_click', arguments: { ref: 'btn-missing' } };
  h.child.send(
    { method: 'item/started', params: { threadId: 'browser-test-thread', turnId: 'browser-test-turn', item: { ...item, status: 'inProgress' } } },
    { method: 'item/completed', params: { threadId: 'browser-test-thread', turnId: 'browser-test-turn', item: { ...item, status: 'completed', result: failure } } },
  );
  const calls = h.events.filter(event => event.type === 'tool-call');
  const results = h.events.filter(event => event.type === 'tool-result');
  assert.equal(calls[0].callId, item.id);
  assert.equal(results[0].callId, item.id);
  assert.match(results[0].resultPreview, /BROWSER_REF_NOT_FOUND/);
  const metrics = measureBrowserFailures([], calls, results);
  assert.equal(metrics.invalidCalls, 1);
  if (results[0].ok === true) t.diagnostic('Baseline adapter emits ok:true for completed MCP isError; benchmark structured-result check corrects this.');
});
