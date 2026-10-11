import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let electron; try { electron = require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
test('native tray reopens healthy drafts and safely recovers crashed or missing guests', { skip: unavailable, timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-tray-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const child = spawn(electron, [fileURLToPath(new URL('./electron/browser-tray-recovery.mjs', import.meta.url)), '--use-mock-keychain'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); const line = output.split('\n').find(line => line.startsWith('BROWSER_TRAY_REPORT ')); if (code !== 0 || !line) reject(new Error(output)); else resolve(JSON.parse(line.slice('BROWSER_TRAY_REPORT '.length))); });
    });
    assert.equal(report.error, undefined);
    assert.deepEqual(report.healthy, { retainedDraft: true, noReload: true, painted: true });
    assert.ok(Object.values(report.recovery).every(Boolean));
    assert.deepEqual(report.quit, { normalCloseRetainsGuest: true, canceledQuitRetainsGuest: true, hiddenPopoutClosed: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
