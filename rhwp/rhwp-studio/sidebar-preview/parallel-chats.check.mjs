import assert from 'node:assert/strict';

const LOCK_REASON = '다른 채팅이 이 문서를 편집하고 있어요';

async function openPreview(page, origin, query) {
  await page.goto(`${origin}/?theme=light&width=480&reset=1&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
}

async function clickNewChat(page) {
  const mode = await page.$eval('.ag-root', (root) => ({
    fullscreen: root.classList.contains('ag-fullscreen'), collapsed: root.classList.contains('ag-rail-collapsed'),
  }));
  if (!mode.fullscreen) await page.click('.ag-header .ag-threads-btn');
  else if (mode.collapsed) await page.click('.ag-workspace-threads-btn');
  await page.waitForSelector('.ag-threads-new', { visible: true });
  await page.click('.ag-threads-new');
}

function draftState(page) {
  return page.evaluate(() => {
    const preview = window.sidebarPreview;
    return {
      threads: preview.threadStore.listThreads().map((thread) => thread.id),
      chatStarts: preview.snapshot().chatStarts.length,
      current: preview.sidebar.currentThreadId(),
      focus: document.querySelector('.ag-root').classList.contains('ag-fullscreen'),
    };
  });
}

/** The toolbar keeps the current sidebar/focus view for empty and established chats. */
export async function checkNewChatViewMode(page, origin) {
  for (const fullscreen of [false, true]) {
    await openPreview(page, origin, `scenario=chat${fullscreen ? '&fullscreen=1' : ''}`);
    const openDraft = async () => {
      await clickNewChat(page);
      await page.waitForFunction(() => document.querySelector('.ag-input')?.checkVisibility()
        && document.querySelector('.ag-chat-page')?.getAttribute('aria-hidden') === 'false'
        && window.sidebarPreview.sidebar.currentThreadId() === null);
      assert.equal((await draftState(page)).focus, fullscreen, 'new chat preserves the current view');
    };
    await openDraft();
    await page.type('.ag-input', '첫 채팅');
    await page.click('.ag-send');
    await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
      && document.querySelector('.ag-msg-assistant'));
    const before = await draftState(page);
    await openDraft();
    assert.equal((await draftState(page)).current, null, 'the completed conversation opens a fresh draft');
    assert.deepEqual((await draftState(page)).threads, before.threads, 'opening a draft creates no stored chat');
  }
  await openPreview(page, origin, 'parallel=1&scenario=chat&hold=1');
  await page.click('#play');
  await page.waitForFunction(() => window.sidebarPreview.chats[0].mock.snapshot().running);
  await clickNewChat(page);
  await page.waitForFunction(() => window.sidebarPreview.chats[1]?.sidebar.isActive());
  assert.equal((await draftState(page)).focus, false, 'a host-routed new chat also keeps sidebar view');
  assert.equal(await page.evaluate(() => window.sidebarPreview.chats[0].mock.snapshot().running), true);
}

/** New chat keeps an explicit focus-mode view and creates no stored chat before the first send. */
export async function checkDraftChat(page, origin) {
  await openPreview(page, origin, 'scenario=chat&fullscreen=1');
  await page.type('.ag-input', '첫 채팅');
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && document.querySelector('.ag-msg-assistant'));
  const before = await draftState(page);
  assert.equal(before.threads.length, 1);
  assert.equal(before.current, before.threads[0]);

  await clickNewChat(page);
  await page.waitForFunction(() => document.querySelector('.ag-focus-greeting')?.checkVisibility());
  assert.deepEqual(await draftState(page), { ...before, current: null, focus: true });
  assert.equal(await page.$('.ag-threads-item.ag-active'), null);

  // Leaving the draft discards it and returns to the earlier chat without restarting it.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.deepEqual(await draftState(page), { ...before, focus: false });

  // Re-enter focus mode explicitly; the new-chat toolbar itself keeps sidebar view.
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  // The first send creates the chat and starts it once, with the message.
  await clickNewChat(page);
  await page.waitForFunction(() => document.querySelector('.ag-focus-greeting')?.checkVisibility());
  await page.type('.ag-input', '목차를 정리해 줘');
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && document.querySelector('.ag-msg-assistant'));
  const sent = await page.evaluate(() => {
    const preview = window.sidebarPreview;
    const { chatStarts, messagesSent } = preview.snapshot();
    return {
      threads: preview.threadStore.listThreads().length,
      chatStarts: chatStarts.length,
      startedThread: chatStarts.at(-1)?.threadId,
      current: preview.sidebar.currentThreadId(),
      messagesSent,
      userMessages: document.querySelectorAll('.ag-msg-user').length,
    };
  });
  assert.equal(sent.threads, 2);
  assert.equal(sent.chatStarts, before.chatStarts + 1);
  assert.equal(sent.startedThread, sent.current);
  assert.notEqual(sent.current, before.current);
  assert.equal(sent.messagesSent, 2);
  assert.equal(sent.userMessages, 1);
}

/** A new chat while the shown chat works goes through openChat and leaves that agent running. */
export async function checkNewChatWhileRunning(page, origin) {
  await openPreview(page, origin, 'parallel=1&scenario=chat&hold=1&fullscreen=1');
  await page.type('.ag-input', '진행 중인 채팅');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.chats[0].mock.snapshot().running);
  const runningThread = await page.evaluate(() => window.sidebarPreview.chats[0].sidebar.currentThreadId());
  assert(runningThread);

  await clickNewChat(page);
  await page.waitForFunction(() => window.sidebarPreview.chats[1]?.sidebar.isActive()
    && document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  const state = await page.evaluate(() => {
    const { chats, openChatCalls } = window.sidebarPreview;
    const first = chats[0].mock.snapshot();
    return {
      openChatCalls,
      firstRunning: first.running,
      firstInterrupts: first.interrupts,
      firstShown: chats[0].sidebar.isActive(),
      firstThread: chats[0].sidebar.currentThreadId(),
      secondThread: chats[1].sidebar.currentThreadId(),
      secondStarts: chats[1].mock.snapshot().chatStarts.length,
    };
  });
  assert.deepEqual(state, {
    openChatCalls: [{ chat: 0, request: { kind: 'new' } }],
    firstRunning: true,
    firstInterrupts: 0,
    firstShown: false,
    firstThread: runningThread,
    secondThread: null,
    secondStarts: 0,
  });
}

/** Continues from the previous check: the first chat still edits, the new chat is shown. */
export async function checkChatModeLock(page) {
  await page.waitForFunction(() => document.querySelector('.ag-mode')?.dataset.mode === 'chat');
  await page.click('.ag-mode-btn');
  await page.waitForSelector('.ag-mode.ag-model-open');
  const items = await page.$$eval('.ag-mode-item', (nodes) => nodes.map((node) => ({
    mode: node.dataset.mode,
    disabled: node.disabled,
    title: node.title,
  })));
  assert.deepEqual(items, [
    { mode: 'chat', disabled: false, title: '' },
    { mode: 'plan', disabled: true, title: LOCK_REASON },
    { mode: 'agent', disabled: true, title: LOCK_REASON },
    { mode: 'full', disabled: true, title: LOCK_REASON },
  ]);
  await page.click('.ag-mode-item[data-mode="agent"]');
  await page.click('.ag-mode-item[data-mode="full"]');
  assert.equal(await page.$eval('.ag-mode', (node) => node.dataset.mode), 'chat');
  await page.click('.ag-mode-btn');
  await page.waitForFunction(() => !document.querySelector('.ag-mode').classList.contains('ag-model-open'));

  await page.type('.ag-input', '이 문단은 무슨 뜻이야?');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.chats[1].mock.snapshot().chatStarts.length === 1);
  const started = await page.evaluate(() => {
    const { chats } = window.sidebarPreview;
    return {
      start: chats[1].mock.snapshot().chatStarts[0],
      thread: chats[1].sidebar.currentThreadId(),
      firstRunning: chats[0].mock.snapshot().running,
    };
  });
  assert.equal(started.start.workflow, 'question');
  assert.equal(started.start.threadId, started.thread);
  assert.equal(started.firstRunning, true);
  await page.evaluate(() => window.sidebarPreview.chats[0].mock.bridge.interrupt());
}
