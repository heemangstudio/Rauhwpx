import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { siteRequestListener } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';
import { createUniqueInstallsService, emptyUniqueInstallsState } from '../unique-installs.mjs';
import { createWaitlistService, emptyWaitlistState } from '../waitlist.mjs';

const ADMIN = 'admin-token-for-tests';

async function listen(waitlist) {
  const uniqueInstalls = createUniqueInstallsService({
    store: createMemoryStore(emptyUniqueInstallsState()),
  });
  const server = http.createServer(siteRequestListener({ uniqueInstalls, waitlist }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('website signups are stored once, readable only with the admin token, and notified', async () => {
  const notified = [];
  const waitlist = createWaitlistService({
    store: createMemoryStore(emptyWaitlistState()),
    now: () => Date.parse('2026-10-06T00:00:00.000Z'),
    adminToken: ADMIN,
    telegramBotToken: 'bot-token',
    telegramChatId: '42',
    fetchImpl: async (url, init) => {
      notified.push([url, JSON.parse(init.body)]);
      return new Response('{}');
    },
  });
  const server = await listen(waitlist);
  try {
    // 웹사이트처럼 text/plain 으로 보낸다.
    const join = (email) => fetch(`${server.origin}/v1/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ email }),
    });
    const first = await join('Andy@Example.com');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('access-control-allow-origin'), '*');
    assert.equal((await join('andy@example.com')).status, 200);

    const bad = await join('not-an-email');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('access-control-allow-origin'), '*');
    assert.equal((await bad.json()).error, 'WAITLIST_EMAIL_INVALID');

    assert.equal((await fetch(`${server.origin}/v1/waitlist`)).status, 403);
    const listed = await fetch(`${server.origin}/v1/waitlist`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    assert.deepEqual(await listed.json(), {
      count: 1,
      entries: [{ email: 'Andy@Example.com', joinedAt: '2026-10-06T00:00:00.000Z' }],
    });
    assert.deepEqual(notified, [[
      'https://api.telegram.org/botbot-token/sendMessage',
      { chat_id: '42', text: 'Rauhwpx 체험 신청: Andy@Example.com' },
    ]]);
  } finally {
    await server.close();
  }
});

test('the waitlist stays closed when no admin token is configured', async () => {
  const server = await listen(createWaitlistService({ store: createMemoryStore(emptyWaitlistState()) }));
  try {
    const response = await fetch(`${server.origin}/v1/waitlist`, { headers: { Authorization: 'Bearer ' } });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});
