import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let electron = process.env.RHWP_TEST_ELECTRON_BINARY;
if (!electron) try { electron = require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

test('real native password fill submits without exposing secrets to hub and preserves subsequent input', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const entry = fileURLToPath(new URL('./electron/browser-passwords.mjs', import.meta.url));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const report = await new Promise((resolve, reject) => {
    const child = spawn(electron, [entry, '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((value) => value.startsWith('NATIVE_PASSWORD_REPORT '));
      if (!line) return reject(new Error(`Native password harness did not finish\n${stdout}\n${stderr}`));
      const result = JSON.parse(line.slice('NATIVE_PASSWORD_REPORT '.length));
      if (code !== 0) reject(new Error(`Native password harness exited ${code}\n${result.error ?? ''}\n${stderr}`));
      else resolve(result);
    });
  });
  assert.equal(report.error, undefined);
  for (const key of ['protectedReload', 'agentManualAutofill', 'schoolIdAutocomplete', 'schoolFormFill', 'manualSave', 'nativeFill', 'humanAutocomplete', 'nativeSubmit', 'protectedWebSocket', 'postNavigationInput', 'noSecretInHub', 'staleAndWrongOriginRejected', 'rawReadbackAndCaptureBlocked']) assert.equal(report[key], true, key);
});
