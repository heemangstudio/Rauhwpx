import assert from 'node:assert/strict';
import { clickPage, loadApp, newDocument, waitFor } from './lib.mjs';

const MARK = 'UNSAVED_GUARD';

/** 열린 문서 세션마다 { current, text, dirty }. */
const sessions = (page) => page.evaluate(() => window.__documentSessions.list()
  .filter((session) => session.wasm.hasLoadedDocument())
  .map((session) => ({
    current: session === window.__documentSessions.attached(),
    text: session.wasm.getTextRange(0, 0, 0, 100),
    dirty: session.documentState.isDirty(),
  })));

/** 데스크톱 창 닫기 요청을 보내고, 미저장 확인 창이 뜨면 label 버튼을 누른 뒤 창이 닫혀도 되는지 돌려준다. */
async function requestWindowClose(page, label) {
  const requestId = await page.evaluate(() => window.__smokeClose.request());
  await waitFor(page, 'unsaved changes dialog',
    () => document.querySelector('.modal-overlay .dialog-wrap')?.textContent.includes('저장하지 않은 변경사항'));
  await page.evaluate((name) => {
    [...document.querySelectorAll('.modal-overlay .dialog-btn')]
      .find((button) => button.textContent.trim() === name).click();
  }, label);
  await waitFor(page, 'close answer', (id) => window.__smokeClose.answers.has(id), requestId);
  return page.evaluate((id) => window.__smokeClose.answers.get(id), requestId);
}

export default {
  name: 'unsaved-changes guard',
  async run({ page, url }) {
    // 데스크톱 preload 의 창 닫기 요청 통로만 흉내 낸다. 나머지는 웹 앱 그대로다.
    await page.evaluateOnNewDocument(() => {
      let listener = null;
      let next = 0;
      window.__smokeClose = { answers: new Map(), request: () => {
        const requestId = `close-${next += 1}`;
        listener({ requestId, reason: 'close' });
        return requestId;
      } };
      window.rhwpDesktop = {
        onCloseRequested: (callback) => { listener = callback; },
        respondToCloseRequest: (requestId, allow) => { window.__smokeClose.answers.set(requestId, allow); },
      };
    });
    await loadApp(page, url);
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type(MARK);
    await waitFor(page, 'dirty document', () => window.__documentState.isDirty());

    // 새 문서는 새 탭에 열린다. 바뀐 문서는 묻지 않고 뒤 탭으로 남는다.
    const created = await page.evaluate(() => new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const off = window.__eventBus.on('create-new-document:done', (payload) => {
        if (payload.requestId !== requestId) return;
        off();
        resolve(payload);
      });
      window.__eventBus.emit('create-new-document', { requestId });
    }));
    assert.ok(created.ok, created.error || 'new document failed');
    assert.equal(await page.evaluate(() => document.querySelector('.modal-overlay')), null, 'no prompt for a new tab');
    assert.deepEqual(await sessions(page), [
      { current: false, text: MARK, dirty: true },
      { current: true, text: '', dirty: false },
    ], 'the edited document stays open behind the new tab');

    // 창을 닫으면 뒤 탭의 바뀐 문서를 앞에 띄워 묻는다. 취소하면 창을 닫지 않고 그 문서에 머문다.
    assert.equal(await requestWindowClose(page, '취소'), false, 'cancel keeps the window open');
    assert.deepEqual(await sessions(page), [
      { current: true, text: MARK, dirty: true },
      { current: false, text: '', dirty: false },
    ], 'cancel keeps the edits in front');

    assert.equal(await requestWindowClose(page, '저장 안 함'), true, 'discard lets the window close');
  },
};
