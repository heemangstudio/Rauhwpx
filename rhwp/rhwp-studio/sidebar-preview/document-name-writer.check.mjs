// 문서를 이은 채팅의 머리: 집중 화면에서 이으면 하마가 '/ 문서 이름' 을 글자마다 쓰고, 끝나면 두 머리 모두
// 보통 문서 채팅과 같은 '/ 문서 이름' 이 된다. 동작 줄이기면 이름이 바로 보인다. 집중 화면 상태와 페이지 표시,
// 보내지 않은 초안, 홈에서 연 설정을 닫을 때의 집중 화면도 함께 본다. 실제 사이드바와 미리보기의 모의 편집기로 돈다.
import assert from 'node:assert/strict';

const headers = (page) => page.evaluate(() => {
  const read = (selector, nameSelector) => {
    const context = document.querySelector(selector);
    const name = context.querySelector(nameSelector);
    const separator = context.querySelector('.ag-workspace-title-sep');
    return {
      name: name.textContent,
      plain: name.children.length === 0,
      visible: getComputedStyle(name).visibility === 'visible' && getComputedStyle(separator).visibility === 'visible',
      writing: Boolean(context.querySelector('.ag-doc-name-fx')),
    };
  };
  return {
    focus: read('.ag-workspace-document-context', '.ag-workspace-document-name'),
    dock: read('.ag-document-context', '.ag-document-name'),
  };
});

const settled = (name) => ({ name, plain: true, visible: true, writing: false });

async function startUnlinkedChatInFocus(page, open) {
  await open('reset=1&scenario=chat&document=empty');
  await page.type('.ag-input', '자료를 모아 정리해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-msg-user');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.isUnlinkedChat()), true);
}

export async function checkDocumentNameWriter({ page, open, screenshot }) {
  // 검사 브라우저는 동작 줄이기로 뜬다 — 쓰는 모습은 움직임을 켠 채로 본다.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await checkWriteFlow(page, open, screenshot);
  } finally {
    await page.emulateMediaFeatures();
  }
  await checkFullscreenState(page, open);
}

async function checkWriteFlow(page, open, screenshot) {
  // 1. 집중 화면에서 이으면 하마가 이름을 쓰고, 끝나면 두 머리 모두 보통의 '/ 문서 이름' 이 된다.
  await startUnlinkedChatInFocus(page, open);
  await page.evaluate(() => { void window.sidebarPreview.sidebar.linkCurrentChat({ kind: 'new' }); });
  await page.waitForSelector('.ag-workspace-document-context .ag-doc-name-fx');
  const writing = await headers(page);
  assert.equal(writing.focus.plain, false, 'the focus header name is being written letter by letter');
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (screenshot) await screenshot('document-name-writing');
  await page.waitForFunction(() => !document.querySelector('.ag-doc-name-fx'), { timeout: 10_000 });
  const linked = await headers(page);
  assert.deepEqual(linked.focus, settled('새 문서 1.hwpx'));
  assert.deepEqual(linked.dock, settled('새 문서 1.hwpx'), 'the docked header shows the same name');
  if (screenshot) await screenshot('document-name-focus');

  // 2. 문서 화면으로 돌아가도 다시 쓰지 않는다. 페이지 표시는 화면 전환을 기다리지 않고 상태를 따른다.
  const exiting = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } }));
    return {
      pageClass: document.body.classList.contains('ag-fullscreen-open'),
      state: window.sidebarPreview.sidebar.isFullscreen(),
    };
  });
  assert.deepEqual(exiting, { pageClass: false, state: false });
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.deepEqual((await headers(page)).dock, settled('새 문서 1.hwpx'));
  if (screenshot) await screenshot('document-name-dock');
  const entering = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } }));
    return document.body.classList.contains('ag-fullscreen-open');
  });
  assert.equal(entering, true, 'the page class turns on with the state, before the layout swaps');
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal((await headers(page)).focus.writing, false, 'a name already written is not written again');

  // 3. 동작 줄이기면 이름이 바로 보인다.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await startUnlinkedChatInFocus(page, open);
  await page.evaluate(() => window.sidebarPreview.sidebar.linkCurrentChat({ kind: 'new' }));
  assert.deepEqual((await headers(page)).focus, settled('새 문서 1.hwpx'));
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
