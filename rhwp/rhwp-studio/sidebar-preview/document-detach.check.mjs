// 채팅을 문서에서 떼기: 입력기 아래 줄의 연결 단추(붙은 채팅은 분리, 문서 없는 채팅은 연결), 일하는 동안 막힘,
// 하마가 머리의 문서 이름을 삼킨 뒤 문서 없는 채팅이 되는지, 같은 허브 세션의 chat-start 가 뗀 문서를 싣고
// 압축을 한 번 청하는지, 동작 줄이기, 단추로 다시 이으면 하마가 이름을 쓰는지. 실제 사이드바와 미리보기의 모의
// 브리지·편집기로 돈다.
import assert from 'node:assert/strict';

const toggle = (page) => page.$eval('.ag-doc-link-toggle', (button) => ({
  hidden: button.hidden,
  label: button.getAttribute('aria-label'),
  disabled: button.getAttribute('aria-disabled') === 'true',
  title: button.title,
}));

const dockedName = (page) => page.$eval('.ag-document-name', (name) => name.textContent);

async function startChat(page, open, query = '') {
  await open(`reset=1&scenario=chat${query ? `&${query}` : ''}`);
  await page.type('.ag-input', '이 문서의 핵심을 정리해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-msg-user');
  const threadId = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());
  assert.ok(threadId, 'the chat was saved');
  return threadId;
}

const idle = (page) => page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
  && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');

export async function checkDocumentDetach({ page, open, screenshot }) {
  // 1. 붙은 채팅은 분리 단추다. 일하는 동안에는 막히고 그 이유가 툴팁이다.
  await startChat(page, open, 'hold=1');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  assert.deepEqual(await toggle(page), {
    hidden: false, label: '문서에서 분리', disabled: true, title: '작업이 끝나면 분리할 수 있어요',
  });
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.beginDocumentDetach()), null,
    'a running chat cannot be detached');
  await page.evaluate(() => window.sidebarPreview.finishTurn());
  await idle(page);
  assert.deepEqual(await toggle(page), { hidden: false, label: '문서에서 분리', disabled: false, title: '문서에서 분리' });

  // 2. 누르면 하마가 머리의 이름을 삼키고, 채팅은 문서 없이 같은 허브 세션에서 다시 열린다(chat-stop 없음).
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await checkDetachAndRelink(page, open, screenshot);
  } finally {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }

  // 3. 동작 줄이기면 삼키지 않고 바로 뗀다.
  const reduced = await startChat(page, open);
  await idle(page);
  await page.evaluate(() => {
    window.detachFx = false;
    new MutationObserver(() => {
      if (document.querySelector('.ag-doc-name-fx')) window.detachFx = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.click('.ag-doc-link-toggle');
  await page.waitForFunction(() => window.sidebarPreview.sidebar.isUnlinkedChat());
  assert.equal(await page.evaluate(() => window.detachFx), false, 'reduced motion skips the inhale');
  assert.equal(await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).documentId, reduced), null);
  assert.equal((await toggle(page)).label, '문서 연결');
}

async function checkDetachAndRelink(page, open, screenshot) {
  const threadId = await startChat(page, open);
  await idle(page);
  assert.equal(await dockedName(page), '사업 제안서.hwpx');
  const before = await page.evaluate(() => window.sidebarPreview.snapshot());
  await page.click('.ag-doc-link-toggle');
  await page.waitForSelector('.ag-document-context .ag-doc-name-fx');
  assert.equal((await toggle(page)).disabled, true, 'the button waits while the chat is detaching');
  if (screenshot) await screenshot('document-detach-inhale');
  await page.waitForFunction(() => window.sidebarPreview.sidebar.isUnlinkedChat(), { timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('.ag-doc-name-fx'));
  assert.ok(!(await dockedName(page)).includes('사업 제안서'), 'the header no longer names the document');
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), threadId, 'the same chat continues');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.detachCalls), [
    { threadId, documentId: 'preview-proposal', draft: false },
  ]);
  const stored = await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id), threadId);
  assert.deepEqual([stored.documentId, stored.docKey, stored.documentLinkedAt], [null, null, undefined]);
  assert.equal(typeof stored.documentLinkChangedAt, 'number');
  assert.deepEqual(stored.documentDetachedFrom, { documentId: 'preview-proposal', docKey: '사업 제안서.hwpx' },
    'the detach is remembered and its compaction was asked for');

  // 같은 허브 세션에서 문서 없이 다시 시작하고, 뗀 문서를 싣는다. 압축은 한 번, 문서를 뗀 까닭으로 청한다.
  await page.waitForFunction((count) => window.sidebarPreview.snapshot().compactions.length > count, {},
    before.compactions.length);
  await page.waitForSelector('.ag-marker-compaction', { timeout: 10_000 });
  await idle(page);
  const after = await page.evaluate(() => window.sidebarPreview.snapshot());
  const start = after.chatStarts.at(-1);
  assert.deepEqual([start.threadId, start.documentId, start.detachedFrom],
    [threadId, null, { documentId: 'preview-proposal', documentName: '사업 제안서.hwpx' }]);
  assert.deepEqual(after.compactions.slice(before.compactions.length), [{ reason: 'document-detached' }]);
  assert.equal(after.stops, before.stops, 'detaching never stops the hub chat');
  assert.equal(await page.$('.ag-msg-system'), null, 'the compaction leaves no system message');
  assert.deepEqual(await toggle(page), { hidden: false, label: '문서 연결', disabled: false, title: '문서 연결' });
  if (screenshot) await screenshot('document-detached');

  // 4. 다시 이으면 문서 선택이 열리고, 고른 문서를 이 채팅에 이으며 하마가 이름을 쓴다.
  await page.click('.ag-doc-link-toggle');
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-rail-popover [role="option"]')]
    .some((node) => node.textContent?.includes('회의록')));
  const option = await page.evaluateHandle(() => [...document.querySelectorAll('.ag-rail-popover [role="option"]')]
    .find((node) => node.textContent?.includes('회의록')));
  await option.asElement().click();
  await page.waitForSelector('.ag-document-context .ag-doc-name-fx');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().documentLinks.length === 1);
  await page.waitForFunction(() => !document.querySelector('.ag-doc-name-fx'), { timeout: 10_000 });
  assert.equal(await dockedName(page), '회의록.hwpx');
  const relinked = await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id), threadId);
  assert.deepEqual([relinked.documentId, relinked.documentDetachedFrom], ['preview-notes', undefined]);
  assert.ok(relinked.documentLinkChangedAt > stored.documentLinkChangedAt);
  assert.equal((await toggle(page)).label, '문서에서 분리');
}
