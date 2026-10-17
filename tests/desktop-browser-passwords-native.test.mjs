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

function runHarness(name, marker) {
  const entry = fileURLToPath(new URL(`./electron/${name}`, import.meta.url));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [entry, '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((value) => value.startsWith(`${marker} `));
      if (!line) return reject(new Error(`Native harness ${name} did not finish\n${stdout}\n${stderr}`));
      const result = JSON.parse(line.slice(marker.length + 1));
      if (code !== 0) reject(new Error(`Native harness ${name} exited ${code}\n${result.error ?? ''}\n${stderr}`));
      else resolve(result);
    });
  });
}

test('real native password fill submits without exposing secrets to hub and preserves subsequent input', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const report = await runHarness('browser-passwords.mjs', 'NATIVE_PASSWORD_REPORT');
  assert.equal(report.error, undefined);
  for (const key of ['hostileObservation', 'armedCapture', 'protectedCapture', 'protectedReload', 'agentManualAutofill', 'schoolIdAutocomplete', 'schoolFormFill', 'manualSave', 'nativeFill', 'humanAutocomplete', 'nativeSubmit', 'protectedWebSocket', 'postNavigationInput', 'noSecretInHub', 'staleAndWrongOriginRejected', 'rawReadbackAndCaptureBlocked', 'redirectedPost']) assert.equal(report[key], true, key);
});

test('native secret fill checks origin and form before reading, types in the isolated world and shields the page', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const report = await runHarness('browser-secret-fill.mjs', 'NATIVE_SECRET_REPORT');
  assert.equal(report.error, undefined);
  for (const key of ['refusedBeforeRead', 'nativeSecretFill', 'observationsMasked', 'onlyFillRequestCarriesValue', 'otherTabMasked', 'nativeSubmit']) assert.equal(report[key], true, key);
});
