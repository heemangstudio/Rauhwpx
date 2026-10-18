import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserPolicy, DEFAULT_RESEARCH_SITES } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';
import { createUserSecretStore } from '../user-secrets.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

// 2026-10-17 노트북 데이터 모양: 쿠팡 쿠키가 출처 미상 세션으로 격리돼 있었고, 사용자 항목은 읽기만 허용했다.
const SESSION_ACK = '0b0c3f6e-6f47-4c2a-9c1d-5d2f7a1e9b10';
const LOGIN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const SECRET = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const agent = { threadId: 'chat-a', projectId: 'project', agentId: 'chat-a:root' };
const configuration = { profileId: 'default', downloads: { directory: 'managed', maxFileBytes: 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false } };

async function laptopProfile(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-permission-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const research = DEFAULT_RESEARCH_SITES.map((site, index) => ({ ...site, id: `seed-${index}`, source: 'research-default', allowedActions: ['browse', 'read', 'download', 'research-import'], blockedActions: [] }));
  await fs.writeFile(path.join(dataDir, 'browser-policy.json'), JSON.stringify({
    schema: 1, ownerId: 'local-owner', revision: 9, seeded: true, defaults: { browse: true, download: true, researchImport: true },
    sites: [...research,
      { id: 'coupang', origin: 'https://coupang.com', label: 'coupang.com', source: 'user', allowedActions: ['browse', 'read', 'download', 'research-import'], blockedActions: [] },
      { id: 'mail-www', origin: 'https://www.mailhost.com', label: 'Mail', source: 'user', allowedActions: ['browse', 'read'], blockedActions: [] },
      { id: 'mail-apex', origin: 'https://mailhost.com', label: 'Mail', source: 'user', allowedActions: ['download'], blockedActions: ['research-import'] },
      { id: 'inbox', origin: 'https://inbox.mailhost.com', label: 'Inbox', source: 'user', allowedActions: [], blockedActions: ['browse'] }],
    accounts: [{ accountId: SESSION_ACK, profileId: 'native', origins: ['https://portal.school.ac.kr'], approved: true, version: 2 },
      { accountId: LOGIN, profileId: 'default', origins: ['https://www.shop.co.kr'], approved: false, version: 1 }],
  }));
  await fs.writeFile(path.join(dataDir, 'browser-accounts.json'), JSON.stringify({
    schema: 1, configuration,
    sessions: [
      { domain: 'accounts.google.com', profileId: 'native', source: 'human', version: 2 },
      { domain: 'iscience.riroschool.kr', profileId: 'native', source: 'unknown', version: 3 },
      { domain: 'coupang.com', profileId: 'native', source: 'unknown', version: 3 },
      { domain: 'login.coupang.com', profileId: 'native', source: 'unknown', version: 3 },
      { domain: 'www.coupang.com', profileId: 'native', source: 'unknown', version: 3 },
      { domain: 'x.com', profileId: 'native', source: 'human', version: 4 },
      { origin: 'https://www.x.com', profileId: 'native', source: 'human', version: 4 },
    ],
    accounts: [
      { id: SESSION_ACK, origin: 'https://portal.school.ac.kr', origins: ['https://portal.school.ac.kr'], label: 'School', stableIdentity: SESSION_ACK, profileId: 'native', hasPassword: false, sessionStatus: 'session-retained', version: 1, sessionVersion: 3, updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: LOGIN, origin: 'https://www.shop.co.kr', origins: ['https://www.shop.co.kr'], label: 'andy', stableIdentity: 'andy', profileId: 'default', hasPassword: true, sessionStatus: 'saved', version: 4, sessionVersion: 2, updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
  }));
  await fs.writeFile(path.join(dataDir, 'user-secrets.json'), JSON.stringify({ schema: 1, secrets: [
    { id: SECRET, label: 'Dashboard key', kind: 'api-key', origins: ['https://api.shop.co.kr'], approved: true, createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null },
  ] }));
  return dataDir;
}
async function open(dataDir) {
  const policy = createBrowserPolicy({ dataDir });
  const broker = createBrowserCredentialBroker({ dataDir, policy, secretStore: createMemorySecretStore() });
  const secrets = createUserSecretStore({ dataDir, secretStore: createMemorySecretStore() });
  await broker.ready();
  await secrets.ready();
  return { policy, broker, secrets };
}
const read = async (dataDir, name) => JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));

test('a laptop-shaped schema 1 profile migrates once: quarantined cookies stop gating and owner evidence becomes markers', async (t) => {
  const dataDir = await laptopProfile(t);
  const { policy, broker, secrets } = await open(dataDir);

  const migrated = await read(dataDir, 'browser-policy.json');
  assert.equal(migrated.schema, 2);
  assert.equal('accounts' in migrated, false, 'per-account approvals are dropped');
  assert.equal('legacyAccounts' in migrated, false, 'the broker consumed the legacy approvals');
  const userSites = migrated.sites.filter((site) => site.source === 'user').map((site) => [site.origin, site.allowedActions.sort(), site.blockedActions.sort()]).sort();
  assert.deepEqual(userSites, [
    ['https://coupang.com', ['browse', 'download', 'read', 'research-import'], []],
    ['https://inbox.mailhost.com', [], ['browse']],
    ['https://mailhost.com', ['browse', 'download', 'read'], ['research-import']],
    ['https://school.ac.kr', ['browse', 'read'], []],
  ], 'allows fold into the site key, sub-host blocks stay exact, the approved session account becomes a read allow');
  assert.deepEqual(migrated.signedIn.map((marker) => [marker.profileId, marker.key, marker.source]).sort(), [
    ['native', 'https://google.com', 'legacy'], ['native', 'https://school.ac.kr', 'legacy'], ['native', 'https://x.com', 'legacy'],
  ], 'human sessions dedupe per site; unknown sessions are dropped');

  const accounts = await read(dataDir, 'browser-accounts.json');
  assert.equal(accounts.schema, 2);
  assert.equal('sessions' in accounts, false);
  assert.deepEqual(accounts.accounts.map((account) => [account.id, account.agentBlocked, 'sessionVersion' in account]), [[LOGIN, false, false]], 'password-less accounts are removed and logins keep working');
  assert.equal((await broker.listAccounts()).accounts[0].site, 'shop.co.kr');
  assert.deepEqual((await secrets.list()).map((secret) => [secret.id, secret.blocked, 'approved' in secret]), [[SECRET, false, false]]);

  // 쿠팡: 쿠키가 있어도 로그인 증거가 없으면 열람은 그대로 된다. 저장된 로그인이 있으면 읽기는 사용자 항목이 허용한다.
  await policy.setCookieSites('native', ['https://coupang.com', 'https://x.com', 'https://google.com']);
  for (const url of ['https://www.coupang.com/', 'https://login.coupang.com/login.pang']) {
    assert.equal((await policy.check({ actor: agent, action: 'browse', url, profileId: 'native' })).allowed, true, url);
  }
  policy.setSavedLoginSites('native', ['https://coupang.com']);
  assert.equal((await policy.check({ actor: agent, action: 'read', url: 'https://www.coupang.com/cart', profileId: 'native' })).source, 'user');
  assert.equal((await policy.check({ actor: agent, action: 'account-use', url: 'https://login.coupang.com/', profileId: 'native' })).reason, 'account-use', 'the first login fill asks for one site card');
  assert.equal((await policy.check({ actor: agent, action: 'read', url: 'https://x.com/home', profileId: 'native' })).reason, 'signed-in');
  assert.equal((await policy.check({ actor: agent, action: 'read', url: 'https://www.google.com/search?q=kettle', profileId: 'native' })).source, 'research-default');
  assert.equal((await policy.check({ actor: agent, action: 'read', url: 'https://mail.google.com/', profileId: 'native' })).reason, 'signed-in');
  assert.equal((await policy.list()).signedIn.some((marker) => marker.key === 'https://school.ac.kr'), false, 'a marker without cookies expires');

  // 다시 열어도 같은 상태다.
  const before = { policy: await read(dataDir, 'browser-policy.json'), accounts: await read(dataDir, 'browser-accounts.json') };
  await open(dataDir);
  assert.deepEqual({ policy: await read(dataDir, 'browser-policy.json'), accounts: await read(dataDir, 'browser-accounts.json') }, before);
});

test('a crash after the policy migrated still converts approved session accounts on the next start', async (t) => {
  const dataDir = await laptopProfile(t);
  // 정책만 먼저 열어 스키마 2 로 쓰고, 중개자는 아직 스키마 1 로 둔다.
  await createBrowserPolicy({ dataDir }).ready();
  assert.equal((await read(dataDir, 'browser-policy.json')).legacyAccounts.length, 1);
  assert.equal((await read(dataDir, 'browser-accounts.json')).schema, 1);
  await open(dataDir);
  const policy = await read(dataDir, 'browser-policy.json');
  assert.ok(policy.sites.some((site) => site.origin === 'https://school.ac.kr' && site.allowedActions.includes('read')));
  assert.equal('legacyAccounts' in policy, false);
});
