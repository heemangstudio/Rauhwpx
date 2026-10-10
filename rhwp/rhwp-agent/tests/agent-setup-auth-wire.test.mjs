import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_KEY_MAX_BYTES } from '../input-bounds.mjs';
import { startLiveHub } from './live-hub-fixture.mjs';

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readSource(name) {
  return fs.readFile(path.join(hubDir, name), 'utf8');
}

function agentSetupAuthHandler(source) {
  const start = source.indexOf("case 'agent-setup-auth':");
  const end = source.indexOf("case 'agent-setup-auth-code':", start);
  assert.notEqual(start, -1, 'agent-setup-auth handler is missing');
  assert.ok(end > start, 'agent-setup-auth handler boundary is missing');
  return source.slice(start, end);
}

/** 로그인 진행 프레임은 스튜디오가 그대로 그리는 유일한 통로다 — 필드가 빠지면 로그인이 멈춘다. */
test('the auth progress frame forwards both the login URL and the device code', async () => {
  const source = await readSource('server.mjs');
  const handler = agentSetupAuthHandler(source);
  const start = handler.indexOf('const progress = (entry) => {');
  const end = handler.indexOf('const started =', start);
  assert.notEqual(start, -1, 'agent-setup-auth progress handler is missing');
  assert.ok(end > start, 'agent-setup-auth progress handler boundary is missing');
  const frame = handler.slice(start, end);
  assert.match(frame, /type: 'agent-setup-progress'/);
  assert.match(frame, /entry\.authUrl \? \{ authUrl: entry\.authUrl \}/);
  assert.match(frame, /entry\.userCode \? \{ userCode: entry\.userCode \}/);
  assert.match(frame, /authRunId: run\.runId|sendAuthRunFrame\(authRun/);
});

test('auth-run cancellation and owner-session close fence API key manager commits', async () => {
  const source = await readSource('server.mjs');
  const handler = agentSetupAuthHandler(source);

  assert.match(handler, /const cancelProvider = \(\) => \{\s*abort\.abort\(\)/);
  assert.match(handler, /piManager\.setApiKey\(msg\.key,/);
  assert.doesNotMatch(handler, /piManager\.setApiKey\(String\(/);
  assert.match(handler, /piManager\.setApiKey\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.match(handler, /cliSetup\.authenticate\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.match(source, /case 'agent-setup-cancel':[\s\S]+authRuns\.cancelOwned\(/);
  assert.match(source, /authRuns\.cancelForSession\(sessionId, 'owner-session-closed'\)/);
});

test('OAuth callback and post-auth work share one exact credential commit boundary', async () => {
  const source = await readSource('server.mjs');
  const handler = agentSetupAuthHandler(source);
  assert.match(handler, /const isLiveAuthRun = \(\) => !abort\.signal\.aborted && authRuns\.get\(agent\) === authRun/);
  assert.match(handler, /authRuns\.finish\(authRun\)[\s\S]+authRun\.credentialsCommitted = true/);
  assert.match(handler, /const progress = \(entry\) => \{\s*if \(!isLiveAuthRun\(\)\) return/);
  assert.match(handler, /piManager\.setApiKey\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.match(handler, /cliSetup\.authenticate\([^;]+signal: abort\.signal,[^;]+onCommitted: commitAuthRun/s);
  assert.ok(handler.indexOf('onCommitted: commitAuthRun') < handler.indexOf('providerHealth.check(true)'));

  const callbackStart = source.indexOf("url.pathname === '/oauth/openrouter/callback'");
  const callbackEnd = source.indexOf("url.pathname.startsWith('/sessions/')", callbackStart);
  const callback = source.slice(callbackStart, callbackEnd);
  assert.match(callback, /piManager\.completeOAuth\([^;]+signal: authRun\.signal,[^;]+onCommitted: authRun\.commitCredentials/s);
  assert.match(callback, /authRun\.credentialsCommitted !== true/);
});

// 문자열이 아닌 키를 허브가 String() 으로 바꿔 넘기면 배열 안의 긴 문자열이 길이 오류로 바뀐다.
test('Pi API-key frames reject non-string keys without coercing them', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  const key = ['x'.repeat(API_KEY_MAX_BYTES + 1)];

  hub.studio.send({ type: 'pi-set-key', requestId: 'set-key', key });
  const direct = await hub.studio.next((frame) => frame.requestId === 'set-key' && frame.type !== 'pi-status');
  assert.equal(direct.type, 'pi-error', JSON.stringify(direct));
  assert.equal(direct.code, 'OPENROUTER_KEY_INVALID');

  hub.studio.send({ type: 'agent-setup-auth', requestId: 'auth-key', agent: 'pi', method: 'api-key', key });
  const setup = await hub.studio.next((frame) => frame.requestId === 'auth-key' && frame.type === 'agent-setup-error');
  assert.equal(setup.code, 'OPENROUTER_KEY_INVALID');
});
