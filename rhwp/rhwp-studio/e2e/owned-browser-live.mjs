/** Real owned Chromium + authenticated hub + Studio. Only the research site and Pi turn are fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { ensureChromePath, findAvailablePort, startHub, stopServer, studioRoot, writeFakePi } from './agent-bench-harness.mjs';
import { startResearchFixture } from './owned-browser-fixture.mjs';

ensureChromePath();
const root = path.resolve(studioRoot, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.tools/owned-browser-chromium');
const evidence = process.env.RHWP_BROWSER_EVIDENCE_DIR || path.join(root, 'docs/pr-evidence/owned-browser');
fs.mkdirSync(evidence, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-owned-browser-live-'));
const browserDataDir = path.join(fixtureRoot, 'browser-data');
const keyFile = path.join(fixtureRoot, 'wrapping-key');
fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
fs.mkdirSync(path.join(fixtureRoot, 'projects'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'projects/settings.json'), JSON.stringify({ librarian: { enabled: false }, agent: { chatMayEdit: false } }));
const site = await startResearchFixture();
const hubPort = await findAvailablePort(5940);
const vitePort = await findAvailablePort(7940);
const token = randomUUID();
const results = { runtime: `http://127.0.0.1:${vitePort}`, hubPort, browser: 'actual app-owned Chromium', website: 'deterministic cookie/CSRF/blob research fixture', provider: 'Pi turn fixture, no model inference', scenarios: [], errors: [] };
let hub, vite, browser, page;
const providers = [];
const inboxOnly = process.argv.includes('--inbox-only');
const chromeOnly = process.argv.includes('--chrome-only');

async function attachProvider() {
  const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz`, { headers: { authorization: `Bearer ${token}` } })).json();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
  const record = health.sessions.find(row => row.sessionId === sessionId);
  assert.ok(record, 'Studio session is registered on the real hub');
  const capabilities = await registerHubSession({ port: hubPort, token, launchId: health.launchId, sessionId });
  const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(capabilities.mcp)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`);
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'tool-result') return;
    const entry = pending.get(frame.id); if (!entry) return;
    pending.delete(frame.id); clearTimeout(entry.timer); entry.resolve(frame);
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Provider connection closed')); } pending.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('MCP connection failed')), { once: true }); });
  const provider = { socket, sessionId, async call(tool, args = {}) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Provider turn is no longer active');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Tool timed out: ${tool}`)); }, 45_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, workflow: record.session.workflow, capabilityEpoch: record.session.capabilityEpoch }));
    });
  } };
  providers.push(provider); return provider;
}
function must(frame, scenario) { assert.equal(frame.ok, true, `${scenario}: ${frame.error?.code} ${frame.error?.message}`); return frame.result; }
async function observe(provider, tabId) { return must(await provider.call('browser_snapshot', { tabId }), 'semantic observation').snapshot; }
function refArgs(snapshot, name, intent = 'research') {
  const element = snapshot.elements.find(row => row.name === name);
  assert.ok(element, `Real semantic snapshot contains ${name}`);
  return { tabId: snapshot.tabId, snapshotId: snapshot.snapshotId, ref: element.ref, navigationEpoch: snapshot.navigationEpoch, controllerEpoch: snapshot.controllerEpoch, intent };
}
async function clickRef(provider, tabId, name, intent = 'research') {
  const snapshot = await observe(provider, tabId);
  must(await provider.call('browser_click', refArgs(snapshot, name, intent)), name);
  return snapshot;
}
async function human(action, args = {}) { return page.evaluate((name, input) => window.__agentBridge.requestBrowser(name, input), action, args); }
async function record(name, details = {}) { results.scenarios.push({ name, ...details }); console.log(`PASS ${name}`); }
async function shot(name) { await page.screenshot({ path: path.join(evidence, `${name}.png`) }); }
async function eventually(label, read, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}; last state ${JSON.stringify(value)}`);
}

try {
  hub = await startHub({ hubPort, token, fixtureRoot, logName: 'owned-browser-live-hub.log', env: { RHWP_PI_DIR: piRoot, RHWP_BROWSER_DATA_DIR: browserDataDir, RHWP_BROWSER_WRAPPING_KEY_FILE: keyFile, RHWP_BROWSER_WORKSPACE_TARGETS: JSON.stringify([site.origin]), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`; process.env.RHWP_AGENT_TOKEN = token; process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({ configFile: path.join(studioRoot, 'vite.config.ts'), cacheDir: path.join(fixtureRoot, 'vite-cache'), server: { host: '127.0.0.1', port: vitePort, strictPort: true, open: false, fs: { allow: [studioRoot, path.join(root, 'rhwp/pkg'), path.join(root, 'rhwp/samples'), path.join(root, 'rhwp/npm/editor')] } }, logLevel: 'warn' });
  await vite.listen(); process.env.VITE_URL = results.runtime;
  const { launchBrowser, createPage, loadApp, createNewDocument, waitForState } = await import('./helpers.mjs');
  browser = await launchBrowser(); page = await createPage(browser, 1440, 1000);
  page.on('pageerror', error => results.errors.push(error.message));
  await loadApp(page);
  await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({ defaultAgent: 'pi', defaultModel: 'mock-model', defaultMode: 'chat', defaultEffort: '' })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForState(page, 'real editor and hub ready', () => Boolean(window.__wasm) && window.__agentBridge?.getConnectionState() === 'connected');
  // Fixture login/export POST handlers are owner-approved exact site operations.
  // Public origins continue through default research policy and its semantic write gate.
  await human('policy.update', { operation: 'set-site', origin: site.origin, label: 'Isolated research export fixture', allowedActions: ['browse', 'read', 'download', 'research-import', 'website-change'], blockedActions: [] });
  let provider, tab;
  if (!inboxOnly) {
  await createNewDocument(page);
  await page.type('.ag-input', 'Read the isolated research reference.'); await page.click('.ag-send');
  await waitForState(page, 'Pi fixture research turn running', () => window.__agentBridge.isTurnRunning() && Boolean(window.__agentBridge.projects.store.get()));
  provider = await attachProvider();
  const opened = must(await provider.call('browser_open', { url: site.origin, intent: 'research' }), 'open assigned browser');
  tab = opened.tab;
  assert.ok(tab?.tabId);
  results.source = { sessionId: provider.sessionId, tabId: tab.tabId, projectId: tab.projectId };
  await record('Agent opens actual managed Chromium through authenticated MCP', { tabId: tab.tabId });
  await clickRef(provider, tab.tabId, 'Sign in to fixture account', 'login');
  const snapshot = await eventually('authenticated research page', () => observe(provider, tab.tabId), value => value.text.includes('Approved fixture account'));
  const query = refArgs(snapshot, 'Research query', 'search');
  must(await provider.call('browser_type', { ...query, text: 'Korean HWP research' }), 'type semantic research query');
  await clickRef(provider, tab.tabId, 'Search references', 'search');
  const searched = await observe(provider, tab.tabId);
  assert.ok(searched.text.includes('Result: Korean HWP research'));
  await record('Semantic snapshot refs drive real login, typing and search');
  const stale = await provider.call('browser_click', refArgs(snapshot, 'Search references', 'search'));
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'BROWSER_STALE_REFERENCE');
  await record('Stale semantic reference rejected without replay');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await waitForState(page, 'Agent Focus ready', () => document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.documentElement.classList.contains('ag-fs-vt'));
  await page.click('.ag-workspace-panel-btn');
  await page.waitForSelector('.ag-workbench-launcher:not([hidden])', { visible: true });
  await page.locator('.ag-workbench-launcher-item[data-view="browser"]').click();
  await page.waitForSelector('.ag-browser-frame[src^="data:image"]', { visible: true });
  await shot('real-stream-agent-research');
  await page.click('.ag-browser [aria-label="직접 조작"]');
  await eventually('human controller lease', () => human('status'), value => value.tabs.find(row => row.tabId === tab.tabId)?.controller.owner === 'human');
  const paused = await provider.call('browser_type', { ...refArgs(await observe(provider, tab.tabId), 'Research query', 'search'), text: 'Must not replace human input' });
  assert.equal(paused.ok, false); assert.equal(paused.error.code, 'BROWSER_HUMAN_CONTROL');
  await record('Human takeover through production UI pauses agent input');
  const humanSnapshot = (await human('snapshot', { tabId: tab.tabId })).snapshot;
  await human('type', { ...refArgs(humanSnapshot, 'Research query', 'search'), text: '' });
  const queryElement = humanSnapshot.elements.find(row => row.name === 'Research query');
  const actualFrame = (await human('frame', { tabId: tab.tabId })).frame;
  const queryPoint = await page.$eval('.ag-browser-frame', (image, input) => {
    const rect = image.getBoundingClientRect();
    return { x: rect.left + (input.rect.x + input.rect.width / 2) * rect.width / input.width, y: rect.top + (input.rect.y + input.rect.height / 2) * rect.height / input.height };
  }, { rect: queryElement.rect, width: actualFrame.width, height: actualFrame.height });
  await page.mouse.click(queryPoint.x, queryPoint.y);
  await page.evaluate(() => {
    const input = document.querySelector('.ag-browser-ime');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '자료' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '자료', inputType: 'insertCompositionText', isComposing: false }));
  });
  await eventually('Korean composition reaches actual Chromium once', async () => (await human('snapshot', { tabId: tab.tabId })).snapshot, value => value.elements.find(row => row.name === 'Research query')?.value === '자료');
  await page.evaluate(() => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', ' 검토');
    document.querySelector('.ag-browser-ime').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: clipboard }));
  });
  await eventually('clipboard paste reaches actual Chromium', async () => (await human('snapshot', { tabId: tab.tabId })).snapshot, value => value.elements.find(row => row.name === 'Research query')?.value === '자료 검토');
  await record('Production streamed pointer, Korean IME and clipboard paste reach the owned page once');
  const previousFrame = await page.$eval('.ag-browser-frame', image => image.src);
  await page.click('.ag-browser [aria-label="브라우저 띄우기"]');
  await page.waitForSelector('.ag-browser-floating:not([hidden]) .ag-browser-frame', { visible: true });
  await page.waitForFunction(previous => document.querySelector('.ag-browser-frame')?.src !== previous, {}, previousFrame);
  await shot('real-stream-human-float');
  if (chromeOnly) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
    await waitForState(page, 'normal editor with floating browser', () => !document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.documentElement.classList.contains('ag-fs-vt'));
    const floatRect = await page.$eval('.ag-browser-floating', element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    const resizePoint = await page.$eval('[aria-label="브라우저 크기 조절"]', element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
    await page.mouse.move(resizePoint.x, resizePoint.y); await page.mouse.down();
    await page.mouse.move(resizePoint.x + 560 - floatRect.width, resizePoint.y + 430 - floatRect.height, { steps: 6 }); await page.mouse.up();
    const movePoint = await page.$eval('[aria-label="브라우저 이동"]', element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
    await page.mouse.move(movePoint.x, movePoint.y); await page.mouse.down();
    await page.mouse.move(movePoint.x + 50 - floatRect.x, movePoint.y + 430 - floatRect.y, { steps: 6 }); await page.mouse.up();
    const moved = await page.$eval('.ag-browser-floating', element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    assert.ok(Math.abs(moved.y - floatRect.y) > 10 && moved.width < floatRect.width, 'in-app preview moves and resizes');
    const editorPoint = await page.$eval('#scroll-container canvas', element => { const rect = element.getBoundingClientRect(); return { x: rect.x + 130, y: rect.y + 130 }; });
    assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.tagName, editorPoint), 'CANVAS');
    await page.mouse.click(editorPoint.x, editorPoint.y); await page.keyboard.type('Notes beside research.');
    await page.waitForFunction(() => window.__wasm.getTextRange(0, 0, 0, 200).includes('Notes beside research.'));
    await page.type('.ag-input', 'Keep this draft beside research.');
    assert.equal(await page.$eval('.ag-input', input => input.value), 'Keep this draft beside research.');
    await shot('real-stream-editor-pip');
    await record('In-app floating preview drags and resizes while normal document editing and chat draft remain usable');
    await page.click('.ag-browser [aria-label="브라우저 보기 닫기"]');
    await page.waitForSelector('.ag-browser-floating[hidden]');
    const hiddenTab = (await human('status')).tabs.find(row => row.tabId === tab.tabId);
    assert.equal(hiddenTab.controller.owner, 'human'); assert.equal(hiddenTab.url, `${site.origin}/research`);
    await page.click('.ag-browser-trigger[aria-label="브라우저 열기"]');
    await page.waitForSelector('.ag-browser-floating:not([hidden]) .ag-browser-frame', { visible: true });
    const reopened = (await human('snapshot', { tabId: tab.tabId })).snapshot;
    assert.equal(reopened.elements.find(row => row.name === 'Research query').value, '자료 검토');
    await record('Closing the in-app preview hides presentation and reopening preserves tab, form and human controller');
  }
  await page.click('.ag-browser [aria-label="작업 칸에 붙이기"]');
  await page.waitForSelector('.ag-workbench-page .ag-browser-frame', { visible: true });
  await waitForState(page, 'docked browser transition complete', () => document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.documentElement.classList.contains('ag-fs-vt'));
  const afterDock = await human('status');
  assert.equal(afterDock.tabs.find(row => row.tabId === tab.tabId).url, `${site.origin}/research`);
  await record('Float and dock preserve the original authenticated research tab');
  const menuClosed = await page.$eval('.ag-browser .ag-browser-details', details => !details.open);
  if (menuClosed) await page.click('.ag-browser [aria-label="브라우저 추가 메뉴"]');
  await page.waitForSelector('.ag-browser .ag-browser-details[open] [aria-label="별도 창으로 열기"]', { visible: true });
  const popoutPoint = await page.$eval('.ag-browser [aria-label="별도 창으로 열기"]', button => {
    const rect = button.getBoundingClientRect(); const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, receivesPointer: hit === button || button.contains(hit), hit: hit?.outerHTML.slice(0, 300) };
  });
  assert.ok(popoutPoint.receivesPointer, `More action must receive its physical click: ${JSON.stringify(popoutPoint)}`);
  const popupPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for optional browser window')), 30_000);
    page.once('popup', popup => { clearTimeout(timer); resolve(popup); });
  });
  await page.click('.ag-browser [aria-label="별도 창으로 열기"]');
  const popup = await popupPromise;
  await popup.waitForSelector('.ag-browser-frame', { visible: true });
  await popup.screenshot({ path: path.join(evidence, 'real-stream-popout.png') });
  const dockPoint = await popup.$eval('.ag-browser [aria-label="작업 칸에 붙이기"]', button => { const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await popup.mouse.click(dockPoint.x, dockPoint.y);
  await page.waitForSelector('.ag-workbench-page .ag-browser-frame', { visible: true });
  const afterPopout = (await human('snapshot', { tabId: tab.tabId })).snapshot;
  assert.equal(afterPopout.elements.find(row => row.name === 'Research query').value, '자료 검토');
  await record('Popout and dock retain the same tab, authenticated page and form input');
  await page.click('.ag-browser [aria-label="페이지·개체·영역에 의견 붙이기"]');
  await page.type('.ag-browser [aria-label="자료 의견"]', 'Review the authenticated research export.');
  await page.click('.ag-browser [aria-label="의견과 자료를 선택한 채팅에 첨부"]');
  await page.waitForSelector('.ag-capture-inbox .ag-capture-pill', { visible: true });
  const capture = await page.$eval('.ag-capture-inbox .ag-capture-pill', element => ({ title: element.title, id: element.dataset.captureId }));
  assert.ok(capture.id && capture.title.includes('authenticated research export'));
  await shot('real-stream-capture-composer');
  await record('Real page screenshot and comment attach to the pinned destination composer', { captureId: capture.id, sourceTabId: tab.tabId });
  await page.click('.ag-browser [aria-label="에이전트에게 넘기기"]');
  await eventually('agent controller lease', () => human('status'), value => value.tabs.find(row => row.tabId === tab.tabId)?.controller.owner === 'agent');
  if (!chromeOnly) {
  for (const [name, intent] of [['Download authenticated GET PDF', 'export'], ['Export POST PDF', 'export'], ['Download blob PDF', 'export']]) {
    await clickRef(provider, tab.tabId, name, intent);
    const downloads = await eventually(`completed ${name}`, async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => ['imported', 'import-failed'].includes(row.state) && !results.scenarios.some(scenario => scenario.downloadId === row.downloadId)));
    const job = downloads.find(row => ['imported', 'import-failed'].includes(row.state) && !results.scenarios.some(scenario => scenario.downloadId === row.downloadId));
    assert.equal(job.target.projectId, tab.projectId, 'download stays in its captured project');
    assert.ok(job.sha256); assert.equal(job.size, site.pdf.length);
    assert.equal(job.state, 'imported', 'project PDF creates its reference automatically');
    assert.ok(job.projectItemId && job.fileId);
    const saved = await page.evaluate(async ({ projectId, itemId }) => Array.from(new Uint8Array(await (await window.__agentBridge.projects.service.fileBlob(projectId, itemId)).arrayBuffer())), { projectId: tab.projectId, itemId: job.projectItemId });
    assert.ok(Buffer.from(saved).equals(site.pdf), 'authenticated project viewer route returns original Chromium bytes');
    await record(name, { downloadId: job.downloadId, state: job.state, projectId: job.target.projectId, fileId: job.fileId, projectItemId: job.projectItemId, size: job.size });
  }
  await page.click('.ag-browser [aria-label="다운로드 목록"]');
  await page.waitForSelector('.ag-browser-downloads:not([hidden])', { visible: true });
  await shot('real-stream-managed-pdfs');
  await page.click('.ag-browser-downloads [aria-label="문서에서 열기"]');
  await page.waitForSelector('.ag-wdocs-panel:not([hidden]) canvas', { visible: true });
  await shot('real-stream-pdf-open');
  await record('Automatic project PDF reopens in the existing Documents viewer');
  await page.click('.ag-workbench-add');
  await page.locator('.ag-workbench-launcher-item[data-view="board"]').click();
  const firstImported = results.scenarios.find(row => row.projectItemId);
  await page.waitForSelector(`.ag-workbench-board .ag-pcard[data-item="${firstImported.projectItemId}"]`, { visible: true });
  await shot('real-stream-pdf-board-card');
  await record('Captured PDF has an automatic durable reference card on the project board');
  await page.click('.ag-workbench-tabs [role="tab"][data-view="browser"]');
  await clickRef(provider, tab.tabId, 'Download malformed PDF', 'export');
  const malformed = await eventually('malformed PDF retained with failed extraction', async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => row.filename === 'corrupt-reference.pdf' && row.state === 'imported' && row.extractionStatus === 'failed'));
  const broken = malformed.find(row => row.filename === 'corrupt-reference.pdf');
  assert.ok(broken.fileId && broken.projectItemId, 'malformed PDF bytes and card survive parser failure');
  await record('Failed PDF extraction preserves completed bytes and the project reference', { downloadId: broken.downloadId, extractionStatus: broken.extractionStatus });
  await page.evaluate(() => window.__agentBridge.projects.store.refresh());
  await page.click('.ag-workbench-tabs [role="tab"][data-view="documents"]');
  const retrySelector = `.ag-wdocs-download-group:has(.ag-wdocs-card[data-item-id="${broken.projectItemId}"]) [aria-label$="글자 추출 다시 시도"]`;
  await page.locator(retrySelector).click();
  const retried = await eventually('Documents retries retained PDF extraction', async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => row.downloadId === broken.downloadId && row.extractionStatus === 'failed' && row.updatedAt !== broken.updatedAt));
  const retriedJob = retried.find(row => row.downloadId === broken.downloadId);
  assert.equal(retriedJob.fileId, broken.fileId); assert.equal(retriedJob.projectItemId, broken.projectItemId);
  await shot('real-stream-pdf-extraction-retry');
  await record('Documents extraction retry keeps the original completed file and card', { downloadId: broken.downloadId, projectItemId: broken.projectItemId });
  await page.click('.ag-workbench-tabs [role="tab"][data-view="browser"]');
  await clickRef(provider, tab.tabId, 'Download slow PDF', 'export');
  const pending = await eventually('slow transfer begins', async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => row.filename === 'slow-reference.pdf' && row.state === 'downloading'));
  const slow = pending.find(row => row.filename === 'slow-reference.pdf');
  must(await provider.call('browser_downloads', { action: 'cancel', downloadId: slow.downloadId }), 'cancel actual browser transfer');
  await eventually('cancelled transfer', async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => row.downloadId === slow.downloadId && row.state === 'cancelled'));
  await record('Cancelling an actual transfer preserves no partial project card', { downloadId: slow.downloadId });
  await human('configuration.update', { downloads: { maxFileBytes: 1024 * 1024 } });
  await clickRef(provider, tab.tabId, 'Download oversized PDF', 'export');
  const limited = await eventually('unknown-length transfer reaches its byte cap', async () => must(await provider.call('browser_downloads', {}), 'managed download status').downloads, rows => rows.some(row => row.filename === 'large-reference.pdf' && ['interrupted', 'cancelled'].includes(row.state)));
  const capped = limited.find(row => row.filename === 'large-reference.pdf');
  assert.ok(!capped.projectItemId && capped.size <= 1024 * 1024);
  await record('Unknown-length browser download enforces its configured byte limit', { downloadId: capped.downloadId, state: capped.state, size: capped.size });
  await human('configuration.update', { downloads: { maxFileBytes: 100 * 1024 * 1024 } });
  await page.evaluate(() => window.__eventBus.emit('settings:open', { destination: 'browser', fullscreen: true }));
  await page.waitForSelector('.ag-browser-settings', { visible: true });
  await page.locator('.ag-browser-settings button::-p-text(승인된 권한)').click();
  await page.waitForFunction(() => document.querySelector('.ag-browser-settings-body')?.textContent?.includes('Google Search'));
  await shot('real-stream-browser-approved-permissions');
  await record('Production Browser Settings exposes durable research permissions');
  assert.ok(site.requests.some(row => row.path === '/pdf/post' && row.method === 'POST' && row.authenticated));
  assert.equal(site.requests.filter(row => row.path === '/pdf/get').length, 1, 'authenticated PDF is never refetched');
  const publicResults = JSON.stringify(results.scenarios);
  assert.ok(!publicResults.includes('fixture-private') && !publicResults.includes('fixture-export'));
  await record('Chromium-delivered GET, POST and blob bytes retain private request state');
  await record('Scoped workspace fixture configured without private-network bypass');
  }
  }
  if (!chromeOnly) {
  const projectPage = inboxOnly ? null : page;
  const standaloneContext = inboxOnly ? null : await browser.createBrowserContext();
  if (standaloneContext) {
  page = await createPage(standaloneContext, 1440, 1000);
  await loadApp(page);
  await waitForState(page, 'standalone owner client ready', () => window.__agentBridge?.getConnectionState() === 'connected');
  }
  const inboxTab = (await human('open', { url: `${site.origin}/research` })).tab;
  assert.equal(inboxTab.projectId, null, 'new owner client has no invented project');
  if (provider) {
  const crossAgent = await provider.call('browser_snapshot', { tabId: inboxTab.tabId });
  assert.equal(crossAgent.ok, false); assert.ok(/SCOPE|OWNED|NOT_FOUND/.test(crossAgent.error.code));
  await record('Guessed cross-agent tab ID is rejected by the real hub', { code: crossAgent.error.code });
  }
  let inboxSnapshot = (await human('snapshot', { tabId: inboxTab.tabId })).snapshot;
  if (inboxSnapshot.elements.some(row => row.name === 'Sign in to fixture account')) {
    await human('click', refArgs(inboxSnapshot, 'Sign in to fixture account', 'login'));
    inboxSnapshot = await eventually('standalone fixture login', async () => (await human('snapshot', { tabId: inboxTab.tabId })).snapshot, value => value.text.includes('Approved fixture account'));
  }
  await human('click', refArgs(inboxSnapshot, 'Export POST PDF', 'export'));
  const inboxRows = await eventually('general inbox receives PDF', async () => (await human('downloads', { action: 'list' })).downloads, rows => rows.some(row => row.target.tabId === inboxTab.tabId && row.state === 'downloaded'));
  const inboxJob = inboxRows.find(row => row.target.tabId === inboxTab.tabId && row.state === 'downloaded');
  assert.equal(inboxJob.target.projectId ?? null, null);
  const inboxBytes = await page.evaluate(async id => Array.from(new Uint8Array(await (await window.__agentBridge.readBrowserDownload(id)).arrayBuffer())), inboxJob.downloadId);
  assert.ok(Buffer.from(inboxBytes).equals(site.pdf));
  await record('No-project download is immediately available from authenticated owner inbox', { downloadId: inboxJob.downloadId });
  await page.click('.dh-downloads');
  await waitForState(page, 'Home downloads focus transition finished', () => document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.documentElement.classList.contains('ag-fs-vt'));
  await page.waitForSelector(`.ag-download-inbox-row[data-download-id="${inboxJob.downloadId}"]`, { visible: true });
  await page.locator(`.ag-download-inbox-row[data-download-id="${inboxJob.downloadId}"] [aria-label="받은 파일 열기"]`).click();
  await page.waitForFunction(() => document.querySelector('.ag-download-inbox-viewer canvas')?.width > 1 && document.querySelector('.ag-download-inbox-viewer')?.textContent.includes('1 / 1'));
  await shot('real-stream-general-inbox-pdf');
  await record('General inbox PDF opens without a document or project');
  // A failed destination move must retain its durable inbox bytes.
  await assert.rejects(() => page.evaluate(async ({ id, projectId }) => window.__agentBridge.importBrowserDownload(id, projectId), { id: inboxJob.downloadId, projectId: 'missing-project' }));
  const retained = (await human('downloads', { action: 'list' })).downloads.find(row => row.downloadId === inboxJob.downloadId);
  assert.equal(retained.importProjectId ?? null, null);
  if (projectPage) {
  const moved = await projectPage.evaluate(async ({ id, projectId }) => window.__agentBridge.importBrowserDownload(id, projectId), { id: inboxJob.downloadId, projectId: tab.projectId });
  assert.equal(moved.state, 'imported'); assert.ok(moved.projectItemId);
  await record('Failed inbox move retains bytes and a later project move succeeds', { downloadId: inboxJob.downloadId, projectItemId: moved.projectItemId });
  }
  await standaloneContext?.close(); if (projectPage) page = projectPage;
  }
  if (provider) {
  fs.writeFileSync(finishTurnPath, '');
  await waitForState(page, 'Pi fixture turn settled', () => !window.__agentBridge.isTurnRunning());
  }
  assert.deepEqual(results.errors, [], 'no uncaught Studio runtime errors');
  results.status = 'passed';
} catch (error) {
  results.failure = { message: error.message, stack: error.stack };
  if (page) results.failure.ui = await page.evaluate(() => ({ body: document.body.className, sidebar: document.querySelector('.ag-root')?.className,
    inboxes: Array.from(document.querySelectorAll('.ag-download-inbox-viewer')).map(viewer => ({ hidden: viewer.hidden, text: viewer.textContent?.slice(0, 500), canvas: viewer.querySelector('canvas')?.width })),
    home: { documentClass: document.documentElement.className, rows: Array.from(document.querySelectorAll('[aria-label="문서 홈"]')).map(home => ({ hidden: home.hidden, style: getComputedStyle(home).display })) },
    inboxStatus: Array.from(document.querySelectorAll('.ag-download-inbox [role="status"]')).map(node => node.textContent) })).catch(() => null);
  if (page) await shot('real-stream-failure').catch(() => {});
  console.error(error.stack); process.exitCode = 1;
} finally {
  results.fixtureRequests = site.requests;
  fs.writeFileSync(path.join(evidence, chromeOnly ? 'real-chrome-results.json' : inboxOnly ? 'real-inbox-results.json' : 'real-stream-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  for (const provider of providers) provider.socket.close();
  await browser?.close(); await vite?.close(); await stopServer(hub); await site.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
