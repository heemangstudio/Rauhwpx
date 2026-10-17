/**
 * 요청 카드 실제 검증: 인증된 허브 + Studio(Vite) + 앱 소유 Chromium + 결정적 HTTPS 사이트.
 * 공급자 턴만 가짜 Pi 와 직접 MCP 호출로 대신한다(모델 추론 없음).
 *
 * 비밀 값은 정확한 HTTPS 출처에만 입력되므로 사이트는 실행마다 만드는 임시 CA 로 HTTPS 를 연다.
 * 허브의 아이콘 요청은 NODE_EXTRA_CA_CERTS 로, 소유 Chromium 은 시작 옵션 ignoreHTTPSErrors 로
 * 그 인증서를 믿는다(허브 프로세스에만 들어가는 미리 불러오기). 그 밖의 경로는 그대로다.
 *
 * 증거(화면·결과 JSON)는 RHWP_REQUEST_CARDS_EVIDENCE_DIR, 없으면 rhwp/target/request-cards-live.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from '../../rhwp-agent/tests/fake-cli-bin.mjs';
import { ensureChromePath, findAvailablePort, openSample, repoRoot, startHub, stopServer, studioRoot, writeFakePi } from './agent-bench-harness.mjs';

ensureChromePath();
const root = path.resolve(studioRoot, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.tools/owned-browser-chromium');
const evidence = process.env.RHWP_REQUEST_CARDS_EVIDENCE_DIR || path.join(repoRoot, 'target', 'request-cards-live');
const shots = path.join(evidence, 'shots');
fs.mkdirSync(shots, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-request-cards-live-'));
const browserDataDir = path.join(fixtureRoot, 'browser-data');
const keyFile = path.join(fixtureRoot, 'wrapping-key');
fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const hubLogName = 'request-cards-live-hub.log';
const hubLog = path.join(repoRoot, 'target', hubLogName);

// ─── 가짜 Pi: 턴마다 받은 글을 기록하고 finish-turn 파일이 생기면 정착한다 ───
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
const promptLog = path.join(fixtureRoot, 'provider-prompts.jsonl');
writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
  if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
  const fs = require('node:fs');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2), input }) + '\\n'));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(finishTurnPath)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ type: 'agent_settled' }));
  }, 25);
`);
fs.mkdirSync(path.join(fixtureRoot, 'projects'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'projects/settings.json'), JSON.stringify({ librarian: { enabled: false }, agent: { chatMayEdit: false } }));

// ─── 임시 CA 와 HTTPS 사이트 둘(서로 다른 출처) ───
function makeCertificates(dir) {
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Request cards live CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=127.0.0.1');
  fs.writeFileSync(path.join(dir, 'leaf.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext');
  return { ca: path.join(dir, 'ca.pem'), key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: Buffer.concat([fs.readFileSync(path.join(dir, 'leaf.pem')), fs.readFileSync(path.join(dir, 'ca.pem'))]) };
}

/** 32×32 PNG 로고(색 바탕 + 흰 대각선). */
function logoPng([r, g, b]) {
  const size = 32;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const stripe = Math.abs(x - y) < 4 || Math.abs(x + y - size) < 3;
      const corner = (x < 3 || x > size - 4) && (y < 3 || y > size - 4);
      row.set(corner ? [0, 0, 0, 0] : stripe ? [255, 255, 255, 255] : [r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function startKeySite(name, tls, color) {
  const png = logoPng(color);
  const requests = [];
  const server = https.createServer(tls, async (request, response) => {
    const url = new URL(request.url, 'https://fixture.invalid');
    let body = '';
    if (request.method === 'POST') for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: url.pathname, body });
    const html = (content) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(`<!doctype html><html lang="en"><head><title>${name}</title><link rel="icon" type="image/png" href="/icon.png"><style>body{font:18px system-ui;margin:48px;color:#16304a}input,button{font:inherit;margin:8px;padding:10px}</style></head><body>${content}</body></html>`); };
    if (url.pathname === '/favicon.ico' || url.pathname === '/icon.png') { response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }); response.end(png); return; }
    if (url.pathname === '/keys' && request.method === 'POST') {
      const key = new URLSearchParams(body).get('api_key') ?? '';
      // 사이트가 저장한 키를 그대로 다시 보여 주는 경우 — 관찰에서는 가려져야 한다.
      html(`<h1>${name}</h1><p id="saved">Saved key: ${escapeHtml(key)}</p><label>Stored key <input aria-label="Stored key" value="${escapeHtml(key)}"></label>`); return;
    }
    if (url.pathname === '/verify') { html(`<h1>${name} verification</h1><label>Code <input aria-label="Verification code" name="code"></label><button>Verify</button>`); return; }
    html(`<h1>${name}</h1><form action="/keys" method="POST"><label>API key <input type="text" name="api_key" aria-label="API key"></label><button>Save key</button></form>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `https://127.0.0.1:${server.address().port}`, requests, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

const tls = makeCertificates(fixtureRoot);
const siteA = await startKeySite('Key console', tls, [37, 99, 235]);
const siteB = await startKeySite('Other console', tls, [220, 38, 38]);
// 허브 프로세스에서만: 소유 Chromium 이 임시 CA 의 인증서를 받아들이게 한다.
const preload = path.join(fixtureRoot, 'trust-fixture-tls.mjs');
fs.writeFileSync(preload, `import { createRequire } from 'node:module';
if (/server\\.mjs$/.test(process.argv[1] ?? '')) {
  const { chromium } = createRequire(${JSON.stringify(path.join(repoRoot, 'rhwp-agent', 'package.json'))})('playwright');
  const launch = chromium.launchPersistentContext.bind(chromium);
  chromium.launchPersistentContext = (dir, options = {}) => launch(dir, { ...options, ignoreHTTPSErrors: true });
}
`);

const secretValue = `sk-live-${randomBytes(12).toString('hex')}`;
const reconnectValue = `pw-${randomBytes(10).toString('hex')}`;
const valueVariants = (value) => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
const hubPort = await findAvailablePort(5960);
const vitePort = await findAvailablePort(7960);
const token = randomUUID();
const results = { runtime: `http://127.0.0.1:${vitePort}`, hubPort, sites: [siteA.origin, siteB.origin], browser: 'app-owned Chromium (Playwright persistent context)', provider: 'fake Pi turn + direct authenticated MCP calls, no model inference', scenarios: [], errors: [] };
const mcpFrames = [];
const consoleLines = [];
const providers = [];
let hub, vite, browser, page;

async function attachProvider() {
  const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz`, { headers: { authorization: `Bearer ${token}` } })).json();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
  const record = health.sessions.find((row) => row.sessionId === sessionId);
  assert.ok(record, 'Studio session is registered on the real hub');
  const capabilities = await registerHubSession({ port: hubPort, token, launchId: health.launchId, sessionId });
  const socket = new WebSocket(`ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(capabilities.mcp)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`);
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', (event) => {
    mcpFrames.push(String(event.data));
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'tool-result') return;
    const entry = pending.get(frame.id); if (!entry) return;
    pending.delete(frame.id); clearTimeout(entry.timer); entry.resolve(frame);
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Provider connection closed')); } pending.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('MCP connection failed')), { once: true }); });
  const provider = { socket, async call(tool, args = {}) {
    const id = ++sequence;
    const frame = JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, workflow: record.session.workflow, capabilityEpoch: record.session.capabilityEpoch });
    mcpFrames.push(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Tool timed out: ${tool}`)); }, 45_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(frame);
    });
  } };
  providers.push(provider);
  return provider;
}
async function hubSession() {
  const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz`, { headers: { authorization: `Bearer ${token}` } })).json();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
  return health.sessions.find((row) => row.sessionId === sessionId)?.session ?? {};
}
/** 머리줄의 '항상' 스위치를 원하는 범위로 맞춘다. */
async function setScope(page, scope, root = '') {
  const selector = `${root} .ag-request-scope`.trim();
  if (await page.$eval(selector, (node) => node.dataset.scope) !== scope) await page.click(selector);
  assert.equal(await page.$eval(selector, (node) => node.dataset.scope), scope);
}

function must(frame, label) { assert.equal(frame.ok, true, `${label}: ${frame.error?.code} ${frame.error?.message}`); return frame.result; }
const outlineLine = (snapshot, name) => snapshot.outline.split('\n').find((line) => line.includes(`"${name}"`));
function refArgs(snapshot, name) {
  const ref = outlineLine(snapshot, name)?.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref, `snapshot contains ${name}: ${snapshot.outline}`);
  return { tabId: snapshot.tabId, snapshotId: snapshot.snapshotId, ref, navigationEpoch: snapshot.navigationEpoch, controllerEpoch: snapshot.controllerEpoch };
}
async function observe(provider, tabId, extra = {}) { return must(await provider.call('browser_snapshot', { tabId, ...extra }), 'snapshot').snapshot; }
async function human(action, args = {}) { return page.evaluate((name, input) => window.__agentBridge.requestBrowser(name, input), action, args); }
function record(name, details = {}) { results.scenarios.push({ name, status: 'pass', ...details }); console.log(`PASS ${name}`); }
async function eventually(label, read, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}; last state ${JSON.stringify(value)?.slice(0, 2000)}`);
}
const prompts = () => (fs.existsSync(promptLog) ? fs.readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
async function waitIdle(label) {
  await eventually(label, () => page.evaluate(() => window.__agentBridge.isTurnRunning()), (running) => running === false);
}
/** 에이전트가 턴을 끝낸다(요청 뒤 턴 종료 규칙). 다음 턴이 열려 있도록 정착 파일은 곧 지운다. */
async function endTurn(label) {
  fs.writeFileSync(finishTurnPath, '');
  await waitIdle(label);
  fs.rmSync(finishTurnPath, { force: true });
}
/** 사용자가 답한 뒤 허브가 연 이어 가기 턴. */
async function waitContinuation(label, text) {
  const before = prompts().length;
  const entry = await eventually(label, prompts, (rows) => rows.some((row) => row.input.includes(text)));
  await eventually(`${label} turn running`, () => page.evaluate(() => window.__agentBridge.isTurnRunning()), (running) => running === true);
  return { input: entry.find((row) => row.input.includes(text)).input, promptCount: before };
}
const card = (requestId) => `.ag-request-card[data-request-id="${requestId}"]`;
async function setTheme(mode) { await page.evaluate(async (value) => (await import('/src/core/theme.ts')).setThemeMode(value), mode); }
async function shot(name, selector) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const file = path.join(shots, `${name}.png`);
  if (!selector) { await page.screenshot({ path: file }); return file; }
  const element = await page.waitForSelector(selector, { visible: true });
  await element.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const box = await element.boundingBox();
  const pad = 16;
  await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
  return file;
}
async function cardState(requestId) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const mark = node.querySelector('.ag-site-mark');
    return { status: node.dataset.status, settled: node.dataset.settled === 'true', text: node.textContent.trim(),
      logo: mark ? { icon: mark.dataset.icon ?? null, img: mark.querySelector('img')?.getAttribute('src')?.slice(0, 30) ?? null, letter: mark.querySelector('img') ? null : mark.textContent } : null,
      thumb: node.querySelector('.ag-request-thumb-image')?.getAttribute('src')?.slice(0, 30) ?? null,
      chip: node.querySelector('.ag-request-chip')?.textContent ?? null };
  }, card(requestId));
}
async function waitCard(requestId, predicate, label) {
  return eventually(label, () => cardState(requestId), (state) => state !== null && predicate(state));
}
async function openBrowserSettings(tab) {
  await page.evaluate(() => window.__eventBus.emit('settings:open', { destination: 'browser' }));
  await page.waitForSelector('.ag-browser-settings', { visible: true });
  if (tab) await page.locator(`.ag-browser-settings button::-p-text(${tab})`).click();
}
async function closeSettings() {
  const open = () => page.evaluate(() => Boolean(document.querySelector('.ag-root.ag-settings-open')));
  for (const attempt of ['button', 'escape']) {
    if (attempt === 'button') await page.evaluate(() => [...document.querySelectorAll('.ag-settings-close, [aria-label="설정 닫기"]')].find((node) => node.checkVisibility())?.click());
    else await page.keyboard.press('Escape');
    if (await eventually('settings closed', open, (value) => value === false, 4000).then(() => true, () => false)) break;
  }
  assert.equal(await open(), false, 'settings closed');
  await page.waitForSelector('.ag-input', { visible: true });
}
async function leaveFocusMode() {
  if (!await page.evaluate(() => document.querySelector('.ag-root')?.classList.contains('ag-fullscreen'))) return;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.documentElement.classList.contains('ag-fs-vt'));
}
async function studioSurface() {
  return page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('input, textarea')].map((input) => input.value).join('\n');
    const storage = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    return `${document.documentElement.outerHTML}\n${inputs}\n${storage}`;
  });
}
function grepTree(dir, needles) {
  const hits = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      let bytes; try { bytes = fs.readFileSync(full); } catch { continue; }
      for (const needle of needles) {
        if (bytes.includes(Buffer.from(needle)) || bytes.includes(Buffer.from(needle, 'utf16le'))) hits.push({ file: path.relative(dir, full), needle: needle === needles[0] ? 'raw' : needle.slice(0, 6) + '…' });
      }
    }
  };
  walk(dir);
  return hits;
}

try {
  hub = await startHub({ hubPort, token, fixtureRoot, logName: hubLogName, env: {
    RHWP_PI_DIR: piRoot, RHWP_BROWSER_DATA_DIR: browserDataDir, RHWP_BROWSER_WRAPPING_KEY_FILE: keyFile,
    // 사용자의 키체인을 쓰지 않는다: 값은 임시 래핑 키로 암호화한 저장소에 둔다.
    RHWP_BROWSER_OS_KEYRING: '0',
    RHWP_BROWSER_WORKSPACE_TARGETS: JSON.stringify([siteA.origin, siteB.origin]),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NODE_EXTRA_CA_CERTS: tls.ca,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim(),
  } });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`; process.env.RHWP_AGENT_TOKEN = token; process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({ root: studioRoot, configFile: path.join(studioRoot, 'vite.config.ts'), cacheDir: path.join(fixtureRoot, 'vite-cache'), server: { host: '127.0.0.1', port: vitePort, strictPort: true, open: false, fs: { allow: [studioRoot, path.join(root, 'rhwp/pkg'), path.join(root, 'rhwp/samples'), path.join(root, 'rhwp/npm/editor')] } }, logLevel: 'warn' });
  await vite.listen(); process.env.VITE_URL = results.runtime;
  const { launchBrowser, createPage, loadApp, waitForState } = await import('./helpers.mjs');
  browser = await launchBrowser(); page = await createPage(browser, 1440, 1000);
  page.on('pageerror', (error) => results.errors.push(error.message));
  page.on('console', (message) => consoleLines.push(`${message.type()} ${message.text()}`));
  await loadApp(page);
  await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({ defaultAgent: 'pi', defaultModel: 'mock-model', defaultMode: 'chat', defaultEffort: '' })));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForState(page, 'real editor and hub ready', () => Boolean(window.__wasm) && window.__agentBridge?.getConnectionState() === 'connected');
  await setTheme('light');
  for (const site of [siteA, siteB]) {
    await human('policy.update', { operation: 'set-site', origin: site.origin, label: 'Request cards fixture', allowedActions: ['browse', 'read', 'website-change'], blockedActions: [] });
  }
  // 새로고침 뒤 같은 문서를 다시 열 수 있도록 표본 문서에서 채팅한다(같은 바이트는 같은 documentId).
  const sampleName = 'text-align-2.hwp';
  await openSample(page, sampleName);
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true'
    || [...document.querySelectorAll('.ag-root')].some((node) => node.dataset.composerReady === 'true'), { timeout: 20_000 });
  await page.type('.ag-input', 'Save my API key on the key console.'); await page.click('.ag-send');
  await waitForState(page, 'Pi fixture turn running', () => window.__agentBridge.isTurnRunning());

  // ── 1. 비밀 값 저장 ──
  let provider = await attachProvider();
  const tabA = must(await provider.call('browser_open', { url: siteA.origin, intent: 'research' }), 'open key console').tab;
  const statusBefore = must(await provider.call('browser_status'), 'status');
  assert.equal(JSON.stringify(statusBefore).includes('faviconUrl'), false, 'agent status carries no favicon');
  const save = must(await provider.call('request_secret', { label: 'Key console API key', origins: [siteA.origin], kind: 'api-key', reason: 'The key console needs your API key to finish setup.' }), 'request_secret');
  assert.equal(save.pending, true); assert.equal(save.kind, 'secret-save');
  await endTurn('agent ends its turn after request_secret');
  const pendingSave = await waitCard(save.requestId, (state) => state.status === 'pending' && state.logo?.img, 'secret card with site logo');
  assert.match(pendingSave.logo.img, /^data:image\/png;base64,/, 'card header shows the site favicon as a data URI');
  const scope = await page.$eval(`${card(save.requestId)} .ag-request-scope`, (node) => [node.dataset.scope, node.getAttribute('aria-checked')]);
  assert.deepEqual(scope, ['always', 'true'], 'secret save defaults the 항상 switch on');
  await shot('secret-save-pending-light', card(save.requestId));
  await setTheme('dark'); await shot('secret-save-pending-dark', card(save.requestId)); await setTheme('light');
  await page.type(`${card(save.requestId)} .ag-request-secret input`, secretValue);
  await setScope(page, 'always', card(save.requestId));
  await shot('secret-save-typed-light', card(save.requestId));
  await page.click(`${card(save.requestId)} .ag-request-primary`);
  const savedCard = await waitCard(save.requestId, (state) => state.status === 'granted', 'secret card settles');
  assert.ok(savedCard.settled && savedCard.text.includes('완료'));
  assert.equal(await page.$eval(`${card(save.requestId)}`, (node) => node.querySelectorAll('input').length), 0, 'settled card keeps no input');
  await shot('secret-save-granted-light', card(save.requestId));
  await setTheme('dark'); await shot('secret-save-granted-dark', card(save.requestId)); await setTheme('light');
  const resumedSave = await waitContinuation('agent resumes after the secret is saved', 'saved the secret');
  provider = await attachProvider();
  const status = must(await provider.call('browser_status'), 'status after save');
  const listed = status.secrets?.find((secret) => secret.label === 'Key console API key');
  assert.ok(listed && listed.blocked !== true && listed.origins[0] === siteA.origin, `browser_status lists the secret: ${JSON.stringify(status.secrets)}`);
  assert.equal(JSON.stringify(status).includes(secretValue), false);
  assert.equal(JSON.stringify(status).includes('faviconUrl'), false, 'agent status carries no favicon');
  const meta = (await human('secrets.list')).secrets.find((secret) => secret.id === listed.id);
  assert.equal(meta.scope, 'always');
  await openBrowserSettings();
  await page.locator('.ag-browser-account-kinds button::-p-text(비밀 값)').click();
  const settingsRow = await page.waitForSelector(`.ag-browser-account-option[data-secret-id="${listed.id}"]`, { visible: true });
  await page.waitForFunction((id) => document.querySelector(`.ag-browser-account-option[data-secret-id="${id}"] .ag-site-mark img`)?.src.startsWith('data:image/png'), { timeout: 10_000 }, listed.id);
  assert.ok(settingsRow);
  await shot('settings-secrets-light', '.ag-browser-settings');
  await closeSettings();
  record('1. Secret save: card with site logo, 항상, 저장, continuation, browser_status and settings list', {
    requestId: save.requestId, secretId: listed.id, logo: pendingSave.logo.img, continuation: resumedSave.input.split('\n').find((line) => line.includes('saved the secret')),
    statusSecret: listed, meta,
  });

  // ── 2. 비밀 값 사용 ──
  let snapshot = await observe(provider, tabA.tabId);
  const filled = must(await provider.call('browser_fill_secret', { ...refArgs(snapshot, 'API key'), secretId: listed.id }), 'browser_fill_secret');
  snapshot = await observe(provider, tabA.tabId);
  must(await provider.call('browser_click', { ...refArgs(snapshot, 'Save key'), intent: 'research' }), 'submit key form');
  const posted = await eventually('fixture receives the submitted key', () => siteA.requests.filter((row) => row.method === 'POST'), (rows) => rows.length > 0);
  assert.equal(new URLSearchParams(posted[0].body).get('api_key'), secretValue, 'the secret reached the page and the site');
  const afterSubmit = await eventually('result page', () => observe(provider, tabA.tabId), (value) => value.outline.includes('Saved key'));
  const found = must(await provider.call('browser_snapshot', { tabId: tabA.tabId, find: 'Saved key' }), 'find');
  const text = must(await provider.call('browser_snapshot', { tabId: tabA.tabId, text: true }), 'text snapshot');
  const agentView = JSON.stringify({ filled, afterSubmit, found, text });
  for (const variant of valueVariants(secretValue)) assert.equal(agentView.includes(variant), false, 'agent observations mask the secret');
  const usedMeta = (await human('secrets.list')).secrets.find((secret) => secret.id === listed.id);
  assert.ok(usedMeta.lastUsedAt, 'filling records lastUsedAt');
  record('2. Secret use: browser_fill_secret types into the same-origin form; site receives it; agent results stay masked', {
    filledKeys: Object.keys(filled), fixturePost: { path: posted[0].path, received: 'matches stored value' },
    maskedOutline: outlineLine(afterSubmit, 'Stored key') ?? afterSubmit.outline.split('\n').find((line) => line.includes('Saved key')),
  });

  // ── 3. 다른 출처 거절 ──
  const tabB = must(await provider.call('browser_open', { url: siteB.origin, intent: 'research' }), 'open other origin').tab;
  const otherSnapshot = await observe(provider, tabB.tabId);
  const refused = await provider.call('browser_fill_secret', { ...refArgs(otherSnapshot, 'API key'), secretId: listed.id });
  assert.equal(refused.ok, false);
  assert.match(refused.error.code, /ORIGIN/);
  const otherAfter = await observe(provider, tabB.tabId);
  assert.ok(!/\]: \S/.test(outlineLine(otherAfter, 'API key') ?? ''), `other origin field stays empty: ${outlineLine(otherAfter, 'API key')}`);
  assert.equal(siteB.requests.filter((row) => row.method === 'POST').length, 0);
  record('3. Origin refusal on a different HTTPS origin', { code: refused.error.code, message: refused.error.message, field: outlineLine(otherAfter, 'API key') });

  // ── 4. 거절(×) ──
  const second = must(await provider.call('request_secret', { label: 'Second token', origins: [siteA.origin], kind: 'token', reason: 'Another token for the export API.' }), 'second request_secret');
  await endTurn('agent ends its turn after the second request');
  await waitCard(second.requestId, (state) => state.status === 'pending', 'second secret card');
  await page.click(`${card(second.requestId)} .ag-request-close`);
  const denied = await waitCard(second.requestId, (state) => state.status === 'denied', 'denied card collapses');
  assert.ok(denied.settled && denied.text.includes('닫음'), denied.text);
  await shot('secret-save-denied-light', card(second.requestId));
  const declined = await waitContinuation('agent resumes with the decline sentence', 'declined the secret');
  assert.equal((await human('secrets.list')).secrets.some((secret) => secret.label === 'Second token'), false, 'no secret stored after deny');
  record('4. Deny with × collapses to 닫음 and resumes with the decline sentence', { requestId: second.requestId, row: denied.text, continuation: declined.input.split('\n').find((line) => line.includes('declined')) });

  // ── 5. 재연결 ──
  provider = await attachProvider();
  const third = must(await provider.call('request_secret', { label: 'Reconnect password', origins: [siteA.origin], kind: 'password', reason: 'Sign-in password for the console.' }), 'third request_secret');
  await endTurn('agent ends its turn before the reload');
  await waitCard(third.requestId, (state) => state.status === 'pending', 'pending card before reload');
  const sessionBefore = await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId);
  const contextBefore = await hubSession();
  // 5a. 연결만 끊긴다: 같은 페이지가 다시 붙으면 카드는 그대로 대기 중이다.
  await page.evaluate(() => { window.__droppedSocket = window.__agentBridge.ws; window.__agentBridge.ws.close(); });
  await waitForState(page, 'Studio WebSocket reconnected', () => window.__agentBridge.getConnectionState() === 'connected' && window.__agentBridge.ws && window.__agentBridge.ws !== window.__droppedSocket);
  const afterDrop = await waitCard(third.requestId, (state) => state.status === 'pending', 'card still pending after the socket reconnects');
  await shot('secret-save-after-reconnect-light', card(third.requestId));
  // 5b. 페이지 새로고침: 같은 문서를 다시 열면 그 채팅의 카드가 대기 중으로 돌아온다.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForState(page, 'Studio reconnected after reload', () => Boolean(window.__wasm) && window.__agentBridge?.getConnectionState() === 'connected');
  const homeAfterReload = await page.evaluate(() => document.documentElement.classList.contains('document-home-open'));
  if (homeAfterReload) await openSample(page, sampleName);
  const reloaded = await waitCard(third.requestId, (state) => state.status === 'pending', 'card is pending again after reload');
  await shot('secret-save-after-reload-light', card(third.requestId));
  await page.type(`${card(third.requestId)} .ag-request-secret input`, reconnectValue);
  await setScope(page, 'chat', card(third.requestId));
  await page.click(`${card(third.requestId)} .ag-request-primary`);
  await waitCard(third.requestId, (state) => state.status === 'granted', 'reloaded card completes');
  const reconnectMeta = (await human('secrets.list')).secrets.find((secret) => secret.label === 'Reconnect password');
  assert.equal(reconnectMeta?.scope, 'chat');
  await waitContinuation('agent resumes after the reloaded card', 'Reconnect password');
  record('5. Socket reconnect and page reload keep the pending card; it can still be completed', { requestId: third.requestId, afterDrop: afterDrop.status, homeAfterReload, documentBefore: contextBefore.documentId, documentAfter: (await hubSession()).documentId, sessionBefore, sessionAfter: await page.evaluate(() => window.__agentBridge.getHubFontAccess().sessionId), reloaded, scope: reconnectMeta.scope });

  // ── 6. 인증 코드 넘김 ──
  provider = await attachProvider();
  const verify = must(await provider.call('browser_open', { url: `${siteA.origin}/verify`, intent: 'research' }), 'open verify page').tab;
  const code = must(await provider.call('browser_request_account', { tabId: verify.tabId, origin: siteA.origin, label: 'Key console', reason: 'The console asks for a one-time code.', kind: 'code' }), 'request code handoff');
  await endTurn('agent ends its turn after the code request');
  // 작업 공간에 그 탭의 화면이 없으면 칩만 보인다(계약). 직접 입력이 작업 공간을 열면 화면이 붙는다.
  const codeCard = await waitCard(code.requestId, (state) => state.status === 'pending' && state.chip === '에이전트 대기 중', 'code card waiting');
  const browserViewsAtRequest = await page.evaluate(() => ({ floating: [...document.querySelectorAll('.ag-browser-floating')].map((node) => !node.hidden), frames: document.querySelectorAll('.ag-browser-frame[src^="data:image"]').length }));
  await shot('handoff-code-waiting-light', card(code.requestId));
  await page.click(`${card(code.requestId)} .ag-request-actions .ag-request-secondary`);
  await eventually('user takes control', () => human('status'), (value) => value.tabs.find((row) => row.tabId === verify.tabId)?.controller.held === true);
  const holding = await waitCard(code.requestId, (state) => state.chip === '직접 제어 중' && state.thumb, 'chip shows 직접 제어 중 with the live thumbnail');
  assert.match(holding.thumb, /^data:image\//);
  await shot('handoff-code-holding-light', card(code.requestId));
  await page.click(`${card(code.requestId)} .ag-request-primary`);
  await waitCard(code.requestId, (state) => state.status === 'granted', 'code card completes');
  await eventually('completion releases the hold', () => human('status'), (value) => !value.tabs.find((row) => row.tabId === verify.tabId)?.controller.held);
  await shot('handoff-code-granted-light', card(code.requestId));
  await waitContinuation('agent resumes after the code', 'entered the verification code');
  provider = await attachProvider();
  const code2 = must(await provider.call('browser_request_account', { tabId: verify.tabId, origin: siteA.origin, label: 'Key console', reason: 'Another one-time code.', kind: 'code' }), 'second code handoff');
  await endTurn('agent ends its turn after the second code request');
  const waitingWithFrame = await waitCard(code2.requestId, (state) => state.status === 'pending' && state.thumb && state.chip === '에이전트 대기 중', 'second code card shows the live thumbnail while the agent waits');
  await shot('handoff-code-waiting-thumbnail-light', card(code2.requestId));
  await page.click(`${card(code2.requestId)} .ag-request-actions .ag-request-secondary`);
  await eventually('user holds the tab', () => human('status'), (value) => value.tabs.find((row) => row.tabId === verify.tabId)?.controller.held === true);
  // 사람의 클릭(누름과 뗌 사이 150ms)이 실시간 화면 갱신 중에도 단추에 닿는지 본다.
  const churn = await page.evaluate((selector) => new Promise((resolve) => {
    const root = document.querySelector(selector); let renders = 0;
    const observer = new MutationObserver((records) => { if (records.some((entry) => entry.target === root && entry.type === 'childList')) renders++; });
    observer.observe(root, { childList: true });
    setTimeout(() => { observer.disconnect(); resolve({ rendersIn2s: renders }); }, 2000);
  }), card(code2.requestId));
  const closeBox = await (await page.$(`${card(code2.requestId)} .ag-request-close`)).boundingBox();
  await page.mouse.move(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
  await page.mouse.down();
  // 누른 채로 다음 화면 갱신까지 기다린다 — 사람의 클릭 도중 프레임이 오는 경우.
  await page.evaluate((selector) => new Promise((resolve) => {
    const root = document.querySelector(selector);
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(root, { childList: true });
    setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
  }), card(code2.requestId));
  await page.mouse.up();
  const humanClick = await eventually('slow human click on ×', () => cardState(code2.requestId), (state) => state.status !== 'pending', 3000).then(() => 'landed', () => 'lost');
  results.handoffRerender = { ...churn, humanClick };
  assert.equal(humanClick, 'landed', `× click must survive live thumbnail updates (${churn.rendersIn2s} card rebuilds in 2 s)`);
  console.log(`PASS × click survives a live thumbnail update (${churn.rendersIn2s} card rebuilds in 2 s)`);
  await waitCard(code2.requestId, (state) => state.status === 'denied', 'second code card closes');
  await eventually('× releases the hold', () => human('status'), (value) => !value.tabs.find((row) => row.tabId === verify.tabId)?.controller.held);
  await waitContinuation('agent resumes after the declined handoff', 'declined the browser handoff');
  record('6. Code handoff: thumbnail, 직접 입력 takes control, 완료 resumes, × releases the hold', { requestId: code.requestId, firstCardThumb: codeCard.thumb, browserViewsAtRequest, holdingThumb: holding.thumb, chips: [codeCard.chip, holding.chip, waitingWithFrame.chip], waitingThumb: waitingWithFrame.thumb, secondRequestId: code2.requestId });

  // ── 7. 항상 허용 ──
  await leaveFocusMode();
  provider = await attachProvider();
  const permission = must(await provider.call('request_permission', { capability: 'local-execution', reason: 'Run the converter script.' }), 'request_permission');
  await endTurn('agent ends its turn after request_permission');
  await waitCard(permission.requestId, (state) => state.status === 'pending', 'permission card');
  await setScope(page, 'always', card(permission.requestId));
  await shot('permission-pending-always-light', card(permission.requestId));
  await page.click(`${card(permission.requestId)} .ag-request-primary`);
  await waitCard(permission.requestId, (state) => state.status === 'granted', 'permission granted');
  assert.deepEqual((await human('permissions.list')).always, ['local-execution']);
  await waitContinuation('agent resumes after the grant', 'granted local-execution');
  fs.writeFileSync(finishTurnPath, ''); await waitIdle('continuation ends'); fs.rmSync(finishTurnPath, { force: true });
  await openBrowserSettings('권한');
  await page.waitForFunction(() => document.querySelector('.ag-browser-settings-body')?.textContent?.includes('항상 허용한 권한'), { timeout: 10_000 });
  await shot('settings-always-permissions-light', '.ag-browser-settings');
  await closeSettings();
  const oldThread = (await hubSession()).threadId;
  await page.click('button[aria-label="채팅 목록"]');
  await page.click('.ag-threads-new');
  await page.type('.ag-input', 'Start a fresh chat.'); await page.click('.ag-send');
  await waitForState(page, 'fresh chat turn running', () => window.__agentBridge.isTurnRunning());
  const fresh = await eventually('new chat starts with the always grant', hubSession, (value) => value.threadId && value.threadId !== oldThread && value.chatPermissionGrants?.includes('local-execution'));
  const freshStudioGrants = await page.evaluate(() => window.__agentBridge.getChatPermissionGrants());
  await endTurn('fresh chat turn ends');
  await openBrowserSettings('권한');
  await page.waitForFunction(() => document.querySelector('.ag-browser-settings-body')?.textContent?.includes('항상 허용한 권한'));
  await page.locator('.ag-browser-settings-body button::-p-text(해제)').click();
  await eventually('해제 removes the always grant', () => human('permissions.list'), (value) => value.always.length === 0);
  await page.waitForFunction(() => !document.querySelector('.ag-browser-settings-body')?.textContent?.includes('항상 허용한 권한'), { timeout: 10_000 });
  await closeSettings();
  record('7. Always grant: listed in settings, new chat starts with it, 해제 removes it', { requestId: permission.requestId, newThread: fresh.threadId, hubGrants: fresh.chatPermissionGrants, studioGrants: freshStudioGrants });

  // ── 누출 검사 ──
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const needles = valueVariants(secretValue).concat(valueVariants(reconnectValue));
  const surface = await studioSurface();
  const leaks = {
    mcpTraffic: needles.filter((needle) => mcpFrames.some((frame) => frame.includes(needle))).length,
    providerPrompts: needles.filter((needle) => fs.existsSync(promptLog) && fs.readFileSync(promptLog, 'utf8').includes(needle)).length,
    studioDom: needles.filter((needle) => surface.includes(needle)).length,
    studioConsole: needles.filter((needle) => consoleLines.some((line) => line.includes(needle))).length,
    hubLog: needles.filter((needle) => fs.readFileSync(hubLog, 'utf8').includes(needle)).length,
    files: grepTree(fixtureRoot, valueVariants(secretValue)).concat(grepTree(fixtureRoot, valueVariants(reconnectValue))),
  };
  results.leaks = leaks;
  results.status = Object.entries(leaks).every(([, value]) => (Array.isArray(value) ? value.length === 0 : value === 0)) ? 'passed' : 'leaks-found';
  console.log(JSON.stringify(leaks, null, 2));
  if (results.status !== 'passed') process.exitCode = 1;
  assert.deepEqual(results.errors, [], 'no uncaught Studio runtime errors');
} catch (error) {
  results.failure = { message: error.message, stack: error.stack };
  if (page) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  console.error(error.stack); process.exitCode = 1;
} finally {
  results.fixtureRequests = { a: siteA.requests.map(({ body, ...row }) => ({ ...row, bodyBytes: body.length })), b: siteB.requests.map(({ body, ...row }) => ({ ...row, bodyBytes: body.length })) };
  if (fs.existsSync(promptLog)) fs.writeFileSync(path.join(evidence, 'provider-prompts.txt'), prompts().map((row) => row.input).join('\n----\n'));
  fs.writeFileSync(path.join(evidence, 'studio-console.log'), consoleLines.join('\n'));
  for (const provider of providers) provider.socket.close();
  await browser?.close(); await vite?.close(); await stopServer(hub); await siteA.close(); await siteB.close();
  // 소유 Chromium 과 허브가 끝나며 디스크에 쓴 것까지 다시 찾는다.
  results.filesAfterShutdown = grepTree(fixtureRoot, valueVariants(secretValue)).concat(grepTree(fixtureRoot, valueVariants(reconnectValue)));
  if (results.filesAfterShutdown.length) { results.status = 'leaks-found'; process.exitCode = 1; }
  if (fs.existsSync(hubLog)) fs.copyFileSync(hubLog, path.join(evidence, 'hub.log'));
  fs.writeFileSync(path.join(evidence, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (process.env.RHWP_REQUEST_CARDS_KEEP_DATA) console.log(`kept ${fixtureRoot}`);
  if (!process.env.RHWP_REQUEST_CARDS_KEEP_DATA) fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
