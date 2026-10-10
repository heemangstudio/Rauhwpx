import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let electron;
try { electron = require('electron'); } catch {}
const enabled = process.platform === 'darwin' && electron && existsSync(electron) && process.env.RHWP_TEST_MAC_PASSKEY_HANDOFF === '1';

test('real Electron returns an isolated signed Chrome session to its retained native tab', { skip: enabled ? false : 'Opt in with RHWP_TEST_MAC_PASSKEY_HANDOFF=1 on macOS with signed Chrome', timeout: 50_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hama-native-passkey-')));
  const env = { ...process.env, RHWP_WEBAUTHN_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = fileURLToPath(new URL('./electron/native-passkey-handoff.mjs', import.meta.url));
  try {
    const report = await new Promise((resolve, reject) => {
      const child = spawn(electron, [entry, '--use-mock-keychain'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find((value) => value.startsWith('NATIVE_PASSKEY_REPORT '));
        if (code !== 0 || !line) reject(new Error(`Native passkey handoff fixture failed\n${stdout}\n${stderr}`));
        else resolve(JSON.parse(line.slice('NATIVE_PASSKEY_REPORT '.length)));
      });
    });
    assert.equal(report.mode, 'native');
    assert.equal(report.retainedTarget, true);
    assert.equal(report.authenticated, true);
    assert.equal(report.retainedPath, '/research');
    assert.equal(report.unrelatedStoragePreserved, true);
    assert.equal(report.agentReady, true);
    if (process.env.RHWP_TEST_NATIVE_PASSWORD_HOST) assert.equal(report.protectedAutofill, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
