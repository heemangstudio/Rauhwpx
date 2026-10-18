import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserNavigationUrl, pageNavigationUrl } from '../desktop/browser-host.mjs';

const require = createRequire(import.meta.url);
let electron = process.env.RHWP_BROWSER_ELECTRON_PATH; try { electron ||= require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

test('page-initiated navigation also allows blob URLs that web pages create, and nothing privileged', () => {
  for (const [input, expected] of [
    ['https://example.com', 'https://example.com/'],
    ['http://127.0.0.1:7700/path?q=1', 'http://127.0.0.1:7700/path?q=1'],
    ['about:blank', 'about:blank'],
    ['about:srcdoc', 'about:srcdoc'],
    ['blob:https://example.com/7f1d0c4e-1111-4222-8333-944445555666', 'blob:https://example.com/7f1d0c4e-1111-4222-8333-944445555666'],
    ['blob:http://127.0.0.1:5175/abc', 'blob:http://127.0.0.1:5175/abc'],
  ]) assert.equal(pageNavigationUrl(input), expected, input);
  for (const input of [
    'blob:null/7f1d0c4e', 'blob:file:///etc/passwd', 'blob:hamaeditor://app/x', 'blob:chrome://settings/x',
    'file:///etc/passwd', 'data:text/html,<script>1</script>', 'javascript:alert(1)', 'chrome://settings', 'devtools://devtools/x',
    'hamaeditor://app/', 'https://user:pass@example.com/', 'about:config', 'not a url',
  ]) assert.throws(() => pageNavigationUrl(input), undefined, input);
  // 주소창·에이전트 이동은 여전히 http(s)만 받는다.
  for (const input of ['about:srcdoc', 'blob:https://example.com/abc']) assert.throws(() => browserNavigationUrl(input), undefined, input);
});

test('real native guests open page blob links and click protected-tab targets inside shadow roots, readonly fields and partly covered buttons', { skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-page-actions-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const args = [fileURLToPath(new URL('./electron/browser-page-actions.mjs', import.meta.url)), '--use-mock-keychain'];
      if (process.platform === 'darwin') args.push('-ApplePersistenceIgnoreState', 'YES');
      const child = spawn(electron, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find(line => line.startsWith('BROWSER_PAGE_ACTIONS_REPORT '));
        if (!line) return reject(new Error(`Page action fixture exited ${code} (${signal})\n${stdout}\n${stderr}`));
        const result = JSON.parse(line.slice('BROWSER_PAGE_ACTIONS_REPORT '.length));
        if (code || result.error) reject(new Error(result.error ?? stderr)); else resolve(result);
      });
    });
    assert.deepEqual(report.blob, { targetBlank: true, windowOpen: true, backgroundTab: true, sameTab: true });
    assert.deepEqual(report.protectedClick, { shadowRoot: true, readonly: true, coveredCenter: true, fullyCoveredRefused: true, readonlyTypeRefused: true });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
});
