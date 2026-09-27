/**
 * E2E 테스트: 쪽을 넘나드는 문단에 입력할 때 다음 쪽도 바로 다시 그려진다.
 *
 * 배경:
 *   줄 구성이 그대로인 입력은 pagination 을 지연하고 캐럿 쪽만 다시 그린다. 문단이 다음
 *   쪽까지 이어지면 뒤로 밀린 글자는 다음 쪽 줄에 그려지므로, 그 쪽을 그리지 않으면 입력
 *   내내 글자가 사라진 것처럼 보인다. 종전에는 쪽 바닥 근처에서 키마다 pagination 전체를
 *   확정해 막았고(키당 10ms 이상), 지금은 문단이 걸친 쪽만 page-local 로 다시 그린다.
 *
 * 검증: 지연 flush 를 막은 상태로 입력한 직후의 두 쪽 픽셀이 pagination 을 확정하고
 *   전체를 다시 그린 결과와 같다. (1) 두 쪽에 걸친 문단에 IME 조합·영문 입력,
 *   (2) 쪽 바닥에서 끝나는 문단 끝에 입력해 줄이 다음 쪽으로 넘어가는 경우.
 *
 * 사전 조건: WASM 빌드(pkg/) + Vite dev server
 * 실행: node e2e/typing-page-spanning-paragraph.test.mjs --mode=headless
 */
import { runTest, createNewDocument, assert } from './helpers.mjs';

const nextFrames = (page, count = 3) => page.evaluate((n) => new Promise((resolve) => {
  const step = (left) => (left === 0 ? setTimeout(resolve, 0) : requestAnimationFrame(() => step(left - 1)));
  step(n);
}), count);

async function pagePixels(page, pages) {
  return page.evaluate((list) => list.map((index) => {
    const canvas = window.__canvasView.canvasPool.getCanvas(index);
    return canvas ? canvas.toDataURL('image/png') : null;
  }), pages);
}

await runTest('쪽을 넘나드는 문단 입력', async ({ page }) => {
  await page.setViewport({ width: 1200, height: 1600 });
  await createNewDocument(page);

  // 두 쪽에 걸친 긴 문단을 만들고 첫 쪽 마지막 줄 근처에 캐럿을 둔다.
  const setup = await page.evaluate(() => {
    const wasm = window.__wasm;
    const handler = window.__inputHandler;
    const sentence = '쪽을 넘나드는 문단의 글자가 다음 쪽 줄로 밀려도 바로 보여야 합니다. ';
    wasm.insertText(0, 0, 0, sentence.repeat(90));
    handler.flushDeferredPaginationIfNeeded('test-setup', true);
    const len = wasm.getParagraphLength(0, 0);
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (wasm.getCursorRect(0, 0, mid).pageIndex === 0) lo = mid; else hi = mid - 1;
    }
    const offset = Math.max(0, lo - 12);
    handler.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: offset });
    handler.updateCaret();
    handler.textarea.focus();
    return { pages: wasm.getParagraphPages(0, 0), offset, lastOffsetOnPage0: lo };
  });
  assert(setup.pages.length >= 2, `문단이 두 쪽 이상에 걸친다 (${JSON.stringify(setup.pages)})`);
  await page.evaluate(() => {
    const info = window.__wasm.getPageInfo(0);
    document.getElementById('scroll-container').scrollTop = info.height * 0.6;
  });
  await nextFrames(page, 6);

  // idle flush 를 막아 지연 pagination 상태의 화면을 그대로 검사한다.
  const typed = await page.evaluate(async () => {
    const handler = window.__inputHandler;
    handler.scheduleDeferredPaginationFlush = function () {
      this.deferredPaginationPending = true;
    };
    const invalidated = new Set();
    const off = window.__eventBus.on('document-page-invalidated', (payload) => {
      invalidated.add(payload.pageIndex);
    });
    const ta = handler.textarea;
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const fire = (type, init) => ta.dispatchEvent(type === 'input'
      ? new InputEvent('input', { bubbles: true, ...init })
      : new CompositionEvent(type, { bubbles: true, ...init }));
    let base = ta.value.length;
    for (const stages of [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]) {
      fire('compositionstart', { data: '' });
      for (const preedit of stages) {
        ta.value = ta.value.slice(0, base) + preedit;
        fire('compositionupdate', { data: preedit });
        fire('input', { data: preedit, inputType: 'insertCompositionText', isComposing: true });
        await frame();
      }
      const text = stages.at(-1);
      fire('compositionend', { data: text });
      fire('input', { data: text, inputType: 'insertFromComposition', isComposing: false });
      base = ta.value.length;
      await frame();
    }
    for (const ch of 'abcdef') {
      ta.value += ch;
      fire('input', { data: ch, inputType: 'insertText', isComposing: false });
      await frame();
    }
    off();
    return {
      pending: handler.hasDeferredPaginationPending(),
      caretPage: handler.cursor.getRect()?.pageIndex,
      invalidated: [...invalidated].sort((a, b) => a - b),
    };
  });
  await nextFrames(page);

  assert(typed.pending, '입력 뒤 pagination 이 지연 상태로 남는다 (page-local 경로 검증)');
  assert(typed.caretPage === 0, `캐럿이 첫 쪽에 머문다 (${typed.caretPage})`);
  assert(typed.invalidated.includes(1), `다음 쪽도 page-local 로 다시 그린다 (${JSON.stringify(typed.invalidated)})`);

  const before = await pagePixels(page, [0, 1]);
  assert(before.every(Boolean), '두 쪽 canvas 가 모두 그려져 있다');

  await page.evaluate(() => {
    window.__inputHandler.flushDeferredPaginationIfNeeded('test-verify', true);
  });
  await nextFrames(page, 6);
  const after = await pagePixels(page, [0, 1]);

  assert(before[0] === after[0], '첫 쪽: 지연 상태 화면이 확정 조판 화면과 같다');
  assert(before[1] === after[1], '다음 쪽: 지연 상태 화면이 확정 조판 화면과 같다');

  const text = await page.evaluate((offset) => window.__wasm.getTextRange(0, 0, offset, 12), setup.offset);
  assert(text.startsWith('한글abcdef'), `입력한 글자가 문단에 들어간다 (${JSON.stringify(text)})`);

  // ── 2) 쪽 바닥 근처 문단 끝에서 입력해 줄이 다음 쪽으로 넘어간다
  await createNewDocument(page);
  const bottom = await page.evaluate(() => {
    const wasm = window.__wasm;
    const handler = window.__inputHandler;
    const sentence = 'Typing near the bottom of a page must wrap onto the next page. ';
    let count = 0;
    // 한 쪽을 넘기 직전까지 채운다.
    for (;;) {
      wasm.insertText(0, 0, wasm.getParagraphLength(0, 0), sentence);
      handler.flushDeferredPaginationIfNeeded('test-setup', false);
      count += 1;
      const pages = wasm.getParagraphPages(0, 0);
      if (pages.length > 1) {
        const len = wasm.getParagraphLength(0, 0);
        wasm.deleteText(0, 0, len - sentence.length, sentence.length);
        handler.flushDeferredPaginationIfNeeded('test-setup', true);
        break;
      }
      if (count > 200) break;
    }
    const len = wasm.getParagraphLength(0, 0);
    handler.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: len });
    handler.updateCaret();
    handler.textarea.focus();
    handler.scheduleDeferredPaginationFlush = function () {
      this.deferredPaginationPending = true;
    };
    return { pages: wasm.getParagraphPages(0, 0), len };
  });
  assert(bottom.pages.length === 1, `문단이 첫 쪽 바닥에서 끝난다 (${JSON.stringify(bottom.pages)})`);
  await page.evaluate(() => {
    const info = window.__wasm.getPageInfo(0);
    document.getElementById('scroll-container').scrollTop = info.height * 0.6;
  });
  await nextFrames(page, 6);
  await page.evaluate(async () => {
    const ta = window.__inputHandler.textarea;
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    for (const ch of 'The tail line keeps growing until it moves onto the following page.') {
      ta.value += ch;
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText', isComposing: false }));
      await frame();
    }
  });
  await nextFrames(page);
  const wrapped = await page.evaluate(() => window.__wasm.getParagraphPages(0, 0));
  assert(wrapped.length > 1, `입력한 줄이 다음 쪽으로 넘어간다 (${JSON.stringify(wrapped)})`);
  const bottomBefore = await pagePixels(page, [0, 1]);
  assert(bottomBefore.every(Boolean), '두 쪽 canvas 가 모두 그려져 있다');
  await page.evaluate(() => {
    window.__inputHandler.flushDeferredPaginationIfNeeded('test-verify', true);
  });
  await nextFrames(page, 6);
  const bottomAfter = await pagePixels(page, [0, 1]);
  assert(bottomBefore[0] === bottomAfter[0], '쪽 바닥 첫 쪽: 확정 조판 화면과 같다');
  assert(bottomBefore[1] === bottomAfter[1], '쪽 바닥 다음 쪽: 확정 조판 화면과 같다');
});
