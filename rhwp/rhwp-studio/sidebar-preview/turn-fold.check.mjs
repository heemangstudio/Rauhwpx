// 정착한 턴 접기 — 사이드바 미리보기에서 실제 사이드바로 확인한다.
// node rhwp/rhwp-studio/sidebar-preview/turn-fold.check.mjs (CHROME_PATH, root 에서는 CI=1)
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });

const cacheDir = await mkdtemp(resolve(tmpdir(), 'hamaeditor-turn-fold-check-'));
const server = await createServer({
  cacheDir,
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;

try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol.startsWith('http') && url.origin !== origin) || /\.wasm$|\/api\//.test(url.pathname)) {
      void request.abort();
    } else void request.continue();
  });

  async function open(query) {
    await page.goto(`${origin}/?theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  }
  async function play(query) {
    await open(`reset=1&${query}`);
    await page.click('#play');
    await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  }
  async function turnEnded() {
    await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
      && !document.querySelector('.ag-turn-pending:not([hidden])'));
  }
  async function screenshot(name) {
    const sidebar = await page.$('.ag-root');
    // 보이는 화면 그대로 찍는다 — 화면 밖까지 찍으려 뷰포트를 바꾸면 미리보기 사이드바 폭이 다시 잡힌다.
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`), captureBeyondViewport: false });
  }
  async function step(name, run) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, 'turn-fold-failure.png') });
      throw new Error(`${name}: ${error.message}\nRuntime errors: ${JSON.stringify(errors)}`, { cause: error });
    }
  }
  /** "편집 중…" 고리는 지연 동안 숨은 채 대화 중간에 남아 있어도 언제나 대화 흐름에 있고 접힘에 들지 않는다. */
  async function assertRingOutsideFolds() {
    const ring = await page.evaluate(() => {
      const node = document.querySelector('.ag-turn-pending');
      return {
        inFlow: node?.parentElement === document.querySelector('.ag-messages'),
        inFold: Boolean(node?.closest('.ag-turn-fold')),
      };
    });
    assert.deepEqual(ring, { inFlow: true, inFold: false });
  }
  /** 화면의 접힘 줄 — 머리 문구, 접힘 상태, 본문 inert, 본문 안의 작업 노드 수. */
  const folds = () => page.$$eval('.ag-messages > .ag-turn-fold:not([hidden])', (rows) => rows.map((row) => ({
    label: row.querySelector('.ag-turn-fold-label').textContent,
    errors: row.querySelector('.ag-turn-fold-errors').hidden ? '' : row.querySelector('.ag-turn-fold-errors').textContent,
    title: row.querySelector('.ag-turn-fold-toggle').getAttribute('aria-label'),
    collapsed: row.classList.contains('ag-turn-fold-collapsed'),
    expanded: row.querySelector('.ag-turn-fold-toggle').getAttribute('aria-expanded'),
    inert: row.querySelector('.ag-turn-fold-body').inert,
    work: row.querySelectorAll('.ag-turn-fold-body > *').length,
    height: Math.round(row.querySelector('.ag-turn-fold-body').getBoundingClientRect().height),
  })));

  await step('(a) 끝난 턴의 작업이 최종 답변 위 한 줄로 접히고, 누르면 펼쳐진다', async () => {
    await play('scenario=tools');
    await turnEnded();
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    // 펼친 모습에서 접히는 전환이 끝날 때까지 기다린다.
    await page.waitForFunction(() => document.querySelector('.ag-messages > .ag-turn-fold:not([hidden]) .ag-turn-fold-body')
      .getBoundingClientRect().height === 0);
    const [fold, ...rest] = await folds();
    assert.equal(rest.length, 0, '턴 하나에 접힘 줄 하나');
    assert.match(fold.label, /^작업 \d+초 · /);
    assert.equal(fold.errors, '· 오류 1', '실패한 호출은 오류로만 센다');
    assert.match(fold.title, / · 오류 1$/);
    assert.deepEqual([fold.collapsed, fold.expanded, fold.inert, fold.height], [true, 'false', true, 0]);
    assert.ok(fold.work >= 1, `작업 노드가 본문으로 옮겨졌다 (${fold.work})`);
    // 최종 답변과 복사 단추는 접힘 밖, 줄 아래에 남는다.
    const layout = await page.evaluate(() => {
      const row = document.querySelector('.ag-messages > .ag-turn-fold:not([hidden])');
      const answers = [...document.querySelectorAll('.ag-msg-assistant')];
      const answer = answers.at(-1);
      return {
        answerInFlow: answer.parentElement === document.querySelector('.ag-messages'),
        answerAfterRow: Boolean(row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING),
        copyVisible: Boolean(answer.querySelector('.ag-msg-copy')?.checkVisibility()),
        userBeforeRow: Boolean(row.compareDocumentPosition(document.querySelector('.ag-msg-user')) & Node.DOCUMENT_POSITION_PRECEDING),
        // 요청 말풍선(과 그 안의 "이 작업 전으로 되돌리기" 버튼)은 접힘 밖에 남는다.
        userInFold: document.querySelectorAll('.ag-turn-fold .ag-msg-user').length,
        workInFlow: document.querySelectorAll('.ag-messages > .ag-progress-step:not(.ag-fleet-slot[hidden])').length,
      };
    });
    assert.deepEqual(layout, { answerInFlow: true, answerAfterRow: true, copyVisible: true, userBeforeRow: true, userInFold: 0, workInFlow: 0 });
    await assertRingOutsideFolds();
    // 접힌 본문은 클릭을 받지 않는다.
    assert.equal(await page.$eval('.ag-turn-fold .ag-activity-toggle', (node) => node.closest('[inert]') !== null), true);
    await screenshot('turn-fold');
    await page.click('.ag-turn-fold-toggle');
    await page.waitForFunction(() => document.querySelector('.ag-turn-fold-body').getBoundingClientRect().height >= 32);
    const [open] = await folds();
    assert.deepEqual([open.collapsed, open.expanded, open.inert], [false, 'true', false]);
    // 펼친 본문 안의 도구 묶음도 따로 펼쳐진다.
    await page.click('.ag-turn-fold .ag-activity-toggle');
    await page.waitForFunction(() => document.querySelectorAll('.ag-turn-fold .ag-tool-row').length > 0
      && [...document.querySelectorAll('.ag-turn-fold .ag-tool-row')].some((row) => row.checkVisibility()));
    await screenshot('turn-fold-open');
    // 본문에 초점이 있을 때 접으면 초점은 머리로 간다.
    await page.focus('.ag-turn-fold .ag-activity-toggle');
    await page.click('.ag-turn-fold-toggle');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-turn-fold-toggle')), true);
    assert.equal((await folds())[0].inert, true);
  });

  await step('(b) 다시 열어도 같은 머리, 같은 접힘', async () => {
    const before = (await folds())[0];
    const threadId = await page.evaluate(async () => {
      await window.sidebarPreview.threadStore.waitForThreadsPersistence();
      return window.sidebarPreview.threadStore.listThreads()[0].id;
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.evaluate(async (id) => {
      await window.sidebarPreview.threadStore.waitForThreadsPersistence();
      window.sidebarPreview.sidebar.openThreadById(id);
    }, threadId);
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    const after = await folds();
    assert.equal(after.length, 1);
    assert.equal(after[0].label, before.label);
    assert.equal(after[0].errors, before.errors);
    assert.deepEqual([after[0].collapsed, after[0].inert], [true, true]);
    assert.equal(await page.$$eval('.ag-messages > .ag-progress-step', (nodes) => nodes.length), 0, '복원한 작업도 접힌다');
  });

  await step('(c) 멈춘 턴은 “중단됨”으로 접힌다', async () => {
    await play('scenario=tools&hold=1');
    await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('단계별 일정과 담당자를 확인합니다.'));
    await page.$eval('.ag-send', (button) => button.click());
    await turnEnded();
    const [fold] = await folds();
    assert.match(fold.label, /^중단됨/);
    assert.equal(fold.collapsed, true);
    await assertRingOutsideFolds();
    await screenshot('turn-fold-interrupted');
  });

  await step('(d) 오류로 끝난 턴은 접지 않고 모든 단계와 오류 줄을 보인다', async () => {
    await play('scenario=error');
    await turnEnded();
    assert.deepEqual(await folds(), []);
    assert.equal(await page.$$eval('.ag-messages > .ag-turn-fold', (rows) => rows.length), 0, '숨은 자리표시도 남지 않는다');
    assert.equal(await page.$eval('.ag-messages > .ag-progress-step .ag-activity-toggle', (node) => node.checkVisibility()), true);
    // 실패는 접힘 밖, 흐름에 알림 하나로 남는다(U5).
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ag-messages > .ag-failure-notice')]
      .filter((node) => node.checkVisibility()).length), 1);
  });

  await step('(e) 정착한 서브에이전트 카드는 접히고, 백그라운드로 도는 카드는 도크에 남는다', async () => {
    await play('scenario=fleet');
    await turnEnded();
    await page.waitForFunction(() => document.querySelector('.ag-turn-fold .ag-fleet-slot:not([hidden]) .ag-fleet'));
    assert.match((await folds())[0].label, /^작업 /);
    assert.equal(await page.$$eval('.ag-messages > .ag-fleet-slot', (nodes) => nodes.length), 0);

    await open('reset=1&scenario=fleet&background=1');
    await page.evaluate(() => {
      window.__backgroundTasks = [];
      window.sidebarPreview.bridge.onEvent((event) => {
        if (event.type === 'agent' && event.event.type === 'task-start' && event.event.background) {
          window.__backgroundTasks.push({ agent: event.event.agent, taskId: event.event.taskId });
        }
      });
    });
    await page.click('#play');
    await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
    await turnEnded();
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    const fleetState = () => page.evaluate(() => ({
      hostedCards: document.querySelectorAll('.ag-fleet-popup .ag-fleet').length,
      hiddenSlotsInFlow: document.querySelectorAll('.ag-messages > .ag-fleet-slot[hidden]').length,
      cardsInFlow: document.querySelectorAll('.ag-messages > .ag-fleet-slot:not([hidden]) .ag-fleet').length,
      slotsInFold: document.querySelectorAll('.ag-turn-fold .ag-fleet-slot').length,
    }));
    assert.deepEqual(await fleetState(), { hostedCards: 1, hiddenSlotsInFlow: 1, cardsInFlow: 0, slotsInFold: 0 });
    await assertRingOutsideFolds();
    // 백그라운드 작업이 턴 뒤에 끝나면 카드는 접힘 밖, 흐름의 예약 자리에 보이게 내려앉는다.
    await page.evaluate(() => {
      for (const task of window.__backgroundTasks) {
        window.sidebarPreview.streamEvent({ type: 'task-end', agent: task.agent, taskId: task.taskId, status: 'completed', summary: '백그라운드 검토를 마쳤습니다.' });
      }
    });
    await page.waitForFunction(() => document.querySelector('.ag-messages > .ag-fleet-slot:not([hidden]) .ag-fleet'));
    assert.deepEqual(await fleetState(), { hostedCards: 0, hiddenSlotsInFlow: 0, cardsInFlow: 1, slotsInFold: 0 });
    assert.equal(await page.$eval('.ag-messages > .ag-fleet-slot .ag-fleet-toggle', (node) => node.checkVisibility()), true);
  });

  await step('(f) 샘플 채팅의 끝난 턴과 멈춘 턴이 접혀 복원된다', async () => {
    await open('reset=1&chats=sample');
    const labelOf = async (id) => {
      await page.evaluate((threadId) => window.sidebarPreview.sidebar.openThreadById(threadId), id);
      await page.waitForFunction(() => document.querySelector('.ag-messages > .ag-turn-fold:not([hidden])'));
      return (await folds()).map((fold) => fold.title);
    };
    assert.deepEqual(await labelOf('preview-chat-overview'), ['작업 2분 31초 · 문단 2개 수정 · 표 1개 읽음']);
    assert.deepEqual(await labelOf('preview-chat-attendees'), ['중단됨 · 1분 12초 · 표 1개 추가']);
  });

  await step('(g) 도는 턴을 위로 올려 읽는 중에 턴이 끝나면 펼친 채로 두고 읽던 줄을 지킨다', async () => {
    await page.setViewport({ width: 1280, height: 560, deviceScaleFactor: 1 });
    await play('scenario=tools&hold=1');
    await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('단계별 일정과 담당자를 확인합니다.'));
    const messages = await page.$('.ag-messages');
    const box = await messages.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 사용자처럼 휠로 올려 턴의 작업이 화면 위쪽에 오게 한다.
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel({ deltaY: -120 });
      await new Promise((done) => setTimeout(done, 60));
    }
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const before = await page.evaluate(() => {
      const messages = document.querySelector('.ag-messages');
      const top = messages.getBoundingClientRect().top;
      const candidates = [...messages.querySelectorAll('.ag-msg, .ag-activity-toggle, .ag-progress-step')]
        .filter((node) => node.checkVisibility() && node.getBoundingClientRect().bottom > top + 4);
      window.__readerLine = candidates[0];
      return { top: window.__readerLine.getBoundingClientRect().top, scrollTop: messages.scrollTop };
    });
    assert.ok(before.scrollTop > 0 || before.top >= 0, '대화가 위로 올라가 있다');
    await page.$eval('.ag-send', (button) => button.click());
    await turnEnded();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const [fold] = await folds();
    assert.match(fold.label, /^중단됨/);
    assert.deepEqual([fold.collapsed, fold.inert], [false, false], '읽는 중인 턴은 펼친 채로 둔다');
    await assertRingOutsideFolds();
    const after = await page.evaluate(() => window.__readerLine.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before.top) <= 2, `읽던 줄이 ${after - before.top}px 움직였다`);
    assert.equal(await page.evaluate(() => Boolean(window.__readerLine.closest('.ag-turn-fold-body'))
      || window.__readerLine.parentElement === document.querySelector('.ag-messages')), true);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });

  await step('(h) 새로고침 뒤 다시 잡은 턴은 접지 않고 있다가 실제 끝에서 정상으로 접힌다', async () => {
    const RUNNING_CHAT = 'preview-chat-schedule';
    await page.goto(`${origin}/?reset=1&theme=light&width=480&chats=sample&reload=running`, { waitUntil: 'networkidle0' });
    await page.waitForFunction((id) => window.sidebarPreview?.sidebar.currentThreadId() === id
      && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', {}, RUNNING_CHAT);
    // 새로고침 전에 남긴 열린 표식: 접지 않은 작업과 숨은 자리표시만 있다.
    assert.deepEqual(await page.evaluate(() => ({
      running: window.sidebarPreview.bridge.isTurnRunning(),
      placeholders: document.querySelectorAll('.ag-messages > .ag-turn-fold[hidden]').length,
      visibleFolds: document.querySelectorAll('.ag-messages > .ag-turn-fold:not([hidden])').length,
      workInFlow: document.querySelectorAll('.ag-messages > .ag-progress-step').length > 0,
    })), { running: true, placeholders: 1, visibleFolds: 0, workInFlow: true });
    await page.evaluate(() => window.sidebarPreview.finishTurn('completed'));
    await turnEnded();
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    const [fold, ...rest] = await folds();
    assert.equal(rest.length, 0);
    assert.match(fold.label, /^작업 \d+초 · 표 1개 수정 · 표 1개 읽음$/);
    assert.equal(fold.collapsed, true);
    // 다시 잡은 턴의 도구 작업도 접힌다. 이 턴은 최종 답변 없이 끝나 마지막 글(이정표)만 흐름에 남는다.
    assert.deepEqual(await page.evaluate(() => ({
      toolsInFlow: [...document.querySelectorAll('.ag-messages .ag-activity')].filter((node) => !node.closest('.ag-turn-fold')).length,
      stepsInFlow: [...document.querySelectorAll('.ag-messages > .ag-progress-step')].map((node) => node.textContent.trim()),
    })), { toolsInFlow: 0, stepsInFlow: ['추진 일정 표를 읽고 분기별로 묶겠습니다.'] }, '다시 잡은 턴의 작업도 접힌다');
    const stored = await page.evaluate(async (id) => {
      await window.sidebarPreview.threadStore.waitForThreadsPersistence();
      return window.sidebarPreview.threadStore.getThread(id).messages
        .filter((message) => message.kind === 'turn')
        .map((marker) => ({ outcome: marker.outcome, settled: marker.endedAt !== null }));
    }, RUNNING_CHAT);
    assert.deepEqual(stored, [{ outcome: 'completed', settled: true }], '표식은 실제 끝의 결과로 정착한다');
    await assertRingOutsideFolds();
  });

  await step('(i) 보고를 쓴 뒤 도구를 부르고 끝난 턴은 그 보고를 접지 않는다 — 살아 있을 때와 다시 열었을 때', async () => {
    const REPORT = '필요한 부분을 선택해 주시면 이어서 다듬겠습니다.';
    await play('scenario=chat&report=1');
    await turnEnded();
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    const layout = () => page.evaluate((report) => {
      const messages = document.querySelector('.ag-messages');
      const row = messages.querySelector(':scope > .ag-turn-fold:not([hidden])');
      const reports = [...messages.querySelectorAll('.ag-progress-milestone')].filter((node) => node.textContent.includes(report));
      const todos = [...messages.querySelectorAll('.ag-activity-label')].filter((node) => node.textContent.includes('할 일 갱신'));
      const step = reports[0]?.closest('.ag-progress-step');
      return {
        folds: messages.querySelectorAll(':scope > .ag-turn-fold:not([hidden])').length,
        collapsed: row.classList.contains('ag-turn-fold-collapsed'),
        reports: reports.length,
        reportInFold: Boolean(reports[0]?.closest('.ag-turn-fold')),
        reportVisible: Boolean(reports[0]?.checkVisibility()),
        reportStepInFlow: step?.parentElement === messages,
        reportAfterRow: Boolean(step && (row.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING)),
        todosInFold: todos.length > 0 && todos.every((node) => Boolean(node.closest('.ag-turn-fold-body'))),
        // 편집 턴 끝의 안내 줄은 답이 아니다 — 있어도 보고를 접지 않는다.
        checkNoteInFlow: [...messages.querySelectorAll(':scope > .ag-msg-assistant')]
          .some((node) => node.textContent.includes('작업 완료 · 문서 확인')),
      };
    }, REPORT);
    const expected = {
      folds: 1, collapsed: true, reports: 1, reportInFold: false, reportVisible: true,
      reportStepInFlow: true, reportAfterRow: true, todosInFold: true, checkNoteInFlow: true,
    };
    assert.deepEqual(await layout(), expected);
    await screenshot('turn-fold-report');
    const threadId = await page.evaluate(async () => {
      await window.sidebarPreview.threadStore.waitForThreadsPersistence();
      return window.sidebarPreview.sidebar.currentThreadId();
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.evaluate(async (id) => {
      await window.sidebarPreview.threadStore.waitForThreadsPersistence();
      window.sidebarPreview.sidebar.openThreadById(id);
    }, threadId);
    await page.waitForSelector('.ag-messages > .ag-turn-fold:not([hidden])');
    assert.deepEqual(await layout(), expected, '다시 연 대화도 보고를 흐름에 남긴다');
  });

  assert.deepEqual(errors, [], 'no runtime errors');
} finally {
  await browser?.close();
  await server.close();
}
