import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

test('hub becomes healthy while the owner credential store is awaiting approval', { timeout: 15_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hama-keychain-startup-'));
  const token = 'startup-owner-token';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, NODE_ENV: 'test', RHWP_AGENT_MODE: 'production',
      RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token, RHWP_LAUNCH_ID: 'startup-test',
      RHWP_SECRET_BROKER: 'ipc', RHWP_WORK_DIR: root,
      RHWP_PI_DIR: path.join(root, 'pi'), RHWP_CLI_DIR: path.join(root, 'cli'),
      RHWP_TEMPLATES_DIR: path.join(root, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'),
      RHWP_REFERENCES_DIR: path.join(root, 'references'),
      RHWP_PROJECTS_DIR: path.join(root, 'projects'),
      RHWP_BROWSER_DATA_DIR: path.join(root, 'browser'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await exit;
    clearTimeout(force);
    await fs.rm(root, { recursive: true, force: true });
  });
  // 승인 대기 중인 Keychain처럼 요청에는 응답하지 않는다.
  const credentialRequest = new Promise((resolve) => {
    child.on('message', (message) => {
      if (message?.type === 'rhwp-secret-request') resolve(message);
    });
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Hub waited for credentials: ${stderr}`)), 5_000);
    lines.on('line', (line) => {
      if (!line.startsWith('RHWP_HUB_READY ')) return;
      clearTimeout(timeout);
      resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  await credentialRequest;
  const response = await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
    headers: { authorization: `Bearer ${token}`, 'x-rhwp-launch-id': 'startup-test' },
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pid, child.pid);
});
