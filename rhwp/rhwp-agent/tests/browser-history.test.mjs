import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createBrowserHistory } from '../browser-history.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';

const tempDir = async (t) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-history-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };

test('history stores sanitized URLs only: no credentials, fragments, tracking or signed values on disk or in results', async (t) => {
  const file = path.join(await tempDir(t), 'browser', 'history.json');
  const history = createBrowserHistory({ file });
  const signed = 'https://user:PRIVATE_PASS@files.example.com/report.pdf?id=7&X-Amz-Signature=PRIVATE_SIGNATURE&token=PRIVATE_TOKEN&utm_source=mail&blob=' + 'A'.repeat(48) + '#PRIVATE_FRAGMENT';
  assert.equal(await history.record({ url: signed, title: '  보고서\n  2026 ', profileId: 'default' }), true);
  const raw = await fs.readFile(file, 'utf8');
  for (const secret of ['PRIVATE_PASS', 'PRIVATE_SIGNATURE', 'PRIVATE_TOKEN', 'utm_source', 'AAAAAAAA', 'PRIVATE_FRAGMENT', 'user']) assert.ok(!raw.includes(secret), `${secret} reached disk`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const [entry] = await history.list({ profileId: 'default' });
  assert.equal(entry.url, 'https://files.example.com/report.pdf?id=7');
  assert.equal(entry.title, '보고서 2026');
});

test('history skips non-web and sign-in pages', async (t) => {
  const history = createBrowserHistory({ file: path.join(await tempDir(t), 'history.json') });
  for (const url of ['about:blank', 'data:text/html,hi', 'file:///etc/passwd', 'chrome-error://chromewebdata/', 'https://example.com/login', 'https://accounts.example.com/oauth2/authorize?x=1', 'https://example.com/member/sign-in.do']) {
    assert.equal(await history.record({ url, title: 'x', profileId: 'default' }), false, url);
  }
  assert.deepEqual(await history.list({ profileId: 'default' }), []);
});

test('history dedupes by URL, evicts the least recent past its bound, ranks frequent sites first and scopes to a profile', async (t) => {
  let clock = 1_000_000;
  const file = path.join(await tempDir(t), 'history.json');
  const history = createBrowserHistory({ file, limit: 3, now: () => clock });
  for (const name of ['a', 'b', 'a', 'c', 'a', 'c', 'd']) { clock += 1000; await history.record({ url: `https://${name}.example.com/`, title: name.toUpperCase(), profileId: 'default' }); }
  await history.record({ url: 'https://native.example.com/', title: 'N', profileId: 'native' });
  // 한도를 넘으면 가장 오래 안 간 주소(b, 그다음 a)부터 밀려난다.
  const listed = await history.list({ profileId: 'default' });
  assert.ok(!listed.some((entry) => entry.url.startsWith('https://b.')));
  assert.equal(listed[0].url, 'https://c.example.com/');
  assert.equal(listed[0].visits, 2);
  assert.deepEqual((await history.list({ profileId: 'native' })).map((entry) => entry.title), ['N']);
  assert.deepEqual((await history.list({ profileId: 'default', query: 'D' })).map((entry) => entry.url), ['https://d.example.com/']);
  // 다시 읽어도 같은 기록이다.
  const reloaded = createBrowserHistory({ file, limit: 3, now: () => clock });
  assert.deepEqual(await reloaded.list({ profileId: 'default' }), listed);
});

test('forget removes a page that later showed a saved password', async (t) => {
  const history = createBrowserHistory({ file: path.join(await tempDir(t), 'history.json') });
  await history.record({ url: 'https://bank.example.com/account', title: '계좌', profileId: 'native' });
  assert.equal(await history.forget({ url: 'https://bank.example.com/account#x', profileId: 'native' }), true);
  assert.deepEqual(await history.list({ profileId: 'native' }), []);
});

test('clear wipes the file and drops visits recorded before it ran', async (t) => {
  const file = path.join(await tempDir(t), 'history.json');
  const history = createBrowserHistory({ file });
  await history.record({ url: 'https://law.go.kr/', title: '국가법령정보센터', profileId: 'default' });
  const late = history.record({ url: 'https://www.g2b.go.kr/', title: '나라장터', profileId: 'default' });
  await history.clear();
  assert.equal(await late, false);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.deepEqual(await history.list({ profileId: 'default' }), []);
});

// 서비스 연결: 페이지 이벤트를 흉내 내는 가짜 런타임. 탭마다 새 페이지다.
function fakeRuntime(titles) {
  const newPage = () => {
    let current = 'about:blank';
    const frame = {};
    const page = Object.assign(new EventEmitter(), {
      url: () => current, isClosed: () => false, frames: () => [], mainFrame: () => frame, async routeWebSocket() {}, async close() {},
      async goto(url) { current = url; page.emit('framenavigated', frame); page.emit('domcontentloaded'); },
      async title() { return titles[current.split('#')[0]] ?? 'Page'; }, async evaluate() { return 'complete'; },
      locator: () => ({ async elementHandles() { return []; }, async count() { return 0; }, async innerText() { return ''; } }),
      async ariaSnapshotJSON() { return []; }, mouse: { async up() {} }, keyboard: { async up() {} },
    });
    return page;
  };
  const context = Object.assign(new EventEmitter(), {
    async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [], newPage: async () => newPage(),
    async newCDPSession() { return { async send() { return { targetInfo: {} }; }, async detach() {} }; },
  });
  return async () => ({ kind: 'chromium', context, browser: new EventEmitter(), async close() {} });
}

test('the browser service records user visits only and browser_status { history } hides blocked and unapproved signed-in sites', async (t) => {
  const dataDir = await tempDir(t);
  await fs.writeFile(path.join(dataDir, 'browser-policy.json'), JSON.stringify({ schema: 2, ownerId: 'owner', sites: [] }));
  let resetter;
  const credentialBroker = {
    setDataResetter: (callback) => { resetter = callback; },
    async resetBrowserData() { await resetter({ phase: 'before' }); await resetter({ phase: 'after' }); return {}; },
  };
  const policy = {
    check: async ({ url }) => new URL(url).hostname.startsWith('mail.') ? { allowed: false, code: 'BROWSER_PERMISSION_REQUIRED', reason: 'signed-in' } : { allowed: true },
    blockedActionsFor: async (origin) => origin.includes('blocked') ? ['browse'] : [],
  };
  const titles = { 'https://www.law.go.kr/LSW/main.html': '국가법령정보센터', 'https://mail.example.com/inbox/42': '홍길동 받은편지함' };
  const browser = createOwnedBrowserService({ dataDir, policy, credentialBroker, lookup: async () => { throw Object.assign(new Error('offline fixture'), { code: 'ENOTFOUND' }); }, runtimeFactory: fakeRuntime(titles) });
  t.after(() => browser.close());
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const agent = { threadId: 'chat', agentId: 'chat:root', sessionId: 'window' };
  const visit = (url) => browser.request(human, 'open', { url });
  await visit('https://www.law.go.kr/LSW/main.html');
  await visit('https://www.law.go.kr/LSW/main.html#top');
  await visit('https://mail.example.com/inbox/42');
  await visit('https://blocked.example.com/');
  await visit('https://www.google.com/search?q=private+query');
  // 에이전트가 연 페이지는 사용자가 자주 가는 곳이 아니다.
  await browser.request(agent, 'open', { url: 'https://agent-only.example.com/' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = await browser.request(agent, 'status', { history: '' });
  const urls = status.history.map((entry) => entry.url);
  assert.equal(status.history[0].url, 'https://www.law.go.kr/LSW/main.html');
  assert.equal(status.history[0].title, '국가법령정보센터');
  assert.equal(status.history[0].visits, 2);
  assert.match(status.history[0].lastVisited, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(status.history.find((entry) => entry.url.startsWith('https://mail.')), { title: '', url: 'https://mail.example.com/', visits: 1, lastVisited: status.history[0].lastVisited, signedIn: true });
  for (const hidden of ['blocked.example.com', 'google.com', 'agent-only.example.com']) assert.ok(!urls.some((url) => url.includes(hidden)), hidden);
  assert.ok(!JSON.stringify(status.history).includes('홍길동'));
  assert.deepEqual((await browser.request(agent, 'status', { history: '법령' })).history.map((entry) => entry.url), ['https://www.law.go.kr/LSW/main.html']);
  assert.equal((await browser.request(agent, 'status', {})).history, undefined, 'status stays small unless asked');

  // 브라우저 데이터 지우기가 방문 기록도 지운다.
  await browser.request(human, 'reset-browser', {});
  await assert.rejects(fs.stat(path.join(dataDir, 'browser', 'history.json')), { code: 'ENOENT' });
  assert.deepEqual((await browser.request(agent, 'status', { history: '' })).history, []);
});
