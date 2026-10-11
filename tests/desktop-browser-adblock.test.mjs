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
let electron = process.env.RHWP_BROWSER_ELECTRON_PATH; try { electron ||= require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

test('Ghostery blocks native ad traffic while ordinary pages, settings and the security guard remain usable', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-adblock-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const args = [fileURLToPath(new URL('./electron/browser-adblock.mjs', import.meta.url)), '--use-mock-keychain'];
      if (process.platform === 'darwin') args.push('-ApplePersistenceIgnoreState', 'YES');
      const child = spawn(electron, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find(line => line.startsWith('BROWSER_ADBLOCK_REPORT '));
        if (!line) return reject(new Error(`Adblock fixture exited ${code} (${signal})\n${stdout}\n${stderr}`));
        const result = JSON.parse(line.slice('BROWSER_ADBLOCK_REPORT '.length));
        if (code || result.error) reject(new Error(`${result.error ?? stderr}\n${stderr}`)); else resolve(result);
      });
    });
    assert.deepEqual(report.blocked, { ordinaryScript: true, adRequestsReachedServer: 0, cosmeticHidden: true, draftPreserved: true });
    assert.deepEqual(report.sitePause, { requestAllowed: true, cosmeticsRemovedAfterReload: true, draftPreservedWithoutReload: true });
    assert.deepEqual(report.globalToggle, { disabledAllowsRequest: true, reenabledBlocks: true, failedUpdateKeepsBlocking: true });
    assert.deepEqual(report.filterUpdate, { fixedUrlsOnly: true, successfulCacheWrite: true, updatedEngineBlocks: true });
    assert.equal(report.formSubmission, true); assert.equal(report.securityGuardStillBlocks, true); assert.equal(report.offlineRestart, true);
    console.log(`Ghostery engine: ${JSON.stringify(report.engine)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
