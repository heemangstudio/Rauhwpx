import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v3';
import { TOOL_DEFINITIONS } from '../tools.mjs';
import { createOwnedBrowserService, OwnedBrowserError } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';

const actor = { threadId: 'contract-chat', agentId: 'contract-agent' };
const call = (browser, name, input) => browser.request(actor, name.slice('browser_'.length), z.object(TOOL_DEFINITIONS.find(tool => tool.name === name).shape).parse(input));
const refs = observation => ({ tabId: observation.tab.tabId, snapshotId: observation.snapshot.snapshotId, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch, ref: observation.snapshot.elements.find(element => element.name === 'Query').ref });
async function fixture(t, { policy } = {}) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-contracts-'));
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('streaming'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><form onsubmit="event.preventDefault();submissions++;trusted=event.isTrusted"><label>Query<input name="query"></label><button>Ready search</button></form><button id="delayed" style="display:none">Delayed action</button><p id="result" hidden>Loaded result</p><script>window.submissions=0;window.trusted=false;fetch("/stream");setTimeout(()=>{document.querySelector("#delayed").style.display="block";document.querySelector("#result").hidden=false},300)</script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let runtime;
  const browser = createOwnedBrowserService({ dataDir, policy: policy ?? { assertAllowed: async () => {} }, workspaceTargets: [origin], autoInstall: false, runtimeFactory: async options => runtime = await startOwnedBrowserRuntime(options) });
  t.after(async () => { await browser.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const opened = await call(browser, 'browser_open', { url: origin });
  return { browser, tabId: opened.tab.tabId, page: runtime.context.pages().find(page => page.url().startsWith(origin)) };
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
  assert.ok(visible.snapshot.elements.some(element => element.name === 'Delayed action'));
  const text = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 2000 });
  assert.ok(text.snapshot.text.includes('Loaded result'));
  const start = Date.now();
  const idle = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'idle', timeoutMs: 2000 });
  assert.ok(Date.now() - start >= 500);
  assert.equal(idle.completed, true);
  assert.ok(idle.snapshot.snapshotId);
  await call(f.browser, 'browser_type', { ...refs({ tab: ready.tab, snapshot: idle.snapshot }), text: 'fresh wait reference' });
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
  const frame = f.page.mainFrame();
  const evaluateHandle = frame.evaluateHandle.bind(frame);
  let delayed = false;
  frame.evaluateHandle = async (...args) => {
    if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 300)); }
    return evaluateHandle(...args);
  };
  const start = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 60 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - start < 300);
  const current = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 350));
  await call(f.browser, 'browser_type', { ...refs(current), text: 'current snapshot survives' });
});

// Public HTTPS sites served in-process. The service's own route handler still runs its guard and
// policy checks first; only the final network continuation is answered locally.
async function publicSites(t, sites, { broker = false } = {}) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-public-'));
  const policy = createBrowserPolicy({ dataDir });
  const credentialBroker = broker ? createBrowserCredentialBroker({ dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 6) }) : undefined;
  const requests = [];
  let runtime;
  const browser = createOwnedBrowserService({ dataDir, policy, credentialBroker, autoInstall: false, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    runtimeFactory: async options => {
      runtime = await startOwnedBrowserRuntime(options);
      const route = runtime.context.route.bind(runtime.context);
      runtime.context.route = (pattern, handler) => route(pattern, original => handler(new Proxy(original, { get(target, key) {
        if (key !== 'continue') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
        return async () => {
          const request = target.request(), url = new URL(request.url());
          requests.push({ method: request.method(), url: url.href });
          const site = sites[url.origin];
          const page = typeof site === 'function' ? site(url, request) : site?.[url.pathname];
          if (page === undefined) { await target.fulfill({ status: 404, body: '' }); return; }
          const response = typeof page === 'string' ? { body: page } : page;
          await target.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', ...response });
        };
      } })));
      return runtime;
    } });
  t.after(async () => { await browser.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { browser, policy, credentialBroker, requests, context: () => runtime.context };
}
const by = (observation, name) => observation.snapshot.elements.find(element => element.name === name || element.text === name);
const refArgs = (result, element) => ({ tabId: result.tab.tabId, snapshotId: result.snapshot.snapshotId, ref: element.ref, navigationEpoch: result.tab.navigationEpoch, controllerEpoch: result.tab.controllerEpoch });
const LAW = 'https://law.example';

test('public GET search forms work on any public site while POST, private and mutating forms stay gated', async t => {
  let deletes = 0;
  const f = await publicSites(t, { [LAW]: (url) => {
    if (url.pathname === '/search') return `<h1>Results for ${url.searchParams.get('q')}</h1>`;
    if (/delete|remove/.test(url.href)) { deletes++; return 'deleted'; }
    return `<form action="/search" id="main"><input name="q" aria-label="Statute query"><input type="hidden" name="lang" value="ko"><button>Search</button></form>
      <input name="year" form="main" aria-label="Year" value="2026">
      <form method="post" action="/comments"><input name="body" aria-label="Comment"><button>Post comment</button></form>
      <form action="/login"><input name="id" aria-label="Login id"><input type="password" name="pw"><button>Sign in</button></form>
      <form action="/items/42/delete"><input name="why" aria-label="Delete reason"><button>Delete item</button></form>
      <form action="/search"><input type="hidden" name="action" value="remove"><input name="q" aria-label="Hidden verb query"><button>Find</button></form>
      <form action="/search"><input name="q" aria-label="Scripted query"><button type="button" onclick="fetch('/remove')">Run script</button></form>`;
  } });
  if (!f) return;
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  assert.ok(opened.snapshot, 'open returns its first snapshot');
  const query = by(opened, 'Statute query');
  assert.deepEqual([query.inputType, query.formMethod, query.formAction], ['text', 'get', `${LAW}/search`]);
  assert.equal(by(opened, 'Year').formAction, `${LAW}/search`, 'form-associated controls carry their form');
  const searched = await call(f.browser, 'browser_type', { ...refArgs(opened, query), text: '민법 750조', submit: true, intent: 'search' });
  assert.match(searched.snapshot.text, /Results for 민법 750조/);
  assert.ok(f.requests.some(entry => entry.url === `${LAW}/search?q=%EB%AF%BC%EB%B2%95+750%EC%A1%B0&lang=ko&year=2026`));
  for (const [name, action, extra] of [['Comment', 'browser_type', { text: 'spam' }], ['Post comment', 'browser_click', {}], ['Login id', 'browser_type', { text: 'me' }],
    ['Delete reason', 'browser_type', { text: 'x', submit: true }], ['Hidden verb query', 'browser_type', { text: 'x', submit: true }], ['Run script', 'browser_click', {}]]) {
    const page = await call(f.browser, 'browser_navigate', { tabId: opened.tab.tabId, url: LAW, navigationEpoch: (await f.browser.inventory(actor)).tabs[0].navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
    await assert.rejects(call(f.browser, action, { ...refArgs(page, by(page, name)), ...extra }), { code: 'BROWSER_PERMISSION_REQUIRED' }, name);
  }
  assert.equal(deletes, 0);
  assert.equal(f.requests.filter(entry => entry.method !== 'GET').length, 0);
});

test('action results carry a settled snapshot, opened popups within the tab limit and dismissed dialogs', async t => {
  const f = await publicSites(t, { [LAW]: {
    '/': `<a href="/next">Next page</a><a href="/next" target="_blank">New tab</a><a href="#" onclick="for (let i = 0; i < 4; i++) window.open('/popup?' + i); return false">Many tabs</a>
      <a href="#" onclick="alert('Saved draft discarded'); return false">Warn</a>`,
    '/covered': `<a href="#" onclick="document.title='clicked'; return false">Covered target</a><div style="position:fixed;inset:0;background:#fff8" aria-label="Cookie banner"></div>`,
    '/next': '<h1>Second page</h1><a href="/">Back home</a>', '/popup': '<a href="#" onclick="window.open(\'/popup\'); return false">Nested</a>',
  } });
  if (!f) return;
  const covered = await call(f.browser, 'browser_open', { url: `${LAW}/covered` });
  // A covered target fails before any input reaches the page.
  await assert.rejects(call(f.browser, 'browser_click', refArgs(covered, by(covered, 'Covered target'))), (failure) => failure.code === 'BROWSER_TARGET_COVERED' && /Cookie banner/.test(failure.message) && !!failure.hint);
  assert.notEqual(await f.context().pages().find(page => page.url().endsWith('/covered')).title(), 'clicked');
  await call(f.browser, 'browser_close', { tabId: covered.tab.tabId, navigationEpoch: covered.tab.navigationEpoch, controllerEpoch: covered.tab.controllerEpoch });
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  const current = opened;
  const warned = await call(f.browser, 'browser_click', refArgs(current, by(current, 'Warn')));
  assert.deepEqual(warned.dialogs, [{ type: 'alert', message: 'Saved draft discarded', dismissed: true }]);
  const next = await call(f.browser, 'browser_click', refArgs(warned, by(warned, 'Next page')));
  assert.match(next.snapshot.text, /Second page/);
  assert.equal(next.snapshot.navigationEpoch, next.tab.navigationEpoch);
  const back = await call(f.browser, 'browser_click', refArgs(next, by(next, 'Back home')));
  assert.equal(back.ok, true, 'refs from one action result drive the next action without a stale navigation');
  const quiet = await call(f.browser, 'browser_scroll', { tabId: back.tab.tabId, deltaY: 100, navigationEpoch: back.tab.navigationEpoch, controllerEpoch: back.tab.controllerEpoch, snapshot: false });
  assert.equal(quiet.snapshot, undefined);
  const popup = await call(f.browser, 'browser_click', refArgs(back, by(back, 'New tab')));
  assert.equal(popup.popups.length, 1);
  assert.equal(popup.popups[0].openerTabId, opened.tab.tabId);
  const many = await call(f.browser, 'browser_click', refArgs(popup, by(popup, 'Many tabs')));
  assert.equal(many.popups.length, 1);
  assert.ok(many.popupsBlocked.count >= 3);
  assert.equal((await f.browser.inventory(actor)).tabs.length, 3);
  assert.equal((await f.browser.inventory({ threadId: 'other-chat', agentId: 'other-agent' })).tabs.length, 0);
  const nested = await f.browser.request(actor, 'snapshot', { tabId: many.popups[0].tabId });
  const nestedTab = (await f.browser.inventory(actor)).tabs.find(tab => tab.tabId === many.popups[0].tabId);
  const blocked = await call(f.browser, 'browser_click', refArgs({ tab: nestedTab, snapshot: nested.snapshot }, by(nested, 'Nested')));
  assert.equal(blocked.popupsBlocked.count, 1, 'nested popups count against the same agent');
  assert.equal((await f.browser.inventory(actor)).tabs.length, 3);
});

test('snapshots read same-origin frames, cap after visibility and keep cross-origin frames out', async t => {
  const clipped = Array.from({ length: 45 }, (_, i) => `<a href="#" style="position:absolute;top:${200 + i * 6}px;left:0">Clipped frame ${i}</a>`).join('');
  const hidden = Array.from({ length: 450 }, (_, index) => `<button style="display:none">Hidden ${index}</button>`).join('');
  const f = await publicSites(t, {
    [LAW]: { '/': `${hidden}<iframe src="/statute" style="width:600px;height:100px"></iframe><iframe src="https://ads.example/" style="width:300px;height:100px"></iframe>
      <label><input type="checkbox" checked> Include repealed</label><a href="/doc?id=7">Document link</a><div style="height:3000px"></div><button>Far button</button>`,
      '/statute': `${clipped}<p>제750조 불법행위의 내용</p><button>Frame action</button>` },
    'https://ads.example': { '/': '<p>Third party ad text</p><button>Ad button</button>' },
  });
  if (!f) return;
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  const snapshot = (await call(f.browser, 'browser_snapshot', { tabId: opened.tab.tabId })).snapshot;
  assert.match(snapshot.text, /제750조/);
  assert.doesNotMatch(JSON.stringify(snapshot), /Third party ad|Ad button/);
  const frameAction = snapshot.elements.find(element => element.name === 'Frame action');
  assert.ok(frameAction.rect.y > 0 && frameAction.inViewport);
  const outsideFrame = snapshot.elements.filter(element => element.name.startsWith('Clipped frame '));
  assert.equal(outsideFrame.length, 45, 'full snapshots retain controls outside the frame viewport');
  assert.ok(outsideFrame.every(element => !element.inViewport && element.ref), 'clipped controls keep refs without being marked in the viewport');
  assert.equal(snapshot.elements.find(element => element.name === 'Far button').inViewport, false);
  const box = snapshot.elements.find(element => element.inputType === 'checkbox');
  assert.deepEqual([box.role, box.checked], ['checkbox', true]);
  assert.equal(snapshot.elements.find(element => element.name === 'Document link').href, `${LAW}/doc?id=7`);
  assert.equal(snapshot.truncated, false, 'hidden controls do not consume the element cap');
  const clicked = await f.browser.request(actor, 'click', { tabId: opened.tab.tabId, snapshotId: snapshot.snapshotId, ref: frameAction.ref, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch, intent: 'website-change' }).catch(failure => failure);
  assert.equal(clicked.code, 'BROWSER_PERMISSION_REQUIRED', 'frame refs resolve to real handles and keep the website-change gate');
});

test('human-check interstitials are reported while ordinary CAPTCHA scripts are not', async t => {
  const f = await publicSites(t, {
    'https://cf.example': { '/': '<title>Just a moment...</title><script>window._cf_chl_opt={}</script><p>Checking your browser</p>' },
    'https://captcha.example': { '/': '<p>Please verify you are human</p><iframe src="https://www.google.com/recaptcha/api2/anchor?k=1" style="width:304px;height:78px"></iframe>' },
    'https://shop.example': { '/': '<script src="https://www.google.com/recaptcha/api.js"></script><form><input aria-label="Email"><button>Subscribe</button></form><p>Ordinary shop page</p>' },
  });
  if (!f) return;
  for (const [url, provider] of [['https://cf.example/', 'cloudflare'], ['https://captcha.example/', 'captcha']]) {
    const blocked = await call(f.browser, 'browser_open', { url });
    assert.deepEqual([blocked.ok, blocked.code, blocked.provider], [false, 'BROWSER_CHALLENGE_REQUIRED', provider]);
    assert.equal(blocked.tab.status, 'challenge-required');
    await call(f.browser, 'browser_close', { tabId: blocked.tab.tabId, navigationEpoch: blocked.tab.navigationEpoch, controllerEpoch: blocked.tab.controllerEpoch });
  }
  const ordinary = await call(f.browser, 'browser_open', { url: 'https://shop.example/' });
  assert.equal(ordinary.ok, true);
});

test('browser_press without a ref and browser_wait with a ref are reachable through the tool schemas', async t => {
  const f = await publicSites(t, { [LAW]: { '/': '<input aria-label="Notes" autofocus><p id="toast">Saving</p><script>setTimeout(()=>document.querySelector("#toast").remove(),300)</script>' } });
  if (!f) return;
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  const page = { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch };
  assert.equal((await call(f.browser, 'browser_press', { ...page, key: 'ArrowDown' })).ok, true);
  await assert.rejects(call(f.browser, 'browser_press', { ...page, key: 'Enter' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  const fresh = await call(f.browser, 'browser_snapshot', { tabId: opened.tab.tabId });
  const toast = await f.browser.request(actor, 'snapshot', { tabId: opened.tab.tabId });
  const target = toast.snapshot.elements.find(element => element.name === 'Notes');
  assert.ok(fresh.ok && target);
  const waited = await call(f.browser, 'browser_wait', { tabId: opened.tab.tabId, snapshotId: toast.snapshot.snapshotId, ref: target.ref, state: 'visible', timeoutMs: 2000 });
  assert.equal(waited.completed, true);
  assert.throws(() => TOOL_DEFINITIONS.find(tool => tool.name === 'browser_wait').validate({ ref: 'e1' }), /snapshotId/);
});

test('human previews never take over agent request attribution, POST gating or session provenance', async t => {
  let posts = 0;
  const f = await publicSites(t, { 'https://github.example': (url, request) => {
    if (request.method() === 'POST') { posts++; return 'posted'; }
    if (url.pathname === '/beacon') return { body: 'ok', headers: { 'set-cookie': `_octo=anon-${Date.now()}; Path=/; Secure` } };
    return { body: `<h1>Repository ${url.pathname}</h1><script>for (let i = 0; i < 40; i++) setTimeout(() => { fetch('/beacon'); fetch('/collect', { method: 'POST', body: 'x' }).catch(() => {}); }, i * 25)</script>`,
      headers: { 'set-cookie': 'logged_in=no; Path=/; Secure' } };
  } }, { broker: true });
  if (!f) return;
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const opening = call(f.browser, 'browser_open', { url: 'https://github.example/microsoft/playwright' });
  let previews = 0;
  for (let index = 0; index < 60 && previews < 12; index++) {
    const tab = (await f.browser.inventory(human)).tabs[0];
    if (tab) { await f.browser.request(human, 'frame', { tabId: tab.tabId }).then(() => previews++, () => {}); }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const opened = await opening;
  assert.ok(previews > 0);
  assert.equal(posts, 0, 'agent page POSTs stay behind the website-change gate during human previews');
  assert.equal((await call(f.browser, 'browser_open', { url: 'https://github.example/microsoft/playwright/releases/latest' })).ok, true);
  await call(f.browser, 'browser_navigate', { tabId: opened.tab.tabId, url: 'https://github.example/microsoft/playwright/releases', navigationEpoch: (await f.browser.inventory(actor)).tabs[0].navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
  await f.credentialBroker.assertBrowserAccess({ actor, url: 'https://github.example' });
  // Genuine human input is still fenced as human: a human tab that writes storage quarantines its site.
  const humanTab = await f.browser.request(human, 'open', { url: 'https://github.example/settings' });
  await f.context().pages().find(page => page.url().endsWith('/settings')).evaluate(() => localStorage.setItem('session', 'HUMAN_PRIVATE'));
  await assert.rejects(call(f.browser, 'browser_open', { url: 'https://github.example/private' }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  assert.ok(humanTab.ok);
});

test('agent-only research skips full storage reads and close still flushes the checkpoint', async t => {
  const f = await publicSites(t, { [LAW]: { '/': '<h1>Law</h1><script>localStorage.setItem("pref", "agent")</script><a href="/next">Next</a>', '/next': '<h1>Next</h1>' } }, { broker: true });
  if (!f) return;
  const saved = [];
  const saveCheckpoint = f.credentialBroker.saveCheckpoint;
  f.credentialBroker.saveCheckpoint = async (input) => { saved.push(input.state); return saveCheckpoint(input); };
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  const storageState = f.context().storageState.bind(f.context());
  let reads = 0;
  f.context().storageState = (...args) => { reads++; return storageState(...args); };
  let current = opened;
  for (let index = 0; index < 3; index++) {
    current = await call(f.browser, 'browser_click', refArgs(current, by(current, 'Next') ?? by(current, 'Law')));
    current = await call(f.browser, 'browser_navigate', { tabId: current.tab.tabId, url: LAW, navigationEpoch: current.tab.navigationEpoch, controllerEpoch: current.tab.controllerEpoch });
  }
  assert.equal(reads, 0, 'no human activity means no full storage read on the agent hot path');
  await f.browser.close();
  assert.ok(reads > 0 && saved.at(-1).origins.some(entry => entry.origin === LAW), 'shutdown flushes agent storage into the checkpoint');
});

test('search origins and public GET forms validate every protected identity control and submitter override', async t => {
  const search = 'https://www.google.com';
  const protectedControls = [
    '<input type="password" name="pw" value="fake-password">',
    '<input type="email" name="private" value="fake@review.test">',
    '<input name="username" value="fake-user">',
    '<input autocomplete="username" name="identity" value="fake-user">',
    '<input autocomplete="cc-number" name="card" value="4242424242424242">',
    '<input data-rhwp-private-field name="private" value="fake-private">',
    '<input type="file" name="attachment">',
  ];
  const f = await publicSites(t, Object.fromEntries([LAW, search].map(origin => [origin, url => {
    if (url.pathname === '/search') return '<h1>Search results</h1>';
    const index = Number(url.searchParams.get('case') ?? -1);
    return `<form id="search" action="/search"><input name="q" aria-label="Query"><button>Search</button><button formmethod="post">POST override</button><button formaction="https://private.example/checkout">Action override</button></form>${protectedControls[index]?.replace('<input ', '<input form="search" ') ?? ''}`;
  }])));
  if (!f) return;
  for (const origin of [LAW, search]) {
    for (let index = 0; index < protectedControls.length; index++) {
      const opened = await call(f.browser, 'browser_open', { url: `${origin}/?case=${index}` });
      for (const [action, name, extra] of [['browser_type', 'Query', { text: 'query', submit: true }], ['browser_click', 'Search', {}]]) {
        await assert.rejects(call(f.browser, action, { ...refArgs(opened, by(opened, name)), ...extra }), { code: 'BROWSER_PERMISSION_REQUIRED' });
      }
      assert.equal(f.requests.some(entry => /fake-|fake%40|424242/.test(entry.url)), false, 'no protected value reaches a GET request');
      await call(f.browser, 'browser_close', { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
    }
    const opened = await call(f.browser, 'browser_open', { url: origin });
    for (const name of ['POST override', 'Action override']) await assert.rejects(call(f.browser, 'browser_click', refArgs(opened, by(opened, name))), { code: 'BROWSER_PERMISSION_REQUIRED' });
    const result = await call(f.browser, 'browser_type', { ...refArgs(opened, by(opened, 'Query')), text: 'public', submit: true });
    assert.match(result.snapshot.text, /Search results/);
    await call(f.browser, 'browser_close', { tabId: result.tab.tabId, navigationEpoch: result.tab.navigationEpoch, controllerEpoch: result.tab.controllerEpoch });
  }
  assert.equal(f.requests.some(entry => entry.method !== 'GET'), false);
});

test('input completed before a stale submit guard never invites replay', async t => {
  let currentPage;
  const f = await fixture(t, { policy: { assertAllowed: async () => { if (currentPage && await currentPage.locator('input').inputValue() === 'once') throw new OwnedBrowserError('BROWSER_STALE_NAVIGATION', 'The page changed after input.', true); } } }); if (!f) return;
  currentPage = f.page;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await assert.rejects(call(f.browser, 'browser_type', { ...refs(observed), text: 'once', submit: true }), failure => {
    assert.equal(failure.code, 'BROWSER_ACTION_UNCERTAIN');
    assert.equal(failure.actionCompleted, true);
    assert.equal(failure.retryable, false);
    assert.match(failure.hint, /Do not repeat/);
    return true;
  });
  assert.equal(await f.page.locator('input').inputValue(), 'once');
  assert.equal(await f.page.evaluate(() => submissions), 0, 'the stale second operation was not dispatched');
});

test('a failed input dispatch is uncertain and must be observed before retrying', async t => {
  const f = await fixture(t); if (!f) return;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  f.page.keyboard.press = async () => { throw new Error('transport disconnected after dispatch'); };
  await assert.rejects(call(f.browser, 'browser_press', { tabId: f.tabId, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: observed.tab.controllerEpoch, key: 'ArrowDown' }), failure => {
    assert.equal(failure.retryable, false);
    assert.equal(failure.actionCompleted, undefined);
    assert.match(failure.hint, /may have reached.*Do not repeat/);
    return true;
  });
});


test('a parent-document overlay blocks clicks on same-origin frame controls', async t => {
  const f = await publicSites(t, { [LAW]: { '/': '<iframe src="/frame" style="width:600px;height:300px"></iframe><div style="position:fixed;inset:0" aria-label="Parent cookie banner"></div>', '/frame': '<form action="/search"><input name="q" value="law"><button>Frame search</button></form>', '/search': 'Unexpected submission' } });
  if (!f) return;
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  await assert.rejects(call(f.browser, 'browser_click', refArgs(opened, by(opened, 'Frame search'))), failure => failure.code === 'BROWSER_TARGET_COVERED' && /Parent cookie banner/.test(failure.message) && failure.retryable === true && !!failure.hint);
  assert.equal(f.requests.some(entry => entry.url.includes('/search')), false);
});


test('public GET form safety uses isolated DOM ownership and controls despite hostile page prototypes', async t => {
  const hostile = `<script>
    Element.prototype.matches = () => false;
    const attribute = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function(name) { return name === 'aria-label' ? attribute.call(this, name) : null; };
    Object.defineProperty(HTMLInputElement.prototype, 'form', { get: () => null });
    Object.defineProperty(HTMLInputElement.prototype, 'type', { get: () => 'text' });
    Object.defineProperty(HTMLFormElement.prototype, 'elements', { get: () => [] });
    Object.defineProperty(HTMLFormElement.prototype, 'method', { get: () => 'get' });
  </script>`;
  const f = await publicSites(t, { [LAW]: url => {
    if (url.pathname === '/search') return '<h1>Isolated search result</h1>';
    if (url.pathname === '/safe') return `<form id="lookup" action="/search"><input name="q" aria-label="Query"><button>Search</button><button formmethod="post">POST override</button><button formaction="/checkout">Action override</button></form><form><input type="email" value="unrelated@review.test"></form>${hostile}`;
    if (url.pathname === '/owner') return `<form id="safe" action="/search"><input name="q" form="private" aria-label="Query"></form><form id="private" action="/search"><input type="email" name="private" value="fake@review.test"></form>${hostile}`;
    if (url.pathname === '/duplicate') return `<div id="lookup"></div><form id="lookup" action="/search"><input name="q" form="lookup" aria-label="Query"><button>Search</button></form>${hostile}`;
    return `<form id="lookup" method="get" action="/search"><input name="q" aria-label="Query"><button>Search</button></form><input form="lookup" type="email" name="private" value="fake@review.test">${hostile}`;
  } });
  if (!f) return;
  for (const path of ['/', '/owner', '/duplicate']) {
    const opened = await call(f.browser, 'browser_open', { url: LAW + path });
    assert.equal(JSON.stringify(opened.snapshot).includes('fake@review.test'), false);
    await assert.rejects(call(f.browser, 'browser_type', { ...refArgs(opened, by(opened, 'Query')), text: 'research', submit: true, snapshot: false }), { code: 'BROWSER_PERMISSION_REQUIRED' });
    assert.equal(f.requests.some(request => request.url.includes('private=')), false);
    await call(f.browser, 'browser_close', { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
  }
  const opened = await call(f.browser, 'browser_open', { url: LAW + '/safe' });
  for (const name of ['POST override', 'Action override']) await assert.rejects(call(f.browser, 'browser_click', refArgs(opened, by(opened, name))), { code: 'BROWSER_PERMISSION_REQUIRED' });
  const searched = await call(f.browser, 'browser_type', { ...refArgs(opened, by(opened, 'Query')), text: `한글 >> "search" O'Reilly`, submit: true });
  assert.match(searched.snapshot.text, /Isolated search result/);
  assert.equal(new URL(f.requests.at(-1).url).searchParams.get('q'), `한글 >> "search" O'Reilly`);
  assert.equal(f.requests.some(request => request.method !== 'GET'), false);
});


test('type submit rechecks form safety after site input handlers and never replays a completed fill', async t => {
  const f = await publicSites(t, { [LAW]: url => `<form id="lookup" action="/search"><input name="q" aria-label="Query"><button>Search</button></form><script>
    window.submissions = 0;
    document.querySelector('form').addEventListener('submit', () => submissions++);
    document.querySelector('input').addEventListener('input', event => {
      const form = event.target.form;
      if (location.pathname === '/email') document.body.insertAdjacentHTML('beforeend', '<input form="lookup" type="email" name="private" value="fake@review.test">');
      if (location.pathname === '/post') form.method = 'post';
      if (location.pathname === '/action') form.action = '/checkout';
    });
  </script>` });
  if (!f) return;
  for (const path of ['/email', '/post', '/action']) {
    const opened = await call(f.browser, 'browser_open', { url: LAW + path });
    await assert.rejects(call(f.browser, 'browser_type', { ...refArgs(opened, by(opened, 'Query')), text: 'written once', submit: true, intent: 'search' }), failure => {
      assert.equal(failure.code, 'BROWSER_PERMISSION_REQUIRED');
      assert.equal(failure.actionCompleted, true);
      assert.equal(failure.retryable, false);
      assert.match(failure.hint, /Do not repeat/);
      return true;
    });
    const page = f.context().pages().find(page => page.url() === LAW + path);
    assert.deepEqual(await page.evaluate(() => ({ value: document.querySelector('input').value, submissions })), { value: 'written once', submissions: 0 });
    assert.equal(f.requests.some(request => /\/(search|checkout)(?:[?]|$)/.test(new URL(request.url).pathname)), false);
    assert.equal(f.requests.some(request => request.method !== 'GET' || request.url.includes('private=')), false);
    await call(f.browser, 'browser_close', { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
  }
});

test('fallback ARIA roles expose sortable headers without granting generic button submissions', async t => {
  const f = await publicSites(t, { [LAW]: { '/': `<table><thead><tr><th role="columnheader button" tabindex="0" aria-sort="none">Location</th></tr></thead><tbody><tr><td>Zimbabwe</td></tr><tr><td>Afghanistan</td></tr><tr><td>Brazil</td></tr></tbody></table>
    <div role="unsupported button" tabindex="0" onclick="window.unknownClicks++">Unknown fallback button</div>
    <div role="command button" tabindex="0" onclick="window.abstractClicks++">Abstract fallback button</div>
    <div role="button link" tabindex="0" onclick="window.primaryClicks++">Primary button</div>
    <div role="unsupported link" tabindex="0">Fallback link</div>
    <div role="navigation" aria-label="Not a control">Navigation text</div>
    <div role="unsupported textbox" contenteditable="true" aria-label="Fallback editor"></div>
    <script>window.unknownClicks=window.abstractClicks=window.primaryClicks=0;
      document.querySelector('th').addEventListener('click',event=>{
        const body=document.querySelector('tbody');
        [...body.rows].sort((a,b)=>a.textContent.localeCompare(b.textContent)).forEach(row=>body.append(row));
        event.currentTarget.setAttribute('aria-sort','ascending');
        window.sortedTrusted=event.isTrusted;
        fetch('/collect',{method:'POST',body:'blocked'}).catch(()=>{});
      });
    </script>` } });
  if (!f) return;
  const opened = await call(f.browser, 'browser_open', { url: LAW });
  const header = by(opened, 'Location');
  assert.equal(header?.role, 'columnheader');
  assert.equal(by(opened, 'Unknown fallback button')?.role, 'button');
  assert.equal(by(opened, 'Abstract fallback button')?.role, 'button');
  assert.equal(by(opened, 'Primary button')?.role, 'button');
  assert.equal(by(opened, 'Fallback link')?.role, 'link');
  assert.equal(by(opened, 'Fallback editor')?.role, 'textbox');
  assert.equal(by(opened, 'Navigation text'), undefined, 'discovery does not expand to all ARIA roles');
  for (const name of ['Unknown fallback button', 'Abstract fallback button', 'Primary button']) await assert.rejects(call(f.browser, 'browser_click', refArgs(opened, by(opened, name))), { code: 'BROWSER_PERMISSION_REQUIRED' });
  const result = await call(f.browser, 'browser_click', refArgs(opened, header));
  assert.equal(result.ok, true);
  const page = f.context().pages().find(page => page.url() === LAW + '/');
  assert.deepEqual(await page.evaluate(() => ({ rows:[...document.querySelector('tbody').rows].map(row=>row.textContent), sort:document.querySelector('th').getAttribute('aria-sort'), trusted:window.sortedTrusted, unknownClicks, abstractClicks, primaryClicks })), { rows:['Afghanistan','Brazil','Zimbabwe'], sort:'ascending', trusted:true, unknownClicks:0, abstractClicks:0, primaryClicks:0 });
  assert.equal(f.requests.some(request => request.method !== 'GET'), false, 'local sorting does not approve POST requests');
});
