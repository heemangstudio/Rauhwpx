// Real Windows processes, hub, Studio and sidebar; synthetic provider output.
// CHROME_PATH=... node e2e/provider-stream-recovery.test.mjs [--runs=10]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findAvailablePort, startHub, startVite, stopServer, removeTempDir } from './agent-bench-harness.mjs';
import { writeFakeCliBin } from '../../rhwp-agent/tests/fake-cli-bin.mjs';
import { installEventCapture, readEventCapture, resetEventCapture, startFreshChat } from '../bench/agent-live-common.mjs';

const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1] ?? 1);
assert.ok(Number.isSafeInteger(runs) && runs > 0 && runs <= 100);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-stream-recovery-'));
const cliRoot = path.join(root, 'cli');
const releasePath = path.join(root, 'release-output');
const source = `const releasePath = ${JSON.stringify(releasePath)};\n` + fs.readFileSync(new URL('./fixtures/stream-fault-cli.cjs', import.meta.url), 'utf8');
for (const agent of ['codex', 'claude']) {
  const { binPath, fixturePath } = writeFakeCliBin(path.join(cliRoot, 'prefix/node_modules/.bin'), agent, source);
  // Use the managed npm-shim path, including Node installations under Program Files.
  if (process.platform === 'win32') {
    // The Claude SDK recognizes .js scripts and launches them through Node.
    const sdkScript = fixturePath.replace(/\.cjs$/, '.js');
    fs.copyFileSync(fixturePath, sdkScript);
    fs.writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "${sdkScript}" %*\r\n`);
  }
}
const hubPort = await findAvailablePort(8390);
const vitePort = await findAvailablePort(8395);
const token = 'stream-recovery-test';
const evidence = fileURLToPath(new URL('../../target/provider-stream-recovery/', import.meta.url));
fs.mkdirSync(evidence, { recursive: true });
let hub, vite, browser;
const results = [];
try {
  hub = await startHub({ hubPort, token, fixtureRoot: root, env: { RHWP_CLI_DIR: cliRoot, RHWP_USAGE_DIR: path.join(root, 'usage'), RHWP_PROVIDER_TRANSCRIPT_DIR: path.join(evidence, 'transcripts') }, logName: 'stream-recovery-hub.log' });
  vite = await startVite({ vitePort, hubPort, token, logName: 'stream-recovery-vite.log' });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { launchBrowser, loadApp, createNewDocument } = await import('./helpers.mjs');
  browser = await launchBrowser();
  for (const agent of ['codex', 'claude']) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const model = agent === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5';
    await page.evaluateOnNewDocument((defaultAgent, defaultModel) => {
      localStorage.setItem('rhwp-agent-prefs', JSON.stringify({ defaultAgent, defaultModel, defaultEffort: 'low', defaultMode: 'full' }));
    }, agent, model);
    await loadApp(page);
    await createNewDocument(page);
    await installEventCapture(page);
    await startFreshChat(page, { agent, model, effort: 'low' });
    for (let run = 0; run < runs; run++) {
      for (const scenario of (process.argv.find((arg) => arg.startsWith('--scenarios='))?.split('=')[1]?.split(',') ?? ['healthy', 'partial', 'missing', 'duplicate', 'auth-failure', 'healthy', 'crash', 'healthy', 'stop', 'healthy', 'reconnect', 'healthy'])) {
        fs.rmSync(releasePath, { force: true });
        fs.rmSync(releasePath + '.done', { force: true });
        await resetEventCapture(page);
        await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 15000 });
        await page.type('#agent-sidebar textarea.ag-input', `stream-test ${scenario}`);
        await page.waitForFunction((value) => document.querySelector('textarea.ag-input')?.value === value
          && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', {}, `stream-test ${scenario}`);
        await page.click('.ag-send:not(.ag-stop)');
        if (scenario === 'stop') {
          await page.waitForFunction(() => window.__liveText?.includes('확인 '), { timeout: 15000 });
          await page.click('.ag-send.ag-stop');
        }
        if (scenario === 'reconnect') {
          await page.waitForFunction(() => window.__liveText?.includes('확인 '), { timeout: 15000 });
          await page.setOfflineMode(true);
          await page.evaluate(() => window.__agentBridge.ws.close());
          await page.waitForFunction(() => window.__agentBridge.getConnectionState() !== 'connected');
          fs.writeFileSync(releasePath, 'release');
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(releasePath + '.done')) {
            assert.ok(Date.now() < deadline, 'provider did not finish during the offline gap');
            await delay(20);
          }
          await page.setOfflineMode(false);
          await page.evaluate(() => window.__agentBridge.reconnectNow());
          await page.waitForFunction(() => window.__agentBridge.getConnectionState() === 'connected');
        }
        try {
          await page.waitForFunction(() => window.__liveEvents?.some((event) => event.type === 'turn-end'), { timeout: 20000 });
        } catch (error) {
          await page.screenshot({ path: path.join(evidence, `${agent}-${run}-${scenario}-timeout.png`) });
          const state = await page.evaluate(() => ({ events: window.__liveEvents, sidebar: document.querySelector('#agent-sidebar')?.innerText, input: document.querySelector('textarea.ag-input')?.value, ready: document.querySelector('#agent-sidebar')?.dataset.composerReady }));
          fs.writeFileSync(path.join(evidence, 'timeout.json'), JSON.stringify(state, null, 2));
          throw error;
        }
        const capture = await readEventCapture(page);
        const end = capture.events.find((event) => event.type === 'turn-end');
        const expected = ['healthy', 'partial', 'missing', 'duplicate', 'reconnect'].includes(scenario) ? '확인 완료. 편집을 저장했습니다.' : null;
        const pass = capture.events.filter((event) => event.type === 'turn-end').length === 1
          && (expected === null || capture.text === expected)
          && (scenario !== 'stop' || end.stopReason === 'interrupted')
          && (!['auth-failure', 'crash'].includes(scenario) || !['completed', 'end_turn'].includes(end.stopReason));
        const visible = await page.$eval('#agent-sidebar', (el) => el.innerText);
        const row = { agent, run, scenario, pass: pass && (expected === null || visible.includes(expected)), text: capture.text, stopReason: end.stopReason };
        results.push(row);
        console.log(JSON.stringify(row));
        if (!row.pass || scenario === 'partial') await page.screenshot({ path: path.join(evidence, `${agent}-${run}-${scenario}.png`) });
      }
    }
    await context.close();
  }
} finally {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results }, null, 2));
  await browser?.close();
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(root);
}
assert.equal(results.filter((row) => !row.pass).length, 0, `stream recovery failures: ${JSON.stringify(results.filter((row) => !row.pass))}`);
