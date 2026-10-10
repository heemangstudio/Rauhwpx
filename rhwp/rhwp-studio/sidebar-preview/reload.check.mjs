import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

const RUNNING_CHAT = 'preview-chat-schedule';
const OTHER_TEXT = '현장 인터뷰 일정\n다시 확인';
const QUEUED = ['표 제목도 맞춰 주세요', '끝나면 요약해 주세요'];

/**
 * A reload while the hub still runs the window's chat: the sidebar re-adopts that chat instead of
 * restarting it. The fixture bridge counts every start, stop and interrupt the sidebar sends.
 */
export async function checkReloadPreview(page, origin, artifacts) {
  async function open(reload) {
    await page.goto(`${origin}/?reset=1&theme=light&width=480&chats=sample&reload=${reload}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.waitForFunction((id) => window.sidebarPreview.sidebar.currentThreadId() === id
      && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', {}, RUNNING_CHAT);
  }
  const counts = () => page.evaluate(() => {
    const { chatStarts, stops, interrupts } = window.sidebarPreview.snapshot();
    return { starts: chatStarts.length, stops, interrupts };
  });

  await open('running');
  await page.waitForSelector('.ag-send.ag-stop');
  // The working ring appears once the agent has been quiet for the status delay.
  await page.waitForFunction(() => document.querySelector('.ag-turn-pending')?.hidden === false);
  assert.deepEqual(await counts(), { starts: 0, stops: 0, interrupts: 0 }, 'the running chat is adopted, not restarted');
  assert.deepEqual(await page.evaluate(() => ({
    running: window.sidebarPreview.bridge.isTurnRunning(),
    request: document.querySelector('.ag-msg-user')?.textContent ?? '',
    pending: !document.querySelector('.ag-turn-pending')?.hidden,
    systemLines: [...document.querySelectorAll('.ag-msg-system')].map((node) => node.textContent),
  })), {
    running: true,
    request: '추진 일정 표의 날짜를 분기별로 정리해 주세요.',
    pending: true,
    systemLines: [],
  });
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'reload-running.png') });
  // The adopted turn is a real turn: Stop ends it.
  await page.click('.ag-send.ag-stop');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  assert.equal((await counts()).interrupts, 1);

  await open('question');
  await page.waitForSelector('.ag-user-question[data-inactive="false"]');
  assert.deepEqual(await counts(), { starts: 0, stops: 0, interrupts: 0 }, 'the waiting chat is adopted, not restarted');
  assert.deepEqual(await page.evaluate(() => {
    const input = document.querySelector('.ag-input');
    return {
      step: document.querySelector('.ag-question-step')?.textContent,
      value: input.value,
      label: input.getAttribute('aria-label'),
      anchored: Boolean(document.querySelector('.ag-messages > .ag-question-timeline-anchor')),
      back: Boolean(document.querySelector('.ag-question-back:not(:disabled)')),
    };
  }), {
    step: '2/2',
    value: OTHER_TEXT,
    label: '현재 질문의 직접 답변',
    anchored: true,
    back: true,
  });
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'reload-question.png') });
  // The restored draft answers the question the running turn waits on.
  await page.click('.ag-question-next');
  await page.waitForSelector('.ag-question-history');
  assert.equal((await counts()).starts, 0);

  // Follow-ups queued before the reload stay queued and are released, not held as cut off: the
  // adopted turn's end is seen here, so each normal turn end sends the next one.
  const queueState = () => page.evaluate(() => {
    const strip = document.querySelector('.ag-followups');
    return {
      rows: [...document.querySelectorAll('.ag-followup')].map((row) => row.querySelector('.ag-followup-text')?.title ?? ''),
      hold: strip?.dataset.hold ?? null,
      sent: window.sidebarPreview.snapshot().messageTexts,
    };
  });
  await open('running');
  for (const text of QUEUED) {
    const before = (await queueState()).rows.length;
    await page.focus('.ag-input');
    await page.type('.ag-input', text);
    await page.keyboard.press('Enter');
    await page.waitForFunction((count) => document.querySelectorAll('.ag-followup').length === count, {}, before + 1);
  }
  await page.evaluate(() => window.sidebarPreview.threadStore.waitForThreadsPersistence());
  // Reload without re-seeding the sample chats, so the stored chat keeps its queue.
  await page.goto(`${origin}/?theme=light&width=480&reload=running`, { waitUntil: 'networkidle0' });
  await page.waitForFunction((id) => window.sidebarPreview?.sidebar.currentThreadId() === id
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', {}, RUNNING_CHAT);
  assert.deepEqual(await counts(), { starts: 0, stops: 0, interrupts: 0 }, 'the chat with a queue is adopted, not restarted');
  assert.deepEqual(await queueState(), { rows: QUEUED, hold: null, sent: [] },
    'the queue survives the reload and is not held while the adopted turn runs');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'reload-queued.png') });
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.length === 1);
  assert.deepEqual(await queueState(), { rows: [QUEUED[1]], hold: null, sent: [QUEUED[0]] },
    'the adopted turn\'s normal end sends the first queued message');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.length === 2, { timeout: 10_000 });
  assert.deepEqual((await queueState()).sent, QUEUED, 'the next normal turn end sends the second one');
}

if (isMainModule(import.meta)) await runStandalone('Reload re-adopts the live chat', checkReloadPreview);
