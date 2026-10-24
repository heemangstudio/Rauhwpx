import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const EDITOR = '.ag-settings-instructions-editor';
const SURFACE = `${EDITOR} .ag-mde-surface`;
const SOURCE = `${EDITOR} .ag-mde-source`;
const APPLY = '.ag-settings-ai-footer .ag-settings-primary';

/** 원문 보기로 바꿔 지금 값(저장될 마크다운)을 읽고 서식 보기로 돌아온다. */
async function readMarkdown(page) {
  await page.click(`${EDITOR} .ag-mde-source-toggle`);
  const value = await page.$eval(SOURCE, (area) => area.value);
  await page.click(`${EDITOR} .ag-mde-source-toggle`);
  await page.waitForSelector(SURFACE, { visible: true });
  return value;
}

async function caretToEnd(page, selector) {
  await page.$eval(selector, (el) => {
    el.closest('.ag-mde-surface').focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('li, p, h1, h2, h3') === el || el.tagName !== 'LI') last = node;
    }
    const range = document.createRange();
    if (last) range.setStart(last, last.length);
    else range.setStart(el, 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
}

async function paste(page, text) {
  await page.$eval(SURFACE, (surface, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    data.setData('text/html', '<span style="color:red;font-size:40px">foreign</span>');
    surface.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function open(page, origin, theme) {
  await page.goto(`${origin}/?page=settings&destination=ai-custom&reset=1&controls=0&width=520&theme=${theme}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(`${SURFACE} h1`);
  return page.$eval(`${EDITOR} .ag-mde-surface`, () => true);
}

export async function checkMarkdownEditor(page, origin, artifacts) {
  const mod = (await page.evaluate(() => /mac/i.test(navigator.platform))) ? 'Meta' : 'Control';
  const shot = async (name) => {
    const section = await page.$('.ag-settings-instructions-section');
    await section.screenshot({ path: resolve(artifacts, `markdown-editor-${name}.png`) });
  };

  await open(page, origin, 'light');
  const original = await readMarkdown(page);
  assert.match(original, /^# 앱 에이전트 지시\n\n/);
  assert.equal(await page.$eval(SURFACE, (s) => s.querySelectorAll('h1, h2, ul > li').length), 6, 'headings and list render formatted');
  assert.equal(await page.$eval(APPLY, (b) => b.disabled), true, 'nothing to apply before an edit');
  await shot('light');

  // 목록 끝에 항목을 더하고, 인라인 단축 입력으로 굵게·코드를 만든다.
  await caretToEnd(page, `${SURFACE} ul > li:last-child`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('**굵게** 와 `코드` 확인');
  assert.equal(await page.$eval(APPLY, (b) => b.disabled), false, '적용 enables after an edit');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 빈 항목에서 Enter: 목록을 나간다.
  await page.keyboard.type('## 새 제목');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> 인용문');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 빈 인용 문단에서 Enter: 인용을 나간다.
  await page.keyboard.type('1. 첫째');
  await page.keyboard.press('Enter');
  await page.keyboard.type('둘째');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 하위 항목을 한 단계 내어 쓴다.
  await page.keyboard.type('셋째');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const a = 1;');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 코드 블록 빈 끝줄에서 Enter: 나간다.
  // 막대: 단어를 골라 기울임·링크.
  await page.keyboard.type('끝 문장');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 2; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.click(`${EDITOR} .ag-mde-btn[data-command="italic"]`);
  assert.equal(await page.$eval(`${EDITOR} .ag-mde-btn[data-command="italic"]`, (b) => b.getAttribute('aria-pressed')), 'true');
  await page.keyboard.down(mod);
  await page.keyboard.press('k');
  await page.keyboard.up(mod);
  await page.waitForSelector(`${EDITOR} .ag-mde-link-input`, { visible: true });
  await page.keyboard.type('https://example.com/a b');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${SURFACE} a`);

  const edited = await readMarkdown(page);
  const expectedTail = [
    '- **굵게** 와 `코드` 확인',
    '',
    '## 새 제목',
    '',
    '> 인용문',
    '',
    '1. 첫째',
    '   1. 둘째',
    '2. 셋째',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '끝 *[문장](<https://example.com/a b>)*',
    '',
  ].join('\n');
  assert.equal(edited, original + expectedTail, `edited markdown:\n${edited}`);
  // 손대지 않은 머리 부분은 원문 그대로.
  const head = original.slice(0, original.indexOf('- 모든'));
  assert(edited.startsWith(head), 'untouched blocks stay verbatim');
  await shot('light-edited');

  // 실행 취소는 자체 기록으로 되돌린다.
  await page.focus(SURFACE);
  for (let i = 0; i < 150; i += 1) {
    await page.keyboard.down(mod);
    await page.keyboard.press('z');
    await page.keyboard.up(mod);
  }
  assert.equal(await readMarkdown(page), original, 'undo returns the exact original');
  await page.keyboard.down(mod);
  await page.keyboard.down('Shift');
  await page.keyboard.press('z');
  await page.keyboard.up('Shift');
  await page.keyboard.up(mod);

  // 원문 보기에서 고친 내용도 그대로 저장된다.
  await page.click(`${EDITOR} .ag-mde-source-toggle`);
  await page.$eval(SOURCE, (area) => {
    area.value = `${area.value}\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const withTable = await page.$eval(SOURCE, (area) => area.value);
  await page.click(`${EDITOR} .ag-mde-source-toggle`);
  assert.equal(await page.$eval(SURFACE, (s) => s.querySelectorAll('.ag-mde-raw').length), 1, 'tables show as a raw block');
  assert.equal(await readMarkdown(page), withTable);
  await page.click(APPLY);
  await page.waitForFunction((selector) => document.querySelector(selector)?.disabled, {}, APPLY);
  assert.equal(await readMarkdown(page), withTable, 'applied content round-trips');

  // 붙여넣기: 일반 글을 마크다운 구조로, 외부 HTML 스타일은 버린다.
  await open(page, origin, 'dark');
  await caretToEnd(page, `${SURFACE} > p`);
  await page.keyboard.press('Enter');
  await paste(page, '### 붙여넣은 제목\n\n- 하나\n  - 둘\n\n> 인용\n\n| 표 | 값 |\n|---|---|\n| x | 1 |');
  await page.waitForSelector(`${SURFACE} h3`);
  assert.equal(await page.$eval(SURFACE, (s) => s.querySelector('[style]') === null), true, 'no pasted styles');
  assert.equal(await page.$eval(SURFACE, (s) => [...s.children].filter((el) => el.tagName === 'P' && !el.textContent).length), 0, 'no empty paragraphs left around the paste');
  const pasted = await readMarkdown(page);
  assert(pasted.includes('### 붙여넣은 제목\n\n- 하나\n  - 둘\n\n> 인용\n\n| 표 | 값 |\n|---|---|\n| x | 1 |\n\n## 이 파일 관리'), `pasted markdown:\n${pasted}`);
  await page.$eval(SURFACE, (s) => { s.scrollTop = 0; });
  await shot('dark');
  await page.click(`${EDITOR} .ag-mde-source-toggle`);
  await shot('dark-source');
}
