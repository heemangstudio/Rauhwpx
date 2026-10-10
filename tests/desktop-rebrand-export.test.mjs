import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBinary = (() => {
  try {
    return require('electron');
  } catch {
    return null;
  }
})();
const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const skip = !electronBinary || !existsSync(electronBinary)
  ? 'Electron binary is not installed'
  : headless ? 'needs a display server' : false;

function runHarness() {
  const entry = fileURLToPath(new URL('./electron/rebrand-export.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [entry, '--use-mock-keychain'], {
      cwd: path.dirname(entry),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entryLine) => entryLine.startsWith('REBRAND_EXPORT_REPORT '));
      if (!line) reject(new Error(`no report from Electron\n${stdout}\n${stderr}`));
      else resolve(JSON.parse(line.slice('REBRAND_EXPORT_REPORT '.length)));
    });
  });
}

test('the desktop exports a real 2.0.11 profile in chunks, hands it over once and gives up fast on a stuck or dead reader', { skip, timeout: 150_000 }, async () => {
  const report = await runHarness();
  assert.equal(report.error, undefined, report.error);

  const { normal } = report;
  assert.ok(normal.threadChunks >= 2, 'a 12 MB chat store travels in more than one message');
  assert.equal(normal.secondTake, null, 'a second window does not import the same handoff');
  assert.deepEqual(normal.localStorage, [['hamaeditor-settings', '{"theme":{"mode":"dark"}}']]);
  assert.deepEqual(normal.databases, ['hamaeditorAgentThreads', 'hamaeditorAutosave']);
  assert.equal(normal.bigTextLength, 6 * 1024 * 1024);
  assert.deepEqual(normal.draftData, ['[object ArrayBuffer]', [7, 8, 9]]);
  assert.equal(normal.finished, true);
  assert.ok(normal.marker.storageFingerprint);
  assert.deepEqual(normal.marker.storageLedger, { 'rhwpAgentThreads/threads': ['"thread-small"'] });
  assert.equal(normal.nextLaunchTake, null, 'a finished import does not run again');

  assert.equal(report.timeout.take, null);
  assert.ok(report.timeout.elapsedMs < 6000, `a silent reader is abandoned after its timeout (${report.timeout.elapsedMs} ms)`);
  assert.equal(report.timeout.marker.storageFingerprint, undefined, 'a timed-out export is retried later');
  assert.equal(report.timeout.marker.storageAttempts?.count, 1);

  assert.equal(report.crash.take, null);
  assert.ok(report.crash.elapsedMs < 8000, `a crashed reader fails without waiting for the timeout (${report.crash.elapsedMs} ms)`);
});
