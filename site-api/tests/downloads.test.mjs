import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { createDownloadsService, MAX_KEYS_PER_DAY, parseDownload } from '../downloads.mjs';
import { createSiteServer } from '../server.mjs';

const ADMIN = 'admin-token-for-download-tests';
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('download payloads: whitelisted platforms, `latest` or x.y.z versions, bounded lengths', () => {
  assert.deepEqual(parseDownload({ platform: 'mac-arm64', version: 'latest' }), { platform: 'mac-arm64', version: 'latest' });
  assert.deepEqual(parseDownload({ platform: ' win-x64 ', version: '3.2.1-beta.2' }), { platform: 'win-x64', version: '3.2.1-beta.2' });
  for (const bad of [{}, { platform: 'mac', version: 'latest' }, { platform: 'mac-arm64' }, { platform: 'mac-arm64', version: '../../etc' },
    { platform: 'mac-arm64', version: `1.2.3-${'a'.repeat(30)}` }, { platform: 'mac-arm64', version: 7 }, { platform: ['mac-arm64'], version: 'latest' }]) {
    assert.throws(() => parseDownload(bad), (error) => error.code.endsWith('_INVALID'), JSON.stringify(bad));
  }
});

test('counts by KST day, platform and version; old days are pruned; unbounded versions fold into `other`', async () => {
  let clock = Date.parse('2026-10-19T23:30:00+09:00');
  const svc = createDownloadsService({ now: () => clock, adminToken: ADMIN });
  await svc.record({ platform: 'mac-arm64', version: 'latest' });
  await svc.record({ platform: 'mac-arm64', version: 'latest' });
  clock += HOUR;
  await svc.record({ platform: 'mac-arm64', version: '3.2.0' });
  let summary = await svc.summary(ADMIN, { days: '7' });
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byPlatform, { 'mac-arm64': 3 });
  assert.deepEqual(summary.byVersion, { latest: 2, '3.2.0': 1 });
  assert.deepEqual(summary.byDay.map((d) => [d.day, d.total]), [['2026-10-20', 1], ['2026-10-19', 2]]);

  for (let i = 0; i < MAX_KEYS_PER_DAY + 3; i += 1) await svc.record({ platform: 'win-x64', version: `1.0.${i}` });
  summary = await svc.summary(ADMIN, { days: '1' });
  assert.equal(Object.keys(summary.byDay[0].counts).length, MAX_KEYS_PER_DAY + 1);
  assert.equal(summary.byDay[0].counts['win-x64|other'], 4);

  clock += 500 * DAY;
  await svc.record({ platform: 'mac-arm64', version: 'latest' });
  summary = await svc.summary(ADMIN, { days: '400' });
  assert.deepEqual(summary.byDay.map((d) => d.total), [1], 'days past the retention are dropped');
  await assert.rejects(svc.summary('nope'), { code: 'DOWNLOADS_FORBIDDEN' });
});

async function listen(t, env = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-dl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const server = createSiteServer({ RAU_SITE_DATA: directory, ADMIN_TOKEN: ADMIN, ...env }, { log: () => {}, alertProvider: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, directory };
}

test('HTTP: sendBeacon-style text/plain posts count, bad ones answer 400, 30 per 10 minutes per IP, no IP on disk, admin read', async (t) => {
  const { origin, directory } = await listen(t);
  const beacon = (body, headers = {}) => fetch(`${origin}/v1/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'X-Forwarded-For': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ok = await beacon({ platform: 'mac-arm64', version: 'latest' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal((await beacon({ platform: 'ios', version: 'latest' })).status, 400);
  assert.equal((await beacon('not json')).status, 400);

  for (let i = 0; i < 27; i += 1) assert.equal((await beacon({ platform: 'mac-arm64', version: 'latest' })).status, 200);
  assert.equal((await beacon({ platform: 'mac-arm64', version: 'latest' })).status, 429, 'the 31st request from one IP');
  assert.equal((await beacon({ platform: 'mac-arm64', version: 'latest' }, { 'X-Forwarded-For': '198.51.100.9' })).status, 200, 'another IP still counts');

  const saved = await fs.readFile(path.join(directory, 'downloads.json'), 'utf8');
  assert.ok(!saved.includes('203.0.113.7') && !saved.includes('198.51.100.9'), 'no IP is persisted');
  assert.deepEqual(Object.values(JSON.parse(saved).days)[0], { 'mac-arm64|latest': 29 });

  assert.equal((await fetch(`${origin}/v1/admin/downloads`)).status, 403);
  const admin = await (await fetch(`${origin}/v1/admin/downloads?days=7`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.deepEqual([admin.total, admin.byPlatform], [29, { 'mac-arm64': 29 }]);

  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'downloads', '--days', '7'], {
    env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN },
  });
  assert.match(stdout, /^200 \{/);
  assert.match(stdout, /29 downloads since \d{4}-\d{2}-\d{2} · mac-arm64 29 · latest 29/);
});
