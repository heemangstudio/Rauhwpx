import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserPolicy } from '../browser-policy.mjs';

// DESIGN §4: 사이트 S 를 채팅 T 에서 본 상태. B 차단, G 사이트 사용, R 연구 기본값, L 로그인됨.
const owner = { isHuman: true, clientId: 'owner', threadId: 'chat-t' };
const agent = { threadId: 'chat-t', projectId: 'project', agentId: 'chat-t:root' };
const subagent = { ...agent, agentId: 'chat-t:task:7', taskId: '7' };
const other = { ...agent, threadId: 'chat-u', agentId: 'chat-u:root' };
const SHOP = 'https://www.shop.example.com';
const profileId = 'default';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-policy-decide-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  await policy.ready();
  return { dataDir, policy };
}
const decide = (policy, input) => policy.check({ profileId, ...input });
async function signIn(policy, origin = SHOP) {
  await policy.markSignedIn({ profileId, origin, source: 'owner-form' });
  await policy.setCookieSites(profileId, ['https://example.com']);
}

test('navigation and reads: a block wins, site access allows, a signed-in site asks, and a public site is open', async (t) => {
  const { policy } = await fixture(t);
  for (const action of ['browse', 'read']) {
    assert.equal((await decide(policy, { actor: agent, action, url: `${SHOP}/item` })).source, 'public', 'not signed in: open');
  }
  await signIn(policy);
  const asked = await decide(policy, { actor: agent, action: 'browse', url: `${SHOP}/orders` });
  assert.deepEqual([asked.allowed, asked.code, asked.reason, asked.site], [false, 'BROWSER_PERMISSION_REQUIRED', 'signed-in', 'example.com']);
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: 'https://login.example.com/' })).reason, 'signed-in', 'the marker covers the registrable domain');
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: `${SHOP}/orders`, shared: true })).allowed, true, 'an owner-shared tab is readable');
  assert.equal((await decide(policy, { actor: owner, action: 'read', url: `${SHOP}/orders` })).allowed, true, 'the owner is always allowed');

  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'chat' });
  const granted = await decide(policy, { actor: agent, action: 'read', url: 'https://m.example.com/orders' });
  assert.deepEqual([granted.allowed, granted.source], [true, 'chat']);
  assert.equal((await decide(policy, { actor: other, action: 'read', url: `${SHOP}/orders` })).reason, 'signed-in', 'a chat grant stays in its chat');

  await policy.update({ actor: owner, operation: 'set-site', origin: SHOP, blockedActions: ['browse'] });
  const blocked = await decide(policy, { actor: agent, action: 'browse', url: `${SHOP}/` });
  assert.deepEqual([blocked.allowed, blocked.code, blocked.blocked], [false, 'BROWSER_SITE_BLOCKED', ['browse']], 'a block beats a chat grant');
});

test('subresources load on signed-in sites but stop at a block', async (t) => {
  const { policy } = await fixture(t);
  await signIn(policy);
  assert.equal((await decide(policy, { actor: agent, action: 'browse', url: 'https://cdn.example.com/logo.png', resource: 'subresource' })).allowed, true);
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://cdn.example.com', blockedActions: ['browse'] });
  assert.equal((await decide(policy, { actor: agent, action: 'browse', url: 'https://cdn.example.com/logo.png', resource: 'subresource' })).code, 'BROWSER_SITE_BLOCKED');
  assert.equal((await decide(policy, { actor: agent, action: 'browse', url: 'https://www.example.com/app.js', resource: 'subresource' })).allowed, true, 'a sub-host block stays on that host');
});

test('website changes and saved items need site access on every site, and research defaults never grant them', async (t) => {
  const { policy } = await fixture(t);
  for (const action of ['website-change', 'account-use']) {
    const denied = await decide(policy, { actor: agent, action, url: `${SHOP}/cart` });
    assert.deepEqual([denied.code, denied.reason], ['BROWSER_PERMISSION_REQUIRED', action]);
    assert.equal((await decide(policy, { actor: agent, action, url: 'https://docs.google.com/document/d/x' })).allowed, false, 'research defaults are read-only');
  }
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: 'https://docs.google.com/document/d/x' })).source, 'research-default');
  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: 'https://login.example.com', scope: 'always' });
  for (const actor of [agent, other]) for (const action of ['website-change', 'account-use']) {
    assert.equal((await decide(policy, { actor, action, url: `${SHOP}/cart` })).source, 'user', 'always covers every chat and every subdomain');
  }
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://example.com', blockedActions: ['website-change'] });
  assert.equal((await decide(policy, { actor: agent, action: 'website-change', url: `${SHOP}/cart` })).code, 'BROWSER_SITE_BLOCKED');
  assert.equal((await decide(policy, { actor: agent, action: 'account-use', url: `${SHOP}/login` })).allowed, true, 'only the blocked action is off');
});

test('downloads and imports stay open on readable pages unless blocked', async (t) => {
  const { policy } = await fixture(t);
  await signIn(policy);
  for (const action of ['download', 'research-import']) assert.equal((await decide(policy, { actor: agent, action, url: `${SHOP}/invoice.pdf` })).allowed, true);
  await policy.update({ actor: owner, operation: 'set-site', origin: SHOP, blockedActions: ['download'] });
  assert.deepEqual((await decide(policy, { actor: agent, action: 'download', url: `${SHOP}/invoice.pdf` })).blocked, ['download']);
});

test('a login or secret the owner turned off is blocked even with site access', async (t) => {
  const { policy } = await fixture(t);
  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'chat' });
  const item = { accountId: '11111111-1111-4111-8111-111111111111', blocked: true };
  const denied = await decide(policy, { actor: agent, action: 'account-use', url: `${SHOP}/login`, item });
  assert.deepEqual([denied.code, denied.item.accountId], ['BROWSER_SITE_BLOCKED', item.accountId]);
  assert.equal((await decide(policy, { actor: agent, action: 'account-use', url: `${SHOP}/login`, item: { ...item, blocked: false } })).allowed, true);
});

test('pages without a web origin, HTTP previews and IPs are never treated as signed-in sites', async (t) => {
  const { policy } = await fixture(t);
  for (const url of ['about:blank', 'data:text/html,hi', 'chrome-error://chromewebdata/']) {
    assert.equal((await decide(policy, { actor: agent, action: 'read', url })).source, 'no-origin');
  }
  for (const origin of ['http://localhost:5173', 'https://127.0.0.1:8443']) {
    await policy.markSignedIn({ profileId, origin, source: 'owner-form' });
    await policy.setCookieSites(profileId, [origin]);
    assert.equal((await decide(policy, { actor: agent, action: 'read', url: `${origin}/` })).allowed, true, origin);
  }
});

test('a signed-in site needs both evidence and live cookies, and a saved login counts as evidence', async (t) => {
  const { policy } = await fixture(t);
  await policy.setCookieSites(profileId, ['https://example.com']);
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: SHOP })).allowed, true, 'cookies alone never gate');
  policy.setSavedLoginSites(profileId, ['https://example.com']);
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: SHOP })).reason, 'signed-in');
  policy.setSavedLoginSites(profileId, []);
  await policy.markSignedIn({ profileId, origin: SHOP, source: 'handoff' });
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: SHOP })).reason, 'signed-in');
  await policy.setCookieSites(profileId, []);
  assert.equal((await decide(policy, { actor: agent, action: 'read', url: SHOP })).allowed, true, 'no cookies left: the marker is gone');
  assert.equal((await policy.list()).signedIn.length, 0);
});

test('every denial names its site and carries the exact next call; a subagent reports to the root', async (t) => {
  const { policy } = await fixture(t);
  await signIn(policy);
  const failure = await policy.assertAllowed({ actor: agent, action: 'browse', url: `${SHOP}/orders`, profileId }).catch((error) => error);
  assert.deepEqual({ code: failure.code, reason: failure.reason, site: failure.site, origin: failure.origin, performed: failure.performed, request: failure.request },
    { code: 'BROWSER_PERMISSION_REQUIRED', reason: 'signed-in', site: 'example.com', origin: SHOP, performed: false, request: { tool: 'browser_request_account', args: { kind: 'site', origin: SHOP } } });
  assert.match(failure.message, /browser_request_account with \{"kind":"site","origin":"https:\/\/www\.shop\.example\.com"\}/);
  const delegated = await policy.assertAllowed({ actor: subagent, action: 'website-change', url: SHOP }).catch((error) => error);
  assert.equal(delegated.request.reportToRoot, true);
  assert.match(delegated.message, /Report to the root conversation that example\.com needs site access/);
  await policy.update({ actor: owner, operation: 'set-site', origin: SHOP, blockedActions: ['download'] });
  const blocked = await policy.assertAllowed({ actor: agent, action: 'download', url: SHOP }).catch((error) => error);
  assert.deepEqual(blocked.request.args, { kind: 'site', origin: SHOP, blocked: ['download'] });
  const secret = { secretId: '22222222-2222-4222-8222-222222222222', label: 'Key', origins: [SHOP], kind: 'api-key' };
  const secretDenial = await policy.assertAllowed({ actor: agent, action: 'account-use', url: SHOP, item: secret }).catch((error) => error);
  assert.equal(secretDenial.request.tool, 'request_secret');
  assert.equal(secretDenial.request.args.secretId, secret.secretId);
});

test('lifting a block takes only the listed actions, is saved for every chat, and a plain grant never unblocks', async (t) => {
  const { policy } = await fixture(t);
  await policy.update({ actor: owner, operation: 'set-site', origin: SHOP, blockedActions: ['download', 'website-change'] });
  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'always' });
  assert.equal((await decide(policy, { actor: agent, action: 'website-change', url: SHOP })).code, 'BROWSER_SITE_BLOCKED', 'an ordinary approval leaves blocks alone');
  await assert.rejects(policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'chat', unblock: ['website-change'] }), { code: 'BROWSER_INVALID_POLICY' });
  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'always', unblock: ['website-change'] });
  assert.equal((await decide(policy, { actor: other, action: 'website-change', url: SHOP })).allowed, true);
  assert.equal((await decide(policy, { actor: agent, action: 'download', url: SHOP })).code, 'BROWSER_SITE_BLOCKED', 'the unlisted block stays');
  await assert.rejects(policy.grantSiteAccess({ actor: agent, threadId: agent.threadId, origin: SHOP, scope: 'always' }), { code: 'BROWSER_OWNER_REQUIRED' });
});

test('chat grants survive restarts until the chat is deleted, and revoking a site removes every grant', async (t) => {
  const { policy, dataDir } = await fixture(t);
  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'chat' });
  const restarted = createBrowserPolicy({ dataDir });
  assert.equal((await restarted.check({ actor: agent, action: 'website-change', url: SHOP })).source, 'chat');
  assert.deepEqual((await restarted.siteStatus(agent)).map((row) => [row.site, row.chat, row.always]), [['example.com', true, false]]);
  await restarted.endThread(agent.threadId);
  assert.equal((await restarted.check({ actor: agent, action: 'website-change', url: SHOP })).allowed, false);
  await restarted.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: SHOP, scope: 'chat' });
  await restarted.grantSiteAccess({ actor: owner, threadId: other.threadId, origin: SHOP, scope: 'always' });
  await restarted.revokeSiteAccess({ actor: owner, origin: 'https://example.com' });
  for (const actor of [agent, other]) assert.equal((await restarted.check({ actor, action: 'website-change', url: SHOP })).allowed, false);
});

test('signed-in markers are capped per profile without throwing, evicting markers without cookies first', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-policy-markers-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir, signedInLimit: 8 });
  await policy.setCookieSites(profileId, ['https://keep.com']);
  await policy.markSignedIn({ profileId, origin: 'https://www.keep.com', source: 'owner-form' });
  for (let index = 1; index <= 12; index++) assert.equal(await policy.markSignedIn({ profileId, domain: `site-${index}.com`, source: 'owner-form' }), true);
  const markers = (await policy.list()).signedIn.filter((marker) => marker.profileId === profileId);
  assert.equal(markers.length, 8);
  assert.ok(markers.some((marker) => marker.key === 'https://keep.com'), 'the marker with live cookies survives');
  assert.ok(markers.some((marker) => marker.key === 'https://site-12.com') && !markers.some((marker) => marker.key === 'https://site-1.com'), 'then the oldest go first');
});
