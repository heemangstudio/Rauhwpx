import { clickPage, loadApp, newDocument, waitFor } from './lib.mjs';

const MARK = 'RECOVER_ME';

export default {
  name: 'autosave recovery after a crash',
  async run({ page, context, url }) {
    // 유휴 자동 저장을 허용 최소값(5초)으로 줄여 실제 예약 경로가 복구본을 쓰게 한다.
    await page.evaluate(() => localStorage.setItem('hamaeditor-settings',
      JSON.stringify({ autosave: { idleSaveEnabled: true, idleDelaySeconds: 5 } })));
    await loadApp(page, url);
    await newDocument(page);
    await clickPage(page);
    await page.keyboard.type(MARK);
    await page.waitForFunction(async (mark) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('hamaeditorAutosave');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!db.objectStoreNames.contains('drafts')) { db.close(); return false; }
      const drafts = await new Promise((resolve) => {
        const req = db.transaction('drafts').objectStore('drafts').getAll();
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      return drafts.some((draft) => draft.byteLength > 0) && window.__wasm.getTextRange(0, 0, 0, 100) === mark;
    }, { timeout: 15000, polling: 250 }, MARK).catch((error) => {
      throw new Error('autosave did not write a draft', { cause: error });
    });

    // 렌더러를 죽여 창이 정리 코드 없이 사라진 상황을 만든다.
    // Page.crash 는 응답하지 않으므로 기다리지 않고, 페이지의 crash 이벤트를 기다린다.
    const crashed = new Promise((resolve) => page.once('error', resolve));
    void (await page.createCDPSession()).send('Page.crash').catch(() => {});
    await crashed;
    await page.close().catch(() => {});

    const next = await context.newPage();
    next.on('dialog', (dialog) => void dialog.dismiss());
    await next.setViewport({ width: 1280, height: 900 });
    await loadApp(next, url);
    await waitFor(next, 'recovery dialog', () => document.querySelector('.modal-overlay .dialog-wrap')?.textContent.includes('복구'));
    await next.evaluate(() => [...document.querySelectorAll('.modal-overlay .dialog-btn')]
      .find((button) => button.textContent.trim() === '복구').click());
    // 복구한 문서는 글자를 그대로 되찾고, 다시 저장하기 전까지 미저장 상태로 남는다.
    await waitFor(next, 'recovered unsaved text', (mark) => window.__wasm.pageCount > 0
      && window.__wasm.getTextRange(0, 0, 0, 100) === mark && window.__documentState.isDirty(), MARK);
  },
};
