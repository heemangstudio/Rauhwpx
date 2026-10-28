import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserPolicy, readBrowserJson, writeBrowserJson } from '../browser-policy.mjs';

const owner = { isHuman: true, clientId: 'owner' };
const agent = { threadId: 'thread-a', projectId: 'project-a', agentId: 'root' };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-policy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  await policy.ready();
  return { dataDir, policy };
}

test('public research works immediately while website changes and saved items require site access', async (t) => {
  const { policy } = await fixture(t);
  for (const action of ['browse', 'read', 'download', 'research-import']) {
    assert.equal((await policy.check({ actor: agent, action, url: 'https://pubmed.ncbi.nlm.nih.gov/123/' })).allowed, true);
  }
  assert.equal((await policy.check({ actor: agent, action: 'website-change', url: 'https://docs.google.com/' })).allowed, false);
  assert.equal((await policy.check({ actor: agent, action: 'account-use', url: 'https://docs.google.com/' })).allowed, false);
  assert.deepEqual(policy.effectiveResearch(agent), { browse: true, downloads: true, import: true });
  assert.ok((await policy.list()).sites.some((site) => site.label === 'PMC'));
});

test('research defaults stay on even when an older profile saved them as disabled', async (t) => {
  const { policy, dataDir } = await fixture(t);
  await policy.update({ actor: owner, operation: 'set-default', key: 'browse', enabled: false });
  await policy.update({ actor: owner, operation: 'set-default', key: 'download', enabled: false });
  const afterRestart = createBrowserPolicy({ dataDir });
  await afterRestart.ready();
  for (const action of ['browse', 'read', 'download']) assert.equal((await afterRestart.check({ actor: agent, action, url: 'https://www.google.com/' })).allowed, true);
  assert.deepEqual(afterRestart.categoryAvailability(), { browse: true, downloads: true, import: true });
});

test('site revocations and removed seeds survive restarts without reseeding', async (t) => {
  const { policy, dataDir } = await fixture(t);
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://www.google.com', blockedActions: ['browse', 'download'] });
  await policy.update({ actor: owner, operation: 'remove-site', origin: 'https://ko.wikipedia.org' });
  const restarted = createBrowserPolicy({ dataDir });
  await restarted.ready();
  assert.equal((await restarted.check({ actor: agent, action: 'download', url: 'https://www.google.com/file' })).code, 'BROWSER_SITE_BLOCKED');
  assert.equal((await restarted.list()).sites.some((site) => site.origin === 'https://ko.wikipedia.org'), false);
  await assert.rejects(restarted.update({ actor: agent, operation: 'set-default', key: 'browse', enabled: true }), { code: 'BROWSER_OWNER_REQUIRED' });
});

test('corrupt or foreign-owner policy fails closed and preserves its bytes', async (t) => {
  const { dataDir } = await fixture(t);
  const policyFile = path.join(dataDir, 'browser-policy.json');
  await fs.writeFile(policyFile, '{broken');
  const corrupt = createBrowserPolicy({ dataDir });
  await assert.rejects(corrupt.ready(), { code: 'BROWSER_STORAGE_INVALID' });
  assert.deepEqual(corrupt.effectiveResearch(), { browse: false, downloads: false, import: false });
  assert.equal(await fs.readFile(policyFile, 'utf8'), '{broken');
});

test('a site access approval covers the registrable domain, stays in its chat unless always, and a later block wins', async (t) => {
  const { policy, dataDir } = await fixture(t);
  const other = { ...agent, threadId: 'thread-b' };
  const allowed = async (actor, url, owner = policy) => (await owner.check({ actor, action: 'website-change', url })).allowed;
  assert.equal(await allowed(agent, 'https://coupang.com/cart'), false);
  await assert.rejects(policy.grantSiteAccess({ actor: agent, threadId: agent.threadId, origin: 'https://coupang.com' }), { code: 'BROWSER_OWNER_REQUIRED' });

  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: 'https://coupang.com', scope: 'chat' });
  for (const url of ['https://coupang.com/cart', 'https://www.coupang.com/order', 'https://login.coupang.com/', 'https://checkout.coupang.com/pay']) {
    assert.equal(await allowed(agent, url), true, `${url} is covered`);
  }
  assert.equal(await allowed(agent, 'http://login.coupang.com/'), false, 'only HTTPS is covered');
  assert.equal(await allowed(agent, 'https://coupang.co.kr/'), false, 'another registrable domain is not');
  assert.equal(await allowed(other, 'https://coupang.com/cart'), false, 'a chat approval stays in its chat');
  assert.equal((await policy.list()).sites.some((site) => site.origin.includes('coupang')), false, 'a chat approval is not a site entry');

  // 설정에서 사이트 변경을 막으면 그 도메인 전체가 막히고, 채팅 승인보다 우선한다.
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://www.coupang.com', allowedActions: ['browse', 'read'], blockedActions: ['website-change'] });
  for (const url of ['https://www.coupang.com/order', 'https://coupang.com/cart', 'https://login.coupang.com/']) {
    assert.equal(await allowed(agent, url), false, `${url} is blocked`);
  }

  await policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin: 'https://login.coupang.com', scope: 'always', unblock: ['website-change'] });
  const afterAlways = createBrowserPolicy({ dataDir });
  await afterAlways.ready();
  for (const url of ['https://www.coupang.com/order', 'https://coupang.com/cart', 'https://login.coupang.com/']) {
    assert.equal(await allowed(other, url, afterAlways), true, `${url} is allowed in every chat after a restart`);
  }
  const sites = (await afterAlways.list()).sites.filter((site) => site.origin.includes('coupang'));
  assert.deepEqual(sites.map((site) => [site.origin, site.domain, site.blockedActions]), [['https://coupang.com', 'coupang.com', []]], 'the www entry folds into one domain entry');
});

test('site approvals respect public suffixes and keep IPs and local hosts exact', async (t) => {
  const { policy } = await fixture(t);
  const allowed = async (url) => (await policy.check({ actor: agent, action: 'website-change', url })).allowed;
  const grant = (origin) => policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin, scope: 'chat' });

  assert.deepEqual((await grant('https://www.foo.co.kr')).origins, ['https://foo.co.kr']);
  assert.equal(await allowed('https://shop.foo.co.kr/'), true);
  assert.equal(await allowed('https://bar.co.kr/'), false, 'co.kr is a public suffix, never the domain');

  assert.deepEqual((await grant('https://x.github.io')).origins, ['https://x.github.io']);
  assert.equal(await allowed('https://x.github.io/repo'), true);
  assert.equal(await allowed('https://y.github.io/'), false, 'github.io is a public suffix');

  await grant('https://shop.example.com.au');
  assert.equal(await allowed('https://www.example.com.au/'), true);
  assert.equal(await allowed('https://other.com.au/'), false);

  for (const origin of ['https://127.0.0.1:8443', 'https://localhost:3000', 'https://app.localhost']) {
    assert.deepEqual((await grant(origin)).origins, [origin], `${origin} stays exact`);
  }
  assert.equal(await allowed('https://127.0.0.1:8443/x'), true);
  assert.equal(await allowed('https://127.0.0.2:8443/'), false);
  assert.equal(await allowed('https://localhost:3001/'), false);
  assert.equal(await allowed('https://other.app.localhost/'), false);
});

test('a domain block in settings blocks its subdomains while sub-host entries stay exact', async (t) => {
  const { policy } = await fixture(t);
  const browse = async (url) => (await policy.check({ actor: agent, action: 'browse', url })).allowed;
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://coupang.com', allowedActions: [], blockedActions: ['browse', 'read', 'download', 'research-import'] });
  assert.equal(await browse('https://login.coupang.com/'), false);
  assert.equal(await browse('https://www.coupang.com/'), false);
  assert.equal((await policy.list()).sites.find((site) => site.origin === 'https://coupang.com').domain, 'coupang.com');

  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://mail.example.com', allowedActions: [], blockedActions: ['browse'] });
  assert.equal(await browse('https://mail.example.com/'), false);
  assert.equal(await browse('https://docs.example.com/'), true, 'a block on one subdomain stays on it');
});


test('a trailing-dot host name is the same host for sub-host blocks', async (t) => {
  const { policy } = await fixture(t);
  const browse = async (url) => (await policy.check({ actor: agent, action: 'browse', url })).allowed;
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://admin.corp-site.com', allowedActions: [], blockedActions: ['browse'] });
  assert.equal(await browse('https://admin.corp-site.com/'), false);
  assert.equal(await browse('https://admin.corp-site.com./'), false);
  assert.equal(await browse('https://ADMIN.corp-site.com../login'), false);
  assert.equal(await browse('https://docs.corp-site.com./'), true);
});

test('browser settings writes and reads wait out a short Windows lock on the file', { skip: process.platform !== 'win32' && 'Windows share-mode locks only' }, async (t) => {
  const { spawn } = await import('node:child_process');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-json-lock-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'browser-policy.json');
  await writeBrowserJson(file, { version: 1 });
  // 백신·색인기처럼 공유 없이 쥔다 — 읽기는 EBUSY, 교체는 EPERM 이 난다.
  const holdLock = async () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[System.IO.File]::Open('${file.replaceAll("'", "''")}','Open','ReadWrite','None'); 'locked'; Start-Sleep -Milliseconds 700; $f.Close()`],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    t.after(() => { child.kill(); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
      child.once('exit', () => reject(new Error('lock helper exited early')));
    });
    return child;
  };
  const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
  // 교체와 읽기를 따로 잠가 두 재시도를 각각 확인한다.
  let child = await holdLock();
  await writeBrowserJson(file, { version: 2 });
  await exited(child);
  child = await holdLock();
  assert.deepEqual(await readBrowserJson(file), { version: 2 });
  await exited(child);
});
