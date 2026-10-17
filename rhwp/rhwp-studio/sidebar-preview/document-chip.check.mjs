// 문서를 이은 채팅의 문서 칩: 집중 화면에서 이으면 하마가 칩을 짓고 두 머리에 같은 칩이 선다. 칩을 누르면
// 문서 화면으로 간다. 동작 줄이기면 칩이 바로 선다. 집중 화면 상태와 페이지 표시, 보내지 않은 초안,
// 홈에서 연 설정을 닫을 때의 집중 화면도 함께 본다. 실제 사이드바와 미리보기의 모의 편집기로 돈다.
import assert from 'node:assert/strict';

const chips = (page) => page.evaluate(() => {
  const read = (selector) => {
    const slot = document.querySelector(selector);
    const chip = slot?.querySelector('.ag-doc-chip');
    return slot ? {
      shown: !slot.hidden && !chip.hidden && chip.getClientRects().length > 0,
      present: !slot.hidden && !chip.hidden,
      name: slot.querySelector('.ag-doc-chip-name')?.textContent ?? '',
      building: Boolean(slot.querySelector('.ag-doc-chip-fx')),
    } : null;
  };
  return {
    focus: read('.ag-workspace-document-context .ag-doc-chip-slot'),
    dock: read('.ag-document-context .ag-doc-chip-slot'),
  };
});

async function startUnlinkedChatInFocus(page, open) {
  await open('reset=1&scenario=chat&document=empty');
  await page.type('.ag-input', '자료를 모아 정리해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-msg-user');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.isUnlinkedChat()), true);
}

export async function checkDocumentChip({ page, open, screenshot }) {
  // 검사 브라우저는 동작 줄이기로 뜬다 — 짓는 모습은 움직임을 켠 채로 본다.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await checkChipFlow(page, open, screenshot);
  } finally {
    await page.emulateMediaFeatures();
  }
  await checkFullscreenState(page, open);
}

async function checkChipFlow(page, open, screenshot) {
  // 1. 집중 화면에서 이으면 하마가 짓고, 끝나면 두 머리에 같은 칩이 선다.
  await startUnlinkedChatInFocus(page, open);
  assert.deepEqual(await chips(page).then(({ focus, dock }) => [focus.present, dock.present]), [false, false]);
  await page.evaluate(() => { void window.sidebarPreview.sidebar.linkCurrentChat({ kind: 'new' }); });
  await page.waitForSelector('.ag-workspace-document-context .ag-doc-chip-fx');
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (screenshot) await screenshot('document-chip-build');
  await page.waitForFunction(() => {
    const slot = document.querySelector('.ag-workspace-document-context .ag-doc-chip-slot');
    return slot && !slot.querySelector('.ag-doc-chip-fx') && slot.querySelector('.ag-doc-chip-name').textContent === '새 문서 1.hwpx';
  }, { timeout: 10_000 });
  const linked = await chips(page);
  assert.deepEqual(linked.focus, { shown: true, present: true, name: '새 문서 1.hwpx', building: false });
  assert.deepEqual([linked.dock.present, linked.dock.name], [true, '새 문서 1.hwpx'], 'the docked header shows the same chip');
  if (screenshot) await screenshot('document-chip-focus');

  // 2. 칩을 누르면 문서 화면으로 간다. 페이지 표시는 화면 전환을 기다리지 않고 상태를 따른다.
  const exiting = await page.evaluate(() => {
    document.querySelector('.ag-workspace-document-context button.ag-doc-chip').click();
    return {
      pageClass: document.body.classList.contains('ag-fullscreen-open'),
      state: window.sidebarPreview.sidebar.isFullscreen(),
    };
  });
  assert.deepEqual(exiting, { pageClass: false, state: false });
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  const docked = await chips(page);
  assert.deepEqual([docked.dock.shown, docked.dock.name, docked.dock.building], [true, '새 문서 1.hwpx', false]);
  if (screenshot) await screenshot('document-chip-dock');
  const entering = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } }));
    return document.body.classList.contains('ag-fullscreen-open');
  });
  assert.equal(entering, true, 'the page class turns on with the state, before the layout swaps');
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal((await chips(page)).focus.building, false, 'a chip already shown is not rebuilt');

  // 3. 동작 줄이기면 칩이 바로 선다.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await startUnlinkedChatInFocus(page, open);
  await page.evaluate(() => window.sidebarPreview.sidebar.linkCurrentChat({ kind: 'new' }));
  const instant = await chips(page);
  assert.deepEqual(instant.focus, { shown: true, present: true, name: '새 문서 1.hwpx', building: false });
}

async function checkFullscreenState(page, open) {
  // 4. 집중 화면을 닫아도 보내지 않은 초안은 남는다.
  await open('reset=1&scenario=chat');
  await page.type('.ag-input', '첫 채팅');
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning() && document.querySelector('.ag-msg-user'));
  const first = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  if (await page.$eval('.ag-root', (root) => root.classList.contains('ag-rail-collapsed'))) {
    await page.click('.ag-workspace-threads-btn');
    await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-rail-collapsed'));
  }
  await page.click('.ag-threads-new');
  await page.waitForFunction(() => document.querySelector('.ag-input').value === '');
  await page.type('.ag-input', '보내지 않은 글');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal(await page.$eval('.ag-input', (input) => input.value), '보내지 않은 글');
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), null, 'the draft stays open');
  // 쓴 것이 없는 초안은 예전처럼 앞 채팅으로 돌아간다.
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  await page.click('.ag-threads-new');
  await page.evaluate(() => { document.querySelector('.ag-input').value = ''; });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), first);

  // 5. 홈에서 연 설정은 닫을 때 집중 화면을 접는다 — 홈의 돌아가기가 '새 채팅'을 가리키지 않는다.
  await open('reset=1&width=800');
  await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { fullscreen: true, from: 'home' }));
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen')
    && document.querySelector('.ag-root').classList.contains('ag-settings-open'));
  await page.evaluate(() => document.querySelector('.ag-workspace-settings-back').click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal(await page.evaluate(() => document.body.classList.contains('ag-fullscreen-open')), false);
}
