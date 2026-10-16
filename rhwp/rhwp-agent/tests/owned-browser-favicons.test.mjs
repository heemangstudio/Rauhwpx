import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createFaviconCache, faviconCandidates } from '../owned-browser-favicons.mjs';
import { createBrowserNetworkGuard } from '../owned-browser-network.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';
import { inspectOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pngOf = (size) => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(size - 8, 1)]);
// 16·32·48 픽셀 세 장. 전체는 16 KB를 넘고 32 픽셀 한 장은 한도 안에 든다.
function multiIco() {
  const images = [[16, pngOf(9000)], [32, pngOf(3000)], [48, pngOf(9000)]];
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([pixels, image], index) => {
    const at = 6 + index * 16;
    header[at] = pixels; header[at + 1] = pixels; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += image.length;
  });
  return Buffer.concat([header, ...images.map(([, image]) => image)]);
}

async function fixture(t, routes) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push({ path: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization });
    const route = routes[request.url];
    if (!route) { response.writeHead(404); response.end(); return; }
    route(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}
const send = (type, body, headers = {}) => (_request, response) => { response.writeHead(200, { 'content-type': type, ...headers }); response.end(body); };
const redirect = (location) => (_request, response) => { response.writeHead(302, { location }); response.end(); };

async function cacheFor(t, origin, options = {}) {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-favicons-')), 'browser', 'favicons');
  t.after(() => fs.rm(path.dirname(path.dirname(dir)), { recursive: true, force: true }));
  const guard = createBrowserNetworkGuard({ workspaceTargets: [origin] });
  return { dir, cache: createFaviconCache({ dir, resolve: guard.resolve, isWorkspace: guard.isWorkspace, ...options }) };
}

test('site icons accept only small raster images and reject SVG, markup, oversize bytes, and unsafe redirects', async (t) => {
  const chain = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`/hop${index}`, redirect(`/hop${index + 1}`)]));
  const f = await fixture(t, {
    '/icon.png': send('image/png', PNG),
    '/svg': send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    '/svg-as-png': send('image/png', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    '/html': send('text/html', PNG),
    '/huge.png': send('image/png', pngOf(70 * 1024)),
    '/big.png': send('image/png', pngOf(20 * 1024)),
    '/multi.ico': send('image/x-icon', multiIco()),
    '/redirect': redirect('/icon.png'),
    '/private': redirect('https://127.0.0.1:1/icon.png'),
    '/plain-http': redirect('http://93.184.216.34/icon.png'),
    ...chain,
  });
  const { cache } = await cacheFor(t, f.origin);
  const icon = (key, url) => cache.discover(`https://${key}.test`, [`${f.origin}${url}`]);
  assert.equal(await icon('png', '/icon.png'), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(await icon('redirect', '/redirect'), `data:image/png;base64,${PNG.toString('base64')}`);
  for (const [key, url] of [['svg', '/svg'], ['disguised', '/svg-as-png'], ['html', '/html'], ['huge', '/huge.png'], ['big', '/big.png'], ['private', '/private'], ['plain', '/plain-http'], ['chain', '/hop0']]) {
    assert.equal(await icon(key, url), null, url);
  }
  assert.ok(f.hits.some((hit) => hit.path === '/hop5') && !f.hits.some((hit) => hit.path === '/hop6'), 'at most five redirects are followed');
  assert.ok(f.hits.every((hit) => hit.cookie === undefined && hit.authorization === undefined));
  const ico = await icon('ico', '/multi.ico');
  const bytes = Buffer.from(ico.slice('data:image/x-icon;base64,'.length), 'base64');
  assert.ok(ico.startsWith('data:image/x-icon;base64,') && ico.length <= 16 * 1024);
  assert.equal(bytes.readUInt16LE(4), 1, 'a multi-size icon keeps one image');
  assert.equal(bytes[6], 32, 'the 32 pixel image is chosen');
  // 브라우저가 넘긴 data URI도 같은 검사를 거친다.
  assert.equal(await cache.discover('https://data.test', [`data:image/png;base64,${PNG.toString('base64')}`]), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(await cache.discover('https://data-svg.test', [`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`]), null);
  assert.equal(await cache.discover('https://data-fake.test', [`data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`]), null);
  // 다른 HTTP 주소는 요청 없이 거절한다.
  const before = f.hits.length;
  assert.deepEqual(faviconCandidates('http://example.test/', [{ href: '/icon.png' }]), []);
  assert.deepEqual(faviconCandidates('https://example.test/a', [{ href: 'http://example.test/icon.png' }, { href: '/logo.svg' }, { href: '/x.png', type: 'image/svg+xml' }]), ['https://example.test/favicon.ico']);
  assert.equal(f.hits.length, before);
});

test('site icon cache keeps entries for seven days, caps its size, and drops writes after clearing', async (t) => {
  let delay;
  const f = await fixture(t, {
    '/icon.png': send('image/png', PNG),
    '/slow.png': (request, response) => { delay = setTimeout(() => send('image/png', PNG)(request, response), 300); },
  });
  t.after(() => clearTimeout(delay));
  let clock = 1_000_000;
  const { dir, cache } = await cacheFor(t, f.origin, { now: () => clock, maxEntries: 2 });
  const fetches = () => f.hits.filter((hit) => hit.path === '/icon.png').length;
  const candidates = [`${f.origin}/icon.png`];
  assert.ok(await cache.discover('https://a.test', candidates));
  assert.ok(await cache.discover('https://a.test', candidates));
  assert.equal(fetches(), 1);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    for (const name of await fs.readdir(dir)) assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
  }
  const guard = createBrowserNetworkGuard({ workspaceTargets: [f.origin] });
  const restarted = createFaviconCache({ dir, resolve: guard.resolve, isWorkspace: guard.isWorkspace, now: () => clock });
  assert.equal(await restarted.get('https://a.test'), `data:image/png;base64,${PNG.toString('base64')}`, 'entries survive a hub restart');
  assert.equal(await restarted.get('https://unknown.test'), undefined);
  clock += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(await restarted.get('https://a.test'), undefined, 'entries expire after seven days');
  assert.ok(await cache.discover('https://a.test', candidates));
  assert.equal(fetches(), 2);
  await cache.discover('https://b.test', candidates);
  await cache.discover('https://c.test', candidates);
  assert.equal((await fs.readdir(dir)).filter((name) => name.endsWith('.json')).length, 2, 'the oldest entry is evicted');
  const pending = cache.discover('https://slow.test', [`${f.origin}/slow.png`]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const files = (await fs.readdir(dir)).length;
  await cache.clear();
  assert.equal(await pending, null);
  assert.equal((await fs.readdir(dir)).length, files, 'a fetch finishing after clear does not write');
  assert.equal(cache.peek('https://b.test'), undefined);
});

async function requireManagedChromium(t) {
  const runtime = await inspectOwnedBrowserRuntime();
  if (process.env.CI) assert.equal(runtime.installed, true, 'CI requires the locked Playwright Chromium installation.');
  if (runtime.installed) return true;
  t.skip('Managed Chromium is not installed; run the owned-browser installer.');
  return false;
}

test('real browser shows a page icon to the user only, never to the agent, and browser reset forgets it', async (t) => {
  if (!await requireManagedChromium(t)) return;
  const page = await fixture(t, {
    '/': send('text/html', '<title>Icon fixture</title><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" sizes="32x32" href="/icon.png"><h1>Research</h1>'),
    '/icon.png': send('image/png', PNG),
    '/logo.svg': send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  const related = await fixture(t, { '/favicon.ico': send('image/x-icon', multiIco()) });
  const unrelated = await fixture(t, { '/favicon.ico': send('image/x-icon', multiIco()) });
  const cross = await fixture(t, { '/': send('text/html', `<title>Cross icon</title><link rel="icon" href="${unrelated.origin}/favicon.ico">`) });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-favicon-runtime-'));
  const sitePolicy = createBrowserPolicy({ dataDir });
  // 에이전트는 unrelated 출처를 열 수 없다. 페이지가 그 출처의 아이콘을 선언해도 허브가 대신 받으면 안 된다.
  const policy = { ...sitePolicy, async assertAllowed(input) {
    if (!input.actor.isHuman && new URL(input.url).origin === unrelated.origin) throw Object.assign(new Error('blocked'), { code: 'BROWSER_PERMISSION_REQUIRED' });
    return sitePolicy.assertAllowed(input);
  } };
  const credentialBroker = createBrowserCredentialBroker({ dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 9) });
  const events = [];
  const browser = createOwnedBrowserService({ dataDir, policy, credentialBroker, autoInstall: false, workspaceTargets: [page.origin, related.origin, unrelated.origin, cross.origin],
    faviconOrigins: () => [related.origin], onEvent: (event) => events.push(event) });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const agent = { sessionId: 'window', agentId: 'chat-a:root', threadId: 'chat-a', projectId: null };
  const human = { isHuman: true, clientId: 'window', sessionId: 'window', threadId: 'chat-a', agentId: 'chat-a:root' };
  const opened = await browser.request(agent, 'open', { url: `${page.origin}/` });
  const deadline = Date.now() + 8000;
  let published;
  while (!(published = events.find((event) => event.type === 'owned_browser_tab' && event.tab.tabId === opened.tab.tabId && event.tab.faviconUrl)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const icon = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.equal(published?.tab.faviconUrl, icon);
  assert.equal(page.hits.some((hit) => hit.path === '/logo.svg'), false, 'SVG icons are never fetched by the hub');
  assert.equal((await browser.inventory(human)).tabs[0].faviconUrl, icon);
  assert.equal((await browser.request(human, 'snapshot', { tabId: opened.tab.tabId })).tab.faviconUrl, icon);
  // 에이전트가 받는 결과, browser_status, tabs.json에는 아이콘이 없다.
  const agentResults = [opened, await browser.request(agent, 'status'), await browser.inventory(agent), await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })];
  const stored = await fs.readFile(path.join(dataDir, 'browser', 'tabs.json'), 'utf8');
  for (const value of [...agentResults.map((result) => JSON.stringify(result)), stored]) {
    assert.equal(value.includes('faviconUrl'), false);
    assert.equal(value.includes('data:image'), false);
  }
  await browser.request(agent, 'open', { url: `${cross.origin}/` });
  while (!cross.hits.some((hit) => hit.path === '/favicon.ico') && !unrelated.hits.length && Date.now() < deadline + 4000) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(unrelated.hits.length, 0, 'icon fetches pass the same site policy as the tab');
  assert.ok(cross.hits.some((hit) => hit.path === '/favicon.ico'), 'the blocked candidate falls through to the page origin');
  await assert.rejects(browser.request(agent, 'favicons.get', { origins: [page.origin] }), { code: 'BROWSER_HUMAN_REQUIRED' });
  await assert.rejects(browser.request(human, 'favicons.get', { origins: Array.from({ length: 51 }, (_, index) => `https://site${index}.test`) }), { code: 'BROWSER_FAVICONS_INVALID' });
  const { icons } = await browser.request(human, 'favicons.get', { origins: [page.origin, related.origin, unrelated.origin, 'http://plain.test', 'not a url'] });
  assert.equal(icons[page.origin], icon);
  assert.match(icons[related.origin], /^data:image\/x-icon;base64,/);
  assert.equal(icons[unrelated.origin], null);
  assert.equal(icons['http://plain.test'], null);
  assert.equal(icons['not a url'], null);
  assert.equal(unrelated.hits.length, 0, 'origins without a user relationship are never fetched');
  assert.ok((await fs.readdir(path.join(dataDir, 'browser', 'favicons'))).length >= 2);
  await browser.request(human, 'reset-browser');
  await assert.rejects(fs.access(path.join(dataDir, 'browser', 'favicons')), { code: 'ENOENT' });
  const afterReset = await browser.request(human, 'favicons.get', { origins: [page.origin] });
  assert.equal(afterReset.icons[page.origin], null, 'forgetting browser data forgets cached icons');
});
