import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

/*
 * A question (or the focus-mode plan column) that arrives while the user types waits as a
 * one-line strip: focus, the composer's text, Hangul composition and digits stay with the
 * user. It opens when they pause for 1.5 s, leave the text field, press Enter, or click it.
 * Real keystrokes (trusted events) drive every case.
 */

const IDLE_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(page, origin, query) {
  const params = new URLSearchParams(query);
  params.set('theme', 'light');
  params.set('reset', '1');
  if (!params.has('width')) params.set('width', '480');
  await page.goto(`${origin}/?${params}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
}

/** Starts the sample reply and keeps its turn running (hold=1), as a provider mid-turn. */
async function startHeldTurn(page) {
  await page.evaluate(() => document.querySelector('#play').click());
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  // The sample's last paragraph stays buffered until it completes; wait for the one before
  // it, then for the final chunk to arrive (140 ms apart).
  await page.waitForFunction(() =>
    document.querySelector('.ag-msg-assistant')?.textContent.includes('단계별 일정과 담당자'));
  await sleep(300);
}

const ask = (page) => page.evaluate(() => window.sidebarPreview.askQuestion());

function state(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.ag-input');
    const question = document.querySelector('.ag-user-question');
    const active = document.activeElement;
    return {
      held: question?.dataset.held === 'true',
      open: Boolean(question?.querySelector('.ag-question-prompt')),
      focus: active === input ? 'composer'
        : active?.matches?.('.ag-question-prompt') ? 'prompt'
          : active?.matches?.('[data-rhwp-editor-input]') ? 'document'
            : active?.tagName ?? 'none',
      composerDisabled: input.disabled,
      composerValue: input.value,
      selected: document.querySelectorAll('.ag-question-option[data-selected="true"]').length,
    };
  });
}

const waitForOpenCard = (page, timeout) => page.waitForFunction(() => {
  const question = document.querySelector('.ag-user-question');
  return question?.dataset.held !== 'true' && question?.querySelector('.ag-question-prompt');
}, { timeout });

export async function checkTypingGuard(page, origin, artifacts) {
  // 1. Typing in the composer: the question waits, then opens after the pause.
  await open(page, origin, 'scenario=chat&hold=1');
  await startHeldTurn(page);
  await page.focus('.ag-input');
  await page.type('.ag-input', '2026년 ', { delay: 120 });
  await ask(page);
  await page.type('.ag-input', '3쪽', { delay: 120 });
  let now = await state(page);
  assert.equal(now.held, true, 'the question arrives as a strip while typing');
  assert.equal(now.open, false);
  assert.equal(now.focus, 'composer', 'focus stays in the composer');
  assert.equal(now.composerDisabled, false, 'the composer stays enabled under the user\'s fingers');
  assert.equal(now.composerValue, '2026년 3쪽', 'every typed character reached the composer');
  assert.equal(now.selected, 0, 'typed digits never answer the question');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'question-held.png') });
  await waitForOpenCard(page, IDLE_MS + 1_000);
  now = await state(page);
  assert.equal(now.composerDisabled, true, 'the open card takes the composer over');
  assert.equal(now.focus, 'prompt', 'focus moves from the composer to the question');
  await page.keyboard.press('1');
  assert.equal((await state(page)).selected, 1, 'digits answer once the card is open');
  assert.equal((await state(page)).composerValue, '2026년 3쪽', 'the typed text is kept while the card is open');

  // 2. Enter while the question is held opens it at once and does not stop the agent.
  await open(page, origin, 'scenario=chat&hold=1');
  await startHeldTurn(page);
  await page.focus('.ag-input');
  await page.type('.ag-input', 'abc', { delay: 80 });
  await ask(page);
  await page.type('.ag-input', 'def', { delay: 80 });
  assert.equal((await state(page)).held, true);
  await page.keyboard.press('Enter');
  await waitForOpenCard(page, 400);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().interrupts), 0, 'Enter did not stop the turn');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.isTurnRunning()), true);
  assert.equal((await state(page)).composerValue, 'abcdef', 'the text stays in the composer');

  // 2b. A question that follows the user's own Enter-send opens directly.
  await open(page, origin, 'scenario=question');
  await page.evaluate(() => {
    window.heldSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('.ag-user-question[data-held="true"]')) window.heldSeen = true;
    }).observe(document.querySelector('.ag-root'), { subtree: true, attributes: true, attributeFilter: ['data-held'] });
  });
  await page.focus('.ag-input');
  await page.type('.ag-input', '문체를 다듬어 주세요', { delay: 40 });
  await page.keyboard.press('Enter');
  await waitForOpenCard(page, 3_000);
  assert.equal(await page.evaluate(() => window.heldSeen), false, 'a send ends typing, so the answer is not held');
  assert.equal((await state(page)).focus, 'prompt');

  // 3. An open Hangul composition is never cut short; it opens after the syllable commits.
  await open(page, origin, 'scenario=chat&hold=1');
  await startHeldTurn(page);
  await page.focus('.ag-input');
  const cdp = await page.createCDPSession();
  await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
  await ask(page);
  await sleep(IDLE_MS + 1_000);
  now = await state(page);
  assert.equal(now.held, true, 'an open composition keeps the question held past the pause');
  assert.equal(now.focus, 'composer');
  assert.equal(now.composerDisabled, false);
  await cdp.send('Input.insertText', { text: '한' });
  await waitForOpenCard(page, IDLE_MS + 1_000);
  assert.match((await state(page)).composerValue, /한/, 'the committed syllable is in the composer');
  await cdp.detach();

  // 4. Typing in the document: the card opens after the pause but never takes the focus.
  await open(page, origin, 'editor=1&scenario=chat&hold=1');
  await startHeldTurn(page);
  const documentInput = 'textarea[data-rhwp-editor-input]';
  await page.focus(documentInput);
  await page.type(documentInput, '본문 ', { delay: 100 });
  await ask(page);
  await page.type(documentInput, '수정', { delay: 100 });
  now = await state(page);
  assert.equal(now.held, true);
  assert.equal(now.focus, 'document');
  await waitForOpenCard(page, IDLE_MS + 1_000);
  assert.equal((await state(page)).focus, 'document', 'the open card leaves focus in the document');
  await page.keyboard.type('12');
  assert.equal(await page.$eval(documentInput, (input) => input.value), '본문 수정12', 'digits stay document text');
  assert.equal((await state(page)).selected, 0);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'question-opened-beside-document.png') });

  // 5. The open card keeps its chronological place; Other borrows the composer and returns the user's text.
  await open(page, origin, 'scenario=chat&hold=1');
  await startHeldTurn(page);
  await page.focus('.ag-input');
  await page.type('.ag-input', '초안', { delay: 100 });
  await ask(page);
  await waitForOpenCard(page, IDLE_MS + 1_000);
  assert.deepEqual(await page.evaluate(() => {
    // The streamed text folds into a progress step when the question arrives.
    const answer = [...document.querySelector('.ag-messages').children]
      .findLast((node) => node.textContent.includes('문서를 검토했습니다'));
    const anchor = document.querySelector('.ag-messages .ag-question-timeline-anchor');
    const card = document.querySelector('.ag-user-question');
    return {
      anchorAfterAnswer: Boolean(answer && anchor
        && answer.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING),
      cardAboveComposer: card?.nextElementSibling === document.querySelector('.ag-composer'),
    };
  }), { anchorAfterAnswer: true, cardAboveComposer: true }, 'the transcript reserves the question\'s position');
  await page.click('.ag-question-other');
  await page.waitForFunction(() => {
    const input = document.querySelector('.ag-input');
    return !input.disabled && document.activeElement === input && input.value === '';
  });
  await page.type('.ag-input', '딱딱하게', { delay: 40 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.getPendingUserQuestion());
  await page.waitForFunction(() => document.querySelector('.ag-root').innerText.includes('선택한 문체'));
  now = await state(page);
  assert.equal(now.composerValue, '초안', 'the text typed before the question comes back');
  assert.equal(now.composerDisabled, false);
  assert.equal(await page.evaluate(() => {
    const history = document.querySelector('.ag-messages .ag-question-history');
    const reply = [...document.querySelectorAll('.ag-messages .ag-msg-assistant')]
      .find((node) => node.textContent.includes('선택한 문체'));
    return Boolean(history && reply && history.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'the answered question stays in place above the follow-up');

  // 6. In focus mode the plan column does not slide open while the user types.
  await open(page, origin, 'fullscreen=1&scenario=plan');
  await page.evaluate(() => document.querySelector('#play').click());
  await page.focus('.ag-input');
  await page.type('.ag-input', '계획이 오는 동안 계속 씁니다', { delay: 110 });
  await page.waitForFunction(() => window.sidebarPreview.bridge.getWorkflowState().latestPlan);
  assert.equal(await page.$eval('.ag-root', (root) => root.classList.contains('ag-plan-drawer-open')), false,
    'the plan column stays closed while typing');
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-plan-drawer-open'),
    { timeout: IDLE_MS + 1_000 });
  assert.equal(await page.$eval('.ag-input', (input) => input.value), '계획이 오는 동안 계속 씁니다');
}

if (isMainModule(import.meta)) await runStandalone('Arriving questions wait while the user types', checkTypingGuard);
