import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v3';
import { TOOL_DEFINITIONS } from '../tools.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const actor = { threadId: 'contract-chat', agentId: 'contract-agent' };
const call = (browser, name, input) => browser.request(actor, name.slice('browser_'.length).replaceAll('_', '-'), z.object(TOOL_DEFINITIONS.find(tool => tool.name === name).shape).parse(input));
const refOf = (snapshot, name) => snapshot.outline.split('\n').find(line => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
const target = (observation, name) => ({ tabId: observation.snapshot.tabId, snapshotId: observation.snapshot.snapshotId, navigationEpoch: observation.snapshot.navigationEpoch, controllerEpoch: observation.snapshot.controllerEpoch, ref: refOf(observation.snapshot, name) });
const refs = observation => target(observation, 'Query');
async function fixture(t, pages = {}, options = {}) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-contracts-'));
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('streaming'); return; }
    if (request.url === '/slow') { setTimeout(() => response.end('fetched'), 300); return; }
    response.setHeader('content-type', 'text/html');
    if (pages[request.url]) { response.end(pages[request.url]); return; }
    response.end('<!doctype html><form onsubmit="event.preventDefault();submissions++;trusted=event.isTrusted"><label>Query<input name="query"></label><button>Ready search</button></form><button id="delayed" style="display:none">Delayed action</button><p id="result" hidden>Loaded result</p><script>window.submissions=0;window.trusted=false;fetch("/stream");setTimeout(()=>{document.querySelector("#delayed").style.display="block";document.querySelector("#result").hidden=false},300)</script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let runtime;
  const browser = createOwnedBrowserService({ dataDir, policy: { assertAllowed: async () => {} }, workspaceTargets: [origin], autoInstall: false, runtimeFactory: async options => runtime = await startOwnedBrowserRuntime(options), ...options });
  t.after(async () => { await browser.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const opened = await call(browser, 'browser_open', { url: pages.start ? `${origin}${pages.start}` : origin });
  return { browser, origin, tabId: opened.tab.tabId, page: runtime.context.pages().find(page => page.url().startsWith(origin)) };
}

test('public browser_type submit fills then submits once with a trusted Enter', async t => {
  const f = await fixture(t); if (!f) return;
  let observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await call(f.browser, 'browser_type', { ...refs(observed), text: 'first draft' });
  assert.equal(await f.page.evaluate(() => submissions), 0);
  observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await call(f.browser, 'browser_type', { ...refs(observed), text: 'submitted research', submit: true, intent: 'search' });
  assert.deepEqual(await f.page.evaluate(() => ({ submissions, trusted, text: document.querySelector('input').value })), { submissions: 1, trusted: true, text: 'submitted research' });
});

test('public browser_wait conditions poll visible text, bound timeouts and return fresh actionable refs', async t => {
  const f = await fixture(t); if (!f) return;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  const ready = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 2000 });
  assert.notEqual(ready.snapshot.snapshotId, observed.snapshot.snapshotId);
  const visible = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'visible', text: 'Delayed action', timeoutMs: 2000 });
  assert.ok(refOf(visible.snapshot, 'Delayed action'));
  const text = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 2000, find: 'Loaded' });
  assert.equal(text.snapshot.outline, '- paragraph: Loaded result');
  const start = Date.now();
  const idle = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'idle', timeoutMs: 2000 });
  assert.ok(Date.now() - start >= 500);
  assert.equal(idle.completed, true);
  assert.ok(idle.snapshot.snapshotId);
  await call(f.browser, 'browser_type', { ...refs({ snapshot: idle.snapshot }), text: 'fresh wait reference' });
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text' }), { code: 'BROWSER_WAIT_TEXT_REQUIRED' });
  const timed = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'never appears', timeoutMs: 70 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - timed < 2000);
});

test('wait budget includes queued actions and late reads do not replace a newer snapshot', async t => {
  const f = await fixture(t); if (!f) return;
  const idle = call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'idle', timeoutMs: 2000 });
  const queuedStart = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 40 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - queuedStart < 300);
  await idle;
  const observe = f.page.ariaSnapshotJSON.bind(f.page);
  let delayed = false;
  f.page.ariaSnapshotJSON = async (...options) => {
    if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 300)); }
    return observe(...options);
  };
  const start = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 60 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - start < 300);
  const current = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 350));
  await call(f.browser, 'browser_type', { ...refs(current), text: 'current snapshot survives' });
});

test('compact snapshots give every visible control a ref, cap long pages and narrow with find or scope', async t => {
  const controls = '<h1>Controls</h1><nav aria-label="Primary"><a href="/a">Docs link</a><a href="/b">Blog link</a></nav><button>Plain button</button><label>Query box<input></label><textarea aria-label="Notes area"></textarea><label>Size<select><option>Small</option><option>Large</option></select></label><label><input type="checkbox">Remember me</label><label><input type="radio" name="r">Pick one</label><details><summary>More details</summary>Body</details><div contenteditable="true" aria-label="Rich editor">Draft</div><div role="button" tabindex="0">Role button</div><span role="tab">First tab</span><button style="display:none">Hidden button</button>';
  const long = `<ul>${Array.from({ length: 2000 }, (_, index) => `<li><a href="/r${index}">Result ${index}</a></li>`).join('')}</ul>`;
  const f = await fixture(t, { start: '/controls', '/controls': controls, '/long': long }); if (!f) return;
  const { snapshot } = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  for (const name of ['Docs link', 'Plain button', 'Query box', 'Notes area', 'Size', 'Remember me', 'Pick one', 'More details', 'Rich editor', 'Role button', 'First tab']) assert.ok(refOf(snapshot, name), name);
  assert.equal(snapshot.outline.includes('Hidden button'), false);
  assert.equal(snapshot.truncated, undefined);
  const scoped = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, scope: refOf(snapshot, 'Primary') });
  assert.deepEqual(scoped.snapshot.outline.split('\n').map(line => line.replace(/ \[ref=[^\]]+\]/, '')), ['- navigation "Primary"', '  - link "Docs link"', '  - link "Blog link"']);
  await assert.rejects(call(f.browser, 'browser_snapshot', { tabId: f.tabId, scope: 'e99999' }), { code: 'BROWSER_REFERENCE_NOT_FOUND' });
  await call(f.browser, 'browser_navigate', { tabId: f.tabId, url: `${f.origin}/long`, navigationEpoch: scoped.snapshot.navigationEpoch, controllerEpoch: scoped.snapshot.controllerEpoch });
  const full = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  assert.ok(Buffer.byteLength(full.snapshot.outline) <= 20_000);
  assert.equal(full.snapshot.truncated, true);
  assert.match(full.snapshot.hint, /scope|find/);
  assert.equal(full.snapshot.outline.includes('Result 1999'), false);
  const found = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'result 1999' });
  assert.equal(found.snapshot.matches, 1);
  assert.ok(found.snapshot.outline.split('\n').length <= 2);
  await call(f.browser, 'browser_click', target(found, 'Result 1999'));
  assert.equal(new URL(f.page.url()).pathname, '/r1999');
});

test('browser_upload sets only hub-resolved files after site access and never on a held tab', async t => {
  const page = '<label>Single<input type="file" name="single"></label><label>Many<input type="file" name="many" multiple></label><button onclick="document.querySelector(\'#hidden\').click()">Attach</button><input id="hidden" name="hidden" type="file" hidden><script>window.got={};for(const i of document.querySelectorAll("input"))i.addEventListener("change",()=>got[i.name]=[...i.files].map(f=>f.name+":"+f.size))</script>';
  let siteAccess = false; const events = [];
  const policy = { check: async ({ action, url }) => action === 'website-change' && !siteAccess ? { allowed: false, code: 'BROWSER_PERMISSION_REQUIRED', reason: action, site: new URL(url).origin, origin: new URL(url).origin } : { allowed: true } };
  const f = await fixture(t, { start: '/upload', '/upload': page }, { policy, onEvent: event => events.push(event) }); if (!f) return;
  const file = (name, body) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
  const upload = async (name, files) => { const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId }); return f.browser.uploadFiles(actor, target(observed, name), files); };
  const got = () => f.page.evaluate(() => window.got);
  await assert.rejects(upload('Single', [file('a.txt', 'aaa')]), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.deepEqual(await got(), {});
  siteAccess = true;
  // 모델 인자만으로는 파일을 넣지 못한다. 허브가 읽은 파일이 있어야 한다.
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await assert.rejects(call(f.browser, 'browser_upload', { ...target(observed, 'Single'), files: [{ artifactId: 'model-chosen' }] }), { code: 'BROWSER_UPLOAD_INVALID' });
  await assert.rejects(upload('Single', [file('a.txt', 'a'), file('b.txt', 'b')]), { code: 'BROWSER_UPLOAD_LIMIT' });
  const single = await upload('Single', [file('a.txt', 'aaa')]);
  assert.deepEqual(single.files, [{ name: 'a.txt', size: 3 }]);
  await upload('Many', [file('b.txt', 'bb'), file('c.txt', 'c')]);
  await upload('Attach', [file('d.txt', 'dddd')]);
  assert.deepEqual(await got(), { single: ['a.txt:3'], many: ['b.txt:2', 'c.txt:1'], hidden: ['d.txt:4'] });
  assert.equal(events.some(event => event.type === 'owned_browser_file_chooser'), false);
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const held = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await f.browser.request(human, 'control', { tabId: f.tabId, owner: 'human', navigationEpoch: held.snapshot.navigationEpoch, controllerEpoch: held.snapshot.controllerEpoch });
  await assert.rejects(f.browser.uploadFiles(actor, { ...target(held, 'Single'), controllerEpoch: held.snapshot.controllerEpoch + 1 }, [file('e.txt', 'e')]), { code: 'BROWSER_USER_CONTROL' });
});

test('actions settle and return only what changed: navigation, new tabs and dialogs', async t => {
  const actions = '<title>Actions</title><a href="/next">Go next</a><a href="/next" target="_blank">Open popup</a><button onclick="alert(\'Required field\')">Alert me</button><button onclick="fetch(\'/slow\').then(r=>r.text()).then(t=>{document.querySelector(\'#out\').textContent=\'Loaded \'+t})">Fetch data</button><p id="out">Idle</p>';
  const f = await fixture(t, { start: '/actions', '/actions': actions, '/next': '<title>Next page</title><h1>Arrived</h1>' }); if (!f) return;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  // 요청이 끝날 때까지 기다리므로 별도 browser_wait 없이 결과가 개요에 보인다.
  const fetched = await call(f.browser, 'browser_click', { ...target(observed, 'Fetch data'), snapshot: true });
  assert.deepEqual(Object.keys(fetched).sort(), ['action', 'navigated', 'ok', 'snapshot', 'title', 'url']);
  assert.equal(fetched.navigated, false);
  assert.match(fetched.snapshot.outline, /Loaded fetched/);
  const alerted = await call(f.browser, 'browser_click', target(fetched, 'Alert me'));
  assert.deepEqual(alerted.dialog, { type: 'alert', message: 'Required field' });
  const popup = await call(f.browser, 'browser_click', target(fetched, 'Open popup'));
  assert.equal(popup.navigated, false);
  assert.ok(popup.newTab?.tabId);
  assert.notEqual(popup.newTab.tabId, f.tabId);
  const moved = await call(f.browser, 'browser_click', target(fetched, 'Go next'));
  assert.equal(moved.navigated, true);
  assert.equal(moved.url, `${f.origin}/next`);
  assert.equal(moved.title, 'Next page');
  assert.ok(moved.navigationEpoch > fetched.snapshot.navigationEpoch);
  await assert.rejects(call(f.browser, 'browser_click', target(fetched, 'Go next')), { code: 'BROWSER_STALE_NAVIGATION' });
});

test('browser_fill_form chooses enabled native options by label or value', async t => {
  const form = '<label>Size<select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l" disabled>Large</option></select></label><button>Not a list</button>';
  const f = await fixture(t, { start: '/form', '/form': form }); if (!f) return;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  const { ref: _ref, ...identity } = target(observed, 'Size');
  const choose = (name, value) => call(f.browser, 'browser_fill_form', { ...identity, fields: [{ ref: refOf(observed.snapshot, name), value }] });
  assert.equal((await choose('Size', 'Medium')).fields[0].ok, true);
  assert.equal(await f.page.$eval('#size', el => el.value), 'm');
  await choose('Size', 's');
  assert.equal(await f.page.$eval('#size', el => el.value), 's');
  assert.equal((await choose('Size', 'Large')).fields[0].error.code, 'BROWSER_OPTION_NOT_FOUND');
  assert.equal((await choose('Not a list', 'Small')).fields[0].error.code, 'BROWSER_NOT_EDITABLE');
  const after = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, scope: refOf(observed.snapshot, 'Size') });
  assert.match(after.snapshot.outline, /combobox "Size" \[ref=[^\]]+\]: Small/);
});

test('private field values never reach snapshot, find or text output', async t => {
  const login = '<label>Email<input type="email" value="person@example.com"></label><label>Password<input id="secret" type="password" value="pw-secret-123"></label><label>Code<input autocomplete="one-time-code" value="928374"></label><p>Echo pw-secret-123</p><label>Query<input value="public words"></label>';
  const f = await fixture(t, { start: '/login', '/login': login }); if (!f) return;
  // 값을 미리 읽은 뒤 페이지가 바꾼 비밀번호도 요소 기준으로 가려진다.
  const observe = f.page.ariaSnapshotJSON.bind(f.page);
  f.page.ariaSnapshotJSON = async (...options) => { await f.page.evaluate(() => { document.querySelector('#secret').value = 'late-secret-value'; }); return observe(...options); };
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, text: true });
  f.page.ariaSnapshotJSON = observe;
  const found = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'pw-secret' });
  const serialized = JSON.stringify([observed, found]);
  for (const secret of ['person@example.com', 'pw-secret-123', '928374', 'late-secret-value']) assert.equal(serialized.includes(secret), false, secret);
  assert.match(observed.snapshot.outline, /textbox "Password" \[ref=[^\]]+\]: \[masked\]/);
  assert.match(observed.snapshot.outline, /textbox "Query" \[ref=[^\]]+\]: public words/);
  assert.match(observed.snapshot.text, /Echo \[masked\]/);
  assert.equal(found.snapshot.matches, 0);
});
