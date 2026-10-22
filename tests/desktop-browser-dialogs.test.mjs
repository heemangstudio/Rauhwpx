import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

let electron = process.env.RHWP_BROWSER_ELECTRON_PATH;
try { electron ||= createRequire(import.meta.url)('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

test('native website dialogs leave the editor responsive and preserve human choices without approving agent writes', {
  skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 45_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-dialogs-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const args = [fileURLToPath(new URL('./electron/browser-dialogs.mjs', import.meta.url)), '--use-mock-keychain'];
      if (process.platform === 'darwin') args.push('-ApplePersistenceIgnoreState', 'YES');
      const child = spawn(electron, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 35_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find(line => line.startsWith('BROWSER_DIALOG_REPORT '));
        if (!line) return reject(new Error(`Dialog fixture exited ${code} (${signal})\n${stdout}\n${stderr}`));
        const result = JSON.parse(line.slice('BROWSER_DIALOG_REPORT '.length));
        if (code || result.error) reject(new Error(result.error ?? stderr)); else resolve(result);
      });
    });
    assert.deepEqual(report.agent, { startupAlertContinued: true, alertContinued: true, confirmCancelled: true, editorResponsive: true });
    assert.deepEqual(report.human, { hiddenStartupAlertParented: true, pendingUntilChoice: true, confirmAccepted: true, editorResponsive: true });
    assert.deepEqual(report.shared, { agentAnsweredOwnDialog: true, userDialogLeftToUser: true });
    assert.deepEqual(report.presentation, { dockFloatPopoutReparked: true, hiddenDialogsResponsive: true, draftRetained: true });
    assert.deepEqual(report.ownership, { staleEditorRejected: true, newerPresentationRetained: true });
    assert.deepEqual(report.privacy, { protectedTextAbsent: true, promptUnsupported: true });
    assert.deepEqual(report.cleanup, { closedGuestRemoved: true, parkingWindowDestroyed: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
