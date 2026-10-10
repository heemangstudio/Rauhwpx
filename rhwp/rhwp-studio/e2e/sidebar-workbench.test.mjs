/** 실제 Studio·허브·WASM의 자료 보드 저장과 문서 탭을 확인한다. 추론은 Pi fixture다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { ensureChromePath, findAvailablePort, repoRoot, startHub, stopServer, studioRoot, writeFakePi } from './agent-bench-harness.mjs';
ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-workbench-e2e-'));
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
const evidenceDir = process.env.RHWP_WORKBENCH_EVIDENCE_DIR || path.join(repoRoot, 'output/e2e/sidebar-workbench');
fs.mkdirSync(evidenceDir, { recursive: true });
const hubPort = await findAvailablePort(5880);
const vitePort = await findAvailablePort(7880);
const token = randomUUID();
let hub;
let vite;
try {
  hub = await startHub({
    hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot },
    logName: 'sidebar-workbench-e2e-hub.log',
  });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`;
  process.env.RHWP_AGENT_TOKEN = token;
  process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({
    configFile: path.join(studioRoot, 'vite.config.ts'),
    cacheDir: path.join(fixtureRoot, 'vite-cache'),
    server: {
      host: '127.0.0.1', port: vitePort, strictPort: true, open: false,
      fs: { allow: [studioRoot, fs.realpathSync(path.join(studioRoot, '..', 'pkg')),
        path.join(studioRoot, '..', 'samples'), path.join(studioRoot, '..', 'npm', 'editor')] },
    },
    logLevel: 'warn',
  });
  await vite.listen();
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { runTest, createNewDocument, waitForState } = await import('./helpers.mjs');
  await runTest('자료 보드 저장과 작업 보기 탭', async ({ page }) => {
    await page.setViewport({ width: 1440, height: 1000 });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.log('Workbench browser error:', error.message); });
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultMode: 'chat', defaultEffort: '',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'real editor connected', () => Boolean(window.__wasm)
      && window.__agentBridge?.getConnectionState() === 'connected');
    try { await createNewDocument(page); } catch (error) { console.log('Create document errors:', JSON.stringify(errors)); throw error; }
    await page.type('.ag-input', 'Create this isolated research chat.');
    await page.click('.ag-send');
    await waitForState(page, 'fixture turn and project bound', () => window.__agentBridge.isTurnRunning()
      && Boolean(window.__agentBridge.projects.store.get()));
    fs.writeFileSync(finishTurnPath, '');
    await waitForState(page, 'fixture turn finished', () => !window.__agentBridge.isTurnRunning());
    await page.evaluate(async () => window.__agentBridge.projects.store.edit([
      { op: 'note', name: 'Workbench persisted note', body: 'Original note body.' },
    ]));
    await page.evaluate(async () => window.__agentBridge.projects.store.refresh());
    const seed = await page.evaluate(() => {
      const project = window.__agentBridge.projects.store.get();
      const item = project.items.find(row => row.title === 'Workbench persisted note');
      return { itemId: item.id, projectId: project.id, column: item.column };
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
    // 집중 화면 전환(View Transition)이 끝나기 전에는 페이지 전체가 클릭을 받지 않는다.
    await waitForState(page, 'Agent Focus ready', () => document.querySelector('.ag-root').classList.contains('ag-fullscreen')
      && !document.documentElement.classList.contains('ag-fs-vt'));
    const railState = () => page.$eval('.ag-root', node => node.className);
    if (await page.$eval('.ag-root', node => node.classList.contains('ag-rail-collapsed') || node.classList.contains('ag-workspace-compact'))) await page.click('.ag-workspace-threads-btn');
    const boardLaunch = '.ag-workbench-nav .ag-workbench-launch[data-view="board"]';
    await page.waitForSelector(boardLaunch, { visible: true }).catch(async error => { throw new Error(`Board launcher hidden: ${await railState()}`, { cause: error }); });
    // 레일이 펼쳐지는 동안에는 단추가 움직인다. 칸 전이가 끝난 뒤 누른다.
    await waitForState(page, 'threads rail settled', () => document.querySelector('.ag-stage').getAnimations().length === 0);
    await page.click(boardLaunch);
    const card = `.ag-workbench-board .ag-pcard[data-item="${seed.itemId}"]`;
    await page.waitForSelector(card, { visible: true }).catch(async error => { throw new Error(`Board card missing: ${await railState()}`, { cause: error }); });
    await page.focus(card);
    await page.keyboard.down('Alt');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Alt');
    await waitForState(page, 'board move persisted', (id, oldColumn) =>
      window.__agentBridge.projects.store.get().items.find(item => item.id === id)?.column !== undefined
      && window.__agentBridge.projects.store.get().items.find(item => item.id === id).column !== oldColumn,
      seed.itemId, seed.column);
    const movedColumn = await page.evaluate(async id => {
      await window.__agentBridge.projects.store.refresh();
      return window.__agentBridge.projects.store.get().items.find(item => item.id === id).column;
    }, seed.itemId);
    assert.notEqual(movedColumn, seed.column);
    await page.screenshot({ path: path.join(evidenceDir, 'real-studio-board-persisted.png') });
    await page.focus(card);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pp', { visible: true });
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) [aria-label="노트 편집"]');
    await page.click('.ag-wdocs-panel:not([hidden]) [aria-label="노트 편집"]');
    await page.type('.ag-wdocs-panel:not([hidden]) .ag-pp-note-editor', '\nReal hub persisted text.');
    const draft = await page.$eval('.ag-pp-note-editor', node => node.value);
    await page.click('.ag-workbench-tabs [role="tab"][data-view="board"]');
    await page.click('.ag-workbench-tabs [role="tab"][data-resource-id]');
    assert.equal(await page.$eval('.ag-pp-note-editor', node => node.value), draft);
    await page.click('.ag-wdocs-panel:not([hidden]) [aria-label="노트 저장"]');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) [aria-label="노트 편집"]');
    const saved = await page.evaluate(async ({ projectId, itemId }) =>
      window.__agentBridge.projects.service.note(projectId, itemId), seed);
    assert.equal(saved.body, draft, 'a fresh real hub read returns the saved note');
    assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', tabs => tabs.length), 1);
    await page.screenshot({ path: path.join(evidenceDir, 'real-studio-note-saved.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidenceDir, 'real-studio-results.json'), JSON.stringify({
      runtime: process.env.VITE_URL, hubPort, provider: 'controlled Pi fixture; no model inference',
      boardMovePersisted: true, noteDraftRetained: true, noteSavedAndReRead: true, documentTabCount: 1, browserErrors: errors,
    }, null, 2) + '\n');
  });
} finally {
  await vite?.close();
  await stopServer(hub);
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
