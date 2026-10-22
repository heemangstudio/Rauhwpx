import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBrowserWatchService, diffWatchText, normalizeWatchText, WATCH_LIMITS } from '../browser-watch.mjs';

const actor = (threadId = 'thread-a') => ({ threadId, documentId: 'doc-1', projectId: null, agentId: `${threadId}:root`, isHuman: false });

function harness(dataDir, { pages = new Map(), tabs = [] } = {}) {
  let clock = 1_000_000;
  const timers = new Map();
  let nextTimer = 1;
  const notices = [];
  const changes = [];
  const reads = [];
  const browser = {
    pages,
    async request(who, action, args) {
      if (action === 'status') return { ok: true, tabs };
      assert.equal(action, 'read-many');
      reads.push({ who, args });
      const entry = pages.get(args.urls[0]);
      if (entry instanceof Error) throw entry;
      if (!entry) return { ok: true, action, pages: [{ url: args.urls[0], ok: false, error: { code: 'BROWSER_ACTION_TIMEOUT', message: 'slow' } }] };
      return { ok: true, action, pages: [{ url: args.urls[0], ok: true, title: entry.title, text: entry.text }] };
    },
  };
  const service = createBrowserWatchService({
    dataDir, ownedBrowser: browser,
    onNotice: (notice) => notices.push(notice),
    onChange: (threadId) => changes.push(threadId),
    now: () => clock,
    random: () => 0,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return { id, unref() {} }; },
    clearTimer: (handle) => timers.delete(handle?.id),
  });
  return {
    service, notices, changes, reads, timers, browser,
    advance(ms) { clock += ms; },
    now: () => clock,
    /** 때가 된 타이머를 돌리고 그 확인이 끝나기를 기다린다. */
    async fire() {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      await service.idle();
    },
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-watch-'));
}

test('normalize and diff report added and removed lines only', () => {
  assert.equal(normalizeWatchText('  a   b \n\n​c\r\n'), 'a b\nc');
  const diff = diffWatchText('one\ntwo\nthree', 'two\none\nfour');
  assert.deepEqual(diff.added, ['four']);
  assert.deepEqual(diff.removed, ['three']);
  assert.equal(diffWatchText('x\ny', 'y\nx').addedCount, 0);
});

test('create validates interval, target and per-chat caps', async () => {
  const dir = await tempDir();
  const pages = new Map();
  for (let index = 0; index < 7; index += 1) pages.set(`https://example.com/${index}`, { title: `P${index}`, text: 'hello' });
  const h = harness(dir, { pages });
  await assert.rejects(h.service.create(actor(), { url: 'https://example.com/0', intervalMinutes: 5 }), { code: 'INVALID_ARGS' });
  await assert.rejects(h.service.create(actor(), { url: 'https://example.com/0', intervalMinutes: WATCH_LIMITS.maxIntervalMinutes + 1 }), { code: 'INVALID_ARGS' });
  await assert.rejects(h.service.create(actor(), { url: 'file:///etc/passwd' }), { code: 'INVALID_ARGS' });
  await assert.rejects(h.service.create({ ...actor(), isHuman: true }, { url: 'https://example.com/0' }), { code: 'BROWSER_SCOPE_REQUIRED' });
  for (let index = 0; index < WATCH_LIMITS.perChat; index += 1) await h.service.create(actor(), { url: `https://example.com/${index}` });
  await assert.rejects(h.service.create(actor(), { url: 'https://example.com/6' }), { code: 'BROWSER_WATCH_LIMIT' });
  // 다른 채팅은 따로 센다.
  await h.service.create(actor('thread-b'), { url: 'https://example.com/6' });
  // 같은 주소를 다시 맡기면 새로 만들지 않는다.
  const again = await h.service.create(actor(), { url: 'https://example.com/0' });
  assert.equal(again.existing, true);
  assert.equal(h.service.list('thread-a').length, WATCH_LIMITS.perChat);
  // 다시 읽기는 채팅의 감시 전용 에이전트로 한다.
  assert.equal(h.reads[0].who.agentId, 'thread-a:watch');
  assert.equal(h.reads[0].who.threadId, 'thread-a');
  assert.equal(h.reads[0].who.documentId, 'doc-1');
  await h.service.close();
});

test('tabId resolves the tab URL the agent can see', async () => {
  const dir = await tempDir();
  const h = harness(dir, { pages: new Map([['https://example.com/news', { title: 'News', text: 'a' }]]), tabs: [{ tabId: 'tab-1', url: 'https://example.com/news#top' }] });
  const created = await h.service.create(actor(), { tabId: 'tab-1' });
  assert.equal(created.watch.url, 'https://example.com/news');
  await assert.rejects(h.service.create(actor(), { tabId: 'tab-missing' }), { code: 'BROWSER_TAB_NOT_FOUND' });
  await h.service.close();
});

test('a change notifies once with a diff; an unchanged page stays quiet', async () => {
  const dir = await tempDir();
  const url = 'https://example.com/board';
  const h = harness(dir, { pages: new Map([[url, { title: 'Board', text: 'notice one\nnotice two' }]]) });
  const { watch } = await h.service.create(actor(), { url, intervalMinutes: 15 });
  assert.equal(h.timers.size, 1);
  h.advance(15 * 60_000);
  await h.fire();
  assert.equal(h.notices.length, 0);
  h.browser.pages.set(url, { title: 'Board', text: 'notice zero\nnotice one\nnotice two' });
  h.advance(15 * 60_000);
  await h.fire();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].kind, 'changed');
  assert.equal(h.notices[0].watchId, watch.watchId);
  assert.equal(h.notices[0].threadId, 'thread-a');
  assert.deepEqual(h.notices[0].added, ['notice zero']);
  assert.deepEqual(h.notices[0].removed, []);
  // 같은 글을 다시 읽으면 알리지 않는다.
  h.advance(15 * 60_000);
  await h.fire();
  assert.equal(h.notices.length, 1);
  assert.equal(h.service.pendingNotices().length, 1);
  await h.service.ack([h.notices[0].noticeId]);
  assert.equal(h.service.pendingNotices().length, 0);
  await h.service.close();
});

test('a policy denial pauses the watch and notifies once; read errors back off', async () => {
  const dir = await tempDir();
  const url = 'https://example.com/private';
  const h = harness(dir, { pages: new Map([[url, { title: 'Private', text: 'x' }]]) });
  await h.service.create(actor(), { url, intervalMinutes: 15 });
  h.browser.pages.delete(url);
  h.advance(15 * 60_000);
  await h.fire();
  const [backoff] = [...h.timers.values()];
  assert.equal(backoff.at - h.now(), 2 * 15 * 60_000, 'one failure doubles the interval');
  assert.equal(h.notices.length, 0, 'a timeout is retried quietly');
  h.browser.pages.set(url, Object.assign(new Error('needs access'), { code: 'BROWSER_PERMISSION_REQUIRED' }));
  h.advance(60 * 60_000);
  await h.fire();
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].kind, 'paused');
  assert.equal(h.service.list('thread-a')[0].status, 'paused');
  assert.equal(h.timers.size, 0, 'a paused watch has no timer');
  // 처음 만들 때의 거절은 에이전트에게 그대로 간다.
  await assert.rejects(h.service.create(actor(), { url }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  await h.service.close();
});

test('watches and undelivered notices survive a restart', async () => {
  const dir = await tempDir();
  const url = 'https://example.com/a';
  const first = harness(dir, { pages: new Map([[url, { title: 'A', text: 'v1' }]]) });
  const { watch } = await first.service.create(actor(), { url, find: 'v', intervalMinutes: 30 });
  first.browser.pages.set(url, { title: 'A', text: 'v2' });
  await first.service.checkNow(watch.watchId);
  assert.equal(first.notices.length, 1);
  await first.service.close();
  const stat = await fs.stat(path.join(dir, 'browser', 'watches.json'));
  assert.equal(stat.mode & 0o777, 0o600);

  const second = harness(dir, { pages: new Map([[url, { title: 'A', text: 'v2' }]]) });
  await second.service.ready();
  const [restored] = second.service.list('thread-a');
  assert.equal(restored.watchId, watch.watchId);
  assert.equal(restored.find, 'v');
  assert.equal(second.timers.size, 1);
  assert.equal(second.service.pendingNotices().length, 1);
  await second.service.checkNow(watch.watchId);
  assert.equal(second.notices.length, 0, 'the stored text is the baseline after restart');
  assert.equal(second.reads[0].args.find, 'v');
  await second.service.close();
});

test('cancel and ending a chat stop its timers and drop its notices', async () => {
  const dir = await tempDir();
  const pages = new Map([['https://example.com/1', { title: '1', text: 'a' }], ['https://example.com/2', { title: '2', text: 'b' }]]);
  const h = harness(dir, { pages });
  const one = await h.service.create(actor(), { url: 'https://example.com/1' });
  await h.service.create(actor(), { url: 'https://example.com/2' });
  await h.service.create(actor('thread-b'), { url: 'https://example.com/1' });
  assert.equal(h.timers.size, 3);
  await assert.rejects(h.service.cancel(one.watch.watchId, { threadId: 'thread-b' }), { code: 'BROWSER_WATCH_NOT_FOUND' });
  await h.service.cancel(one.watch.watchId, { threadId: 'thread-a' });
  assert.equal(h.timers.size, 2);
  pages.set('https://example.com/2', { title: '2', text: 'c' });
  const [second] = h.service.list('thread-a');
  await h.service.checkNow(second.watchId);
  assert.equal(h.service.pendingNotices().length, 1);
  const ended = await h.service.endThread('thread-a');
  assert.equal(ended.removed, 1);
  assert.equal(h.service.list('thread-a').length, 0);
  assert.equal(h.service.pendingNotices().length, 0);
  assert.equal(h.timers.size, 1, 'the other chat keeps its watch');
  assert.ok(h.changes.includes('thread-a'));
  await h.service.close();
  assert.equal(h.timers.size, 0);
});

test('a real Chromium re-read detects the changed line through read-many', async (t) => {
  const { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } = await import('../owned-browser-runtime.mjs');
  const { createOwnedBrowserService } = await import('../owned-browser-service.mjs');
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const { createServer } = await import('node:http');
  let body = '<p>첫 공지</p><p>둘째 공지</p>';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>게시판</title><main>${body}</main>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = await tempDir();
  const ownedBrowser = createOwnedBrowserService({ dataDir, policy: { assertAllowed: async () => {} }, workspaceTargets: [origin], autoInstall: false, runtimeFactory: (options) => startOwnedBrowserRuntime(options) });
  const notices = [];
  const watches = createBrowserWatchService({ dataDir, ownedBrowser, onNotice: (notice) => notices.push(notice) });
  t.after(async () => { await watches.close(); await ownedBrowser.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const { watch } = await watches.create(actor(), { url: `${origin}/board` });
  assert.equal(watch.title, '게시판');
  body = '<p>새 공지</p><p>첫 공지</p><p>둘째 공지</p>';
  await watches.checkNow(watch.watchId);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].added, ['새 공지']);
  const status = await ownedBrowser.request({ ...actor(), agentId: 'thread-a:watch' }, 'status', {});
  assert.equal(status.tabs.filter((tab) => tab.agentId === 'thread-a:watch').length, 0, 'the research tab is closed after each read');
});
