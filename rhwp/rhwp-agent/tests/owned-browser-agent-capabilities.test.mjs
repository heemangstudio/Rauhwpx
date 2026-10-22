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
import { citationURL } from '../owned-browser-reading.mjs';

const actor = { threadId: 'capability-chat', agentId: 'capability-agent' };
const call = (browser, name, input) => browser.request(actor, name.slice('browser_'.length).replaceAll('_', '-'), z.object(TOOL_DEFINITIONS.find(tool => tool.name === name).shape).parse(input));
const refOf = (snapshot, name) => snapshot.outline.split('\n').find(line => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
const epochs = (snapshot) => ({ tabId: snapshot.tabId, snapshotId: snapshot.snapshotId, navigationEpoch: snapshot.navigationEpoch, controllerEpoch: snapshot.controllerEpoch });
const target = (snapshot, name) => ({ ...epochs(snapshot), ref: refOf(snapshot, name) });
// 정책 대역: website-change 는 siteAccess 가 켜졌을 때만, blocked 주소는 열람부터 막는다.
const fakePolicy = (state) => ({ check: async ({ action, url }) => {
  const origin = new URL(url).origin;
  if (state.blocked?.some((part) => url.includes(part))) return { allowed: false, code: 'BROWSER_SITE_BLOCKED', reason: action, site: origin, origin, blocked: ['browse'] };
  if (action === 'website-change' && !state.siteAccess) return { allowed: false, code: 'BROWSER_PERMISSION_REQUIRED', reason: action, site: origin, origin };
  return { allowed: true };
} });

async function fixture(t, pages, options = {}) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-capabilities-'));
  const sockets = new Set(); const posts = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://local');
    if (request.method !== 'GET') { posts.push(`${request.method} ${url.pathname}`); response.setHeader('content-type', 'text/html'); response.end('<title>Saved</title><h1>Saved</h1>'); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const page = pages[url.pathname];
    if (page === undefined) { response.statusCode = 404; response.end('<title>Missing</title>missing'); return; }
    response.end(typeof page === 'function' ? page(url) : page);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let runtime; const events = [];
  const browser = createOwnedBrowserService({ dataDir, workspaceTargets: [origin], autoInstall: false, onEvent: (event) => events.push(event), runtimeFactory: async opts => runtime = await startOwnedBrowserRuntime(opts), policy: options.policy ?? { assertAllowed: async () => {} }, ...(options.service ?? {}) });
  t.after(async () => { await browser.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const opened = await call(browser, 'browser_open', { url: `${origin}${options.start ?? '/'}` });
  const tabId = opened.tab.tabId;
  return { browser, origin, tabId, posts, events, page: () => runtime.context.pages().find(page => page.url().startsWith(origin)), snap: async (extra = {}) => (await call(browser, 'browser_snapshot', { tabId, ...extra })).snapshot };
}

test('browser_fill_form fills many field kinds at once, refuses secrets per field and submits only through policy', async t => {
  const form = `<form method="post" action="/save"><label>Name<input name="name"></label><label>Notes<textarea name="notes"></textarea></label>
    <label>Due<input type="date" name="due"></label><label>Size<select name="size"><option value="s">Small</option><option value="l">Large</option></select></label>
    <label><input type="checkbox" name="agree">Agree</label><label><input type="radio" name="plan" value="a">Plan A</label><label><input type="radio" name="plan" value="b">Plan B</label>
    <label>Password<input type="password" name="pw"></label><label>Code<input autocomplete="one-time-code" name="otp"></label><button>Save form</button></form>`;
  const state = { siteAccess: false };
  const f = await fixture(t, { '/': form }, { policy: fakePolicy(state) }); if (!f) return;
  let snapshot = await f.snap();
  const fields = [['Name', 'Kim'], ['Notes', 'two\nlines'], ['Due', '2026-11-03'], ['Size', 'Large'], ['Agree', true], ['Plan B', true], ['Password', 'nope'], ['Code', '123456']]
    .map(([name, value]) => ({ ref: refOf(snapshot, name), value }));
  const filled = await call(f.browser, 'browser_fill_form', { ...epochs(snapshot), fields });
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.fields.map((entry) => entry.ok), [true, true, true, true, true, true, false, false]);
  assert.equal(filled.fields[6].error.code, 'BROWSER_SECRET_CHANNEL_REQUIRED');
  assert.equal(filled.fields[7].error.code, 'BROWSER_USER_CODE_REQUIRED');
  assert.equal(filled.submitted, undefined);
  assert.deepEqual(await f.page().evaluate(() => Object.fromEntries(new FormData(document.forms[0]))), { name: 'Kim', notes: 'two\nlines', due: '2026-11-03', size: 'l', agree: 'on', plan: 'b', pw: '', otp: '' });
  assert.deepEqual(f.posts, []);
  // POST 폼 제출은 사이트 사용이 필요하다.
  snapshot = await f.snap();
  await assert.rejects(call(f.browser, 'browser_fill_form', { ...epochs(snapshot), fields: [{ ref: refOf(snapshot, 'Name'), value: 'Lee' }], submit: refOf(snapshot, 'Save form') }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.deepEqual(f.posts, []);
  state.siteAccess = true;
  snapshot = await f.snap();
  const submitted = await call(f.browser, 'browser_fill_form', { ...epochs(snapshot), fields: [{ ref: refOf(snapshot, 'Name'), value: 'Lee' }], submit: refOf(snapshot, 'Save form') });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.navigated, true);
  assert.deepEqual(f.posts, ['POST /save']);
  // 사용자가 잡은 탭에는 채우지 않는다.
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  await f.browser.request(human, 'navigate', { tabId: f.tabId, url: `${f.origin}/`, navigationEpoch: submitted.navigationEpoch, controllerEpoch: snapshot.controllerEpoch });
  snapshot = await f.snap();
  await f.browser.request(human, 'control', { tabId: f.tabId, owner: 'human' });
  await assert.rejects(call(f.browser, 'browser_fill_form', { ...epochs(snapshot), fields: [{ ref: refOf(snapshot, 'Name'), value: 'x' }] }), { code: 'BROWSER_USER_CONTROL' });
});

test('confirm and prompt dialogs stay open for browser_dialog, block other actions and never hang the click', async t => {
  const page = `<title>Dialogs</title><button onclick="window.answer = confirm('Delete draft?')">Ask confirm</button>
    <button onclick="window.named = prompt('Your name?', 'guest')">Ask prompt</button><button onclick="alert('Saved!')">Alert me</button><p id="out">Idle</p>`;
  const f = await fixture(t, { '/': page }); if (!f) return;
  let snapshot = await f.snap();
  const started = Date.now();
  const clicked = await call(f.browser, 'browser_click', target(snapshot, 'Ask confirm'));
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(clicked.dialog, { type: 'confirm', message: 'Delete draft?', pending: true });
  await assert.rejects(call(f.browser, 'browser_snapshot', { tabId: f.tabId }), (failure) => failure.code === 'BROWSER_DIALOG_PENDING' && /confirm: "Delete draft\?"/.test(failure.message) && /browser_dialog/.test(failure.message));
  const status = await f.browser.request(actor, 'status', {});
  assert.deepEqual(status.tabs.find((tab) => tab.tabId === f.tabId).dialog, { type: 'confirm', message: 'Delete draft?' });
  const answered = await call(f.browser, 'browser_dialog', { tabId: f.tabId, accept: true });
  assert.deepEqual(answered.answered, { type: 'confirm', accepted: true });
  assert.equal(await f.page().evaluate(() => window.answer), true);
  await assert.rejects(call(f.browser, 'browser_dialog', { tabId: f.tabId, accept: true }), { code: 'BROWSER_DIALOG_NOT_FOUND' });
  snapshot = await f.snap();
  await call(f.browser, 'browser_click', target(snapshot, 'Ask prompt'));
  await assert.rejects(call(f.browser, 'browser_dialog', { tabId: f.tabId, accept: false, promptText: 'x' }), { code: 'BROWSER_DIALOG_INVALID' });
  await call(f.browser, 'browser_dialog', { tabId: f.tabId, accept: true, promptText: 'Hana' });
  assert.equal(await f.page().evaluate(() => window.named), 'Hana');
  // browser_type key 는 키 하나를 누른다. Enter 로 연 대화상자도 기다리지 않고 돌아온다.
  snapshot = await f.snap();
  const pressed = await call(f.browser, 'browser_type', { ...target(snapshot, 'Ask confirm'), key: 'Enter' });
  assert.deepEqual(pressed.dialog, { type: 'confirm', message: 'Delete draft?', pending: true });
  await call(f.browser, 'browser_dialog', { tabId: f.tabId, accept: false });
  assert.equal(await f.page().evaluate(() => window.answer), false);
  // 알림은 기다리지 않고 닫히며 문구만 돌아온다.
  snapshot = await f.snap();
  const alerted = await call(f.browser, 'browser_click', target(snapshot, 'Alert me'));
  assert.deepEqual(alerted.dialog, { type: 'alert', message: 'Saved!' });
  await f.snap();
});

test('beforeunload on a shared tab needs site access to accept; dismissing keeps the page', async t => {
  const page = '<title>Editor</title><script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; })</script><input aria-label="Body"><a href="/away">Leave page</a>';
  const state = { siteAccess: false };
  const f = await fixture(t, { '/': page, '/away': '<title>Away</title>away' }, { policy: fakePolicy(state) }); if (!f) return;
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const shared = await f.browser.request(human, 'open', { url: `${f.origin}/` });
  const sharedId = shared.tab.tabId;
  const live = () => f.events.findLast?.((event) => event.tab?.tabId === sharedId) ?? null;
  // beforeunload 는 사용자가 페이지와 상호작용한 뒤에만 뜬다.
  let snapshot = (await call(f.browser, 'browser_snapshot', { tabId: sharedId })).snapshot;
  await call(f.browser, 'browser_type', { ...target(snapshot, 'Body'), text: 'unsaved' });
  snapshot = (await call(f.browser, 'browser_snapshot', { tabId: sharedId })).snapshot;
  const clicked = await call(f.browser, 'browser_click', target(snapshot, 'Leave page'));
  assert.equal(clicked.dialog?.type, 'beforeunload');
  const answer = (accept) => call(f.browser, 'browser_dialog', { tabId: sharedId, accept });
  await assert.rejects(answer(true), { code: 'BROWSER_PERMISSION_REQUIRED' });
  const kept = await answer(false);
  assert.equal(kept.navigated, false);
  assert.ok(live());
});

test('snapshot find counts matches across same-origin frames, scrolls to the Nth and never probes private values', async t => {
  const filler = Array.from({ length: 80 }, (_, index) => `<p>Filler paragraph ${index}</p>`).join('');
  const page = `<title>Find</title><p>Alpha budget line</p>${filler}<p id="late">Second budget mention</p><label>Password<input type="password" value="budget-secret"></label><iframe src="/frame" style="height:80px"></iframe>`;
  const f = await fixture(t, { '/': page, '/frame': '<p>Framed budget note</p>' }); if (!f) return;
  await f.page().waitForLoadState('load');
  const found = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'budget' });
  assert.equal(found.found.count, 3);
  assert.deepEqual(found.found.matches.map((match) => match.frame ?? 'main'), ['main', 'main', 'iframe']);
  assert.match(found.found.matches[1].text, /Second budget mention/);
  assert.ok(found.snapshot.snapshotId);
  assert.match(found.snapshot.outline, /budget/);
  assert.equal(JSON.stringify(found).includes('budget-secret'), false);
  assert.equal(await f.page().evaluate(() => scrollY), 0);
  const scrolled = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'budget', scrollTo: 2 });
  assert.equal(scrolled.found.scrolledTo, 2);
  assert.ok(await f.page().evaluate(() => scrollY) > 200);
  assert.equal(await f.page().evaluate(() => String(getSelection())), 'budget');
  await assert.rejects(call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'budget', scrollTo: 9 }), { code: 'BROWSER_FIND_NOT_FOUND' });
  const none = await call(f.browser, 'browser_snapshot', { tabId: f.tabId, find: 'nothing like this' });
  assert.equal(none.found.count, 0);
  assert.equal(none.snapshot.matches, 0);
});

test('browser_open urls reads pages in parallel within the tab limit, reports denials per URL and closes its tabs', async t => {
  const article = (name) => `<title>${name}</title><nav>Menu Home About</nav><article><h1>${name} headline</h1>${Array.from({ length: 30 }, (_, index) => `<p>Body sentence ${index} for the article text.</p>`).join('')}<p>${name} unique fact</p></article>`;
  const slow = (name) => () => article(name);
  const state = { siteAccess: false, blocked: ['/blocked'] };
  const f = await fixture(t, { '/': '<title>Start</title>', '/a': slow('Apple'), '/b': slow('Banana'), '/c': slow('Cherry'), '/d': slow('Durian'), '/blocked': article('Nope') }, { policy: fakePolicy(state) }); if (!f) return;
  const before = (await f.browser.request(actor, 'status', {})).tabs.length;
  const urls = ['/a', '/b', '/c', '/d', '/blocked'].map((pathname) => `${f.origin}${pathname}?utm_source=x&id=7`);
  const read = await call(f.browser, 'browser_open', { urls, find: 'unique fact' });
  assert.equal(read.pages.length, 5);
  assert.deepEqual(read.pages.map((page) => page.ok), [true, true, true, true, false]);
  assert.equal(read.pages[0].title, 'Apple');
  assert.equal(read.pages[0].text, 'Apple unique fact');
  assert.equal(read.pages[0].url, `${f.origin}/a?id=7`);
  assert.equal(read.pages[4].error.code, 'BROWSER_SITE_BLOCKED');
  assert.equal((await f.browser.request(actor, 'status', {})).tabs.length, before);
  const full = await call(f.browser, 'browser_open', { urls: [`${f.origin}/b`], maxChars: 500, keep: true });
  assert.ok(full.pages[0].text.startsWith('Banana headline'));
  assert.ok(full.pages[0].text.length <= 500);
  assert.equal(full.pages[0].truncated, true);
  assert.ok(full.pages[0].tabId);
  assert.equal((await f.browser.request(actor, 'status', {})).tabs.length, before + 1);
  await assert.rejects(call(f.browser, 'browser_open', { urls: urls.slice(0, 3), keep: true }), { code: 'BROWSER_TAB_LIMIT' });
});

test('browser_cite returns a clean citation from a ref or an exact quote', async t => {
  const page = `<!doctype html><html lang="ko"><head><title>Raw title</title><link rel="canonical" href="/news/42?utm_campaign=x&page=2">
    <meta property="og:site_name" content="Hama News"><meta property="og:title" content="Rain returns">
    <script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-01T09:00:00+09:00","author":{"name":"Park Reporter"}}</script></head>
    <body><article><p id="lead">Heavy rain is expected across the south on Friday.</p><p>Second paragraph.</p></article><label>Password<input type="password" value="pw-123"></label></body></html>`;
  const f = await fixture(t, { '/news/42': page }, { start: '/news/42?token=abc&fbclid=zz' }); if (!f) return;
  const snapshot = await f.snap();
  const lead = snapshot.outline.split('\n').find((line) => line.includes('Heavy rain'));
  assert.ok(lead);
  const byQuote = await call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'rain is expected   across the south' });
  assert.deepEqual(byQuote.citation, {
    quote: 'rain is expected across the south', title: 'Rain returns', url: `${f.origin}/news/42?page=2`, siteName: 'Hama News', author: 'Park Reporter',
    published: '2026-10-01', accessed: byQuote.citation.accessed, lang: 'ko',
    footnote: `Park Reporter, 「Rain returns」, Hama News, 2026-10-01. ${f.origin}/news/42?page=2 (${byQuote.citation.accessed} 접속)`,
  });
  await assert.rejects(call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'pw-123' }), { code: 'BROWSER_QUOTE_NOT_FOUND' });
  await assert.rejects(call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'Snow is expected' }), { code: 'BROWSER_QUOTE_NOT_FOUND' });
  const paragraph = await f.page().evaluate(() => document.querySelector('#lead').textContent);
  assert.equal(paragraph, 'Heavy rain is expected across the south on Friday.');
  await assert.rejects(call(f.browser, 'browser_cite', { tabId: f.tabId, snapshotId: snapshot.snapshotId, ref: refOf(snapshot, 'Password') }), { code: 'BROWSER_CITE_INVALID' });
});

test('browser_cite capture crops the quoted passage or ref after scrolling it into view, and refuses password pages', async t => {
  const filler = Array.from({ length: 40 }, (_, i) => `<p>Filler line ${i}.</p>`).join('');
  const page = `<!doctype html><html><head><title>Deep</title></head><body style="margin:0;font:16px sans-serif">${filler}
    <section aria-label="Market report" id="deep" style="margin-left:40px;width:420px"><p>Prices rose <b>sharply</b> in May across every region.</p></section><p id="next">Next block.</p></body></html>`;
  const secret = '<!doctype html><title>Login</title><p id="lead">Public lead text.</p><label>Password<input type="password" value="pw-123"></label>';
  const f = await fixture(t, { '/deep': page, '/login': secret }, { start: '/deep' }); if (!f) return;
  const { imageDetails } = await import('../insert-image-source.mjs');
  const check = async (result, selector) => {
    assert.equal(result.image.mimeType, 'image/jpeg');
    const size = imageDetails(Buffer.from(result.image.data, 'base64'));
    assert.equal(size.extension, 'jpg');
    const view = await f.page().evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { scrollY, top: r.top, bottom: r.bottom, height: innerHeight, selected: getSelection().rangeCount }; }, selector);
    assert.ok(view.scrollY > 0, 'scrolled to the passage');
    assert.ok(view.top >= 0 && view.bottom <= view.height, 'passage is inside the viewport');
    assert.equal(view.selected, 0, 'no selection left behind');
    assert.ok(size.height >= 16 && size.height < 200, `crop height ${size.height}`);
    assert.ok(size.width > 100 && size.width < 600, `crop width ${size.width}`);
    return size;
  };
  // 인용문이 굵은 글자 경계를 넘어도 범위를 찾는다.
  const byQuote = await call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'Prices rose sharply in May', capture: true });
  assert.equal(byQuote.citation.quote, 'Prices rose sharply in May');
  await check(byQuote, '#deep');
  await f.page().evaluate(() => scrollTo(0, 0));
  const snapshot = await f.snap();
  const ref = refOf(snapshot, 'Market report');
  assert.ok(ref, snapshot.outline);
  const byRef = await call(f.browser, 'browser_cite', { tabId: f.tabId, snapshotId: snapshot.snapshotId, ref, capture: true });
  await check(byRef, '#deep');
  // 없는 인용은 그림 없이 오류다. capture 를 빼면 그림을 싣지 않는다.
  assert.equal((await call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'Next block' })).image, undefined);
  await call(f.browser, 'browser_navigate', { ...epochs(await f.snap()), url: `${f.origin}/login` });
  await assert.rejects(call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'Public lead text', capture: true }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
  assert.ok((await call(f.browser, 'browser_cite', { tabId: f.tabId, quote: 'Public lead text' })).citation);
});

test('citation URLs drop tracking and signed values and keep meaningful queries', () => {
  assert.equal(citationURL('https://user:pw@news.example.com/a?id=5&utm_source=x&fbclid=1#top'), 'https://news.example.com/a?id=5');
  assert.equal(citationURL('https://finance.example.com/item?code=005930'), 'https://finance.example.com/item?code=005930');
  assert.equal(citationURL('https://bucket.example.com/f.pdf?X-Amz-Signature=abc&X-Amz-Credential=def&v=2'), 'https://bucket.example.com/f.pdf?v=2');
  assert.equal(citationURL(`https://example.com/p?s=${'A'.repeat(48)}`), 'https://example.com/p');
  assert.equal(citationURL('javascript:alert(1)'), null);
});

test('hover and drag move the pointer along an eased path, drop HTML5 items and refuse covered targets', async t => {
  const page = `<title>Pointer</title><style>#menu{display:none}#host:hover #menu{display:block}#cover{position:fixed;left:0;top:300px;width:400px;height:60px;background:#eee}</style>
    <div id="host" role="button" aria-label="Products" style="width:160px;padding:8px">Products<div id="menu"><a href="/x">Hidden item</a></div></div>
    <div role="slider" aria-label="Volume" aria-valuenow="0" id="knob" style="width:30px;height:30px;background:#333;position:relative;left:0"></div>
    <div draggable="true" id="card" role="button" style="width:80px;height:30px;background:#ccf">Card one</div><div id="lane" role="region" aria-label="Done lane" style="width:200px;height:80px;background:#cfc;margin-top:20px"></div>
    <button style="position:fixed;left:10px;top:310px">Buried button</button><div id="cover"></div>
    <script>
      window.moves = 0; addEventListener('mousemove', () => moves++);
      let start; const knob = document.querySelector('#knob');
      knob.addEventListener('mousedown', (event) => { start = event.clientX; });
      addEventListener('mouseup', (event) => { if (start !== undefined) { knob.setAttribute('aria-valuenow', String(Math.round(event.clientX - start))); start = undefined; } });
      const lane = document.querySelector('#lane');
      lane.addEventListener('dragover', (event) => event.preventDefault());
      lane.addEventListener('drop', (event) => { event.preventDefault(); lane.append(document.querySelector('#card')); window.dropped = event.isTrusted; });
    </script>`;
  const f = await fixture(t, { '/': page }); if (!f) return;
  let snapshot = await f.snap();
  assert.equal(snapshot.outline.includes('Hidden item'), false);
  const hovered = await call(f.browser, 'browser_click', { ...target(snapshot, 'Products'), hover: true, snapshot: true });
  assert.equal(hovered.ok, true);
  assert.match(hovered.snapshot.outline, /Hidden item/);
  assert.ok(await f.page().evaluate(() => moves) >= 8);
  const pointer = f.events.filter((event) => event.type === 'owned_browser_pointer');
  assert.ok(pointer.some((event) => event.phase === 'move' && event.durationMs >= 120 && event.durationMs <= 400 && event.tab.tabId === f.tabId));
  snapshot = await f.snap();
  await call(f.browser, 'browser_click', { ...target(snapshot, 'Volume'), dragBy: { x: 120, y: 0 } });
  const moved = Number(await f.page().evaluate(() => document.querySelector('#knob').getAttribute('aria-valuenow')));
  assert.ok(moved >= 115 && moved <= 125, String(moved));
  snapshot = await f.snap();
  const cardRef = snapshot.outline.split('\n').find((line) => line.includes('Card one'))?.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(cardRef);
  const dragged = await call(f.browser, 'browser_click', { ...epochs(snapshot), ref: cardRef, dragTo: refOf(snapshot, 'Done lane') });
  assert.ok(['html5', 'synthetic'].includes(dragged.dragged.mode));
  assert.equal(await f.page().evaluate(() => document.querySelector('#lane').contains(document.querySelector('#card'))), true);
  snapshot = await f.snap();
  const before = Date.now();
  await assert.rejects(call(f.browser, 'browser_click', target(snapshot, 'Buried button')), { code: 'BROWSER_TARGET_COVERED' });
  assert.ok(Date.now() - before < 9_000);
  const clicks = f.events.filter((event) => event.type === 'owned_browser_pointer' && event.phase === 'click');
  assert.equal(clicks.length, 0);
});
