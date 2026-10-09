import assert from 'node:assert/strict';

const MINUTES_CHAT = 'preview-chat-minutes';

/**
 * Two live document sessions, one sidebar each. The hidden sidebar keeps its agent
 * and conversation, only the shown sidebar owns page-level state, and chats running
 * in the other session switch sidebars instead of opening read-only.
 */
export async function checkSessionsPreview(page, origin) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await page.goto(`${origin}/?theme=light&width=480&sessions=2&chats=sample&scenario=chat&hold=1`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
    // The background sidebar restores its document's last chat off-screen.
    await page.waitForFunction(() =>
      window.sidebarPreview.sessions[1].sidebar.root.querySelector('.ag-msg-user'));

    // A held turn keeps the proposal session's agent running.
    await page.click('#play');
    // The held reply keeps its last paragraph pending; wait for the one before it.
    await page.waitForFunction(() => document.querySelector('.ag-msg-assistant')?.textContent.includes('담당자를 확인합니다'));
    assert.equal(await page.evaluate(() => window.sidebarPreview.sessions[0].mock.snapshot().running), true);
    // Read the conversation position once the follow scroll has settled.
    await page.waitForFunction(() => new Promise((done) => {
      const node = document.querySelector('.ag-messages');
      const before = node.scrollTop;
      setTimeout(() => done(Math.abs(node.scrollTop - before) < 1), 250);
    }));
    const primaryScroll = await page.$eval('.ag-messages', (node) => node.scrollTop);

    await page.click('.ag-header .ag-threads-btn');
    await page.waitForSelector('.ag-root.ag-threads-open .ag-threads-item.ag-active');
    const runningChat = await page.$eval('.ag-threads-item.ag-active', (node) => node.dataset.threadId);
    // A chat the hidden sidebar restored but nobody read keeps its finished dot.
    assert(await page.$(`.ag-threads-item[data-thread-id="${MINUTES_CHAT}"] .ag-thread-status-finished`));

    // Opening the other live document's chat switches sidebars without stopping this agent.
    await page.click(`.ag-threads-item[data-thread-id="${MINUTES_CHAT}"]`);
    await page.waitForFunction(() => window.sidebarPreview.sessions[1].sidebar.isActive());
    const shown = await page.evaluate(() => ({
      roots: document.querySelectorAll('.ag-root').length,
      ids: document.querySelectorAll('#agent-sidebar').length,
      background: window.sidebarPreview.sessions[1].sidebar.root.isConnected,
      chat: document.querySelector('.ag-msg-user')?.textContent ?? '',
      readOnly: document.querySelector('.ag-composer').classList.contains('ag-readonly'),
      listOpen: document.querySelector('.ag-root').classList.contains('ag-threads-open'),
      primaryRunning: window.sidebarPreview.sessions[0].mock.snapshot().running,
    }));
    assert.deepEqual(shown, {
      roots: 1,
      ids: 1,
      background: true,
      chat: '오늘 회의에서 정한 사항만 다섯 줄로 요약해 주세요.',
      readOnly: false,
      listOpen: false,
      primaryRunning: true,
    });

    // The other session's running chat shows as working in this sidebar's list; the opened chat is read.
    await page.click('.ag-header .ag-threads-btn');
    await page.waitForSelector('.ag-root.ag-threads-open .ag-threads-item');
    assert.match(
      await page.$eval(`.ag-threads-item[data-thread-id="${runningChat}"] .ag-threads-item-when`, (node) => node.textContent),
      /작업 중/,
    );
    assert.equal(await page.$(`.ag-threads-item[data-thread-id="${MINUTES_CHAT}"] .ag-thread-status`), null);
    await page.click('.ag-threads-page .ag-threads-close');
    await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-threads-open'));

    // The menu command reaches only the shown sidebar.
    await page.evaluate(() => window.dispatchEvent(
      new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-sidebar' } }),
    ));
    assert.deepEqual(await page.evaluate(() => ({
      shownCollapsed: document.querySelector('.ag-root').classList.contains('ag-collapsed'),
      pageOpen: document.body.classList.contains('ag-sidebar-open'),
      hiddenCollapsed: window.sidebarPreview.sessions[0].sidebar.root.classList.contains('ag-collapsed'),
    })), { shownCollapsed: true, pageOpen: false, hiddenCollapsed: false });

    // Switching back adopts the page layout (collapsed, chat instead of the list it left open),
    // keeps the running turn, and replays no entrance motion.
    const back = await page.evaluate(() => {
      const { sessions, attachSession } = window.sidebarPreview;
      attachSession(0);
      const root = sessions[0].sidebar.root;
      const replaying = root.getAnimations({ subtree: true }).filter((animation) =>
        animation instanceof CSSAnimation
        && animation.playState === 'running'
        && Number.isFinite(animation.effect.getComputedTiming().endTime));
      return {
        connected: root.isConnected,
        collapsed: root.classList.contains('ag-collapsed'),
        listOpen: root.classList.contains('ag-threads-open'),
        stop: Boolean(root.querySelector('.ag-send.ag-stop')),
        running: sessions[0].mock.snapshot().running,
        replaying: replaying.map((animation) => animation.animationName),
      };
    });
    assert.deepEqual(back, {
      connected: true, collapsed: true, listOpen: false, stop: true, running: true, replaying: [],
    });
    await page.evaluate(() => window.dispatchEvent(
      new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-sidebar' } }),
    ));
    await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-collapsed'));
    const restoredScroll = await page.$eval('.ag-messages', (node) => node.scrollTop);
    assert(Math.abs(restoredScroll - primaryScroll) <= 2, `Conversation scroll ${restoredScroll} restored near ${primaryScroll}`);
    await page.evaluate(() => window.sidebarPreview.sessions[0].mock.bridge.interrupt());
  } finally {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }
}
