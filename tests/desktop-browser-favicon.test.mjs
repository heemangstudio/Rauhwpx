import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let electron;
try { electron = require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

test('native page icons travel from Electron through the hub to the editor tab', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-favicon-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const child = spawn(electron, [fileURLToPath(new URL('./electron/browser-favicon.mjs', import.meta.url)), '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find((value) => value.startsWith('BROWSER_FAVICON_REPORT '));
        if (!line) { reject(new Error(`Native favicon fixture did not finish\n${stdout}\n${stderr}`)); return; }
        const result = JSON.parse(line.slice('BROWSER_FAVICON_REPORT '.length));
        if (code !== 0) reject(new Error(result.error ?? stderr)); else resolve(result);
      });
    });
    assert.deepEqual(report.favicon, { forwarded: true, published: true, inventory: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
