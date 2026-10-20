import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAdminUiServer } from '../admin-ui/server.mjs';
import { createFeedbackProof, createFeedbackService, sha256Hex } from '../feedback.mjs';
import { siteRequestListener } from '../server.mjs';

const ADMIN = 'admin-token-for-feedback-tests';
const DAY = 24 * 60 * 60 * 1000;
const INSTALL = '3f2b8c1e-5d4a-4f6b-9c7d-1e2f3a4b5c6d';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const HWP = Buffer.from('HWP Document File fixture bytes');

async function setup(t, { maxStorageBytes, notify = async () => {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = { now: Date.parse('2026-10-20T03:00:00.000Z') };
  const feedback = createFeedbackService({ dir, now: () => clock.now, adminToken: ADMIN, maxStorageBytes, notify });
  const server = http.createServer(siteRequestListener({ feedback }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${origin}/v1/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const admin = (route, { method = 'GET', body, token = ADMIN } = {}) => fetch(`${origin}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { dir, clock, origin, post, admin };
}

function report(clock, overrides = {}) {
  const installId = overrides.installId ?? INSTALL;
  const createdAt = overrides.createdAt ?? new Date(clock.now).toISOString();
  const message = overrides.message ?? '표를 붙여 넣으면 앱이 멈춥니다.\n두 번째 줄';
  return {
    v: 1,
    installId,
    createdAt,
    proof: createFeedbackProof({ installId, createdAt, message }),
    message,
    email: 'tester@example.com',
    meta: { appVersion: '3.0.4', commit: 'abc1234', os: 'darwin', osVersion: '15.1', arch: 'arm64', screenshotBlurred: true },
    log: '[renderer] TypeError: x is undefined\n',
    screenshot: { mime: 'image/png', base64: PNG.toString('base64') },
    document: { name: '../../보고서 초안.hwp', base64: HWP.toString('base64') },
    ...overrides,
  };
}

test('feedback: a signed report is stored in its own directory, indexed, and pinged to Telegram', async (t) => {
  const pings = [];
  const { dir, clock, post } = await setup(t, { notify: async (text) => { pings.push(text); } });
  const res = await post(report(clock));
  assert.equal(res.status, 201);
  const { ok, id } = await res.json();
  assert.equal(ok, true);
  assert.match(id, /^fb_[0-9a-z]+$/);

  assert.deepEqual((await fs.readdir(path.join(dir, id))).sort(), ['document.hwp', 'log.txt', 'report.json', 'screenshot.png']);
  assert.deepEqual(await fs.readFile(path.join(dir, id, 'screenshot.png')), PNG);
  const stored = JSON.parse(await fs.readFile(path.join(dir, id, 'report.json'), 'utf8'));
  assert.equal(stored.installHash, sha256Hex(INSTALL));
  assert.ok(!JSON.stringify(stored).includes(INSTALL), 'only the install hash is stored');
  assert.ok(!JSON.stringify(stored).includes(PNG.toString('base64')), 'no blobs in report.json');
  assert.equal(stored.attachments.document.name, '보고서 초안.hwp');
  const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(index.reports.map((r) => [r.id, r.status]), [[id, 'new']]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pings.length, 1);
  assert.match(pings[0], /표를 붙여 넣으면/);
  assert.match(pings[0], /3\.0\.4 · macOS 15\.1 arm64/);
  assert.match(pings[0], /첨부: 스크린샷, 로그, 문서/);
});

test('feedback: a failing Telegram ping still answers 201', async (t) => {
  const { clock, post } = await setup(t, { notify: async () => { throw new Error('telegram down'); } });
  assert.equal((await post(report(clock))).status, 201);
});

test('feedback: bad proof, stale clock, bad fields and oversize bodies are refused with contract codes', async (t) => {
  const { dir, clock, post } = await setup(t);
  const expect = async (body, status, error, field) => {
    const res = await post(body);
    const json = await res.json();
    assert.equal(res.status, status, JSON.stringify(json));
    assert.equal(json.error, error);
    if (field) assert.equal(json.field, field);
  };
  await expect({ ...report(clock), message: 'edited after signing' }, 401, 'bad_proof');
  await expect({ ...report(clock), proof: 'zz' }, 401, 'bad_proof');
  await expect(report(clock, { createdAt: new Date(clock.now - 2 * DAY).toISOString() }), 400, 'invalid', 'createdAt');
  await expect(report(clock, { message: '   ' }), 400, 'invalid', 'message');
  await expect(report(clock, { installId: '../etc' }), 400, 'invalid', 'installId');
  await expect(report(clock, { screenshot: { mime: 'image/png', base64: HWP.toString('base64') } }), 400, 'invalid', 'screenshot');
  await expect(report(clock, { email: 'not-an-email' }), 400, 'invalid', 'email');
  await expect('{"v":1,', 400, 'invalid');
  const bigShot = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]).toString('base64');
  await expect(report(clock, { screenshot: { mime: 'image/png', base64: bigShot } }), 413, 'too_large', 'screenshot');
  await expect(report(clock, { log: 'x'.repeat(41 * 1024 * 1024) }), 413, 'too_large');
  assert.deepEqual(await fs.readdir(dir).catch(() => []), [], 'nothing was stored');
});

test('feedback: five reports per install per hour, then 429', async (t) => {
  const { clock, post } = await setup(t);
  const light = (extra) => report(clock, { screenshot: undefined, document: undefined, ...extra });
  for (let i = 0; i < 5; i += 1) assert.equal((await post(light())).status, 201);
  const limited = await post(light());
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { ok: false, error: 'rate_limited' });
  assert.equal((await post(light({ installId: '0a2b8c1e-5d4a-4f6b-9c7d-1e2f3a4b5c6d' }))).status, 201, 'another install is not limited');
});

test('feedback: only hwp, hwpx and hml keep their name; bidi and control characters are stripped', async (t) => {
  const { dir, clock, post } = await setup(t);
  const stored = async (name) => {
    const { id } = await (await post(report(clock, { installId: crypto.randomUUID(), document: { name, base64: HWP.toString('base64') } }))).json();
    const json = JSON.parse(await fs.readFile(path.join(dir, id, 'report.json'), 'utf8'));
    return [json.attachments.document.name, (await fs.readdir(path.join(dir, id))).find((f) => f.startsWith('document'))];
  };
  assert.deepEqual(await stored('invoice.exe'), ['document.bin', 'document.bin']);
  assert.deepEqual(await stored('보고\u202Eexe.hwp'), ['보고exe.hwp', 'document.hwp']);
  assert.deepEqual(await stored('a\u2066b\u0085.HWPX'), ['ab.HWPX', 'document.hwpx']);
  assert.deepEqual(await stored('notes.hml\u202E'), ['notes.hml', 'document.hml']);
});

/** Starts a feedback upload that declares a large body, sends one chunk and leaves it open. */
function openUpload(origin) {
  const req = http.request(`${origin}/v1/feedback`, {
    method: 'POST',
    agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': 30 * 1024 * 1024 },
  });
  req.on('error', () => {});
  req.write(Buffer.alloc(64 * 1024, 0x20));
  const answer = new Promise((resolve) => req.on('response', (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  }));
  return { req, answer };
}

test('feedback: the per-IP limit refuses before the body is read', { timeout: 5000 }, async (t) => {
  const { origin, post } = await setup(t);
  for (let i = 0; i < 20; i += 1) assert.equal((await post('{}')).status, 400);
  const upload = openUpload(origin);
  assert.deepEqual(await upload.answer, { status: 429, body: { ok: false, error: 'rate_limited' } });
  upload.req.destroy();
});

test('feedback: a fourth upload in flight is refused as busy, and the slot frees when one ends', { timeout: 5000 }, async (t) => {
  const { origin, clock, post } = await setup(t);
  const held = [];
  for (let i = 0; i < 3; i += 1) {
    held.push(openUpload(origin));
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const busy = openUpload(origin);
  assert.deepEqual(await busy.answer, { status: 503, body: { ok: false, error: 'busy' } });
  busy.req.destroy();
  held[0].req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await post(report(clock))).status, 201);
  for (const { req } of held) req.destroy();
});

test('feedback admin: list, detail, attachments, status and delete need the token and stay inside the report', async (t) => {
  const { dir, clock, post, admin } = await setup(t);
  const first = (await (await post(report(clock))).json()).id;
  clock.now += 1000;
  const second = (await (await post(report(clock, { message: '두 번째 제보', screenshot: undefined, document: undefined, chat: 'user: 안녕' }))).json()).id;

  assert.equal((await admin('/v1/admin/feedback', { token: 'wrong' })).status, 403);
  const list = await (await admin('/v1/admin/feedback')).json();
  assert.deepEqual(list.reports.map((r) => r.id), [second, first], 'newest first');
  assert.deepEqual(list.counts, { new: 2, seen: 0, resolved: 0 });
  assert.equal(list.reports[1].attachments.document.name, '보고서 초안.hwp');
  assert.equal(list.reports[1].attachments.document.file, undefined, 'disk names stay private');

  const detail = await (await admin(`/v1/admin/feedback/report?id=${first}`)).json();
  assert.equal(detail.report.message, report(clock).message);
  assert.equal(detail.report.meta.commit, 'abc1234');

  const shot = await admin(`/v1/admin/feedback/attachment?id=${first}&name=screenshot`);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG);
  const doc = await admin(`/v1/admin/feedback/attachment?id=${first}&name=document`);
  assert.equal(doc.headers.get('content-type'), 'application/octet-stream');
  assert.equal(doc.headers.get('content-disposition'), `attachment; filename="______.hwp"; filename*=UTF-8''${encodeURIComponent('보고서 초안.hwp')}`);
  assert.deepEqual(Buffer.from(await doc.arrayBuffer()), HWP);
  assert.equal(await (await admin(`/v1/admin/feedback/attachment?id=${second}&name=chat`)).text(), 'user: 안녕');

  assert.equal((await admin(`/v1/admin/feedback/attachment?id=${first}&name=report.json`)).status, 400);
  assert.equal((await admin(`/v1/admin/feedback/attachment?id=${encodeURIComponent('../index.json')}&name=log`)).status, 400);
  assert.equal((await admin(`/v1/admin/feedback/attachment?id=fb_00000000missing&name=log`)).status, 404);
  assert.equal((await admin(`/v1/admin/feedback/attachment?id=${second}&name=screenshot`)).status, 404);

  assert.equal((await admin('/v1/admin/feedback/status', { method: 'POST', body: { id: first, status: 'done' } })).status, 400);
  assert.equal((await admin('/v1/admin/feedback/status', { method: 'POST', body: { id: first, status: 'resolved' } })).status, 200);
  assert.equal((await admin('/v1/admin/feedback/delete', { method: 'POST', body: { id: second } })).status, 200);
  const after = await (await admin('/v1/admin/feedback')).json();
  assert.deepEqual(after.reports.map((r) => [r.id, r.status]), [[first, 'resolved']]);
  await assert.rejects(fs.access(path.join(dir, second)));
});

test('feedback: reports older than 90 days are pruned, and a full volume answers 507', async (t) => {
  const { dir, clock, post, admin } = await setup(t, { maxStorageBytes: 3000 });
  const big = () => report(clock, { log: 'x'.repeat(2000) });
  const old = (await (await post(big())).json()).id;
  const orphan = path.join(dir, 'fb_0000000000orphan');
  await fs.mkdir(orphan);
  const full = await post(big());
  assert.equal(full.status, 507, 'two reports do not fit in 3000 bytes');
  assert.equal((await full.json()).error, 'storage_full');

  clock.now += 91 * DAY;
  assert.equal((await post(big())).status, 201, 'pruning the old one makes room');
  const { reports } = await (await admin('/v1/admin/feedback')).json();
  assert.equal(reports.length, 1);
  assert.notEqual(reports[0].id, old);
  await assert.rejects(fs.access(path.join(dir, old)));
  await assert.rejects(fs.access(orphan), 'directories missing from the index are removed');
});

test('admin page: feedback attachments pass through the proxy byte for byte', async (t) => {
  const { clock, post, origin } = await setup(t);
  const id = (await (await post(report(clock))).json()).id;
  const ui = createAdminUiServer({ port: 0, base: origin, envToken: ADMIN, keychain: { read: async () => '' } });
  await new Promise((resolve) => ui.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => ui.close(resolve)));
  const page = `http://127.0.0.1:${ui.address().port}`;
  const session = (await (await fetch(page)).text()).match(/name="admin-session" content="([^"]+)"/)[1];
  const headers = { 'X-Admin-Session': session };

  assert.equal((await fetch(`${page}/api/feedback/attachment?id=${id}&name=screenshot`)).status, 403, 'session required');
  const shot = await fetch(`${page}/api/feedback/attachment?id=${id}&name=screenshot`, { headers });
  assert.equal(shot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG);
  const doc = await fetch(`${page}/api/feedback/attachment?id=${id}&name=document`, { headers });
  assert.match(doc.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await doc.arrayBuffer()), HWP);
  const list = await (await fetch(`${page}/api/feedback`, { headers })).json();
  assert.deepEqual(list.reports.map((r) => r.id), [id]);
});
