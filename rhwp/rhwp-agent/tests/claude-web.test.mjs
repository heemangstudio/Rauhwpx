import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { claudeActor, claudeChatUrl, createClaudeDriver, createClaudeStore } from '../claude-web.mjs';
import { createClaudeFixture } from './fixtures/claude-web.mjs';

const browserReady = existsSync(chromium.executablePath());
const skip = browserReady ? false : 'Managed Chromium is not installed (node rhwp/rhwp-agent/node_modules/playwright/cli.js install chromium)';

const PROJECT = { uuid: '5e0c3b1a-7d2f-4a6b-9c8d-0e1f2a3b4c5d', name: 'HamaEditor' };
const PROJECT_URL = `https://claude.ai/project/${PROJECT.uuid}`;

async function harness(t, fixtureOptions = {}, driverOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-claude-'));
  const store = createClaudeStore({ filePath: path.join(dir, 'claude.json') });
  await store.ready();
  await store.setEnabled(true);
  const fixture = createClaudeFixture(fixtureOptions);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/*', (route) => fixture.handle(route));
  let page = null;
  const drives = [];
  // owned-browser-service.drive 의 계약: Claude 행위자의 탭 하나, 처음에는 url 로 연다.
  const owned = {
    native: true,
    available: () => owned.native,
    async drive(actor, { url }, operation) {
      drives.push({ actor, url });
      if (!page) { page = await context.newPage(); await page.goto(url); }
      return operation(page);
    },
  };
  const driver = createClaudeDriver({ browser: owned, store, pollMs: 50, stepTimeoutMs: 2_000, timeoutMs: 15_000, ...driverOptions });
  t.after(async () => { await browser.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { store, fixture, driver, owned, drives, page: () => page };
}

test('the first question creates the HamaEditor project, sends with the send button and follows the new chat', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [
    { uuid: '11111111-2222-4333-8444-555555555555', name: 'Other' },
    { uuid: '66666666-7777-4888-9999-aaaaaaaaaaaa', name: 'HamaEditor', archived_at: '2026-09-01T00:00:00Z' },
  ] });
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '내가 좋아하는 말투는?', sessionId: 'window-1' });

  const created = h.fixture.state.projects.filter((project) => project.name === 'HamaEditor' && !project.archived_at);
  assert.equal(created.length, 1, 'an archived HamaEditor project is not reused; one new project is made');
  assert.equal(h.store.projectUrl(), `https://claude.ai/project/${created[0].uuid}`);

  assert.equal(result.answer, '**답**: 내가 좋아하는 말투는?\n\n- 항목');
  assert.equal(claudeChatUrl(result.chatUrl), result.chatUrl);
  assert.equal(h.page().url(), result.chatUrl, 'the tab followed the project page to /chat/<uuid>');
  assert.equal(h.store.chatUrl('thread-1'), result.chatUrl);
  assert.deepEqual(h.fixture.state.sent, [{ conversationId: result.chatUrl.split('/chat/')[1], projectId: created[0].uuid, prompt: '내가 좋아하는 말투는?' }]);
  assert.deepEqual(h.drives[0].actor, claudeActor('window-1'));
});

test('a leftover draft in the composer is cleared and exactly the question is sent', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [PROJECT], draft: '못 보낸 초안' });
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '세 줄로 요약해줘' });
  assert.deepEqual(h.fixture.state.sent.map((entry) => entry.prompt), ['세 줄로 요약해줘'], 'the draft is neither sent nor prepended');
  assert.equal(result.answer, '**답**: 세 줄로 요약해줘\n\n- 항목');
  assert.equal(h.store.projectUrl(), PROJECT_URL, 'the existing project is found');
  assert.equal(h.fixture.state.projects.length, 1, 'and never duplicated');
});

test('a follow-up continues the same Claude chat and reads only the current branch', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { projects: [PROJECT], retries: true });
  const first = await h.driver.ask({ chatKey: 'thread-1', question: '나에 대해 기억하는 것은?' });
  assert.equal(first.answer, '**답**: 나에 대해 기억하는 것은?\n\n- 항목', 'an older retry branch is not mixed into the answer');

  // 다른 곳에 가 있다가 다시 묻는다. 기억한 채팅을 다시 연다.
  await h.page().goto(PROJECT_URL);
  const second = await h.driver.ask({ chatKey: 'thread-1', question: '다섯 단어로 줄여줘' });
  assert.equal(second.chatUrl, first.chatUrl);
  assert.equal(second.answer, '**답**: 다섯 단어로 줄여줘\n\n- 항목', 'the previous answer is never returned again');
  assert.equal(h.fixture.state.conversations.size, 1);
  assert.deepEqual(h.fixture.state.sent.map((entry) => [entry.conversationId, entry.prompt]), [
    [first.chatUrl.split('/chat/')[1], '나에 대해 기억하는 것은?'],
    [first.chatUrl.split('/chat/')[1], '다섯 단어로 줄여줘'],
  ]);

  // 다른 HamaEditor 채팅은 같은 프로젝트의 새 Claude 채팅이 된다.
  const other = await h.driver.ask({ chatKey: 'thread-2', question: '다른 채팅' });
  assert.notEqual(other.chatUrl, first.chatUrl);
  assert.equal(h.fixture.state.conversations.size, 2);
  assert.equal(h.fixture.state.sent.at(-1).projectId, PROJECT.uuid);
});

test('signed-out Claude.ai is reported without sending, and the next ask works once the user signs in', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { signedIn: false, projects: [PROJECT] });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CLAUDE_SIGNED_OUT' });
  assert.equal(h.fixture.state.completions, 0);
  assert.equal(h.store.chatUrl('thread-1'), null);
  assert.deepEqual(await h.driver.status({ check: true }), { enabled: true, available: true, projectUrl: null, signedIn: false });

  h.fixture.state.signedIn = true;
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '이제 될까?' });
  assert.equal(result.answer, '**답**: 이제 될까?\n\n- 항목');
});

test('a Cloudflare challenge (403 + cf-mitigated) asks for the user instead of retrying', { skip, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { challenge: true, projects: [PROJECT] });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CLAUDE_CHALLENGE' });
  assert.equal(h.fixture.state.completions, 0);
  assert.equal(h.store.projectUrl(), null);

  h.fixture.state.challenge = false;
  const result = await h.driver.ask({ chatKey: 'thread-1', question: '확인 끝' });
  assert.equal(result.answer, '**답**: 확인 끝\n\n- 항목');
});

test('a 429 from the completion endpoint is reported as CLAUDE_LIMIT with the reset time', { skip, timeout: 60_000 }, async (t) => {
  const reset = Date.UTC(2026, 9, 28, 18, 0, 0) / 1000;
  // 기한(여기서 20초)까지 기다리지 않고 한도를 받자마자 알려야 한다.
  const h = await harness(t, { projects: [PROJECT], limit: reset }, { timeoutMs: 20_000 });
  const started = Date.now();
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), (error) => {
    assert.equal(error.code, 'CLAUDE_LIMIT');
    assert.match(error.message, /resets 2026-10-28T18:00:00\.000Z/);
    return true;
  });
  assert.ok(Date.now() - started < 10_000, `the limit is reported right away, not at the deadline (${Date.now() - started} ms)`);
  assert.equal(h.fixture.state.completions, 1, 'the question was submitted once');
  assert.equal(h.fixture.state.sent.length, 0, 'and Claude.ai accepted nothing');
});

test('selector drift stops with CLAUDE_UI_CHANGED and never guesses', { skip, timeout: 90_000 }, async (t) => {
  for (const drift of ['composer', 'send-button', 'projects']) {
    const h = await harness(t, { drift, projects: [PROJECT] });
    await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CLAUDE_UI_CHANGED' }, drift);
    assert.equal(h.fixture.state.completions, 0, `${drift}: nothing is sent`);
    assert.equal(h.store.chatUrl('thread-1'), null, `${drift}: no chat is remembered`);
  }
  // 보낸 뒤 대화 조회 모양이 바뀌었으면 멈추되, 이미 생긴 채팅은 다음 질문이 이어 가게 기억한다.
  const h = await harness(t, { drift: 'conversation', projects: [PROJECT] });
  await assert.rejects(h.driver.ask({ chatKey: 'thread-1', question: 'q' }), { code: 'CLAUDE_UI_CHANGED' });
  assert.equal(h.fixture.state.sent.length, 1);
  assert.equal(h.store.chatUrl('thread-1'), `https://claude.ai/chat/${h.fixture.state.sent[0].conversationId}`);
});

test('status({ check: true }) reports the signed-in account', { skip, timeout: 30_000 }, async (t) => {
  const h = await harness(t, { projects: [PROJECT] });
  assert.deepEqual(await h.driver.status(), { enabled: true, available: true, projectUrl: null, signedIn: null }, 'no tab is opened without check');
  assert.equal(h.drives.length, 0);
  assert.deepEqual(await h.driver.status({ check: true, sessionId: 'window-1' }),
    { enabled: true, available: true, projectUrl: null, signedIn: true, account: 'user@example.com' });
  assert.deepEqual(h.drives[0].actor, claudeActor('window-1'));
  assert.equal(h.fixture.state.completions, 0);
});
