import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeOwnedBrowserState } from '../browser-cleanup.mjs';

test('owner cleanup removes its profile while retaining research bytes and unrelated credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'browser-policy.json'), JSON.stringify({ schema: 1, ownerId: 'local-owner', accounts: [] }));
  for (const directory of ['browser/profile', 'browser/native-profile', 'browser/transfers', 'browser/binaries', 'downloads/job', 'projects/project']) await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, 'browser/profile/Cookies'), 'temporary fixture auth');
  await fs.writeFile(path.join(root, 'browser/binaries/chromium'), 'installed fixture browser');
  await fs.writeFile(path.join(root, 'browser/runtime.json'), '{"version":1,"mode":"native","headless":true}');
  await fs.writeFile(path.join(root, 'browser/tabs.json'), 'retained URLs');
  await fs.writeFile(path.join(root, 'browser/tabs.json.0123456789abcdef.part'), 'interrupted fixture URLs');
  await fs.writeFile(path.join(root, 'downloads/job/bytes.bin'), 'retained PDF');
  await fs.writeFile(path.join(root, 'provider-credentials.json'), 'unrelated fixture credential');
  const first = await removeOwnedBrowserState({ dataDir: root });
  assert.equal(first.cleared, true);
  for (const name of ['profile', 'native-profile', 'transfers', 'tabs.json', 'tabs.json.0123456789abcdef.part']) await assert.rejects(fs.stat(path.join(root, 'browser', name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'browser/binaries/chromium'), 'utf8'), 'installed fixture browser');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'browser/runtime.json'), 'utf8')), { version: 1, mode: 'native', headless: true });
  assert.equal(await fs.readFile(path.join(root, 'downloads/job/bytes.bin'), 'utf8'), 'retained PDF');
  assert.equal(await fs.readFile(path.join(root, 'provider-credentials.json'), 'utf8'), 'unrelated fixture credential');
  assert.ok(await fs.stat(path.join(root, 'projects/project')));
  assert.deepEqual(await removeOwnedBrowserState({ dataDir: root }), first);
});

test('cleanup rejects missing ownership and a redirected profile without touching the target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-cleanup-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'unrelated');
  const owned = path.join(root, 'owned');
  await fs.mkdir(outside); await fs.mkdir(owned);
  await fs.writeFile(path.join(outside, 'keep'), 'preserve');
  await assert.rejects(removeOwnedBrowserState({ dataDir: owned }), { code: 'ENOENT' });
  await fs.writeFile(path.join(owned, 'browser-policy.json'), JSON.stringify({ schema: 1, ownerId: 'local-owner', accounts: [] }));
  await fs.symlink(outside, path.join(owned, 'browser'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeOwnedBrowserState({ dataDir: owned }), { code: 'BROWSER_CLEANUP_FAILED' });
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'preserve');
  await fs.unlink(path.join(owned, 'browser'));
  await fs.mkdir(path.join(owned, 'browser'));
  await fs.symlink(outside, path.join(owned, 'browser/profile'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeOwnedBrowserState({ dataDir: owned }), { code: 'BROWSER_CLEANUP_FAILED' });
  assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'preserve');
});
