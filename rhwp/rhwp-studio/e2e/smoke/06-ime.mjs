import { clickPage, newDocument, shortcut, waitFor } from './lib.mjs';

const textIs = (page, label, expected) => waitFor(page, `${label} → ${JSON.stringify(expected)}`,
  (value) => window.__wasm.getTextRange(0, 0, 0, 100) === value, expected);

/** 한글 IME 처럼 확정한 음절을 textarea 값에 남긴 채 다음 음절을 조합한다. */
function composeSyllables(page, syllables) {
  return page.evaluate((list) => {
    const textarea = window.__inputHandler.textarea;
    let prefix = textarea.value;
    for (const steps of list) {
      const final = steps.at(-1);
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      for (const step of steps) {
        textarea.value = prefix + step;
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: step }));
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: step, inputType: 'insertCompositionText', isComposing: true }));
      }
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: final }));
      // 일부 IME 는 확정 뒤 같은 글자의 input 을 한 번 더 보낸다. 두 번 들어가면 안 된다.
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: final, inputType: 'insertText', isComposing: false }));
      prefix += final;
    }
  }, syllables);
}

export default {
  name: 'IME composition',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    const cdp = await page.createCDPSession();

    // 조합 중인 글자는 바로 보이고, 조합 중 클릭(커서 이동)은 글자를 확정하며 자모를 남기지 않는다.
    for (const text of ['ㄱ', '가']) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
    await textIs(page, 'preedit', '가');
    await clickPage(page);
    await textIs(page, 'composition committed by click', '가');
    for (const text of ['ㄴ', '나']) await cdp.send('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '나' });
    await textIs(page, 'next syllable after the click', '가나');

    // 누적되는 textarea 값에서 음절마다 정확히 한 번 확정되고, 되돌리기와 다시 실행이 조합 입력을 온전히 오간다.
    await newDocument(page);
    await clickPage(page);
    await composeSyllables(page, [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]);
    await textIs(page, 'two committed syllables', '한글');
    await shortcut(page, 'KeyZ');
    await textIs(page, 'undo composed text', '');
    await shortcut(page, 'KeyZ', { shift: true });
    await textIs(page, 'redo composed text', '한글');
  },
};
