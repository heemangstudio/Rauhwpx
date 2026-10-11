import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserPolicy } from '../browser-policy.mjs';

const owner = { isHuman: true, clientId: 'owner' };
const agent = { threadId: 'thread-a', projectId: 'project-a', agentId: 'root' };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-policy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  await policy.ready();
  return { dataDir, policy };
}

test('public research works immediately while website changes and private accounts require approval', async (t) => {
  const { policy } = await fixture(t);
  for (const action of ['browse', 'read', 'download', 'research-import']) {
    assert.equal((await policy.check({ actor: agent, action, url: 'https://pubmed.ncbi.nlm.nih.gov/123/' })).allowed, true);
  }
  assert.equal((await policy.check({ actor: agent, action: 'website-change', url: 'https://docs.google.com/' })).allowed, false);
  assert.equal((await policy.check({ actor: agent, action: 'account-use', url: 'https://docs.google.com/', accountId: 'not-approved' })).allowed, false);
  assert.deepEqual(policy.effectiveResearch(agent), { browse: true, downloads: true, import: true });
  assert.ok((await policy.list()).sites.some((site) => site.label === 'PMC'));
});

test('global research disable applies to untouched seeds and explicit user opt-in stays separate', async (t) => {
  const { policy, dataDir } = await fixture(t);
  await policy.update({ actor: owner, operation: 'set-default', key: 'browse', enabled: false });
  await policy.update({ actor: owner, operation: 'set-default', key: 'download', enabled: false });
  for (const action of ['browse', 'read', 'download']) assert.equal((await policy.check({ actor: agent, action, url: 'https://www.google.com/' })).allowed, false);
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://arxiv.org', allowedActions: ['read'], blockedActions: [] });
  assert.equal((await policy.check({ actor: agent, action: 'read', url: 'https://arxiv.org/abs/123' })).allowed, true);
  const afterRestart = createBrowserPolicy({ dataDir });
  await afterRestart.ready();
  assert.equal((await afterRestart.check({ actor: agent, action: 'read', url: 'https://www.google.com' })).allowed, false);
  assert.equal((await afterRestart.check({ actor: agent, action: 'read', url: 'https://arxiv.org' })).allowed, true);
  assert.deepEqual(afterRestart.categoryAvailability(), { browse: true, downloads: false, import: true });
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

test('remembered account permission spans projects and stays bound to exact origins and stable account identity', async (t) => {
  const { policy } = await fixture(t);
  await policy.update({ actor: owner, operation: 'approve-account', accountId: 'account-a', origins: ['https://docs.google.com'], profileId: 'default' });
  assert.equal((await policy.check({ actor: { ...agent, projectId: 'project-b' }, action: 'account-use', url: 'https://docs.google.com/presentation/d/private', accountId: 'account-a', profileId: 'default' })).allowed, true);
  for (const input of [
    { url: 'https://docs.google.com.attacker.test', accountId: 'account-a', profileId: 'default' },
    { url: 'https://docs.google.com:8443', accountId: 'account-a', profileId: 'default' },
    { url: 'https://docs.google.com', accountId: 'account-b', profileId: 'default' },
    { url: 'https://docs.google.com', accountId: 'account-a', profileId: 'other' },
  ]) assert.equal((await policy.check({ actor: agent, action: 'account-use', ...input })).allowed, false);
  await policy.update({ actor: owner, operation: 'revoke-account', accountId: 'account-a' });
  assert.equal((await policy.check({ actor: agent, action: 'account-use', url: 'https://docs.google.com', accountId: 'account-a' })).allowed, false);
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
