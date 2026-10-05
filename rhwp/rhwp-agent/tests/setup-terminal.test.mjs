import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createSetupTerminal } from '../setup-terminal.mjs';
import { AuthRunRegistry } from '../auth-run-registry.mjs';

const child = (code, extras = {}) => createSetupTerminal({ command: process.execPath,
  argv: ['-e', code], cwd: process.cwd(), env: process.env, onOutput: () => {}, timeoutMs: 5000, ...extras });

test('real PTY provides a terminal and forwards interactive input', async () => {
  let output = '';
  const terminal = child('process.stdout.write("READY:"+process.stdin.isTTY+"\\n");process.stdin.once("data",()=>process.exit(0));', {
    onOutput: data => { output += data; if (output.includes('READY:true')) terminal.write('\r'); },
  });
  assert.equal((await terminal.done).code, 0);
  assert.match(output, /READY:true/);
});

test('cancel and timeout terminate the login process', async () => {
  for (const timeout of [false, true]) {
    const abort = new AbortController();
    const terminal = child('setInterval(()=>{},1000)', { signal: abort.signal, timeoutMs: timeout ? 80 : 5000 });
    if (!timeout) abort.abort();
    await assert.rejects(terminal.done, { code: timeout ? 'AGENT_AUTH_TIMEOUT' : 'AGENT_AUTH_CANCELLED' });
  }
});

function windowsPtyFixture(agent) {
  let onExit;
  const terminal = { pid: 12345, _agent: agent,
    onData: () => ({ dispose() {} }),
    onExit: callback => { onExit = callback; return { dispose() {} }; },
    kill() { assert.fail('an exited Windows PID must never be killed again'); },
  };
  const login = child('', { platform: 'win32', spawnPty: () => terminal });
  return { login, exit: () => onExit({ exitCode: 0 }) };
}

test('Windows PTY exit releases pinned node-pty handles without killing the exited PID', async (t) => {
  const released = [];
  const warning = t.mock.method(console, 'warn', () => {});
  const { login, exit } = windowsPtyFixture({
    _inSocket: { destroy() { released.push('input'); } },
    _outSocket: { destroy() { released.push('output'); } },
    _conoutSocketWorker: { dispose() { released.push('worker'); } },
  });
  exit();
  assert.equal((await login.done).code, 0);
  assert.deepEqual(released, ['input', 'output', 'worker']);
  assert.equal(warning.mock.callCount(), 0);
});

test('Windows PTY shape changes warn and still release handles that are available', async (t) => {
  let released = false;
  const warning = t.mock.method(console, 'warn', () => {});
  const { login, exit } = windowsPtyFixture({
    _inSocket: { destroy() { released = true; } },
    _outSocket: { destroy: true },
  });
  exit();
  assert.equal((await login.done).code, 0);
  assert.equal(released, true);
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0].arguments[0], /unexpected node-pty handle shape.*1\.1\.0/);
});

test('Windows PTY disposal failure warns and does not skip the remaining handles', async (t) => {
  const released = [];
  const warning = t.mock.method(console, 'warn', () => {});
  const { login, exit } = windowsPtyFixture({
    _inSocket: { destroy() { throw new Error('closed'); } },
    _outSocket: { destroy() { released.push('output'); } },
    _conoutSocketWorker: { dispose() { released.push('worker'); } },
  });
  exit();
  assert.equal((await login.done).code, 0);
  assert.deepEqual(released, ['output', 'worker']);
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0].arguments[0], /handle destroy failed/);
});

test('terminal frames require the exact owning auth run and enforce input limits', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("    case 'agent-setup-terminal-resume':");
  const end = source.indexOf("    case 'agent-setup-auth-code':", start);
  const dispatch = new Function('msg', 'authRuns', 'record', 'sock', 'cliSetup', 'sendAgentSetupError', 'Buffer', 'sendAuthRunFrame', 'CLI_SETUP_AGENTS',
    `switch(msg.type) { ${source.slice(start, end)} }`);
  const registry = new AuthRunRegistry();
  const run = registry.begin({ agent: 'opencode', method: 'oauth', ownerSessionId: 'owner', requestId: 'request', cancel: () => {} });
  const writes = [], errors = [], frames = [];
  const send = (owner, props = {}) => dispatch({ type: 'agent-setup-terminal-input', agent: 'opencode', authRunId: run.runId, data: '\x1b[B', ...props }, registry,
    { sessionId: owner }, {}, { terminalInput: (...args) => writes.push(args), terminalSnapshot: () => 'private terminal output' }, (...args) => errors.push(args), Buffer, (_run, frame) => frames.push(frame), ['claude', 'codex', 'grok', 'cursor', 'opencode']);
  send('other');
  send('owner', { authRunId: 'stale' });
  send('owner', { data: 'x'.repeat(4097) });
  assert.equal(writes.length, 0);
  assert.equal(errors.length, 3);
  send('owner');
  assert.deepEqual(writes, [['opencode', '\x1b[B']]);
  send('other', { type: 'agent-setup-terminal-resume' });
  assert.equal(frames.length, 0);
  send('owner', { type: 'agent-setup-terminal-resume' });
  assert.equal(frames[0].data, 'private terminal output');
  assert.equal(frames[0].reset, true);
  registry.finish(run);
});
