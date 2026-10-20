import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDiagnosticLog,
  createLineSink,
  redactSecrets,
  teeConsole,
} from '../desktop/diagnostic-log.mjs';
import {
  DEFAULT_FEEDBACK_PROOF_KEY,
  FEEDBACK_MAX_BODY_BYTES,
  FeedbackDraftError,
  buildFeedbackPayload,
  feedbackOrigin,
  feedbackTimeoutMs,
  submitFeedback,
} from '../desktop/issue-report.mjs';
import {
  DEFAULT_FEEDBACK_PROOF_KEY as SERVER_PROOF_KEY,
  MAX_FEEDBACK_BODY_BYTES as SERVER_MAX_BODY_BYTES,
  createFeedbackProof as serverProof,
} from '../site-api/feedback.mjs';

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hama-diag-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('diagnostic log rotates once past its size cap and the tail spans both files', () => withTempDir(async (dir) => {
  let clock = Date.parse('2026-10-20T00:00:00Z');
  const log = createDiagnosticLog({ dir, maxBytes: 4096, now: () => clock++ });
  for (let index = 0; index < 120; index += 1) {
    log.writeText('main', 'warn', `line ${index} ${'x'.repeat(60)}`);
    if (index % 10 === 9) log.flushSync();
  }
  const current = readFileSync(log.filePath, 'utf8');
  const rotated = readFileSync(`${log.filePath}.1`, 'utf8');
  assert.ok(Buffer.byteLength(current) <= 4096);
  assert.ok(Buffer.byteLength(rotated) <= 4096);
  assert.match(current, /line 119 /);
  assert.doesNotMatch(current, /line 0 /);
  assert.ok(!existsSync(`${log.filePath}.2`));

  const tail = log.tail(1_000_000);
  assert.ok(tail.indexOf('line 119 ') > tail.indexOf(rotated.split('\n')[0].slice(30, 50)));
  assert.match(tail, /^2026-10-20T00:00:00\.\d{3}Z warn  \[main\] line \d+ /m);
  assert.ok(Buffer.byteLength(log.tail(300)) <= 300);
}));

test('a fresh process keeps appending to the same file and survives without a flush timer', () => withTempDir(async (dir) => {
  const first = createDiagnosticLog({ dir, flushDelayMs: 60_000 });
  first.writeText('main', 'fatal', 'boom');
  first.flushSync();
  const second = createDiagnosticLog({ dir });
  second.writeText('hub', 'err', 'after restart');
  assert.match(second.tail(), /\[main\] boom[\s\S]*\[hub\] after restart/);
}));

test('secrets are redacted before they reach the disk', () => withTempDir(async (dir) => {
  const home = path.join(os.tmpdir(), 'fake-home-user');
  const log = createDiagnosticLog({ dir, home, secrets: ['hub-token-0123456789abcdef'] });
  log.write('main', 'warn', 'request failed', {
    headers: { Authorization: 'Bearer abcdefghijklmnop123456' },
    apiKey: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX',
  });
  log.writeText('hub', 'err', [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789',
    'url http://127.0.0.1:5175/?token=hub-token-0123456789abcdef',
    `opened ${home}/Documents/report.hwp`,
    'key HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012 activated',
    'gh token ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'tokens: 1234',
  ].join('\n'));
  log.flushSync();
  const written = readFileSync(log.filePath, 'utf8');
  for (const leaked of ['abcdefghijklmnop123456', 'sk-ant-api03', 'dXNlcjpwYXNzd29yZA', 'sk-or-v1', 'hub-token-0123456789abcdef',
    'fake-home-user', 'FGHJK', 'ghp_0123']) {
    assert.ok(!written.includes(leaked), `${leaked} leaked: ${written}`);
  }
  assert.match(written, /~\/Documents\/report\.hwp/);
  assert.match(written, /tokens: 1234/);
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here');
}));

test('hub stderr split mid-token is joined into lines before redaction', () => withTempDir(async (dir) => {
  const log = createDiagnosticLog({ dir });
  const sink = createLineSink((text) => log.writeText('hub', 'log', text));
  const line = Buffer.from('fail 키 OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789\ntail');
  // 6 splits the UTF-8 bytes of 키, 25 and 40 split the key itself.
  const cuts = [0, 6, 25, 40, line.length];
  for (let i = 1; i < cuts.length; i += 1) sink.write(line.subarray(cuts[i - 1], cuts[i]));
  sink.end();
  log.flushSync();
  const written = readFileSync(log.filePath, 'utf8');
  assert.ok(!written.includes('0123456789abcdef'), written);
  assert.match(written, /fail 키 OPENROUTER_API_KEY=\[redacted\]/);
  assert.match(written, /\[hub\] tail\n$/);
}));

test('console tee keeps the original output and records it', () => withTempDir(async (dir) => {
  const log = createDiagnosticLog({ dir });
  const printed = [];
  const target = { warn: (...args) => printed.push(args), error: () => { throw new Error('original throws'); } };
  const restore = teeConsole(log, { target });
  target.warn('[hamaeditor] hub exited', 1);
  assert.throws(() => target.error('x'), /original throws/);
  restore();
  assert.deepEqual(printed, [['[hamaeditor] hub exited', 1]]);
  assert.match(log.tail(), /warn  \[main\] \[hamaeditor\] hub exited 1/);
}));

test('the desktop proof key and HMAC match the site-api verifier', () => {
  assert.equal(DEFAULT_FEEDBACK_PROOF_KEY, SERVER_PROOF_KEY);
  const createdAt = '2026-10-20T01:02:03.004Z';
  const payload = buildFeedbackPayload({ installId: INSTALL_ID, createdAt, message: '  저장이 안 됩니다  ' });
  assert.equal(payload.message, '저장이 안 됩니다');
  assert.equal(payload.proof, serverProof({ installId: INSTALL_ID, createdAt, message: payload.message }));
  const manual = createHmac('sha256', 'rau.feedback.v1.desktop')
    .update(`${INSTALL_ID}\n${createdAt}\n${createHash('sha256').update('저장이 안 됩니다', 'utf8').digest('hex')}`)
    .digest('hex');
  assert.equal(payload.proof, manual);
});

test('payload building enforces contract limits before sending', () => {
  const base = { installId: INSTALL_ID, createdAt: new Date().toISOString(), message: 'crash' };
  assert.throws(() => buildFeedbackPayload({ ...base, message: '   ' }), FeedbackDraftError);
  assert.throws(() => buildFeedbackPayload({ ...base, message: 'x'.repeat(5001) }), (error) => error.code === 'too_large');
  assert.throws(() => buildFeedbackPayload({ ...base, email: 'not-an-email' }), (error) => error.field === 'email');
  assert.throws(
    () => buildFeedbackPayload({ ...base, document: { name: 'a.hwp', bytes: new Uint8Array(20 * 1024 * 1024 + 1) } }),
    (error) => error.field === 'document' && error.code === 'too_large',
  );
  assert.throws(
    () => buildFeedbackPayload({ ...base, screenshot: { mime: 'image/gif', bytes: new Uint8Array(4) } }),
    (error) => error.field === 'screenshot',
  );

  const log = Array.from({ length: 20_000 }, (_, index) => `line ${index} ${'y'.repeat(40)}`).join('\n');
  const payload = buildFeedbackPayload({
    ...base,
    email: ' me@example.com ',
    meta: { appVersion: '3.0.4', window: { width: 1440, height: 920 }, nested: { deep: { gone: true } }, list: [1] },
    log,
    screenshot: { mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    chat: '## 사용자\n안녕',
    document: { name: '보고서.hwpx', bytes: new Uint8Array([1, 2, 3]) },
  });
  assert.equal(payload.email, 'me@example.com');
  assert.deepEqual(payload.meta, { appVersion: '3.0.4', window: { width: 1440, height: 920 }, nested: {} });
  assert.ok(Buffer.byteLength(payload.log) <= 512 * 1024);
  assert.match(payload.log, /line 19999 y+$/);
  assert.deepEqual(payload.screenshot, { mime: 'image/png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
  assert.deepEqual(payload.document, { name: '보고서.hwpx', base64: 'AQID' });
  assert.equal(payload.v, 1);
});

test('submission maps server answers to distinct client codes', async () => {
  const payload = buildFeedbackPayload({ installId: INSTALL_ID, createdAt: new Date().toISOString(), message: 'hi' });
  const reply = (status, body) => async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:9/v1/feedback');
    assert.equal(init.method, 'POST');
    assert.equal(JSON.parse(init.body).proof, payload.proof);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const origin = 'http://127.0.0.1:9';
  assert.deepEqual(await submitFeedback(payload, { origin, fetchImpl: reply(201, { ok: true, id: 'fb_abc12345' }) }), { ok: true, id: 'fb_abc12345' });
  assert.equal((await submitFeedback(payload, { origin, fetchImpl: reply(429, { ok: false, error: 'rate_limited' }) })).code, 'rate_limited');
  assert.equal((await submitFeedback(payload, { origin, fetchImpl: reply(413, { ok: false, error: 'too_large' }) })).code, 'too_large');
  assert.equal((await submitFeedback(payload, { origin, fetchImpl: reply(503, { ok: false, error: 'busy' }) })).code, 'busy');
  assert.equal((await submitFeedback(payload, { origin, fetchImpl: reply(507, { ok: false }) })).code, 'server');
  const offline = await submitFeedback(payload, { origin, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(offline.code, 'offline');
  const hanging = await submitFeedback(payload, {
    origin,
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(hanging.code, 'timeout');
});

test('a body past the server cap fails as too_large without a request, and big bodies get more time', async () => {
  const payload = buildFeedbackPayload({ installId: INSTALL_ID, createdAt: new Date().toISOString(), message: 'hi' });
  assert.equal(FEEDBACK_MAX_BODY_BYTES, SERVER_MAX_BODY_BYTES);
  let requests = 0;
  const result = await submitFeedback({ ...payload, chat: 'x'.repeat(FEEDBACK_MAX_BODY_BYTES) }, {
    origin: 'http://127.0.0.1:9',
    fetchImpl: async () => { requests += 1; throw new Error('should not send'); },
  });
  assert.deepEqual(result, { ok: false, code: 'too_large' });
  assert.equal(requests, 0);
  assert.equal(feedbackTimeoutMs(1024), 31_000);
  assert.ok(feedbackTimeoutMs(35 * 1024 * 1024) > 5 * 60_000, 'a 35 MiB upload may take minutes');
  assert.equal(feedbackTimeoutMs(1024 * 1024 * 1024), 10 * 60_000);
});

test('the site-api origin override only applies to development runs', () => {
  const env = { RAU_SITE_API_ORIGIN: 'http://127.0.0.1:8799/' };
  assert.equal(feedbackOrigin({ packaged: false, env }), 'http://127.0.0.1:8799');
  assert.equal(feedbackOrigin({ packaged: true, env }), 'https://rau-credits-production.up.railway.app');
});
