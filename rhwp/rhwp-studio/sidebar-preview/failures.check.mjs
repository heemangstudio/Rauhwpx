import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

/**
 * Typed provider failures in the production sidebar against the preview mock: one notice per
 * failed turn with the actions that fit the class, login turning into 다시 시도, 다시 시도
 * resending the request, dismissal surviving a chat switch and a reload, and 리셋 후 이어서
 * sending on its own (or not, after 취소). Each kind is saved as a screenshot.
 */
const KINDS = [
  ['network', /에 연결하지 못했어요$/, ['retry']],
  ['auth', /로그인이 필요해요$/, ['login']],
  ['pi-auth', /^Pi 연결 설정이 필요해요$/, ['settings']],
  ['usage', /사용 한도에 도달했어요$/, ['resume', 'usage']],
  ['usage-soon', /사용 한도에 도달했어요$/, ['resume', 'usage']],
  ['credits', /^OpenRouter 크레딧이 부족해요$/, ['usage']],
  ['provider', /서버가 요청을 처리하지 못했어요$/, ['retry']],
  ['exited', /실행이 중간에 멈췄어요$/, ['retry']],
  ['cleanup', /프로세스를 정리하지 못했어요$/, []],
  ['cli-missing', /CLI를 찾지 못했어요$/, ['settings']],
  ['invalid', /^대화가 너무 길어 .+가 처리하지 못했어요$/, []],
  ['unknown', /작업 중 오류가 발생했어요$/, ['retry']],
  ['start', /CLI를 시작하지 못했어요$/, ['retry']],
  ['hub-restarted', /^에이전트 허브가 다시 시작되어 작업이 중단됐어요$/, ['retry']],
  ['legacy', /로그인이 필요해요$/, ['login']],
];

const notices = (page) => page.$$eval('.ag-failure-notice', (nodes) => nodes.map((node) => ({
  title: node.querySelector('.ag-failure-title')?.textContent ?? '',
  line: node.querySelector('.ag-failure-line')?.textContent ?? null,
  actions: [...node.querySelectorAll('.ag-failure-action')].map((button) => ({
    id: button.dataset.action, disabled: button.disabled,
  })),
  compact: node.classList.contains('ag-failure-notice-compact'),
  dismissed: node.classList.contains('ag-failure-notice-dismissed'),
})));
const snapshot = (page) => page.evaluate(() => window.sidebarPreview.snapshot());
const userBubbles = (page) => page.$$eval('.ag-msg-user', (nodes) => nodes.length);

async function openFailure(page, origin, kind, { reset = true } = {}) {
  await page.goto(`${origin}/?theme=light&width=480${reset ? '&reset=1' : ''}&scenario=error&failure=${kind}`, { waitUntil: 'networkidle0' });
  await composerReady(page);
}

/** 입력기가 실제로 보낼 수 있다 (보이는 잠금의 지연과 무관한 준비 플래그). */
async function composerReady(page) {
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
}

async function waitForNotices(page, count) {
  await page.waitForFunction((count) => document.querySelectorAll('.ag-failure-notice').length >= count
    && !window.sidebarPreview.bridge.isTurnRunning(), {}, count);
}

async function playFailure(page, count = 1) {
  await page.click('#play');
  await waitForNotices(page, count);
}

async function shot(page, artifacts, name) {
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, `failure-${name}.png`) });
}

export async function checkFailureNotices(page, origin, artifacts) {
  // One notice per kind, with the class's actions, and no duplicate raw error lines.
  for (const [kind, title, actions] of KINDS) {
    await openFailure(page, origin, kind);
    await playFailure(page);
    const shown = await notices(page);
    assert.equal(shown.length, 1, `${kind}: exactly one notice, got ${JSON.stringify(shown)}`);
    assert.match(shown[0].title, title, kind);
    assert.deepEqual(shown[0].actions.map((action) => action.id), actions, `${kind} actions`);
    const systemLines = await page.$$eval('.ag-msg-system:not(.ag-failure-notice)', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(systemLines.filter((text) => /Invalid API key|stream disconnected|Overloaded|ENOENT|오류 \(/.test(text)), [],
      `${kind}: the provider text is not repeated as a system line`);
    if (kind === 'cleanup') assert.equal(shown[0].line, '앱을 다시 시작한 뒤 계속해 주세요.');
    if (kind === 'usage') assert.match(shown[0].line ?? '', /^리셋 /, 'usage resolves the reset time from the quota report');
    await shot(page, artifacts, kind);
  }

  // 자세히 shows the redacted provider text, and only as text.
  await openFailure(page, origin, 'provider');
  await playFailure(page);
  await page.click('.ag-failure-detail-toggle');
  assert.match(await page.$eval('.ag-failure-detail', (node) => node.hidden ? '' : node.textContent), /Overloaded/);
  await shot(page, artifacts, 'provider-detail');

  // 다시 시도 resends the stored request as a new user turn; the old notice loses its actions.
  await openFailure(page, origin, 'network');
  await playFailure(page);
  const before = await snapshot(page);
  const bubblesBefore = await userBubbles(page);
  await page.click('.ag-failure-action[data-action="retry"]');
  await waitForNotices(page, 2);
  const after = await snapshot(page);
  assert.equal(after.messagesSent, before.messagesSent + 1, 'one resend');
  assert.equal(after.messageTexts.at(-1), before.messageTexts.at(-1), 'the same request text is sent again');
  assert.equal(await userBubbles(page), bubblesBefore + 1, 'the resend is a new user message');
  const [older, newer] = await notices(page);
  assert.equal(older.compact, true, 'an older notice keeps only its title');
  assert.deepEqual(older.actions, []);
  assert.equal(newer.compact, false);

  // 로그인 opens the connect flow; once the account is back the notice offers 다시 시도.
  await openFailure(page, origin, 'auth');
  await playFailure(page);
  const agent = await page.evaluate(() => window.sidebarPreview.bridge.getActiveAgent());
  await page.click('.ag-failure-action[data-action="login"]');
  await page.waitForSelector('.ag-agent-setup-overlay.ag-open');
  // The fixture login runs in the embedded terminal: pick the account, then confirm.
  await page.waitForSelector('.ag-setup-terminal .xterm-helper-textarea');
  await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('❯'));
  await page.focus('.ag-setup-terminal .xterm-helper-textarea');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ag-setup-terminal').textContent.includes('브라우저에서'));
  await page.keyboard.press('Enter');
  await page.waitForFunction((agent) => window.sidebarPreview.bridge.getActiveAgent() === agent
    && document.querySelector('.ag-failure-notice .ag-failure-line')?.textContent === '다시 연결됐어요', {}, agent);
  assert.deepEqual((await notices(page))[0].actions.map((action) => action.id), ['retry']);
  await page.keyboard.press('Escape');
  await shot(page, artifacts, 'auth-reconnected');

  // × collapses the notice; that survives a chat switch and a reload, and a new failure with the
  // same text still leaves a visible (compact) row.
  await openFailure(page, origin, 'provider');
  await playFailure(page);
  await page.click('.ag-failure-close');
  await page.waitForSelector('.ag-failure-notice-dismissed');
  const threadId = await page.evaluate(async () => (await window.sidebarPreview.threadStore.listThreads())
    .find((thread) => thread.messages.some((message) => message.kind === 'error'))?.id);
  assert.ok(threadId, 'the notice is stored in the thread');
  // Switch to a new chat and back through the sidebar's own chat switching.
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  await page.waitForFunction(() => document.querySelectorAll('.ag-failure-notice').length === 0);
  await page.evaluate((threadId) => window.sidebarPreview.sidebar.openThreadById(threadId), threadId);
  await page.waitForSelector('.ag-failure-notice');
  assert.deepEqual((await notices(page)).map((notice) => notice.dismissed), [true], 'still collapsed after a chat switch');
  await page.evaluate(() => window.sidebarPreview.threadStore.waitForThreadsPersistence());
  await openFailure(page, origin, 'provider', { reset: false });
  await page.waitForSelector('.ag-failure-notice');
  assert.deepEqual((await notices(page)).map((notice) => notice.dismissed), [true], 'still collapsed after a reload');
  await playFailure(page, 2);
  const repeated = await notices(page);
  assert.equal(repeated.length, 2, 'the same failure again still leaves a row');
  assert.equal(repeated[1].dismissed, true, 'it arrives collapsed, as dismissed');
  // 다시 보기 reopens the newest one with its actions.
  await page.evaluate(() => [...document.querySelectorAll('.ag-failure-notice')].at(-1).querySelector('.ag-failure-link').click());
  await page.waitForFunction(() => {
    const newest = [...document.querySelectorAll('.ag-failure-notice')].at(-1);
    return !newest.classList.contains('ag-failure-notice-dismissed') && newest.querySelector('.ag-failure-action');
  });
  await shot(page, artifacts, 'dismissed');

  // A failed turn holds the follow-up queue with the failure's reason (a usage limit with its reset
  // time); 다시 시도 releases it, so the queued message goes out after the retried turn ends normally.
  const holdText = () => page.evaluate(() =>
    document.querySelector('.ag-followups-hold:not([hidden]) .ag-followups-hold-text')?.textContent ?? null);
  const queueFailingTurn = async (kind) => {
    await page.goto(`${origin}/?theme=light&width=480&reset=1&scenario=chat&hold=1&failure=${kind}`, { waitUntil: 'networkidle0' });
    await composerReady(page);
    await page.click('#play');
    await page.waitForFunction(() => window.sidebarPreview.snapshot().running);
    await page.focus('.ag-input');
    await page.type('.ag-input', '표도 정리해 주세요');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.ag-followup').length === 1);
    await page.evaluate((kind) => window.sidebarPreview.failRunningTurn(kind), kind);
    await waitForNotices(page, 1);
  };
  await queueFailingTurn('usage-soon');
  assert.match(await holdText() ?? '', /^사용 한도 · 리셋 .+ · 작업이 오류로 끝나/, 'the usage limit and its reset time explain the held queue');
  await shot(page, artifacts, 'queue-held');
  await queueFailingTurn('network');
  assert.match(await holdText() ?? '', /연결 실패 · /);
  const heldBefore = await snapshot(page);
  await page.click('.ag-failure-action[data-action="retry"]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().running);
  assert.equal(await holdText(), null, '다시 시도 releases the held queue');
  const retried = await snapshot(page);
  assert.equal(retried.messageTexts.at(-1), heldBefore.messageTexts.at(-1), 'the retry resends the failed request, not the queued one');
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.at(-1)?.includes('표도 정리해 주세요'));
  assert.equal(await page.$$eval('.ag-followup', (rows) => rows.length), 0, 'the queued message went out after the retried turn');

  // 리셋 후 이어서 sends by itself after the reset; 취소 stops it.
  await openFailure(page, origin, 'usage-soon');
  await playFailure(page);
  const armedBefore = (await snapshot(page)).messagesSent;
  await page.click('.ag-failure-action[data-action="resume"]');
  await page.waitForFunction(() => /에 이어서 보낼게요$/.test(document.querySelector('.ag-failure-line')?.textContent ?? ''));
  await shot(page, artifacts, 'usage-armed');
  await page.waitForFunction((count) => window.sidebarPreview.snapshot().messagesSent === count + 1, { timeout: 15_000 }, armedBefore);

  await openFailure(page, origin, 'usage-soon');
  await playFailure(page);
  const cancelledBefore = (await snapshot(page)).messagesSent;
  await page.click('.ag-failure-action[data-action="resume"]');
  await page.waitForSelector('.ag-failure-action[data-action="cancel-resume"]');
  await page.click('.ag-failure-action[data-action="cancel-resume"]');
  await page.waitForSelector('.ag-failure-action[data-action="resume"]');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  assert.equal((await snapshot(page)).messagesSent, cancelledBefore, '취소 keeps the request unsent');
}

// Run on its own: `node sidebar-preview/failures.check.mjs` (own Vite server and browser profile).
if (isMainModule(import.meta)) await runStandalone('Typed provider failure notices', checkFailureNotices);
