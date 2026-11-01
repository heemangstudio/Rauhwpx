// 설정 → 단축키 탭: 앱과 같은 단축키 서비스(localStorage 'rhwp-shortcuts')에 미리보기의 표본 명령 목록.
//  - 분류별 목록과 칩, 탭 안 검색(이름·키), 키로 찾기.
//  - 기록: + 로 더하기, 다른 명령의 키는 바꾸기·취소, 맨 글자 키 오류, 기록 중 / 와 Esc 가 설정을 건드리지 않음.
//  - 키보드만으로: Tab 으로 + 까지, Enter 로 기록, Esc 취소, Backspace 지우기.
//  - 다시 열어도 남는 지정, 사용자 지정 거르기, 줄 기본값, 모두 기본값으로(확인 시트), 설정 검색.
import assert from 'node:assert/strict';

const PANE = '#ag-settings-pane-shortcuts';
const URL = 'page=settings&destination=shortcuts';

const row = (id) => `${PANE} .ag-shortcuts-row[data-command="${id}"]`;
const bindingsOf = (page, id) => page.$$eval(`${row(id)} .ag-shortcut-binding`, (nodes) => nodes.map((node) => node.dataset.binding));
const visibleRows = (page) => page.$$eval(`${PANE} .ag-shortcuts-row`, (nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.dataset.command));
const statusText = (page) => page.$eval(`${PANE} .ag-shortcuts-status`, (node) => node.textContent);
const rowMessage = (page, id) => page.$eval(`${row(id)} .ag-shortcuts-row-message`, (node) => (node.hidden ? '' : node.textContent));
const activeInfo = (page) => page.evaluate(() => {
  const node = document.activeElement;
  return {
    className: node?.className ?? '',
    command: node?.closest('.ag-shortcuts-row')?.dataset.command ?? null,
    binding: node?.closest('.ag-shortcut-binding')?.dataset.binding ?? null,
    text: node?.textContent ?? '',
  };
});
const customCount = (page) => page.$eval(`${PANE} .ag-shortcuts-filter .ag-settings-segment:last-child`, (node) => node.textContent);

async function openTab(page, open, query) {
  await open(query);
  await page.waitForSelector(`${PANE} .ag-shortcuts-row`, { visible: true });
}

async function setSearch(page, value) {
  await page.$eval(`${PANE} .ag-shortcuts-search`, (input, next) => {
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function pressChord(page, modifiers, key) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

async function startAdd(page, id) {
  await page.click(`${row(id)} .ag-shortcut-add`);
  await page.waitForFunction(() => document.activeElement?.classList.contains('ag-shortcut-capture'));
}

export async function checkShortcutsTab({ page, open, screenshot }) {
  await openTab(page, open, `reset=1&${URL}`);

  // ── 분류와 칩 ──
  const groups = await page.$$eval(`${PANE} .ag-shortcuts-group`, (nodes) => nodes
    .filter((node) => !node.hidden)
    .map((node) => node.querySelector('.ag-settings-group-title').textContent));
  assert.deepEqual(groups, ['파일', '편집', '보기', '입력', '서식', '쪽', '표', '도움말'], 'category groups in order');
  assert.deepEqual(await bindingsOf(page, 'format:bold'), ['mod+b', 'alt+shift+b'], 'bold shows both default keys');
  assert.equal(await page.$eval(`${row('insert:footnote')} .ag-shortcut-chip-fixed`, (node) => node.title),
    '연속 키 단축키는 바꿀 수 없습니다.', 'chord keys are fixed chips');
  assert.equal(await page.$(`${row('edit:undo')} .ag-shortcut-add`), null, 'locked rows have no add button');
  assert.match(await page.$eval(row('edit:undo'), (node) => node.textContent), /고정.*앱 메뉴가 쓰는 키라 바꿀 수 없습니다\./);
  assert.equal(await page.$eval(row('format:strikethrough'), (node) => node.querySelector('.ag-shortcuts-none')?.textContent), '없음');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-reset-all`, (node) => node.disabled), true, 'nothing to reset yet');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-footnote`, (node) => node.textContent),
    '화살표·Home·Esc 같은 이동 키, 복사·붙이기, 연속 키(Ctrl+K,H 등)는 바꿀 수 없습니다.');
  // 비어 있는 상태 줄도 접근성 트리에 남는다(live region 이 미리 있어야 읽힌다).
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-status`, (node) => node.textContent === ''
    && getComputedStyle(node).display !== 'none'), true, 'empty status live region stays rendered');

  // ── 탭 안 검색 ──
  await setSearch(page, '굵게');
  assert.deepEqual(await visibleRows(page), ['format:bold'], 'search by name');
  await setSearch(page, 'ctrl+b');
  assert.deepEqual(await visibleRows(page), ['format:bold'], 'search by key');
  await setSearch(page, 'ctrlb');
  assert.deepEqual(await visibleRows(page), ['format:bold'], 'search ignores +');
  // 온전한 키 표기는 그 키만 — 'ctrls' 가 Ctrl+Shift 줄에, 'alt+s' 가 Alt+Shift 줄에 걸리지 않는다.
  await setSearch(page, 'ctrl+s');
  assert.deepEqual(await visibleRows(page), ['file:save'], 'typed Ctrl+S matches only its owner');
  await setSearch(page, 'alt+s');
  assert.deepEqual(await visibleRows(page), [], 'typed Alt+S does not match Alt+Shift rows');
  // 덜 적은 키 표기는 글자 일부로 견준다.
  await setSearch(page, 'ctrl+sh');
  assert((await visibleRows(page)).includes('file:save-as'), 'partial key text still narrows by text');
  // 고정 칩의 키도 글로 찾는다.
  await setSearch(page, 'ctrl+c');
  assert((await visibleRows(page)).includes('edit:copy'), 'typed Ctrl+C finds the locked copy row');
  await setSearch(page, '없는 명령');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-empty`, (node) => node.textContent), '‘없는 명령’에 맞는 명령이 없습니다.');
  await setSearch(page, '');
  // 키로 찾기: 누른 키를 가진 줄만.
  await page.click(`${PANE} .ag-shortcuts-keysearch`);
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-search`, (node) => node.placeholder), '찾을 키를 누르세요 · Esc 끝내기');
  await pressChord(page, ['Control'], 'KeyS');
  assert.deepEqual(await visibleRows(page), ['file:save'], 'key search finds Ctrl+S');
  // Backspace 는 찾은 키를 지우고 목록을 모두 되돌린다(빈 칸 옆에 예전 키로 거른 목록이 남지 않는다).
  await page.keyboard.press('Backspace');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-search`, (node) => node.value), '');
  assert((await visibleRows(page)).length > 50, 'clearing the key search shows every row');
  // 고정 칩(복사하기 Ctrl+C)도 키로 찾는다.
  await pressChord(page, ['Control'], 'KeyC');
  assert((await visibleRows(page)).includes('edit:copy'), 'key search finds the locked Ctrl+C row');
  // 오류(맨 글자 키)도 찾던 키를 지운다.
  await page.keyboard.press('KeyX');
  assert((await visibleRows(page)).length > 50, 'an error clears the key search');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-keysearch`, (node) => node.getAttribute('aria-pressed')), 'false');
  assert.equal(await page.$eval(PANE, (node) => node.checkVisibility()), true, 'Esc ends key search, settings stay open');
  assert((await visibleRows(page)).length > 50, 'all rows are back');

  // ── + 로 더하기 ──
  await startAdd(page, 'format:bold');
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  assert.match(await page.$eval(`${PANE} .ag-shortcut-capture`, (node) => node.value), /…$/, 'modifier-only shows a live preview');
  await page.keyboard.press('KeyB');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  assert.deepEqual(await bindingsOf(page, 'format:bold'), ['mod+shift+b', 'mod+b', 'alt+shift+b']);
  assert.match(await statusText(page), /^‘굵게’에 .+B를 지정했습니다\.$/);
  assert.deepEqual(await activeInfo(page).then(({ binding }) => binding), 'mod+shift+b', 'focus moves to the new chip');
  // 다른 창의 변경(storage 이벤트)으로 다시 그려도 초점은 같은 칩에 남는다.
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'rhwp-shortcuts' })));
  assert.deepEqual(await activeInfo(page).then(({ command, binding, className }) => ({ command, binding, className })),
    { command: 'format:bold', binding: 'mod+shift+b', className: 'ag-shortcut-chip' }, 'external re-render keeps chip focus');
  assert.equal(await page.$eval(row('format:bold'), (node) => node.querySelector('.ag-shortcuts-badge-changed').hidden), false);
  assert.equal(await page.$eval(`${row('format:bold')} .ag-shortcuts-reset`, (node) => node.hidden), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp-shortcuts')).commands['format:bold'].add[0]), 'mod+shift+b');
  await screenshot('shortcuts-tab-recorded');
  await page.$eval(PANE, (node) => node.scrollTo({ top: 0 }));
  await screenshot('shortcuts-tab');

  // ── 다른 명령의 키: 바꾸기 ──
  await startAdd(page, 'format:italic');
  await pressChord(page, ['Control'], 'KeyS');
  assert.match(await rowMessage(page, 'format:italic'), /는 ‘저장’에 지정되어 있습니다\.바꾸기취소$/);
  assert.equal((await activeInfo(page)).text, '바꾸기', '바꾸기 is focused');
  await screenshot('shortcuts-tab-conflict');
  await page.click(`${row('format:italic')} .ag-shortcuts-replace`);
  assert.deepEqual(await bindingsOf(page, 'file:save'), [], '저장 lost Ctrl+S');
  assert.deepEqual(await bindingsOf(page, 'format:italic'), ['mod+s', 'mod+i', 'alt+shift+i']);
  assert.match(await statusText(page), /^‘저장’에서 .+S를 빼고 여기에 지정했습니다\.$/);

  // ── 맨 글자 키, 기록 중 / 와 Esc ──
  await startAdd(page, 'format:underline');
  await page.keyboard.press('KeyB');
  assert.equal(await rowMessage(page, 'format:underline'), 'Ctrl이나 Alt와 함께 누르세요. F1~F12는 혼자 써도 됩니다.');
  await page.keyboard.press('Slash');
  assert.equal((await activeInfo(page)).className, 'ag-shortcut-capture', '/ during capture does not move focus to settings search');
  await pressChord(page, ['Control'], 'KeyC');
  assert.match(await rowMessage(page, 'format:underline'), /는 편집기가 직접 쓰는 키입니다\.$/, 'Ctrl+C is reserved');
  await page.keyboard.press('Escape');
  assert.equal(await page.$(`${PANE} .ag-shortcut-capture`), null, 'Esc cancels the capture');
  assert.equal(await page.$eval(PANE, (node) => node.checkVisibility()), true, 'Esc does not close settings');
  assert.equal(await rowMessage(page, 'format:underline'), '', 'cancel clears the message');
  const afterEsc = await activeInfo(page);
  assert.equal(afterEsc.command, 'format:underline');
  assert.match(afterEsc.className, /ag-shortcut-add/, 'focus returns to +');

  // ── 키보드만으로: Tab 으로 + 까지, 기록, Esc, Backspace ──
  await page.$eval(`${row('format:underline')} .ag-shortcut-binding:last-of-type .ag-shortcut-chip`, (node) => node.focus());
  await page.keyboard.press('Tab');
  assert.match((await activeInfo(page)).className, /ag-shortcut-remove/, 'Tab reaches the chip remove button');
  await page.keyboard.press('Tab');
  assert.match((await activeInfo(page)).className, /ag-shortcut-add/, 'Tab reaches +');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('ag-shortcut-capture'));
  await page.keyboard.press('Escape');
  assert.match((await activeInfo(page)).className, /ag-shortcut-add/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('ag-shortcut-capture'));
  await page.keyboard.press('F9');
  assert.equal((await activeInfo(page)).binding, 'f9', 'F9 alone is allowed and focused');
  assert((await bindingsOf(page, 'format:underline')).includes('f9'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('ag-shortcut-capture'));
  await page.keyboard.press('Backspace');
  assert.equal((await bindingsOf(page, 'format:underline')).includes('f9'), false, 'Backspace removes the key being changed');
  assert.equal(await statusText(page), 'F9를 지웠습니다.');
  assert.match((await activeInfo(page)).className, /ag-shortcut-add/, 'focus moves to + after a delete');

  // ── 다시 열기: 남는 지정과 사용자 지정 거르기 ──
  await openTab(page, open, URL);
  assert.deepEqual(await bindingsOf(page, 'format:bold'), ['mod+shift+b', 'mod+b', 'alt+shift+b'], 'bold keeps its key after reload');
  assert.deepEqual(await bindingsOf(page, 'format:italic'), ['mod+s', 'mod+i', 'alt+shift+i']);
  // 굵게·기울임에 더하고 저장에서 뺐다 — 세 명령이 기본값과 다르다.
  assert.equal(await customCount(page), '사용자 지정 3');
  await page.click(`${PANE} .ag-shortcuts-filter .ag-settings-segment:last-child`);
  assert.deepEqual(await visibleRows(page), ['file:save', 'format:bold', 'format:italic']);

  // ── 줄 기본값 ──
  await page.click(`${row('format:italic')} .ag-shortcuts-reset`);
  assert.deepEqual(await bindingsOf(page, 'format:italic'), ['mod+i', 'alt+shift+i']);
  assert.equal(await statusText(page), '‘기울임’ 단축키를 기본값으로 되돌렸습니다.');
  await page.click(`${row('file:save')} .ag-shortcuts-reset`);
  assert.deepEqual(await bindingsOf(page, 'file:save'), ['mod+s'], '저장 gets Ctrl+S back');
  assert.equal(await customCount(page), '사용자 지정 1');

  // ── 모두 기본값으로 (확인 시트) ──
  await page.click(`${PANE} .ag-shortcuts-reset-all`);
  await page.waitForSelector('.ag-sheet .ag-sheet-confirm', { visible: true });
  assert.equal(await page.$eval('.ag-sheet .ag-sheet-title', (node) => node.textContent), '단축키를 모두 기본값으로');
  assert.equal(await page.$eval('.ag-sheet .ag-sheet-message', (node) => node.textContent), '직접 지정한 단축키 1개를 지우고 기본 단축키로 되돌립니다.');
  assert.equal(await page.$eval('.ag-sheet .ag-sheet-confirm', (node) => node.textContent), '되돌리기');
  await page.click('.ag-sheet .ag-sheet-confirm');
  await page.waitForFunction(() => !document.querySelector('.ag-sheet'));
  assert.equal(await statusText(page), '모든 단축키를 기본값으로 되돌렸습니다.');
  assert.deepEqual(await bindingsOf(page, 'format:bold'), ['mod+b', 'alt+shift+b']);
  assert.equal(await customCount(page), '사용자 지정 0');
  assert.equal(await page.$eval(`${PANE} .ag-shortcuts-reset-all`, (node) => node.disabled), true);
  assert((await visibleRows(page)).length > 50, 'the custom filter falls back to 전체 once nothing is customized');

  // ── 설정 검색에서 단축키 탭으로 ──
  await page.click('#ag-settings-tab-theme');
  await page.waitForSelector('#ag-settings-pane-theme', { visible: true });
  await page.click('.ag-settings-search-input');
  await page.keyboard.type('단축키');
  await page.waitForSelector('.ag-settings-search-result', { visible: true });
  const result = await page.$$eval('.ag-settings-search-result', (nodes) => nodes.map((node) => ({
    label: node.querySelector('.ag-settings-search-result-label').textContent,
    path: node.querySelector('.ag-settings-search-result-path').textContent,
  })));
  assert(result.some((item) => item.label === '단축키' && item.path === '단축키'), `global search lists the tab: ${JSON.stringify(result)}`);
  await page.keyboard.press('Enter');
  await page.waitForSelector(PANE, { visible: true });
  // 명령 이름도 설정 검색에 걸린다.
  await page.click('.ag-settings-search-input', { clickCount: 3 });
  await page.keyboard.type('굵게');
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-settings-search-result-label')].some((node) => node.textContent === '굵게'));

  // ── 어두운 테마 ──
  await openTab(page, open, URL);
  await page.evaluate(() => {
    const theme = document.querySelector('#theme');
    theme.value = 'dark';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.documentElement.dataset.themeEffective === 'dark');
  await startAdd(page, 'format:italic');
  await pressChord(page, ['Control'], 'KeyS');
  await page.waitForSelector(`${row('format:italic')} .ag-shortcuts-replace`, { visible: true });
  await page.click(`${row('format:italic')} .ag-shortcuts-cancel`);
  assert.deepEqual(await bindingsOf(page, 'format:italic'), ['mod+i', 'alt+shift+i'], '취소 leaves the binding alone');
  await startAdd(page, 'format:bold');
  await pressChord(page, ['Control', 'Shift'], 'KeyB');
  await page.$eval(PANE, (node) => node.scrollTo({ top: 0 }));
  await screenshot('shortcuts-tab-dark');
}
