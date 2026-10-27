// "항상" 허용한 채팅 권한 파일은 같은 사용자의 여러 허브가 함께 쓴다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createChatPermissionPolicy } from '../chat-permissions.mjs';

async function policyFile(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chat-permission-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'chat-permission-policy.json');
}

async function open(filePath) {
  const policy = createChatPermissionPolicy({ filePath });
  await policy.ready();
  return policy;
}

const saved = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8')).always;

test('a grant revoked in one hub stays revoked when another hub writes the shared file', async (t) => {
  const filePath = await policyFile(t);
  const a = await open(filePath);
  await a.grant('local-execution');
  const b = await open(filePath);
  assert.deepEqual(b.list(), ['local-execution']);

  await a.revoke('local-execution');
  // B 는 새 채팅을 거둔 권한으로 시작하지 않는다.
  assert.deepEqual(b.list(), []);
  await b.grant('downloads');
  assert.deepEqual(await saved(filePath), ['downloads']);
  assert.deepEqual((await open(filePath)).list(), ['downloads']);
});

test('grants from two hubs are merged instead of the last writer winning', async (t) => {
  const filePath = await policyFile(t);
  const x = await open(filePath);
  const y = await open(filePath);
  await x.grant('browser');
  await y.grant('downloads');
  assert.deepEqual(await saved(filePath), ['downloads', 'browser']);
  assert.deepEqual(x.list(), ['downloads', 'browser']);
});

test('a policy file saved with a UTF-8 BOM is read', async (t) => {
  const filePath = await policyFile(t);
  await fs.writeFile(filePath, `\uFEFF${JSON.stringify({ schema: 1, always: ['browser'] })}`);
  const policy = await open(filePath);
  assert.deepEqual(policy.list(), ['browser']);
  assert.deepEqual(await policy.grant('downloads'), ['downloads', 'browser']);
});

test('an "always" grant waits out a short Windows lock on the policy file', { skip: process.platform !== 'win32' && 'Windows share-mode locks only' }, async (t) => {
  const filePath = await policyFile(t);
  const policy = await open(filePath);
  await policy.grant('browser');
  // 삭제 공유 없이 연 독자(편집기·동기화 도구)는 rename 을 EPERM 으로 막는다.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[System.IO.File]::Open('${filePath.replaceAll("'", "''")}','Open','Read','ReadWrite'); 'locked'; Start-Sleep -Milliseconds 600; $f.Close()`],
  { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
    child.once('exit', () => reject(new Error('lock helper exited early')));
  });
  assert.deepEqual(await policy.grant('downloads'), ['downloads', 'browser']);
  assert.deepEqual(await saved(filePath), ['downloads', 'browser']);
});
