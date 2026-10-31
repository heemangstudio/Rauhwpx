// 설정 → Rau 탭: 계정의 기억(Rau-0.1)과 문체 학습. 미리보기의 모의 허브(mock-user-memory.ts)에 실제 UI 로 말을 건다.
//  - 잠금: Free·Hama 는 자물쇠와 요금제 카드(Rau 칸), 요금제 API 가 없으면 열려 있고 잔잔한 안내.
//  - 기억: 문체·용어 묶음과 강도 그릇, 고치기·지우기·더하기, 물러난 기억 되살리기, 최근 변화 되돌리기.
//  - 문체 학습: 도는 카드(파일별 진행, 찾는 규칙이 쌓임) → 결과 카드, 멈추기, 실패, 직접 올리기, 입력창 알약.
//  - 입력창: 권유 칩, 이전 원고 칩, /문체학습.
//  - 채팅 구분선: item.change 의 표, 강도, 계정 줄 되돌리기, 모두 보기 → Rau 탭.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PANE = '#ag-settings-pane-rau';
const RAU = 'reset=1&page=settings&destination=rau&plan=rau&userMemory=sample';
const CHAT = 'preview-chat-taste';

const shown = (page, selector) => page.evaluate((s) => document.querySelector(s)?.checkVisibility() ?? false, selector);
const text = (page, selector) => page.$eval(selector, (node) => node.textContent);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function openRau(page, open, query = RAU) {
  await open(query);
  await page.waitForSelector(`${PANE}`, { visible: true });
  await page.waitForFunction(() => document.querySelector('#ag-settings-pane-rau')?.dataset
    && document.querySelector('.ag-rau-pane')?.dataset.availability !== 'loading');
}

/** 기억 묶음별 규칙 — 강한 것부터 보이는 그대로. */
const groups = (page) => page.$$eval('.ag-rau-group', (nodes) => nodes.filter((node) => !node.hidden).map((node) => ({
  kind: node.dataset.kind,
  title: node.querySelector('.ag-rau-group-title').textContent,
  rules: [...node.querySelectorAll('.ag-rau-rule')].map((row) => ({
    id: row.dataset.ruleId,
    text: row.querySelector('.ag-rau-rule-text').textContent,
    strength: Number(row.dataset.strength),
    gauge: row.querySelector('.ag-strength')?.getAttribute('aria-label'),
  })),
})));
const ruleTexts = async (page) => (await groups(page)).flatMap((group) => group.rules.map((rule) => rule.text));
const memory = (page) => page.evaluate(() => window.sidebarPreview.userMemory.snapshot());
const message = (page) => page.$eval('.ag-rau-message', (node) => (node.hidden ? '' : node.textContent));

async function ruleRow(page, ruleId) {
  const row = await page.$(`.ag-rau-rule[data-rule-id="${ruleId}"]`);
  assert(row, `rule ${ruleId} is listed`);
  return row;
}

const SAMPLE_FILES = ['2025 사업계획서.hwpx', '주간 보고 모음.docx', '스캔본 회의록.pdf', '칼럼 초고.md'];

// ── 잠금 ────────────────────────────────────────────────

async function checkLocked({ page, open, screenshot }) {
  for (const tier of ['hama', 'free']) {
    await open(`reset=1&plan=${tier}&userMemory=sample`);
    await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'editing' }));
    await page.waitForSelector('#ag-settings-tab-rau', { visible: true });
    // 자물쇠와 "Rau에서 쓸 수 있어요" — 눌러도 탭은 열리지 않고 요금제 카드가 Rau 칸에 맞춰 열린다.
    assert.equal(await page.$eval('#ag-settings-tab-rau', (tab) => tab.title), 'Rau에서 쓸 수 있어요');
    assert.equal(await shown(page, '#ag-settings-tab-rau .ag-settings-nav-rau-lock'), true, `${tier}: lock icon`);
    assert.equal(await shown(page, PANE), false);
    if (tier === 'hama') await screenshot('rau-tab-locked');
    await page.click('#ag-settings-tab-rau');
    await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]', { visible: true });
    assert.deepEqual(await page.evaluate(() => window.sidebarPreview.planCardRequests), [{ focus: 'rau' }], `${tier}: opens the plan card on Rau`);
    assert.equal(await shown(page, PANE), false, `${tier}: the Rau pane stays closed`);
    assert.equal(await shown(page, '.ag-rau-pane .ag-rau-rule'), false, 'no memory leaks through');
  }

  // 바로 열려 해도 같다.
  await open('reset=1&plan=hama&page=settings&destination=rau&userMemory=sample');
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]', { visible: true });
  assert.equal(await shown(page, PANE), false, 'a direct open stays out of Rau');

  // 요금제가 Rau 로 바뀌면 자물쇠가 풀리고 탭이 열린다.
  await page.click('.ag-pricing-close');
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));
  await page.evaluate(() => window.sidebarPreview.plan.setTier('rau'));
  await page.waitForFunction(() => !document.querySelector('#ag-settings-tab-rau')?.classList.contains('ag-settings-rau-locked'));
  await page.click('#ag-settings-tab-rau');
  await page.waitForSelector(PANE, { visible: true });
  await page.waitForSelector('.ag-rau-rule', { visible: true });
}

async function checkNoPlanApi({ page, open }) {
  // 요금제 API 가 없으면(웹 Studio) 잠그지 않고, 허브는 unavailable 로 답한다: 기억은 보고 고칠 수 있고 배우기는 막힌다.
  await openRau(page, open, 'reset=1&page=settings&destination=rau&userMemory=sample');
  assert.equal(await page.$eval('#ag-settings-tab-rau', (tab) => tab.classList.contains('ag-settings-rau-locked')), false);
  await page.waitForFunction(() => document.querySelector('.ag-rau-pane')?.dataset.availability === 'unavailable');
  assert.equal(await shown(page, '.ag-rau-notice'), true, 'a calm notice');
  assert.equal(await page.$eval('.ag-rau-drop', (button) => button.disabled), true, 'learning is closed');
  assert.equal((await ruleTexts(page)).length, 9, 'the memory is still shown');
  assert.equal(await page.$eval('.ag-rau-rule-edit', (button) => button.disabled), false, 'and editable');
}

async function checkExhausted({ page, open, workdir }) {
  await openRau(page, open, `${RAU}&availability=exhausted`);
  assert.equal(await shown(page, '.ag-rau-notice'), true);
  assert.equal(await page.$eval('.ag-rau-notice', (node) => node.dataset.tone), 'warn');
  assert.equal(await page.$eval('.ag-rau-rule-delete', (button) => button.disabled), false, 'the memory stays editable');
  // 올려 보면 허브가 크레딧 소진으로 거절하고, 기억은 그대로다.
  const file = join(workdir, '칼럼.txt');
  await writeFile(file, '문장은 짧게 쓴다. 본문은 한다체로 쓴다.');
  await (await page.$('.ag-rau-file-input')).uploadFile(file);
  await page.waitForSelector('.ag-rau-error[data-code="RAU_CREDITS_EXHAUSTED"]', { visible: true });
  assert.equal(await page.$('.ag-rau-error .ag-settings-primary'), null, 'no retry while the credits are spent');
  assert.equal((await memory(page)).rules.length, 9);
  await page.click('.ag-rau-error .ag-settings-btn');
  await page.waitForSelector('.ag-rau-drop', { visible: true });
}

// ── 기억 ────────────────────────────────────────────────

async function checkOpen({ page, open, screenshot }) {
  await openRau(page, open);
  await page.waitForSelector('.ag-rau-rule', { visible: true });
  assert.equal(await page.$eval('#ag-settings-tab-rau', (tab) => tab.classList.contains('ag-settings-rau-locked')), false);
  assert.equal(await shown(page, '.ag-rau-notice'), false, 'no notice on the Rau plan');
  assert.match(await text(page, '.ag-rau-hero-status'), /기억 9개/);
  assert.equal(await page.$eval('.ag-taste-learning-row input', (input) => input.checked), true, '대화에서 배우기 is on by default');
  await page.waitForFunction(() => !document.querySelector('.ag-taste-learning-row input').disabled);
  await screenshot('rau-tab-open');

  // 문체·용어로 묶이고, 강한 규칙이 먼저다. 강도는 점이 아니라 그릇(aria-label)으로 읽힌다.
  const grouped = await groups(page);
  assert.deepEqual(grouped.map((group) => [group.kind, group.title]), [['style', '문체'], ['term', '용어']]);
  assert.deepEqual(grouped[0].rules.map((rule) => rule.strength), [5, 4, 3, 3, 2, 2]);
  assert.deepEqual(grouped[1].rules.map((rule) => rule.strength), [3, 1, 1]);
  assert(grouped.flatMap((group) => group.rules).every((rule) => rule.gauge?.startsWith(`강도 ${rule.strength}/5`)), 'a strength gauge per rule');
  assert(grouped[0].rules.some((rule) => rule.text === '본문 종결은 한다체로 쓴다'));
  assert(grouped[1].rules.some((rule) => rule.text === "'고객' 대신 '이용자'로 쓴다"));
  assert.equal(await page.$$eval('.ag-rau-rule-meta', (nodes) => nodes.some((node) => node.textContent === '직접')), true, 'the source of a rule is shown');

  // 최근 변화(되돌릴 수 있는 것과 없는 것)와 접힌 물러난 기억.
  const events = await page.$$eval('.ag-rau-event', (nodes) => nodes.map((row) => ({
    id: row.dataset.eventId, kind: row.dataset.kind, tag: row.querySelector('.ag-rau-tag').textContent, undo: Boolean(row.querySelector('.ag-rau-event-undo')),
  })));
  assert.equal(events.length, 10);
  assert.deepEqual(events.slice(0, 3).map((event) => event.tag), ['보강', '기억 승격', '물러남']);
  assert.equal(events.find((event) => event.id === 'evt_sample000001').undo, true);
  assert.equal(events.find((event) => event.id === 'evt_sample000003').undo, false, 'another rule now holds this one\'s subject');
  assert.equal(await page.$eval('.ag-rau-retired', (details) => details.open), false, 'the retired list starts folded');
  assert.match(await text(page, '.ag-rau-retired-summary'), /5개/);

  // 올린 원고 기록.
  assert.equal(await page.$$eval('.ag-rau-upload', (nodes) => nodes.length), 2);

  await page.$eval('.ag-rau-memory', (node) => node.scrollIntoView({ block: 'start' }));
  await screenshot('rau-tab-memory');
}

async function checkEdit({ page }) {
  // 고치기: 두 번째 규칙을 고쳐 Enter. 허브에는 직접 쓴 규칙으로 남고 최근 변화에 고침이 뜬다.
  const id = 'rule_sample000003';
  await (await page.$(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-rule-edit`)).click();
  await page.waitForSelector(`.ag-rau-rule[data-rule-id="${id}"] textarea`, { visible: true });
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', { timeout: 5000 });
  // Esc 는 고치기만 접는다.
  await page.keyboard.type(' (임시)');
  await page.keyboard.press('Escape');
  await page.waitForFunction((rule) => !document.querySelector(`.ag-rau-rule[data-rule-id="${rule}"] textarea`), {}, id);
  assert.equal(await page.$eval(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-rule-text`, (node) => node.textContent), '긴 문장은 짧게 끊어 쓴다');
  assert.equal(await shown(page, PANE), true, 'Esc does not close settings');

  await (await page.$(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-rule-edit`)).click();
  const input = await page.waitForSelector(`.ag-rau-rule[data-rule-id="${id}"] textarea`, { visible: true });
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', { timeout: 5000 });
  await input.evaluate((node) => { node.select(); });
  await page.keyboard.type('긴 문장은 두 문장으로 끊어 쓴다');
  await page.keyboard.press('Enter');
  await page.waitForFunction((rule) => document.querySelector(`.ag-rau-rule[data-rule-id="${rule}"] .ag-rau-rule-text`)?.textContent === '긴 문장은 두 문장으로 끊어 쓴다', {}, id);
  const saved = (await memory(page)).rules.find((rule) => rule.id === id);
  assert.equal(saved.text, '긴 문장은 두 문장으로 끊어 쓴다');
  assert.equal(saved.origin, 'user');
  await page.waitForFunction(() => document.querySelector('.ag-rau-event')?.dataset.kind === 'edited');
  assert.match(await text(page, '.ag-rau-event .ag-rau-event-text'), /긴 문장은 짧게 끊어 쓴다.*→.*두 문장으로/s, 'the old text is shown struck');

  // 종류를 바꿔 고치면 다른 묶음으로 옮겨 간다.
  await (await page.$(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-rule-edit`)).click();
  await page.waitForSelector(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-kind-option[data-kind="term"]`, { visible: true });
  await page.click(`.ag-rau-rule[data-rule-id="${id}"] .ag-rau-kind-option[data-kind="term"]`);
  await page.click(`.ag-rau-rule[data-rule-id="${id}"] .ag-settings-primary`);
  await page.waitForFunction((rule) => document.querySelector(`.ag-rau-group[data-kind="term"] .ag-rau-rule[data-rule-id="${rule}"]`), {}, id);
  assert.equal((await memory(page)).rules.find((rule) => rule.id === id).kind, 'term');
}

async function checkAddDeleteRestore({ page }) {
  // 더하기: 종류를 고르고 한 줄. 같은 주제가 이미 있으면 허브가 막는다.
  const addRule = async (kind, line) => {
    await page.click(`.ag-rau-add .ag-rau-kind-option[data-kind="${kind}"]`);
    await page.type('.ag-rau-add-input', line);
    await page.click('.ag-rau-add-submit');
  };
  await addRule('term', "'문의' 대신 '질의'로 쓴다");
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-rau-group[data-kind="term"] .ag-rau-rule-text')]
    .some((node) => node.textContent === "'문의' 대신 '질의'로 쓴다"));
  assert.equal(await page.$eval('.ag-rau-add-input', (input) => input.value), '', 'the field clears after adding');
  const added = (await memory(page)).rules.find((rule) => rule.text === "'문의' 대신 '질의'로 쓴다");
  assert.equal(added.origin, 'user');
  assert.equal(added.kind, 'term');
  await addRule('term', "'문의' 대신 '질의'로 쓴다");
  await page.waitForFunction(() => document.querySelector('.ag-rau-message:not([hidden])')?.textContent);
  assert.match(await message(page), /이미 있어요/, 'a rule on the same subject is refused');
  await page.$eval('.ag-rau-add-input', (input) => { input.value = ''; input.dispatchEvent(new Event('input')); });

  // 지우기: 줄이 사라지고 물러난 기억에 '직접 지움'으로 남는다. 접힌 목록을 펴서 되살린다.
  const target = 'rule_sample000005';
  const before = (await memory(page)).retired.length;
  await (await page.$(`.ag-rau-rule[data-rule-id="${target}"] .ag-rau-rule-delete`)).click();
  await page.waitForFunction((id) => !document.querySelector(`.ag-rau-rule[data-rule-id="${id}"]`), {}, target);
  assert.equal((await memory(page)).rules.some((rule) => rule.id === target), false);
  assert.equal((await memory(page)).retired.length, before + 1);
  await page.click('.ag-rau-retired-summary');
  const row = await page.waitForSelector(`.ag-rau-retired-row[data-rule-id="${target}"]`, { visible: true });
  assert.equal(await row.evaluate((node) => node.dataset.reason), 'deleted');
  // 지우기의 user-memory 알림이 답보다 먼저 이 줄을 그린다 — 단추가 풀린 뒤에 누른다.
  await page.waitForFunction((id) => document.querySelector(`.ag-rau-retired-row[data-rule-id="${id}"] .ag-rau-restore`)?.disabled === false, {}, target);
  await row.$eval('.ag-rau-restore', (button) => button.click());
  await page.waitForFunction((id) => document.querySelector(`.ag-rau-rule[data-rule-id="${id}"]`), {}, target);
  assert.equal(await page.$(`.ag-rau-retired-row[data-rule-id="${target}"]`), null, 'restored rules leave the retired list');

  // 같은 주제를 지금 다른 규칙이 쥐고 있으면 되살릴 수 없다 — 줄은 그대로 남고 이유를 말한다.
  const blocked = 'rule_sample000010';
  const stuck = await page.waitForSelector(`.ag-rau-retired-row[data-rule-id="${blocked}"]`, { visible: true });
  assert.equal(await stuck.evaluate((node) => node.dataset.reason), 'flipped');
  // 허브의 user-memory 알림이 답보다 먼저 목록을 그린다 — 앞 요청이 끝나 단추가 풀릴 때까지 기다린다.
  await page.waitForFunction((id) => document.querySelector(`.ag-rau-retired-row[data-rule-id="${id}"] .ag-rau-restore`)?.disabled === false, {}, blocked);
  await stuck.$eval('.ag-rau-restore', (button) => button.click());
  // 앞의 '되살렸어요.' 가 아직 보일 수 있다 — 거절 문구로 바뀔 때까지 기다린다.
  await page.waitForFunction(() => /이미 있어요/.test(document.querySelector('.ag-rau-message:not([hidden])')?.textContent ?? ''), { timeout: 5000 })
    .catch(() => {});
  assert.match(await message(page), /이미 있어요/);
  assert.notEqual(await page.$(`.ag-rau-retired-row[data-rule-id="${blocked}"]`), null);
  assert.equal(await page.$(`.ag-rau-rule[data-rule-id="${blocked}"]`), null);
}

async function checkUndo({ page }) {
  // 최근 변화에서 되돌리기: 강도가 그 앞으로 돌아간다.
  const rule = 'rule_sample000001';
  assert.equal(Number(await page.$eval(`.ag-rau-rule[data-rule-id="${rule}"]`, (row) => row.dataset.strength)), 4);
  await page.waitForFunction(() => document.querySelector('.ag-rau-event[data-event-id="evt_sample000001"] .ag-rau-event-undo')?.disabled === false);
  await page.$eval('.ag-rau-event[data-event-id="evt_sample000001"] .ag-rau-event-undo', (button) => button.click());
  await page.waitForFunction((id) => document.querySelector(`.ag-rau-rule[data-rule-id="${id}"]`)?.dataset.strength === '3', {}, rule);
  assert.equal((await memory(page)).rules.find((candidate) => candidate.id === rule).strength, 3);
  assert.equal(await page.$('.ag-rau-event[data-event-id="evt_sample000001"] .ag-rau-event-undo'), null, 'an event is undone once');

  // 그 뒤에 규칙이 다시 바뀌었으면 되돌릴 수 없다는 말만 한다 — 허브가 USER_MEMORY_UNDO_STALE 로 답한다.
  const stale = await page.evaluate(() => window.sidebarPreview.bridge.requestUserMemory({ op: 'undo', eventId: 'evt_sample000003' }));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'USER_MEMORY_UNDO_STALE');
}

// ── 문체 학습 ───────────────────────────────────────────

async function checkRunning({ page, open, screenshot }) {
  await openRau(page, open, `${RAU}&styleLearn=hold`);
  const card = await page.waitForSelector('.ag-rau-run', { visible: true });
  await page.waitForFunction(() => document.querySelectorAll('.ag-rau-found-item').length === 3);
  // 다른 창에서 시작한 학습도 같은 카드다. 규칙 찾기에서 첫 파일을 마쳤다.
  assert.equal(await card.evaluate((node) => node.dataset.stage), 'extracting');
  assert.match(await text(page, '.ag-rau-run-meta'), /파일 1\/3/);
  assert.match(await text(page, '.ag-rau-run-meta'), /규칙 3개/);
  assert.equal(await text(page, '.ag-rau-run-file'), SAMPLE_FILES[0]);
  const bar = Number(await page.$eval('.ag-rau-run-bar', (node) => node.getAttribute('aria-valuenow')));
  assert(bar > 0 && bar < 100, `the bar is part-way: ${bar}`);
  assert.deepEqual(await page.$$eval('.ag-rau-found-item', (nodes) => nodes.map((node) => node.dataset.kind).sort()), ['style', 'style', 'term']);
  assert.equal(await shown(page, '.ag-rau-run-cancel'), true, 'a cancel button while running');
  assert.equal(await shown(page, '.ag-rau-drop'), false, 'no second upload while one runs');
  assert.equal((await memory(page)).rules.length, 9, 'nothing merges before the end');
  await screenshot('rau-tab-running');

  // 이어 주면 규칙이 더 쌓이고(누적), 합치기를 거쳐 결과 카드가 된다.
  await page.evaluate(() => {
    window.__seen = { found: 0, stages: [], bars: [] };
    const read = () => {
      const run = document.querySelector('.ag-rau-run');
      if (!run) return;
      const seen = window.__seen;
      seen.found = Math.max(seen.found, document.querySelectorAll('.ag-rau-found-item').length);
      if (seen.stages.at(-1) !== run.dataset.stage) seen.stages.push(run.dataset.stage);
      seen.bars.push(Number(document.querySelector('.ag-rau-run-bar').getAttribute('aria-valuenow')));
    };
    new MutationObserver(read).observe(document.querySelector('.ag-rau-pane'), { subtree: true, childList: true, attributes: true, characterData: true });
    window.sidebarPreview.userMemory.releaseStyleLearn();
  });
  await page.waitForSelector('.ag-rau-result', { visible: true });
  const seen = await page.evaluate(() => window.__seen);
  assert.equal(seen.found, 6, 'found rules keep adding up to the running total');
  assert.deepEqual(seen.stages.slice(-2), ['extracting', 'merging']);
  assert.deepEqual(seen.bars, [...seen.bars].sort((a, b) => a - b), 'the bar never goes back');

  // 결과 카드: 새로 2(하나는 뒤집힌 규칙의 새 모습), 보강 1, 감쇄 1, 물러남 1, 어긋남 2, 건너뛴 파일 2.
  const stats = await page.$$eval('.ag-rau-stat', (nodes) => Object.fromEntries(nodes.map((node) => [
    node.querySelector('.ag-rau-stat-label').textContent, Number(node.querySelector('.ag-rau-stat-value').textContent)])));
  assert.deepEqual(stats, { 새로: 2, 보강: 1, 감쇄: 1, 물러남: 1 });
  assert.equal(await page.$$eval('.ag-rau-result-group[data-kind="conflicts"] .ag-rau-result-item', (nodes) => nodes.length), 2);
  const skipped = await text(page, '.ag-rau-result-skipped');
  assert(skipped.includes('스캔본 회의록.pdf') && skipped.includes('칼럼 초고.md'), `skipped files are named: ${skipped}`);
  assert.equal(await page.$$eval('.ag-rau-found-item', (nodes) => nodes.length), 0, 'the running card is gone');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.$eval('.ag-rau-learn', (node) => node.scrollIntoView({ block: 'start' }));
  await screenshot('rau-tab-result');

  // 기억에도 합쳐져 있다: 새 규칙이 묶음에 들어오고, 올린 원고 기록이 맨 위에 생긴다.
  const texts = await ruleTexts(page);
  assert(texts.includes('소제목은 명사형으로 끝낸다'));
  assert(texts.includes("'협력' 대신 '협업'으로 쓴다"));
  assert.equal((await memory(page)).uploads[0].files.length, 4);
  assert.equal(await page.$$eval('.ag-rau-upload', (nodes) => nodes.length), 3);
  assert.equal(await page.$eval('.ag-rau-retired-summary', (node) => node.textContent.includes('개')), true);
  assert.equal(await page.$$eval('.ag-rau-event', (nodes) => nodes.some((node) => node.querySelector('.ag-rau-tag').textContent === '새로')), true);

  // 확인하면 올리는 자리로 돌아온다.
  await page.click('.ag-rau-result-actions .ag-settings-primary');
  await page.waitForSelector('.ag-rau-drop', { visible: true });
  assert.equal(await page.$('.ag-rau-result'), null);
}

async function checkCancelAndFail({ page, open }) {
  // 멈추기: 허브가 CANCELLED 로 답하고 기억은 바뀌지 않는다.
  await openRau(page, open, `${RAU}&styleLearn=hold`);
  await page.waitForSelector('.ag-rau-run', { visible: true });
  await page.waitForFunction(() => document.querySelectorAll('.ag-rau-found-item').length === 3);
  await page.click('.ag-rau-run-cancel');
  await page.waitForSelector('.ag-rau-error[data-code="CANCELLED"]', { visible: true });
  assert.equal((await memory(page)).rules.length, 9);
  assert.equal((await memory(page)).uploads.length, 2);
  assert.equal(await page.evaluate(() => window.sidebarPreview.userMemory.job()), null, 'the job is gone');
  await page.click('.ag-rau-error .ag-settings-btn');
  await page.waitForSelector('.ag-rau-drop', { visible: true });

  // 실패: 사용자 말로 알리고 다시 올릴 수 있다.
  await openRau(page, open, `${RAU}&styleLearn=fail`);
  await page.waitForSelector('.ag-rau-error[data-code="RAU_UNAVAILABLE"]', { visible: true });
  assert.doesNotMatch(await text(page, '.ag-rau-error-text'), /Rau is not available/, 'no raw hub text');
  assert.notEqual(await page.$('.ag-rau-error .ag-settings-primary'), null, 'a retry');
  assert.equal((await memory(page)).rules.length, 9);
}

async function checkUpload({ page, open, workdir }) {
  await openRau(page, open, 'reset=1&page=settings&destination=rau&plan=rau&userMemory=empty');
  await page.waitForSelector('.ag-rau-drop', { visible: true });
  assert.equal(await shown(page, '.ag-rau-memory .ag-rau-empty'), true, 'an empty memory says so');
  assert.equal(await page.$eval('.ag-rau-drop', (button) => button.disabled), false);
  const input = await page.$('.ag-rau-file-input');

  // 못 읽는 형식은 올리지 않고 그 자리에서 말한다.
  const bad = join(workdir, '프로그램.exe');
  await writeFile(bad, 'MZ');
  await input.uploadFile(bad);
  await page.waitForFunction(() => document.querySelector('.ag-rau-learn-message:not([hidden])')?.textContent);
  assert.equal(await page.$('.ag-rau-run'), null);
  assert.equal(await page.evaluate(() => window.sidebarPreview.userMemory.job()), null);

  // 글 하나를 올리면 같은 카드가 돌고 결과로 끝난다. 규칙은 문체·용어 묶음으로 들어간다.
  const good = join(workdir, '칼럼 모음.txt');
  await writeFile(good, '문장은 짧게 쓴다. 본문은 한다체로 쓴다.'.repeat(20));
  await input.uploadFile(good);
  await page.waitForSelector('.ag-rau-result', { visible: true });
  const stats = await page.$$eval('.ag-rau-stat', (nodes) => Object.fromEntries(nodes.map((node) => [
    node.querySelector('.ag-rau-stat-label').textContent, Number(node.querySelector('.ag-rau-stat-value').textContent)])));
  assert.deepEqual(stats, { 새로: 3, 보강: 0, 감쇄: 0, 물러남: 0 });
  assert.equal(await page.$eval('.ag-rau-memory .ag-rau-empty', (node) => node.hidden), true);
  const grouped = await groups(page);
  assert.deepEqual(grouped.map((group) => [group.kind, group.rules.length]), [['style', 2], ['term', 1]]);
  assert.equal((await memory(page)).uploads[0].files[0], '칼럼 모음.txt');
}

/** Rau 탭이 가려진 동안 도는 학습은 입력창 위 알약으로 보인다. 누르면 Rau 탭으로 돌아온다. */
async function checkPill({ page, open }) {
  await openRau(page, open, `${RAU}&styleLearn=hold`);
  await page.waitForSelector('.ag-rau-run', { visible: true });
  assert.equal(await shown(page, '.ag-style-pill'), false, 'the tab already shows the run, so no pill');
  await page.$eval('.ag-settings-close', (close) => close.click());
  await page.waitForSelector('.ag-style-pill', { visible: true, timeout: 5000 });
  assert.match(await text(page, '.ag-style-pill-text'), /^문체 학습 중 · \d+\/\d+$/);
  await page.click('.ag-style-pill-open');
  await page.waitForSelector(PANE, { visible: true });
  await page.waitForFunction(() => document.querySelector('.ag-style-pill')?.hidden !== false);
  assert.equal(await shown(page, '.ag-rau-run'), true, 'the card is still running when you come back');
}

// ── 입력창 ──────────────────────────────────────────────

async function playOneTurn(page) {
  await page.click('#play');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning() && document.querySelector('.ag-msg-assistant'));
}

async function checkComposerChips({ page, open }) {
  // 권유 칩: Rau 에서, 기억도 올린 원고도 없고, 첫 답을 받은 뒤에만. 누르면 Rau 탭이 열리고 다시 뜨지 않는다.
  const invite = '.ag-style-invite-chip';
  const inviteShown = () => shown(page, invite);
  await open('reset=1&plan=rau&userMemory=empty&scenario=chat');
  assert.equal(await inviteShown(), false, 'not before the first reply');
  await playOneTurn(page);
  await page.waitForSelector(invite, { visible: true });
  assert.equal(await text(page, invite), '원고를 올리면 문체를 배웁니다문체 학습');
  await page.click(`${invite} .ag-calibration-chip-open`);
  await page.waitForSelector(PANE, { visible: true });
  await page.$eval('.ag-settings-close', (close) => close.click());
  await page.waitForFunction(() => !document.querySelector('.ag-style-invite-chip') || document.querySelector('.ag-style-invite-chip').hidden);
  await open('plan=rau&userMemory=empty&scenario=chat');
  await playOneTurn(page);
  await sleep(300);
  assert.equal(await inviteShown(), false, 'once used, the invitation is gone for good');

  // 닫아도 같다.
  await open('reset=1&plan=rau&userMemory=empty&scenario=chat');
  await playOneTurn(page);
  await page.waitForSelector(invite, { visible: true });
  await page.click(`${invite} .ag-calibration-chip-close`);
  assert.equal(await inviteShown(), false);

  // Hama 와 기억이 있는 Rau 에는 권유가 없다.
  for (const query of ['reset=1&plan=hama&userMemory=empty&scenario=chat', 'reset=1&plan=rau&userMemory=sample&scenario=chat']) {
    await open(query);
    await playOneTurn(page);
    await sleep(300);
    assert.equal(await inviteShown(), false, query);
  }
}

async function checkLegacyChip({ page, open, screenshot }) {
  const chip = '.ag-style-legacy-chip';
  await open('reset=1&plan=rau&userMemory=legacy');
  await page.waitForSelector(chip, { visible: true });
  assert.equal(await text(page, '.ag-style-legacy-text'), '이전 원고 3개로 기억을 만들까요?');
  assert.equal((await memory(page)).legacy.files, 3);

  // 만들기: 허브가 이전 원고로 학습을 돌린다 — 칩이 걷히고 알약이 돈다. 끝나면 기억이 생기고 이전 원고 제안은 없어진다.
  await page.evaluate(() => window.sidebarPreview.userMemory.holdNextStyleLearn());
  await page.click('.ag-style-legacy-accept');
  await page.waitForFunction(() => window.sidebarPreview.userMemory.job() !== null);
  await page.waitForSelector('.ag-style-pill', { visible: true });
  assert.equal(await shown(page, chip), false, 'the chip steps aside while it runs');
  assert.match(await text(page, '.ag-style-pill-text'), /^문체 학습 중/);
  await screenshot('rau-pill');
  // 첫 파일을 마치고 멈출 때까지 기다린 뒤 잇는다.
  await page.waitForFunction(() => { const job = window.sidebarPreview.userMemory.job(); return job?.stage === 'extracting' && job.completed >= 1; });
  await page.evaluate(() => window.sidebarPreview.userMemory.releaseStyleLearn());
  await page.waitForFunction(() => window.sidebarPreview.userMemory.job() === null);
  await page.waitForFunction(() => window.sidebarPreview.userMemory.snapshot().rules.length > 0);
  const done = await memory(page);
  assert.equal(done.legacy, null, 'the offer is settled');
  assert(done.uploads.length > 0);
  await page.waitForFunction((selector) => !document.querySelector(selector) || document.querySelector(selector).hidden, {}, chip);
  // 알약은 끝났음을 잠깐 알린다.
  await page.waitForFunction(() => /문체 학습 끝/.test(document.querySelector('.ag-style-pill-text')?.textContent ?? ''));
  await page.click('.ag-style-pill-open');
  await page.waitForSelector(PANE, { visible: true });
  assert.equal(await shown(page, '.ag-rau-legacy'), false);
  assert((await ruleTexts(page)).length > 0);

  // 아니요: 허브가 옛 폴더를 지우고 칩이 걷힌다. 학습은 돌지 않는다.
  await open('reset=1&plan=rau&userMemory=legacy');
  await page.waitForSelector(chip, { visible: true });
  await page.click('.ag-style-legacy-decline');
  await page.waitForFunction(() => window.sidebarPreview.userMemory.snapshot().legacy === null);
  await page.waitForFunction((selector) => document.querySelector(selector).hidden, {}, chip);
  assert.equal(await page.evaluate(() => window.sidebarPreview.userMemory.job()), null);
  assert.equal((await memory(page)).rules.length, 0);
}

async function checkSlashCommand({ page, open }) {
  const submit = async (value) => {
    await page.focus('.ag-input');
    await page.type('.ag-input', value);
    await page.keyboard.press('Enter');
  };
  // Rau: 설정 → Rau 가 열린다. 에이전트에게는 가지 않는다.
  await open('reset=1&plan=rau&userMemory=sample');
  await submit('/문체학습');
  await page.waitForSelector(PANE, { visible: true });
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.snapshot().messageTexts), []);
  assert.equal(await page.$eval('.ag-input', (input) => input.value), '');
  assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), 0);

  // Hama: 요금제 카드가 Rau 칸에 맞춰 열린다. 탭은 열리지 않는다.
  await open('reset=1&plan=hama&userMemory=sample');
  await submit('/문체학습');
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]', { visible: true });
  assert.equal(await shown(page, PANE), false);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.snapshot().messageTexts), []);
}

// ── 채팅 구분선 ─────────────────────────────────────────

const labelItems = () => [
  { op: 'add', entryId: 'mem_lab1', text: '표 아래 출처는 작게', origin: 'learned', change: 'new', tier: 'document', kind: 'style', strength: { from: 0, to: 1 } },
  { op: 'update', entryId: 'mem_lab2', text: '본문은 한다체', origin: 'learned', change: 'reinforced', tier: 'document', kind: 'style', strength: { from: 1, to: 2 } },
  { op: 'update', entryId: 'mem_lab3', text: '문장은 짧게', origin: 'learned', change: 'dampened', tier: 'document', kind: 'style', strength: { from: 3, to: 2 } },
  { op: 'add', entryId: 'rule_lab4', text: "'시작' 대신 '착수'로 쓴다", origin: 'learned', change: 'escalated', tier: 'account', kind: 'term', strength: { from: 0, to: 2 }, eventIds: ['evt_lab4'] },
  { op: 'remove', entryId: 'mem_lab5', text: '예산표는 월별로 나눔', origin: 'explicit', change: 'retired', tier: 'document', kind: 'decision', strength: { from: 1, to: 0 } },
  { op: 'update', entryId: 'mem_lab6', text: '제목은 굵게', prevText: '제목은 기울여', origin: 'learned', change: 'updated', tier: 'document', kind: 'style' },
];

async function checkMarker({ page, open, screenshot }) {
  await open('reset=1&taste=sample&plan=rau');
  await page.waitForFunction((id) => document.querySelector('.ag-taste') && window.sidebarPreview.threadStore.getThread(id), {}, CHAT);

  // item.change 마다 표가 다르고, 강도는 처음 → 나중으로 읽힌다.
  await page.evaluate((items) => window.sidebarPreview.emitTasteLearned({
    threadId: 'preview-chat-taste', turnId: null, documentId: 'preview-proposal', key: 'mem-preview-proposal', learnId: 'learn_labels',
    items, changes: items.map((item) => ({ op: item.op, entryId: item.entryId })),
  }), labelItems());
  const marker = '.ag-taste[data-learn-id="learn_labels"]';
  await page.waitForSelector(marker, { visible: true });
  assert.equal(await page.$eval(`${marker} .ag-marker-taste`, (node) => node.getAttribute('aria-label')), 'Rau-0.1 6가지 배움');
  await page.click(`${marker} .ag-marker-taste`);
  const rows = await page.$$eval(`${marker} .ag-taste-row`, (nodes) => nodes.map((row) => ({
    tag: row.querySelector('.ag-taste-tag').textContent,
    gauge: row.querySelector('.ag-strength')?.getAttribute('aria-label') ?? null,
    tier: row.dataset.tier ?? null,
  })));
  assert.deepEqual(rows, [
    { tag: '새로', gauge: '새 기억, 강도 1/5', tier: null },
    { tag: '보강', gauge: '강도 1/5에서 2/5로', tier: null },
    { tag: '감쇄', gauge: '강도 3/5에서 2/5로', tier: null },
    { tag: '기억 승격', gauge: '새 기억, 강도 2/5', tier: 'account' },
    { tag: '물러남', gauge: '강도 1/5에서 물러남', tier: null },
    { tag: '고침', gauge: null, tier: null },
  ]);

  // 계정 줄이 하나라도 있으면 모두 보기는 문서 기억이 아니라 설정 → Rau 를 연다.
  await page.click(`${marker} .ag-taste-action`);
  await page.waitForSelector(PANE, { visible: true });
  assert.equal(await shown(page, '.ag-memory-sheet'), false, 'not the document memory sheet');
  await page.$eval('.ag-settings-close', (close) => close.click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-settings-open'));

  // 예전 허브의 구분선은 change 가 없다: add → 새로, update → 고침, remove → 물러남.
  await page.evaluate(() => window.sidebarPreview.emitTasteLearned({
    threadId: 'preview-chat-taste', turnId: null, documentId: 'preview-proposal', key: 'mem-preview-proposal', learnId: 'learn_old',
    changes: [{ op: 'add', entryId: 'mem_old1' }],
    items: [
      { op: 'add', entryId: 'mem_old1', text: '숫자는 천 단위 쉼표', origin: 'learned' },
      { op: 'update', entryId: 'mem_old2', text: '문단 끝은 마침표', prevText: '문단 끝은 쉼표', origin: 'learned' },
      { op: 'remove', entryId: 'mem_old3', text: '제목은 굵게', origin: 'explicit' },
    ],
  }));
  await page.waitForSelector('.ag-taste[data-learn-id="learn_old"]');
  await page.click('.ag-taste[data-learn-id="learn_old"] .ag-marker-taste');
  assert.deepEqual(await page.$$eval('.ag-taste[data-learn-id="learn_old"] .ag-taste-tag', (nodes) => nodes.map((node) => node.textContent)),
    ['새로', '고침', '물러남']);

  // 한 턴의 학습이 실제로 계정 기억을 바꾼 구분선: 기억 승격 · 보강 · 물러남이 허브의 사건과 함께 온다.
  const ids = await page.evaluate(() => {
    const learned = window.sidebarPreview.emitAccountTasteLearned();
    return learned.items.map((item) => ({ id: item.entryId, change: item.change, events: item.eventIds ?? [] }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-taste')].at(-1)?.dataset.learnId?.startsWith('learn_') && document.querySelectorAll('.ag-taste').length >= 4);
  const last = await page.evaluateHandle(() => [...document.querySelectorAll('.ag-taste')].at(-1));
  await last.$eval('.ag-marker-taste', (node) => { if (node.getAttribute('aria-expanded') !== 'true') node.click(); });
  const changes = await last.$$eval('.ag-taste-row', (nodes) => nodes.map((row) => [row.dataset.change, row.dataset.tier ?? 'document', row.querySelector('.ag-taste-tag').textContent]));
  assert.deepEqual(changes.map(([change]) => change), ['new', 'escalated', 'reinforced', 'retired']);
  assert.deepEqual(changes.map(([, tier]) => tier), ['document', 'account', 'account', 'account']);
  assert.deepEqual(changes.map(([, , tag]) => tag), ['새로', '기억 승격', '보강', '물러남']);
  const escalated = ids.find((item) => item.change === 'escalated');
  assert.match(escalated.id, /^rule_/);
  assert.equal(await last.$eval('.ag-taste-row[data-change="escalated"] .ag-strength', (node) => node.getAttribute('aria-label')), '새 기억, 강도 2/5');
  await page.evaluate(() => window.scrollTo(0, 0));
  await last.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await screenshot('rau-marker');

  // 계정 줄 되돌리기: 허브에 규칙 id 와 사건 id 가 가고, 그 승격이 거둬진다 — 거둔 규칙은 '되돌림' 으로 물러난 기억에 남는다.
  const reinforced = ids.find((item) => item.change === 'reinforced');
  await page.evaluate((id) => window.sidebarPreview.taste.skipUndo(id), reinforced.id);
  await last.$eval('.ag-taste-row[data-change="escalated"] .ag-taste-undo', (button) => button.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-taste')].at(-1).querySelector('.ag-taste-row[data-change="escalated"][data-state="undone"]'));
  const undo = await page.evaluate(() => ({ ...window.sidebarPreview.taste.undos.at(-1) }));
  assert.equal(undo.entryId, escalated.id);
  assert.deepEqual(undo.eventIds, escalated.events);
  const afterUndo = await memory(page);
  assert.equal(afterUndo.rules.some((rule) => rule.id === escalated.id), false, 'the promoted rule is gone');
  assert.equal(afterUndo.retired.find((rule) => rule.id === escalated.id)?.reason, 'undone');
  // 허브가 그새 바뀌었다고 답한 줄은 되돌릴 수 없는 줄이 된다.
  await last.$eval('.ag-taste-row[data-change="reinforced"] .ag-taste-undo', (button) => button.click());
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-taste')].at(-1).querySelector('.ag-taste-row[data-change="reinforced"][data-state="stale"]'));

  // 모두 보기 → Rau 탭에서도 그 변화가 보인다 (거둔 승격은 없고, 물러난 기억에 있다).
  await last.$eval('.ag-taste-action', (button) => button.click());
  await page.waitForSelector(PANE, { visible: true });
  await page.waitForSelector('.ag-rau-rule', { visible: true });
  assert.equal(await page.$(`.ag-rau-rule[data-rule-id="${escalated.id}"]`), null);
  assert.notEqual(await page.$(`.ag-rau-retired-row[data-rule-id="${escalated.id}"][data-reason="undone"]`), null);
}

// ── 어두운 테마 ─────────────────────────────────────────

async function checkDark({ page, origin, screenshot }) {
  await page.goto(`${origin}/?theme=dark&width=480&${RAU}&styleLearn=hold`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.waitForSelector('.ag-rau-run', { visible: true });
  await page.waitForFunction(() => document.querySelectorAll('.ag-rau-found-item').length === 3);
  await page.waitForSelector('.ag-rau-rule', { visible: true });
  assert.notEqual(await page.$eval('.ag-rau-pane', (node) => getComputedStyle(node).color), 'rgb(0, 0, 0)', 'dark text colors are applied');
  await screenshot('rau-tab-dark');
}

// ── 토글 ────────────────────────────────────────────────

async function checkLearningToggle({ page, open }) {
  await openRau(page, open);
  await page.waitForFunction(() => !document.querySelector('.ag-taste-learning-row input')?.disabled);
  const settings = () => page.evaluate(() => window.sidebarPreview.bridge.requestTasteSettings());
  assert.equal((await settings()).enabled, true);
  await page.$eval('.ag-taste-learning-row input', (input) => input.click());
  await page.waitForFunction(() => !document.querySelector('.ag-taste-learning-row input').disabled && !document.querySelector('.ag-taste-learning-row input').checked);
  assert.equal((await settings()).enabled, false, '대화에서 배우기 turned off at the hub');
  await page.$eval('.ag-taste-learning-row input', (input) => input.click());
  await page.waitForFunction(() => !document.querySelector('.ag-taste-learning-row input').disabled && document.querySelector('.ag-taste-learning-row input').checked);
  assert.equal((await settings()).enabled, true);
}

export async function checkRauTab(harness) {
  const workdir = await mkdtemp(join(tmpdir(), 'rau-tab-check-'));
  const h = { ...harness, workdir };
  try {
    await checkLocked(h);
    await checkNoPlanApi(h);
    await checkExhausted(h);
    await checkOpen(h);
    await checkEdit(h);
    await checkAddDeleteRestore(h);
    await checkUndo(h);
    await checkLearningToggle(h);
    await checkRunning(h);
    await checkPill(h);
    await checkCancelAndFail(h);
    await checkUpload(h);
    await checkComposerChips(h);
    await checkLegacyChip(h);
    await checkSlashCommand(h);
    await checkMarker(h);
    await checkDark(h);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
