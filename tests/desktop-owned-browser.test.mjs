import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserNavigationUrl, browserViewBounds } from '../desktop/browser-host.mjs';

const require = createRequire(import.meta.url);
let electron;
try { electron = require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

test('native browser rejects privileged URLs and clamps a projection to its owning window', () => {
  for (const url of ['file:///etc/passwd', 'hamaeditor://app/', 'https://user:pass@example.com/', 'javascript:alert(1)']) assert.throws(() => browserNavigationUrl(url));
  assert.equal(browserNavigationUrl('https://example.com'), 'https://example.com/');
  assert.deepEqual(browserViewBounds({ x: -10, y: 20, width: 1000, height: 1000 }, { getContentBounds: () => ({ width: 800, height: 600 }) }), { x: 0, y: 20, width: 800, height: 580 });
});

test('real native guests retain form state across dock, float, popout and hub restart with scoped control', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const entry = fileURLToPath(new URL('./electron/owned-browser.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const testDataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-owned-browser-'));
  env.RHWP_BROWSER_TEST_DATA_DIR = testDataDir;
  const logPath = env.RHWP_BROWSER_LOG_PATH;
  if (logPath) writeFileSync(logPath, '', { mode: 0o600 });
  const report = await new Promise((resolve, reject) => {
    const child = spawn(electron, [entry, '--use-mock-keychain'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; if (logPath) appendFileSync(logPath, data); });
    child.stderr.on('data', (data) => { stderr += data; if (logPath) appendFileSync(logPath, data); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 50_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((value) => value.startsWith('OWNED_BROWSER_REPORT '));
      if (!line) reject(new Error(`Native browser harness did not finish\n${stdout}\n${stderr}`));
      else if (code !== 0) reject(new Error(`Native browser harness exited ${code}\n${JSON.parse(line.slice('OWNED_BROWSER_REPORT '.length)).error ?? ''}\n${stderr}`));
      else resolve(JSON.parse(line.slice('OWNED_BROWSER_REPORT '.length)));
    });
  }).finally(() => rm(testDataDir, { recursive: true, force: true }));
  assert.equal(report.error, undefined, report.error);
  assert.equal(report.unattachedCapture.captured, true);
  assert.equal(report.presentation.navigations, 0);
  assert.equal(report.popoutClosePreservesPage, true);
  assert.equal(report.floatingPresentation.humanInput, true);
  assert.equal(report.floatingPresentation.moveResizeMatchesViewport, true);
  assert.equal(report.floatingPresentation.hiddenCapture, true);
  assert.equal(report.floatingPresentation.hidePreservesPage, true);
  assert.equal(report.floatingPresentation.dockRestoresPage, true);
  assert.equal(report.hubRestart.retainedForm, true);
  assert.equal(report.sharedAuthentication, true);
  assert.equal(report.routeInterception, true);
  assert.equal(report.download.filename, 'native.pdf');
  assert.equal(report.control.physicalInputBlocked, true);
  assert.equal(report.control.physicalHumanInput, true);
  assert.equal(report.debuggerOwnership.devtoolsDisabled, true);
  assert.equal(report.debuggerOwnership.debuggerRetained, true);
  assert.equal(report.browserReset.storageClearedAfterRestart, true);
  assert.deepEqual(report.nativeDefaultRecovery, { native: true, currentEditorBinding: true, humanInput: true });
});
