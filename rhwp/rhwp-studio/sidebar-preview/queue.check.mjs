// 대기 메시지(U1)와 입력기의 한 보내기 길을 실제 사이드바와 가짜 브리지로 본다.
// 혼자 돌릴 때: node sidebar-preview/queue.check.mjs (CHROME_PATH 필요, standalone.mjs 가 자기 Vite 서버를 띄운다).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

async function openPreview(page, origin, query) {
  await page.goto(`${origin}/?theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
}

function queueState(page) {
  return page.evaluate(() => {
    const snapshot = window.sidebarPreview.snapshot();
    const strip = document.querySelector('.ag-followups');
    return {
      messagesSent: snapshot.messagesSent,
      messageTexts: snapshot.messageTexts,
      interrupts: snapshot.interrupts,
      running: snapshot.running,
      rows: [...document.querySelectorAll('.ag-followup')].map((row) =>
        row.querySelector('.ag-followup-text')?.title ?? row.querySelector('.ag-followup-edit')?.value ?? ''),
      stripVisible: Boolean(strip && !strip.hidden && strip.checkVisibility()),
      hold: strip?.dataset.hold ?? null,
      holdText: document.querySelector('.ag-followups-hold:not([hidden]) .ag-followups-hold-text')?.textContent ?? null,
      composer: document.querySelector('.ag-input').value,
      userBubbles: [...document.querySelectorAll('.ag-msg-user')].map((node) => node.textContent.trim()),
    };
  });
}

async function waitFor(page, predicate, arg, message) {
  try {
    await page.waitForFunction(predicate, { timeout: 5000 }, arg);
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(await queueState(page))}`, { cause: error });
  }
}

const waitRunning = (page) => waitFor(page, () => window.sidebarPreview.snapshot().running, undefined, 'turn did not start');

/** 입력기에 쳐서 Enter 로 대기열에 넣는다 — 일하는 중이어야 한다. */
async function enqueue(page, text) {
  const before = (await queueState(page)).rows.length;
  await page.focus('.ag-input');
  await page.type('.ag-input', text);
  await page.keyboard.press('Enter');
  await waitFor(page, (count) => document.querySelectorAll('.ag-followup').length === count, before + 1, `"${text}" was not queued`);
}

async function sendNowKey(page) {
  const mac = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform || ''));
  const modifier = mac ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('Enter');
  await page.keyboard.up(modifier);
}

/** 대기열: Enter 는 쌓고, 정상 종료에 하나씩 보내고, 미심쩍은 끝에는 붙잡는다. */
export async function checkFollowUpQueue(page, origin, artifacts) {
  const screenshot = async (name) => {
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
  };

  // 1. 일하는 중의 Enter 는 턴을 멈추지 않고 대기열에 넣는다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await enqueue(page, '표를 정리해 줘');
  let state = await queueState(page);
  assert.deepEqual(state.rows, ['표를 정리해 줘']);
  assert.equal(state.messagesSent, 1, 'queueing must not send');
  assert.equal(state.interrupts, 0, 'queueing must not stop the turn');
  assert.equal(state.running, true);
  assert.equal(state.composer, '', 'the composer is cleared after queueing');
  assert.equal(state.hold, null);
  assert.equal(state.stripVisible, true);
  // 띠는 질문 카드와 입력기 바로 위에 서고, 집중 모드를 오간 뒤에도 같은 노드가 같은 자리로 돌아온다.
  const inlineOrder = () => page.evaluate(() => {
    const page = document.querySelector('.ag-chat-page');
    const strip = document.querySelector('.ag-followups');
    const question = document.querySelector('.ag-user-question');
    const composer = document.querySelector('.ag-composer');
    const review = document.querySelector('.ag-review');
    return strip.parentElement === page
      && strip.nextElementSibling === question
      && question.nextElementSibling === composer
      && review.parentElement === page
      && Boolean(review.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(await inlineOrder(), true, 'review, strip, question card and composer stack in order');
  const strip = await page.$('.ag-followups');
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  assert.equal(await page.evaluate(() => {
    const strip = document.querySelector('.ag-followups');
    return strip.checkVisibility() && strip.nextElementSibling === document.querySelector('.ag-user-question');
  }), true, 'focus mode keeps the strip above the question card and composer');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal(await inlineOrder(), true, 'leaving focus mode returns every node to its inline position');
  assert.equal(await page.evaluate((node) => node === document.querySelector('.ag-followups'), strip), true);

  // 2. 빈 입력기의 Enter 는 아무것도 하지 않는다(멈추지도 않는다).
  await page.focus('.ag-input');
  await page.keyboard.press('Enter');
  await new Promise((done) => setTimeout(done, 120));
  state = await queueState(page);
  assert.equal(state.interrupts, 0);
  assert.equal(state.running, true);
  await enqueue(page, '맞춤법도 확인해 줘');
  await screenshot('queue-running');

  // 3. 정상 종료에 맨 앞 하나만 보낸다. 다음 것은 그 턴의 정상 종료를 기다린다.
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '표를 정리해 줘', undefined, 'the head was not sent');
  await waitRunning(page);
  state = await queueState(page);
  assert.deepEqual(state.rows, ['맞춤법도 확인해 줘']);
  assert.equal(state.messagesSent, 2);
  assert.equal(state.userBubbles.filter((text) => text === '표를 정리해 줘').length, 1);

  // 4. 중지는 대기열을 붙잡는다. 붙잡음 줄의 보내기가 맨 앞을 보낸다.
  await page.click('.ag-send');
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'stopped', undefined, 'stop did not hold the queue');
  state = await queueState(page);
  assert.equal(state.messagesSent, 2, 'a stopped turn must not send the queue');
  assert.match(state.holdText, /^작업을 멈춰서/);
  assert.equal(state.interrupts, 1);
  await screenshot('queue-held');
  await page.click('.ag-followups-resume');
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '맞춤법도 확인해 줘', undefined, '보내기 did not send');
  await waitRunning(page);
  state = await queueState(page);
  assert.deepEqual(state.rows, []);
  assert.equal(state.stripVisible, false, 'an empty queue hides the strip');

  // 5. Ctrl/⌘+Enter 는 지금 보내기 — 턴을 멈추고 이것부터 보낸다. 나머지 순서는 그대로다.
  await enqueue(page, '첫 번째 대기');
  await enqueue(page, '두 번째 대기');
  await page.type('.ag-input', '급한 요청');
  await sendNowKey(page);
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '급한 요청', undefined, 'send now did not send');
  state = await queueState(page);
  assert.equal(state.interrupts, 2, 'send now stops the running turn');
  assert.deepEqual(state.rows, ['첫 번째 대기', '두 번째 대기']);
  assert.equal(state.hold, null, 'a send-now interruption does not hold the rest');
  assert.equal(state.composer, '');
  await waitRunning(page);

  // 6. 허브가 자기 턴을 먼저 시작해 거절하면 그 메시지는 맨 앞으로 돌아오고, 그 턴이 끝나면 다시 간다.
  await page.evaluate(() => {
    window.sidebarPreview.rejectNextMessage('AGENT_BUSY');
    window.sidebarPreview.finishTurn('completed');
  });
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'busy', undefined, 'a rejected send was not put back');
  state = await queueState(page);
  assert.deepEqual(state.rows, ['첫 번째 대기', '두 번째 대기']);
  assert.equal(state.userBubbles.includes('첫 번째 대기'), false, 'a rejected send leaves no user bubble');
  assert.equal(state.messageTexts.filter((text) => text === '첫 번째 대기').length, 1);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ag-msg-system')]
    .some((node) => node.textContent.includes('AGENT_BUSY'))), false, 'the hold line replaces the generic error line');
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.filter((text) => text === '첫 번째 대기').length === 2,
    undefined, 'the busy hold did not release at the next normal end');
  await waitRunning(page);
  state = await queueState(page);
  assert.deepEqual(state.rows, ['두 번째 대기']);
  assert.equal(state.hold, null);
  assert.equal(state.userBubbles.filter((text) => text === '첫 번째 대기').length, 1);

  // 7. 새로고침해도 대기열은 남고, 보지 못한 턴 끝 뒤이므로 붙잡힌 채 돌아온다.
  await page.evaluate(() => window.sidebarPreview.threadStore.waitForThreadsPersistence());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'interrupted', undefined, 'the reloaded queue is not held');
  await new Promise((done) => setTimeout(done, 300));
  state = await queueState(page);
  assert.deepEqual(state.rows, ['두 번째 대기']);
  assert.match(state.holdText, /작업이 끊겨/);
  assert.equal(state.messagesSent, 0, 'a reload never auto-sends');

  // 9. 수정: Enter 로 저장하고 순서는 그대로다. Esc 는 취소, 삭제는 지운다.
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.click('#play');
  await waitRunning(page);
  await enqueue(page, '세 번째 대기');
  await page.click('.ag-followup:first-child .ag-followup-edit-btn');
  await page.waitForSelector('.ag-followup-edit', { visible: true });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-followup-edit')), true);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type('두 번째를 고쳤어요');
  await page.keyboard.press('Enter');
  await waitFor(page, () => !document.querySelector('.ag-followup-edit'), undefined, 'Enter did not save the edit');
  state = await queueState(page);
  assert.deepEqual(state.rows, ['두 번째를 고쳤어요', '세 번째 대기']);
  await page.click('.ag-followup:last-child .ag-followup-edit-btn');
  await page.waitForSelector('.ag-followup-edit', { visible: true });
  await page.keyboard.type(' 버려질 글');
  await page.keyboard.press('Escape');
  await waitFor(page, () => !document.querySelector('.ag-followup-edit'), undefined, 'Esc did not close the editor');
  assert.deepEqual((await queueState(page)).rows, ['두 번째를 고쳤어요', '세 번째 대기']);
  await page.click('.ag-followup:last-child .ag-followup-remove');
  assert.deepEqual((await queueState(page)).rows, ['두 번째를 고쳤어요']);
  // 붙잡힌 대기열은 사용자가 풀 때까지 정상 종료에도 나가지 않는다.
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await new Promise((done) => setTimeout(done, 150));
  state = await queueState(page);
  assert.equal(state.hold, 'interrupted');
  assert.equal(state.messagesSent, 1);

  // 8. 계획 승인을 기다리며 끝난 턴은 대기열을 붙잡는다.
  await openPreview(page, origin, 'reset=1&scenario=plan&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await page.waitForSelector('.ag-plan-approve', { visible: true });
  await enqueue(page, '표지도 바꿔 줘');
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'plan-approval', undefined, 'plan approval did not hold the queue');
  state = await queueState(page);
  assert.equal(state.messagesSent, 1);
  assert.match(state.holdText, /계획 승인을 기다리고/);

  // 에이전트 모드에서 검토할 변경을 남기고 끝난 턴 뒤에도 대기열은 나간다. 검토 카드는 그대로 남는다.
  await openPreview(page, origin, 'reset=1&scenario=review&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges > 0);
  await enqueue(page, '검토 뒤에 이어서');
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '검토 뒤에 이어서',
    undefined, 'a pending review held the queue');
  await waitRunning(page);
  assert.ok(await page.$$eval('.ag-review-card', (cards) => cards.length) > 0, 'the review card stays');

  // 오류로 끝난 턴도 붙잡는다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await enqueue(page, '오류 뒤에는 보내지 않아요');
  await page.evaluate(() => window.sidebarPreview.finishTurn('failed'));
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'failed', undefined, 'a failed turn did not hold the queue');
  assert.equal((await queueState(page)).messagesSent, 1);
}

/**
 * 대기 메시지를 보낸 뒤 turn-start 가 오기 전의 틈 — 허브는 이미 그 메시지를 돌리고 있다. 설정은 잠기고,
 * 인라인 지시는 거절되고, 같은 틈의 설정 거절(AGENT_BUSY)은 그 메시지를 되돌리지 않는다. 한 채팅만 띄우는
 * 호스트에서 이 틈에 채팅을 바꾸면 그 메시지는 대기열로 돌아온다.
 */
export async function checkFollowUpGap(page, origin, artifacts) {
  const userBubbles = () => page.$$eval('.ag-msg-user', (nodes) => nodes.map((node) => node.textContent.trim()));
  const sentCount = (text) => page.evaluate((value) => window.sidebarPreview.snapshot().messageTexts
    .filter((sent) => sent === value).length, text);
  /** 대기열 맨 앞을 정상 종료로 보내되, 허브가 그 턴을 아주 늦게 연다. */
  const sendIntoGap = async (text) => {
    await page.evaluate(() => window.sidebarPreview.setTurnStartDelay(60_000));
    await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
    await waitFor(page, (value) => window.sidebarPreview.snapshot().messageTexts.at(-1) === value
      && !window.sidebarPreview.snapshot().running, text, `"${text}" was not sent into the gap`);
  };
  const openThreads = async () => {
    // 새 채팅(초안)은 집중 모드로 열린다 — 머리줄의 채팅 목록 단추가 보이도록 나온다.
    if (await page.evaluate(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen'))) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
      await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
    }
    await page.click('.ag-header .ag-threads-btn');
    await page.waitForSelector('.ag-root.ag-threads-open .ag-threads-item, .ag-root.ag-threads-open .ag-threads-new', { visible: true });
  };
  const activeThread = () => page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());

  // 1. 틈에는 모드·모델이 잠기고 인라인 지시는 거절된다. 설정 거절은 받아들인 메시지를 걷지 않는다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await enqueue(page, '틈에 보낸 요청');
  await sendIntoGap('틈에 보낸 요청');
  const locks = await page.evaluate(() => ({
    mode: document.querySelector('.ag-mode-btn').disabled,
    model: document.querySelector('.ag-llm-trigger').disabled,
    effort: document.querySelector('.ag-effort-trigger').disabled,
  }));
  assert.deepEqual(locks, { mode: true, model: true, effort: true }, 'settings wait for the accepted message\'s turn');
  await screenshot(page, artifacts, 'queue-gap-locked');
  const inline = await page.evaluate(() => window.sidebarPreview.sidebar.sendInlinePrompt({
    prompt: '이 문단을 고쳐 주세요',
    selection: { label: '1쪽 1문단', excerpt: '사업 개요', contextBlock: '[선택] 사업 개요', items: [] },
  }));
  assert.equal(inline.ok, false, 'an inline prompt in the gap is refused instead of being sent and rejected');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 2);
  // 같은 틈에 다른 곳(템플릿 칩 등)에서 바꾼 설정을 허브가 거절했다.
  await page.evaluate(() => window.sidebarPreview.emitHubError('AGENT_BUSY', 'Templates can only change between turns.'));
  let state = await queueState(page);
  assert.deepEqual(state.rows, [], 'the accepted message does not return to the queue');
  assert.equal(state.userBubbles.filter((text) => text === '틈에 보낸 요청').length, 1, 'its bubble stays');
  // 허브가 받아 둔 그 메시지의 턴이 열리고 끝난다 — 다시 보내지 않는다.
  await page.evaluate(() => {
    window.sidebarPreview.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-gap' });
    window.sidebarPreview.finishTurn('completed');
  });
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(await sentCount('틈에 보낸 요청'), 1, 'the accepted message is sent once');

  // 2. 틈에 다른 채팅을 열면 받아들인 대기 메시지는 채팅과 함께 멈추고 대기열 맨 앞으로 돌아온다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
  await page.waitForFunction(() => !window.sidebarPreview.snapshot().running);
  const firstThread = await activeThread();
  await openThreads();
  await page.click('.ag-threads-new');
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.type('.ag-input', '두 번째 채팅의 요청');
  await page.keyboard.press('Enter');
  await waitRunning(page);
  await enqueue(page, '전환 전에 보낸 요청');
  const secondThread = await activeThread();
  assert.ok(firstThread && secondThread && firstThread !== secondThread, 'two saved chats');
  await sendIntoGap('전환 전에 보낸 요청');
  const stopsBefore = await page.evaluate(() => window.sidebarPreview.snapshot().stops);
  await openThreads();
  await page.click(`.ag-threads-item[data-thread-id="${firstThread}"]`);
  await waitFor(page, (before) => window.sidebarPreview.snapshot().stops > before, stopsBefore,
    'opening another chat did not stop this one');
  await openThreads();
  await page.click(`.ag-threads-item[data-thread-id="${secondThread}"]`);
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'stopped', undefined,
    'the message stopped with the chat did not come back to the queue');
  state = await queueState(page);
  assert.deepEqual(state.rows, ['전환 전에 보낸 요청']);
  assert.equal(state.userBubbles.includes('전환 전에 보낸 요청'), false, 'no bubble is left for a message nobody answers');
  assert.equal(await sentCount('전환 전에 보낸 요청'), 1);
  await screenshot(page, artifacts, 'queue-gap-switched');

  // 3. 틈에 새 채팅(초안)을 열어도 앞 채팅을 멈추고 그 메시지를 대기열로 되돌린다 — 답이 초안에 흘러들지 않는다.
  await page.click('.ag-followups-resume');
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '전환 전에 보낸 요청'
    && !document.querySelector('.ag-followup'), undefined, '보내기 did not send the head');
  // 허브가 그 턴을 열고 돌린다. 다음 대기 메시지를 틈으로 보낸다.
  await page.evaluate(() => {
    window.sidebarPreview.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-resumed' });
  });
  await enqueue(page, '초안 전에 보낸 요청');
  await sendIntoGap('초안 전에 보낸 요청');
  const stopsBeforeDraft = await page.evaluate(() => window.sidebarPreview.snapshot().stops);
  await openThreads();
  await page.click('.ag-threads-new');
  await waitFor(page, (before) => window.sidebarPreview.snapshot().stops > before, stopsBeforeDraft,
    'a new chat did not stop the chat whose message the hub was running');
  assert.deepEqual(await userBubbles(), [], 'the draft shows nothing of the previous chat');
  await openThreads();
  await page.click(`.ag-threads-item[data-thread-id="${secondThread}"]`);
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'stopped', undefined,
    'the draft did not put the message back');
  assert.deepEqual((await queueState(page)).rows, ['초안 전에 보낸 요청']);

  // 4. 허브가 스스로 연 턴이 거절될 대기 메시지보다 먼저 오면, 그 턴은 남은 마지막 요청에 묶인다.
  await openPreview(page, origin, 'reset=1&scenario=chat&hold=1');
  await page.click('#play');
  await waitRunning(page);
  await enqueue(page, '거절될 요청');
  await page.evaluate(() => {
    window.sidebarPreview.rejectNextMessage('AGENT_BUSY');
    window.sidebarPreview.finishTurn('completed');
    window.sidebarPreview.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-hub' });
  });
  await waitFor(page, () => document.querySelector('.ag-followups')?.dataset.hold === 'busy', undefined, 'the refusal did not bounce');
  const binding = await page.evaluate(() => ({
    turnKey: window.sidebarPreview.restoreState.turnKey,
    requestKey: [...document.querySelectorAll('.ag-msg-user')].at(-1)?.dataset.turnKey ?? null,
    bubbles: [...document.querySelectorAll('.ag-msg-user')].length,
  }));
  assert.equal(binding.bubbles, 1, 'only the first request is left');
  assert.ok(binding.requestKey);
  assert.equal(binding.turnKey, binding.requestKey, 'the hub turn moved to the request that is still shown');
  await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
}

async function screenshot(page, artifacts, name) {
  const sidebar = await page.$('.ag-root');
  await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
}

/** 입력기의 한 보내기 길: 템플릿 머리말·스킬 호출·첨부가 요청에 실리고, 로컬 명령은 메시지를 보내지 않는다. */
export async function checkComposerSendPath(page, origin) {
  const sent = () => page.evaluate(() => window.sidebarPreview.snapshot().sentMessages);
  const submit = async (text) => {
    await page.focus('.ag-input');
    await page.type('.ag-input', text);
    await page.keyboard.press('Enter');
  };
  const settle = () => page.waitForFunction(() => !window.sidebarPreview.snapshot().running
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');

  await openPreview(page, origin, 'reset=1&scenario=chat');
  // 로컬 명령은 사용자 메시지를 보내지 않는다.
  await submit('/fast status');
  await submit('/calibration');
  await page.waitForSelector('.ag-calibration-overlay', { visible: true });
  assert.deepEqual(await sent(), [], 'local commands never reach the agent');
  assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), 0);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.ag-calibration-overlay', { hidden: true });

  // 템플릿 호출은 템플릿을 고르고 본문을 보낸다. 기록에는 템플릿 머리말이 남는다(허브는 템플릿 id 로 안다).
  await page.click('.ag-input');
  await page.evaluate(() => { document.querySelector('.ag-input').value = ''; });
  await submit('/templates 회의록 안건을 정리해 줘');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().sentMessages.length === 1);
  assert.equal((await sent())[0].text, '안건을 정리해 줘');
  assert.equal(await page.$eval('.ag-template-chip-name', (node) => node.textContent), '회의록');
  assert.equal(await page.evaluate(() => window.sidebarPreview.threadStore.listThreads()[0]?.messages
    .find((message) => message.role === 'user')?.text), '/templates 회의록 안건을 정리해 줘');
  await settle();

  // 스킬 토큰만 있는 호출은 기록은 비워 두고 요청은 명시적 슬래시 호출로 보낸다.
  await page.click('.ag-template-chip-clear').catch(() => {});
  await page.focus('.ag-input');
  await page.type('.ag-input', '/proofread-korean ');
  await page.waitForSelector('.ag-composer-skill:not([hidden])');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().sentMessages.length === 2);
  const skill = (await sent())[1];
  assert.equal(skill.text, '/proofread-korean');
  assert.equal(skill.skillName, 'proofread-korean');
  assert.equal(await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.ag-msg-user')].at(-1);
    return Boolean(bubble?.querySelector('.ag-msg-skill')) && !bubble.querySelector('.ag-msg-user-text');
  }), true, 'the bubble shows the skill token and no sentence');
  await settle();

  // 첨부는 준비된 스테이징 id 와 함께 나가고 receipt 를 받는다.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['sample'], 'sample.txt', { type: 'text/plain' }));
    const input = document.querySelector('.ag-input');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      input.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }
  });
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true'
    && !document.querySelector('.ag-send').disabled
    && document.querySelector('.ag-reference-upload-chip'));
  await submit('첨부를 확인해 줘');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().sentMessages.length === 3);
  const attachment = (await sent())[2];
  assert.equal(attachment.referenceIds.length, 1);
  assert.equal(attachment.text, '첨부를 확인해 줘');

  // 일하는 동안 첨부가 있는 글은 대기열에 넣지 않고 입력기에 남긴다.
  await settle();
  await page.evaluate(() => window.sidebarPreview.setHold(true));
  await submit('하나 더');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().running);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['more'], 'more.txt', { type: 'text/plain' }));
    document.querySelector('.ag-input').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForSelector('.ag-reference-upload-chip');
  await submit('첨부와 함께 대기');
  await page.waitForSelector('.ag-followups-hint:not([hidden])');
  const refused = await queueState(page);
  assert.deepEqual(refused.rows, []);
  assert.equal(refused.composer, '첨부와 함께 대기', 'the text stays in the composer');
}

// 혼자 돌리기 — check.mjs 의 알려진 앞 단계 실패와 상관없이 이 검사만 본다.
if (isMainModule(import.meta)) {
  await runStandalone('Follow-up queue: Enter queues, normal ends drain, doubtful ends hold', checkFollowUpQueue);
  await runStandalone('Follow-up gap: settings lock, inline refusal, settings refusals and chat switches keep the accepted message once',
    checkFollowUpGap);
  await runStandalone('Composer send path: template, skill, attachments and local commands',
    (page, origin) => checkComposerSendPath(page, origin));
}
