import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createAdminUiServer, createKeychain } from '../admin-ui/server.mjs';

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/** Records every call the admin page forwards. */
async function fakeUpstream(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, betas: [] }));
    });
  });
  const port = await listen(t, server);
  return { calls, base: `http://127.0.0.1:${port}` };
}

/** Raw request so the test controls Host and Origin. */
function request(port, { method = 'GET', path = '/', host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

test('admin page: only its own host, session and origin reach an allowlisted admin route, with the bearer added', async (t) => {
  const upstream = await fakeUpstream(t);
  const port = await listen(t, createAdminUiServer({ port: 0, base: upstream.base, envToken: 'admin-secret', keychain: { read: async () => '' } }));

  assert.equal((await request(port, { host: `evil.example:${port}` })).status, 421, 'DNS-rebound host');
  const page = await request(port, { host: `localhost:${port}` });
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('admin-secret'), 'the token never reaches the page');
  const session = page.text.match(/name="admin-session" content="([^"]+)"/)[1];

  const json = { 'Content-Type': 'application/json' };
  assert.equal((await request(port, { path: '/api/betas' })).json.error, 'bad_session');
  assert.equal((await request(port, { path: '/api/betas', headers: { 'X-Admin-Session': 'guess' } })).json.error, 'bad_session');
  assert.equal((await request(port, { path: '/api/betas', host: `evil.example:${port}`, headers: { 'X-Admin-Session': session } })).status, 421);
  assert.equal((await request(port, {
    method: 'POST', path: '/api/revoke', headers: { ...json, 'X-Admin-Session': session, Origin: 'https://evil.example' }, body: { key: 'k' },
  })).json.error, 'bad_origin');
  for (const path of ['/api/orders', '/api/../v1/admin/orders', '/v1/admin/licenses/betas']) {
    assert.equal((await request(port, { path, headers: { 'X-Admin-Session': session } })).status, 404, path);
  }
  assert.equal(upstream.calls.length, 0, 'nothing rejected reached the admin API');

  const ok = await request(port, {
    method: 'POST',
    path: '/api/revoke',
    headers: { ...json, 'X-Admin-Session': session, Origin: `http://127.0.0.1:${port}` },
    body: { key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', amount: 1 },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(upstream.calls, [{
    method: 'POST',
    url: '/v1/admin/licenses/revoke',
    auth: 'Bearer admin-secret',
    body: { key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' },
  }]);
});

test('admin page: without a token it asks once and keeps it in the Keychain, never through a shell', async (t) => {
  const upstream = await fakeUpstream(t);
  const runs = [];
  let stored = '';
  const keychain = createKeychain({
    service: 'throwaway-test-service',
    run: async (file, args) => {
      runs.push([file, ...args]);
      if (args[0] === 'add-generic-password') stored = args.at(-1);
      if (args[0] === 'find-generic-password' && !stored) throw new Error('not found');
      return { stdout: `${stored}\n` };
    },
  });
  const port = await listen(t, createAdminUiServer({ port: 0, base: upstream.base, envToken: '', keychain }));
  const session = (await request(port)).text.match(/name="admin-session" content="([^"]+)"/)[1];
  const headers = { 'X-Admin-Session': session, 'Content-Type': 'application/json' };

  if (process.platform !== 'darwin') return; // Keychain is macOS only.
  assert.equal((await request(port, { path: '/api/state', headers })).json.tokenSource, null);
  assert.equal((await request(port, { path: '/api/betas', headers })).json.error, 'token_missing');
  assert.equal((await request(port, { method: 'POST', path: '/api/token', headers, body: { token: 'from-ui' } })).status, 200);
  assert.deepEqual(runs.at(-1), ['security', 'add-generic-password', '-U', '-s', 'throwaway-test-service', '-a', 'admin', '-w', 'from-ui']);
  assert.equal((await request(port, { path: '/api/betas', headers })).status, 200);
  assert.equal(upstream.calls.at(-1).auth, 'Bearer from-ui');
});

test('admin page: ADMIN_UI_PUBLIC_ORIGIN admits exactly one https front door', async (t) => {
  const upstream = await fakeUpstream(t);
  const front = 'https://mini.tailnet.ts.net:8447';
  const port = await listen(t, createAdminUiServer({
    port: 0, base: upstream.base, envToken: 'admin-secret', keychain: { read: async () => '' }, publicOrigin: front,
  }));
  const page = await request(port, { host: 'mini.tailnet.ts.net:8447' });
  assert.equal(page.status, 200);
  const session = page.text.match(/name="admin-session" content="([^"]+)"/)[1];
  const call = (host, origin) => request(port, { path: '/api/betas', host, headers: { 'X-Admin-Session': session, Origin: origin } });
  assert.equal((await call('mini.tailnet.ts.net:8447', front)).status, 200);
  assert.equal((await call('mini.tailnet.ts.net:8447', 'http://mini.tailnet.ts.net:8447')).json.error, 'bad_origin');
  assert.equal((await call('other.tailnet.ts.net:8447', 'https://other.tailnet.ts.net:8447')).status, 421);
  assert.equal(upstream.calls.length, 1);
  assert.throws(() => createAdminUiServer({ publicOrigin: 'http://mini.tailnet.ts.net:8447' }), /bare https origin/);
});

test('admin page: gift amounts reach the admin API with only keyId and amountUsd', async (t) => {
  const upstream = await fakeUpstream(t);
  const port = await listen(t, createAdminUiServer({ port: 0, base: upstream.base, envToken: 'admin-secret', keychain: { read: async () => '' } }));
  const session = (await request(port)).text.match(/name="admin-session" content="([^"]+)"/)[1];
  const headers = { 'X-Admin-Session': session, 'Content-Type': 'application/json' };
  await request(port, { method: 'POST', path: '/api/gift-amount', headers, body: { keyId: 'lic_1', amountUsd: 12.5, eventId: 'other' } });
  await request(port, { method: 'POST', path: '/api/issue-beta', headers, body: { name: 'T', giftUsd: 3 } });
  assert.deepEqual(upstream.calls.map((c) => [c.url, c.auth, c.body]), [
    ['/v1/admin/gifts/amount', 'Bearer admin-secret', { keyId: 'lic_1', amountUsd: 12.5 }],
    ['/v1/admin/licenses/issue-beta', 'Bearer admin-secret', { name: 'T', giftUsd: 3 }],
  ]);
});

test('admin page: customer, device, renewal and attention routes forward only their fields, with issue and extend pinned to one emailed year', async (t) => {
  const upstream = await fakeUpstream(t);
  const port = await listen(t, createAdminUiServer({ port: 0, base: upstream.base, envToken: 'admin-secret', keychain: { read: async () => '' } }));
  const session = (await request(port)).text.match(/name="admin-session" content="([^"]+)"/)[1];
  const headers = { 'X-Admin-Session': session, 'Content-Type': 'application/json' };
  const extra = { merchantUid: 'm_x', note: 'n', until: '2099-01-01', years: 10, sendEmail: false, reason: 'r', tier: 'beta' };
  const calls = [
    ['GET', '/api/customers?email=a@b.c'],
    ['GET', '/api/attention?kind=rejected'],
    ['POST', '/api/issue', { email: 'buyer@example.com', ...extra }],
    ['POST', '/api/extend', { keyId: 'lic_1', ...extra }],
    ['POST', '/api/resend-email', { keyId: 'lic_1', email: 'fixed@example.com', ...extra }],
    ['POST', '/api/remove-device', { keyId: 'lic_1', deviceId: 'device-1', ...extra }],
    ['POST', '/api/release', { merchantUid: 'm_1', keyId: 'lic_1', amount: 1 }],
    ['POST', '/api/apply-renewal', { merchantUid: 'm_2', keyId: 'lic_1', until: '2099-01-01', years: 10 }],
    ['POST', '/api/ack', { id: 'wh_1', merchantUid: 'm_3', status: 'issued' }],
  ];
  for (const [method, path, body] of calls) assert.equal((await request(port, { method, path, headers, body })).status, 200, path);
  assert.deepEqual(upstream.calls.map((c) => [c.method, c.url, c.body]), [
    ['GET', '/v1/admin/licenses/customers', null],
    ['GET', '/v1/admin/attention', null],
    ['POST', '/v1/admin/licenses/issue', { email: 'buyer@example.com', sendEmail: true, years: 1 }],
    ['POST', '/v1/admin/licenses/extend', { keyId: 'lic_1', years: 1 }],
    ['POST', '/v1/admin/licenses/resend-email', { keyId: 'lic_1', email: 'fixed@example.com' }],
    ['POST', '/v1/admin/licenses/remove-device', { keyId: 'lic_1', deviceId: 'device-1' }],
    ['POST', '/v1/admin/orders/release', { merchantUid: 'm_1' }],
    ['POST', '/v1/admin/orders/apply-renewal', { merchantUid: 'm_2', keyId: 'lic_1' }],
    ['POST', '/v1/admin/attention/ack', { id: 'wh_1', merchantUid: 'm_3' }],
  ]);
});
