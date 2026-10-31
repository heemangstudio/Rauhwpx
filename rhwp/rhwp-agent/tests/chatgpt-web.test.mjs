import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { CHATGPT_ACTOR, chatgptChatUrl, chatgptProjectUrl, createChatgptDriver, createChatgptStore } from '../chatgpt-web.mjs';
import { createChatgptFixture } from './fixtures/chatgpt-web.mjs';

const browserReady = existsSync(chromium.executablePath());
const skip = browserReady ? false : 'Managed Chromium is not installed (node rhwp/rhwp-agent/node_modules/playwright/cli.js install chromium)';

const PROJECT = { id: 'g-p-0123456789abcdef0123456789abcdef', name: 'HamaEditor' };

async function harness(t, fixtureOptions = {}, driverOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chatgpt-'));
  const store = createChatgptStore({ filePath: path.join(dir, 'chatgpt.json') });
  await store.ready();
  await store.setEnabled(true);
  const fixture = createChatgptFixture(fixtureOptions);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/*', (route) => fixture.handle(route));
  let page = null;
  const drives = [];
  // owned-browser-service.drive 의 계약: ChatGPT 행위자의 탭 하나, 처음에는 url 로 연다.
  const owned = {
    native: true,
    available: () => owned.native,
    async drive(actor, { url }, operation) {
      drives.push({ actor, url });
      if (!page) { page = await context.newPage(); await page.goto(url); }
      return operation(page);
    },
  };
  const driver = createChatgptDriver({ browser: owned, store, pollMs: 50, stepTimeoutMs: 2_000, timeoutMs: 15_000, ...driverOptions });
  t.after(async () => { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { store, fixture, driver, owned, drives, dir, page: () => page };
}

test('ask finds the HamaEditor project, binds the new turn and returns the markdown answer', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [{ id: 'g-p-ffffffffffffffffffffffffffffffff', name: 'Other' }, PROJECT] });
  const first = await h.driver.ask({ chatKey: 'thread-1', question: '내가 좋아하는 말투는?', sessionId: 'window-1' });
  assert.equal(first.answer, '**답**: 내가 좋아하는 말투는?\n\n- 항목', 'citation markers are removed and markdown is kept');
  assert.ok(chatgptChatUrl(first.chatUrl), first.chatUrl);
  assert.match(first.chatUrl, new RegExp(`/g/${PROJECT.id}-hamaeditor/c/`));
  assert.equal(h.store.projectUrl(), `https://chatgpt.com/g/${PROJECT.id}-hamaeditor/project`);
  assert.equal(h.store.chatUrl('thread-1'), first.chatUrl);
  // 허브의 ChatGPT 행위자가 묻는 편집기 창에 탭을 붙인다.
  assert.deepEqual(h.drives[0].actor, { ...CHATGPT_ACTOR, sessionId: 'window-1' });
  assert.equal(h.fixture.state.projects.length, 2, 'an existing project is reused, never duplicated');

  // 같은 HamaEditor 채팅의 다음 질문은 같은 ChatGPT 채팅을 잇고, 앞선 차례의 답을 다시 돌려주지 않는다.
  const second = await h.driver.ask({ chatKey: 'thread-1', question: '한 단어로 요약' });
  assert.equal(second.chatUrl, first.chatUrl);
  assert.equal(second.answer, '**답**: 한 단어로 요약\n\n- 항목');
  assert.equal(h.fixture.state.conversations.size, 1);
  assert.deepEqual(h.fixture.state.sent.map((entry) => entry.question), ['내가 좋아하는 말투는?', '한 단어로 요약']);

  // 다른 HamaEditor 채팅은 새 ChatGPT 채팅이 된다.
  const other = await h.driver.ask({ chatKey: 'thread-2', question: '다른 채팅' });
  assert.notEqual(other.chatUrl, first.chatUrl);
  assert.equal(h.fixture.state.conversations.size, 2);
});

test('a follow-up waits out a late re-render and a leftover draft instead of returning the previous answer', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [PROJECT] });
  const first = await h.driver.ask({ chatKey: 'thread-1', question: '나에 대해 기억하는 것은?' });
  // 다시 연 채팅에서 옛 차례가 입력창보다 늦게 그려지고, 앞선 시도가 못 보낸 글이 입력창에 남아 있다.
  h.fixture.state.lateTurnsMs = 800;
  h.fixture.state.draft = '못 보낸 초안';
  await h.page().goto('https://chatgpt.com/');
  const second = await h.driver.ask({ chatKey: 'thread-1', question: '다섯 단어로 줄여줘' });
  assert.equal(second.chatUrl, first.chatUrl);
  assert.equal(second.answer, '**답**: 다섯 단어로 줄여줘\n\n- 항목', 'the previous turn is never mistaken for the new one');
  assert.deepEqual(h.fixture.state.sent.map((entry) => entry.question), ['나에 대해 기억하는 것은?', '다섯 단어로 줄여줘'], 'the stale draft is cleared, not sent');
});

test('ask creates the project with default memory when it does not exist', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [] });
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '첫 질문' });
  assert.equal(h.fixture.state.projects.length, 1);
  assert.equal(h.fixture.state.projects[0].name, 'HamaEditor');
  assert.equal(h.fixture.state.projects[0].memoryScope, 'unset', 'the dialog keeps ChatGPT default memory');
  assert.ok(chatgptProjectUrl(h.store.projectUrl()));
  assert.equal(result.answer, '**답**: 첫 질문\n\n- 항목');
});

test('signed-out ChatGPT is reported without sending anything', { skip, timeout: 30_000 }, async (t) => {
  const h = await harness(t, { signedIn: false, projects: [PROJECT] });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CHATGPT_SIGNED_OUT' });
  assert.equal(h.fixture.state.sent.length, 0);
  assert.deepEqual(await h.driver.status({ check: true }), { enabled: true, available: true, projectUrl: null, signedIn: false });
});

test('a Cloudflare challenge (403 + cf-mitigated) asks for the user instead of retrying', { skip, timeout: 30_000 }, async (t) => {
  const h = await harness(t, { challenge: true, projects: [PROJECT] });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CHATGPT_CHALLENGE' });
  assert.equal(h.fixture.state.sent.length, 0);
});

test('selector drift stops with CHATGPT_UI_CHANGED and never guesses', { skip, timeout: 60_000 }, async (t) => {
  for (const drift of ['composer', 'project-button', 'project-list', 'turns']) {
    const h = await harness(t, { drift, projects: drift === 'project-button' ? [] : [PROJECT] });
    await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CHATGPT_UI_CHANGED' }, drift);
    if (drift !== 'turns') assert.equal(h.fixture.state.sent.length, 0, `${drift}: nothing is sent`);
    assert.equal(h.store.chatUrl('thread-1') === null, drift !== 'turns', `${drift}: a sent chat is remembered for the follow-up`);
  }
});

test('an answer that never finishes times out', { skip, timeout: 30_000 }, async (t) => {
  const h = await harness(t, { projects: [PROJECT], answerDelayMs: 60_000 }, { timeoutMs: 3_000 });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CHATGPT_TIMEOUT' });
  assert.ok(h.store.chatUrl('thread-1'), 'the saved ChatGPT chat is kept for the next ask');
});

test('the driver refuses when ChatGPT is off or the app browser is not native', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chatgpt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createChatgptStore({ filePath: path.join(dir, 'chatgpt.json') });
  await store.ready();
  let drove = false;
  const owned = { native: true, available: () => owned.native, drive: async () => { drove = true; } };
  const driver = createChatgptDriver({ browser: owned, store });
  await assert.rejects(driver.ask({ chatKey: 't', question: 'q' }), { code: 'CHATGPT_DISABLED' });
  await store.setEnabled(true);
  owned.native = false;
  await assert.rejects(driver.ask({ chatKey: 't', question: 'q' }), { code: 'CHATGPT_UNAVAILABLE' });
  assert.equal(drove, false);
});

test('the store persists the opt-in and chat map and rejects foreign addresses', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chatgpt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'chatgpt.json');
  const store = createChatgptStore({ filePath });
  await store.ready();
  assert.equal(store.enabled(), false, 'off by default');
  const chat = `https://chatgpt.com/g/${PROJECT.id}-hamaeditor/c/6adc5c72-88e4-83e8-9af1-76f614c6b91b`;
  await store.setEnabled(true);
  await store.setChatUrl('thread-1', `${chat}?model=x#frag`);
  await store.setChatUrl('thread-2', 'https://evil.example/g/x/c/y');
  const reopened = createChatgptStore({ filePath });
  await reopened.ready();
  assert.equal(reopened.enabled(), true);
  assert.equal(reopened.chatUrl('thread-1'), chat);
  assert.equal(reopened.chatUrl('thread-2'), null);
  await fs.writeFile(filePath, '{broken');
  const corrupt = createChatgptStore({ filePath });
  await corrupt.ready();
  assert.equal(corrupt.enabled(), false, 'an unreadable file falls back to off');
});

test('waits for a slow page to finish loading instead of a fixed step time', { skip, timeout: 60_000 }, async (t) => {
  // 입력창은 3초 뒤에 뜨지만 그동안 리소스가 계속 들어온다. 진행이 이어지면 단계 한도(1초)를 넘어도 기다린다.
  const h = await harness(t, { projects: [PROJECT], slowComposer: { afterMs: 3_000, everyMs: 150 } }, { stepTimeoutMs: 1_000 });
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '천천히 뜨는 화면' });
  assert.ok(result.answer.includes('천천히 뜨는 화면'));
  assert.equal(h.fixture.state.sent.length, 1);
});
