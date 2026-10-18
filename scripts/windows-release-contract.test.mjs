import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const action = readFileSync(new URL('../.github/actions/package-desktop/action.yml', import.meta.url), 'utf8');

test('tagged release requires Windows packaging with the shared WASM engine', () => {
  const windows = workflow.match(/^  windows:\r?\n([\s\S]*?)(?=^  publish:)/m)?.[1];
  assert.ok(windows, 'Windows release job must exist');
  for (const contract of ['needs: [preflight, wasm]', 'platform: windows', 'artifact: windows-dist', 'wasm-artifact: release-wasm']) {
    assert.ok(windows.includes(contract), contract);
  }
  assert.match(workflow, /needs: \[verification, macos, windows\]/);
  for (const contract of ['npm run package:win', 'npm run verify:package', 'verify-release-artifacts.mjs', 'Get-AuthenticodeSignature']) {
    assert.ok(action.includes(contract), contract);
  }
});

test('public release publishes versioned Windows installers and updater metadata alongside checksummed aliases', () => {
  const publicPublish = workflow.split('- name: Publish to the public download repository')[1];
  assert.ok(publicPublish);
  for (const asset of ['release/*.exe', 'release/*.blockmap', 'release/latest*.yml', 'release/SHA256SUMS.txt']) {
    assert.ok(publicPublish.includes(asset), `Public updater asset missing: ${asset}`);
  }
  assert.match(workflow, /cp "\$\{installers\[0\]\}" release\/HamaEditor-win-x64\.exe/);
  assert.ok(workflow.indexOf('HamaEditor-win-x64.exe') < workflow.indexOf('- name: Generate checksums'));
  assert.match(workflow, /checksum_inputs=\([^\n]*\.\/\*\.exe/);
});
