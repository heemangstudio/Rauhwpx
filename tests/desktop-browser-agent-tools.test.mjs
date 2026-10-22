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

// 새 에이전트 도구가 데스크톱 게스트의 비공개 CDP 경로에서도 동작하는지 본다(관리형 Chromium 과 다른 허용 목록·대화상자 처리).
test('agent form fill, find, cite, hover, drag, dialog race and parallel reading work on native guests', {
  skip: unavailable ? 'Electron needs an installed binary and display' : false, timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-agent-tools-'));
  const env = { ...process.env, RHWP_BROWSER_TEST_DATA_DIR: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const report = await new Promise((resolve, reject) => {
      const args = [fileURLToPath(new URL('./electron/browser-agent-tools.mjs', import.meta.url)), '--use-mock-keychain'];
      if (process.platform === 'darwin') args.push('-ApplePersistenceIgnoreState', 'YES');
      const child = spawn(electron, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find(entry => entry.startsWith('BROWSER_AGENT_TOOLS_REPORT '));
        if (!line) return reject(new Error(`Agent tools fixture exited ${code} (${signal})\n${stdout}\n${stderr}`));
        const result = JSON.parse(line.slice('BROWSER_AGENT_TOOLS_REPORT '.length));
        if (code || result.error) reject(new Error(result.error ?? stderr)); else resolve(result);
      });
    });
    assert.deepEqual(report, { fillForm: true, find: true, cite: true, hover: true, drag: true, pointerEvents: ['move', 'move', 'down', 'move', 'up'], dialogRace: true, dialogAccepted: true, readMany: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
