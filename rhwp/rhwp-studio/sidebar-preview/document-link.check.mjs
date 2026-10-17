// 문서 없는 채팅에 문서 잇기: 문서 연결 동의(일회성), 저장 안내 줄의 두 단추, 도는 턴을 멈추지 않는 연결,
// 다른 창의 채팅 저장소가 연결을 따라가는지. 실제 사이드바와 미리보기의 모의 브리지·편집기로 돈다.
import assert from 'node:assert/strict';

async function startUnlinkedChat(page, open, query = '') {
  await open(`reset=1&scenario=chat&document=empty${query ? `&${query}` : ''}`);
  await page.type('.ag-input', '자료를 모아 정리해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-msg-user');
  const threadId = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());
  assert.ok(threadId, 'the chat was saved');
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.isUnlinkedChat()), true);
  return threadId;
}

const snapshot = (page) => page.evaluate(() => {
  const state = window.sidebarPreview.snapshot();
  return {
    stops: state.stops, interrupts: state.interrupts, chatStarts: state.chatStarts.length,
    running: state.running, documentLinks: state.documentLinks, grants: state.chatPermissionGrants,
  };
});

export async function checkDocumentLink({ page, open, screenshot }) {
  // 1. 문서 연결 동의: 이름·상태·경로를 보이고, 허락해도 채팅 권한으로 남지 않는다.
  const threadId = await startUnlinkedChat(page, open);
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(() => window.sidebarPreview.requestDocumentLink());
  const pill = '.ag-permission-pill[data-capability="document-link"]';
  await page.waitForSelector(`${pill} .ag-permission-grant`, { visible: true });
  assert.deepEqual(await page.$eval(pill, (node) => ({
    label: node.querySelector('.ag-permission-label')?.textContent,
    status: node.querySelector('.ag-permission-status')?.textContent,
    path: node.querySelector('.ag-permission-path')?.textContent,
  })), {
    label: '문서 연결 · 2026 사업계획서.hwpx',
    status: '이 채팅에 연결',
    path: '/Users/hama/Documents/HamaEditor/2026 사업계획서.hwpx',
  });
  if (screenshot) await screenshot('document-link-pill');
  await page.click(`${pill} .ag-permission-grant`);
  await page.waitForSelector(`${pill}[data-status="granted"]`);
  assert.equal(await page.$eval(`${pill} .ag-permission-status`, (node) => node.textContent), '연결됨');
  assert.deepEqual((await snapshot(page)).grants, [], 'a link consent is never a chat-wide grant');
  await page.evaluate(() => window.sidebarPreview.finishTurn());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());

  // 2. 저장 안내 줄 — 새 문서는 이 채팅에 새 문서를 잇는다. 채팅은 멈추지도 새로 시작하지도 않는다.
  const second = await page.browser().newPage();
  await second.goto(new URL('/?theme=light&width=480', page.url()).href, { waitUntil: 'networkidle0' });
  // 뒤에 있는 탭은 그리기를 멈춘다 — 그 탭은 시간 간격으로 살핀다.
  await second.waitForFunction((id) => window.sidebarPreview?.threadStore.getThread(id), { polling: 100 }, threadId);
  assert.equal(await second.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).documentId, threadId), null);
  await page.bringToFront();

  await page.evaluate(() => window.sidebarPreview.emitDocumentRequired('project_edit'));
  await page.waitForSelector('.ag-doc-required', { visible: true });
  assert.deepEqual(await page.$eval('.ag-doc-required', (row) => ({
    label: row.querySelector('.ag-doc-required-label')?.textContent,
    actions: [...row.querySelectorAll('button')].map((button) => button.textContent),
  })), { label: '저장하려면 문서가 필요해요', actions: ['새 문서', '문서 연결'] });
  if (screenshot) await screenshot('document-required-row');
  const before = await snapshot(page);
  await page.click('.ag-doc-required-create');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().documentLinks.length === 1);
  const after = await snapshot(page);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.linkCalls), [{ kind: 'new' }]);
  assert.equal(after.documentLinks[0].threadId, threadId, 'the hub links this chat');
  assert.deepEqual([after.stops, after.interrupts, after.chatStarts], [before.stops, before.interrupts, before.chatStarts],
    'linking neither stops nor restarts the chat');
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), threadId);
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.isUnlinkedChat()), false);
  assert.equal(await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id).documentId, threadId), 'preview-new-1');
  assert.equal(await page.$('.ag-doc-required'), null, 'the row leaves once the chat has a document');
  assert.ok(await page.$(`${pill}[data-status="granted"]`), 'the granted link pill stays in the chat');
  // 다른 창의 저장소도 연결을 따라간다(레일은 이 저장소를 읽는다).
  await second.waitForFunction((id) => window.sidebarPreview.threadStore.getThread(id)?.documentId === 'preview-new-1',
    { polling: 100, timeout: 10_000 }, threadId);
  await second.close();
  // 이은 채팅에는 더 잇지 않는다.
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.beginDocumentLink()), null);

  // 3. 도는 턴 중의 문서 연결 — 문서 선택으로 최근 문서를 고른다. 턴은 그대로 돈다.
  const runningThread = await startUnlinkedChat(page, open, 'hold=1');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(() => window.sidebarPreview.emitDocumentRequired('project_import'));
  await page.waitForSelector('.ag-doc-required-link', { visible: true });
  const running = await snapshot(page);
  await page.click('.ag-doc-required-link');
  await page.waitForSelector('.ag-rail-popover [role="option"]', { visible: true });
  const option = await page.evaluateHandle(() => [...document.querySelectorAll('.ag-rail-popover [role="option"]')]
    .find((node) => node.textContent?.includes('회의록')));
  await option.asElement().click();
  await page.waitForFunction(() => window.sidebarPreview.snapshot().documentLinks.length === 1);
  const linked = await snapshot(page);
  assert.equal(linked.documentLinks[0].threadId, runningThread);
  assert.equal(linked.documentLinks[0].documentId, 'preview-notes');
  assert.equal(linked.documentLinks[0].running, true, 'the link happened while the turn ran');
  assert.equal(linked.running, true, 'the turn keeps running');
  assert.deepEqual([linked.stops, linked.interrupts, linked.chatStarts], [running.stops, running.interrupts, running.chatStarts]);
  if (screenshot) await screenshot('document-linked-mid-turn');
  await page.evaluate(() => window.sidebarPreview.finishTurn());
}
