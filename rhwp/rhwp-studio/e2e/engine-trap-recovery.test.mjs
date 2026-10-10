/**
 * E2E: 엔진이 멈춘 뒤 문서 복구 — 페이지를 다시 불러와 열린 문서를 모두 다시 연다.
 *
 * 모의 trap(simulated): 페이지에서 /src/core/engine-trap.ts 를 불러
 * reportEngineTrap(new WebAssembly.RuntimeError('unreachable')) 를 부른다. 앱이 실제 trap 에서 쓰는
 * 알림, 엔진 호출 차단(guard), 복구본 저장, 목록, 다시 불러오기, 다시 열기를 모두 그대로 지난다.
 * 망가진 wasm 힙은 만들지 않는다 — 실제 trap 은 필요할 때 만들 수 없다.
 *
 * 실제 허브와 Vite 개발 서버를 띄우고, 가짜 Pi 로 한 문서의 에이전트 턴을 열어 둔다. 문서는 OPFS
 * 파일 핸들로 열어 원본 파일과 연결된 상태를 만든다.
 *
 * 1. 편집한 문서 하나: 입력한 글자가 저장하지 않은 변경으로, 같은 파일에 연결된 채 돌아온다.
 *    깨끗한 문서는 파일에서 깨끗하게 돌아온다. 일반 자동 저장본 복구 안내는 뜨지 않는다.
 *    멈춘 뒤의 열기·새 문서는 엔진을 건드리지 않고 문서 복구로 안내한다 (지금 문서가 남는다).
 * 2. 두 문서: 에이전트가 일하던 문서는 뒤의 세션으로, 보던 문서는 화면에 돌아오고, 멈춘 채팅의 마지막
 *    턴은 '문서 엔진 멈춤'으로 끊긴 턴이 되어 그 자리에 이유와 이어서 진행이 선다. 이어서 다시 여는
 *    도중 또 멈추면 그 문서는 다음 복구에서 자동으로 열지 않고
 *    결과에서 직접 열 수 있다.
 * 3. 첫 문서를 다시 여는 도중 멈추면 일반 자동 저장본 복구를 띄우지 않는다 — 그 삭제가 다음 문서
 *    복구에 쓸 복구본을 지운다. 복구본은 남아 다음 복구의 결과에서 직접 열 수 있다.
 * 4. 버전 기록을 함께 저장한 .rhwpx 파일에 연결된 깨끗한 문서는 그 묶음에서 문서를 꺼내 다시 연다.
 * 5. 읽기 전용으로 보던 문서(데스크톱의 생성 문서 미리보기 창 등)는 읽기 전용이고 바뀌지 않은 채
 *    돌아온다.
 * 6. 멈출 때 허브 연결이 끊겨 채팅의 멈춤이 닿지 않았으면, 다시 불러온 페이지가 이어받은 그 턴을
 *    첫 welcome 에서 멈춘다 — 다시 연 문서에 계속 쓰지 않게.
 *
 * 실행: CHROME_PATH=... node e2e/engine-trap-recovery.test.mjs --mode=headless
 *       (VITE_PORT / RHWP_AGENT_PORT 로 시작 포트를 바꾼다)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureChromePath,
  findAvailablePort,
  removeTempDir,
  startHub,
  startVite,
  stopServer,
  writeFakePi,
} from './agent-bench-harness.mjs';

const HUB_TOKEN = 'engine-trap-recovery-e2e';
const DOC_A = 'para-001.hwp';
const DOC_B = 'text-align-2.hwp';
const MARKER = 'TRAPKEEP';
const NOTICE = '문서 엔진이 멈춰 작업이 중단됐어요';
/** 멈춘 엔진을 부른 호출이 잡히지 않고 페이지 오류로 새어 나온 것 (다시 던지면 이름 없이 문구만 남는다). */
const TRAP_PAGE_ERROR = /EngineTrapped|ENGINE_TRAPPED|문서 엔진이 멈췄습니다/;

ensureChromePath();
const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || 7845));
const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || 7841));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-trap-recovery-'));
const { piRoot } = writeFakePi(fixtureRoot);
let hub;
let vite;
try {
  hub = await startHub({
    hubPort, token: HUB_TOKEN, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'engine-trap-recovery-hub.log',
  });
  vite = await startVite({ vitePort, hubPort, token: HUB_TOKEN, logName: 'engine-trap-recovery-vite.log' });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const {
    runTest, assert, screenshot, sampleFetchPath, waitForState, clickEditArea, loadApp,
  } = await import('./helpers.mjs');

  function watchConsole(page) {
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' || text.startsWith('[e2e]')) console.log(`  [browser:${message.type()}] ${text}`);
    });
    page.__pageErrors = [];
    page.on('pageerror', (error) => {
      page.__pageErrors.push(String(error?.stack ?? error?.message ?? error));
      console.log(`  [browser:pageerror] ${error.stack ?? error.message}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) console.log(`  [browser:http ${response.status()}] ${response.url()}`);
    });
  }

  /** 샘플을 OPFS 파일로 만들고, 그 파일 핸들로 실제 열기 경로를 거쳐 연다. */
  async function openFromFile(page, sample) {
    const done = await page.evaluate(async ({ url, fileName }) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(fileName).catch(() => {});
      const handle = await root.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      const requestId = `trap-e2e-${fileName}-${Date.now()}`;
      return new Promise((resolve) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          resolve(payload);
        });
        window.__eventBus.emit('open-document-bytes', {
          bytes, fileName, fileHandle: handle, requestId, skipUnsavedGuard: true,
        });
      });
    }, { url: sampleFetchPath(sample), fileName: sample });
    assert(done.ok === true, `${sample} opened from its file (${done.error ?? 'ok'})`);
    await waitForState(page, `${sample} shown`, (name) => window.__wasm?.fileName === name
      && window.__wasm.pageCount > 0 && Boolean(document.querySelector('#scroll-container canvas')), sample);
  }

  /** 편집기에서 문서 맨 앞에 키보드로 입력한다. */
  async function typeAtStart(page, text) {
    await clickEditArea(page);
    await page.evaluate(() => {
      window.__inputHandler.focus?.();
      window.__inputHandler.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
    });
    await page.keyboard.type(text, { delay: 20 });
    await waitForState(page, 'typed text in the document', (marker) => window.__wasm.getTextRange(0, 0, 0, marker.length) === marker
      && window.__documentState.isDirty(), text);
  }

  async function simulateTrap(page) {
    console.log('  [simulated trap] reportEngineTrap(new WebAssembly.RuntimeError("unreachable"))');
    await page.evaluate(async () => {
      const { reportEngineTrap } = await import('/src/core/engine-trap.ts');
      reportEngineTrap(new WebAssembly.RuntimeError('unreachable'));
    });
    // 멈춘 엔진을 명령 상태 갱신이 다시 부르면 갱신마다 EngineTrappedError 가 잡히지 않고 터진다.
    const errorsBefore = page.__pageErrors?.length ?? 0;
    await page.evaluate(() => window.__eventBus.emit('command-state-changed'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const trapErrors = (page.__pageErrors ?? []).slice(errorsBefore).filter((text) => TRAP_PAGE_ERROR.test(text));
    assert(trapErrors.length === 0, `Command-state refresh after the trap does not call the stopped engine (${trapErrors[0] ?? 'no errors'})`);
  }

  /**
   * 엔진이 멈춘 뒤 다시 불러오기까지 어디에서도 멈춘 엔진을 부른 오류가 잡히지 않고 새지 않았다.
   * 페이지 오류는 다시 불러와도 이어서 모이므로, 다시 불러오기 직전과 시나리오 끝에서 본다.
   */
  function assertNoTrapPageErrors(page, when) {
    const leaked = (page.__pageErrors ?? []).filter((text) => TRAP_PAGE_ERROR.test(text));
    assert(leaked.length === 0, `No uncaught stopped-engine error ${when} (${leaked[0]?.split('\n').slice(0, 4).join(' | ') ?? 'none'})`);
  }

  /** 다시 불러온 페이지가 그 파일을 읽을 때 한 번 모의 trap 을 일으킨다 (sessionStorage 로 켠다). */
  async function armTrapOnReopen(page, name) {
    await page.evaluateOnNewDocument((fileName) => {
      const original = FileSystemFileHandle.prototype.getFile;
      FileSystemFileHandle.prototype.getFile = async function getFileWithTrap(...args) {
        if (this.name === fileName && sessionStorage.getItem('e2e-trap-on-open') === 'armed') {
          sessionStorage.setItem('e2e-trap-on-open', 'fired');
          const { reportEngineTrap } = await import('/src/core/engine-trap.ts');
          console.log(`[e2e] simulated engine trap while reopening ${fileName}`);
          reportEngineTrap(new WebAssembly.RuntimeError('unreachable'));
        }
        return original.apply(this, args);
      };
    }, name);
    await page.evaluate(() => sessionStorage.setItem('e2e-trap-on-open', 'armed'));
  }

  async function clickToastAction(page, label) {
    await page.waitForFunction((text) => [...document.querySelectorAll('.rhwp-toast-action')]
      .some((button) => button.textContent === text), { timeout: 10_000 }, label);
    await page.evaluate((text) => [...document.querySelectorAll('.rhwp-toast-action')]
      .find((button) => button.textContent === text).click(), label);
  }

  /** 문서 복구 대화상자의 줄마다 상태. 화면 문서가 먼저 온다. */
  function dialogRows(page) {
    return page.evaluate(() => [...document.querySelectorAll('.trap-recovery-dialog [data-trap-row]')].map((row) => ({
      title: row.querySelector('.recovery-draft-title')?.textContent ?? '',
      status: row.querySelector('.trap-recovery-status')?.textContent ?? '',
      notes: [...row.querySelectorAll('.trap-recovery-note')].map((note) => note.textContent),
    })));
  }

  async function openRecoveryDialogWhenSaved(page, expectedRows) {
    await clickToastAction(page, '문서 복구');
    await page.waitForSelector('.trap-recovery-dialog', { timeout: 10_000 });
    await waitForState(page, 'recovery copies settled', (count) => {
      const rows = [...document.querySelectorAll('.trap-recovery-dialog [data-trap-row]')];
      const button = document.querySelector('.trap-recovery-dialog .dialog-btn-primary');
      return rows.length === count
        && rows.every((row) => !row.querySelector('.trap-recovery-status')?.textContent?.includes('저장 중'))
        && button && !button.disabled;
    }, expectedRows);
    return dialogRows(page);
  }

  async function reopenAll(page) {
    assertNoTrapPageErrors(page, 'between the trap and the reload');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      page.click('.trap-recovery-dialog .dialog-btn-primary'),
    ]);
    await page.waitForFunction(() => Boolean(window.__wasm && window.__canvasView && window.__documentSessions),
      { timeout: 60_000 });
  }

  function loadedSessions(page) {
    return page.evaluate(() => window.__documentSessions.list()
      .filter((session) => session.wasm.hasLoadedDocument())
      .map((session) => ({
        fileName: session.wasm.fileName,
        dirty: session.documentState.isDirty(),
        attached: session === window.__documentSessions.attached(),
        first: session === window.__documentSessions.list()[0],
        text: session.wasm.getTextRange(0, 0, 0, 40),
        threadId: session.activeChat?.sidebar.currentThreadId() ?? null,
      })));
  }

  /** 다시 연 문서가 OPFS 의 그 파일에 연결되어 있는지 */
  function linkedToFile(page, fileName) {
    return page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(name);
      const session = window.__documentSessions.list().find((item) => item.wasm.fileName === name);
      const handle = session?.wasm.currentFileHandle;
      return Boolean(handle && await handle.isSameEntry(file));
    }, fileName);
  }

  function genericRecoveryToastShown(page) {
    return page.evaluate(() => [...document.querySelectorAll('.rhwp-toast-message')]
      .some((message) => message.textContent?.includes('복구할 수 있는 자동 저장본')));
  }

  /** 이 페이지가 다시 기록해 소유한 복구본만 남았는지 (다음 시작에 따로 제안되지 않는다) */
  function recoverableDraftNames(page) {
    return page.evaluate(async () => {
      const { listRecoverableAutosaveDrafts } = await import('/src/recovery/autosave-store.ts');
      return (await listRecoverableAutosaveDrafts()).map((draft) => draft.fileName);
    });
  }

  async function waitForToast(page, text) {
    await waitForState(page, `toast "${text}"`, (wanted) => [...document.querySelectorAll('.rhwp-toast-message')]
      .some((message) => message.textContent?.includes(wanted)), text);
  }

  await runTest('engine trap: one document comes back edited, or clean from its file', async ({ page }) => {
    watchConsole(page);
    await openFromFile(page, DOC_A);
    await typeAtStart(page, MARKER);

    await simulateTrap(page);
    // 멈춘 엔진에 다른 문서를 올리거나 새 문서를 만들면 지금 문서를 먼저 해제한 뒤 실패해, 그 문서가
    // 문서 복구에서 빠진다. 둘 다 엔진에 닿지 않고 문서 복구로 안내해야 한다.
    const refused = await page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const requestId = 'trap-e2e-open-after-trap';
      const opened = await new Promise((resolve) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          resolve(payload);
        });
        window.__eventBus.emit('open-document-bytes', { bytes, fileName: 'other.hwp', skipUnsavedGuard: true, requestId });
      });
      window.__dispatcher.dispatch('file:new-doc');
      return opened;
    }, sampleFetchPath(DOC_B));
    const kept = await page.evaluate(() => {
      const session = window.__documentSessions.attached();
      return {
        loaded: session.wasm.hasLoadedDocument(),
        fileName: session.wasm.fileName,
        dirty: session.documentState.isDirty(),
        sessions: window.__documentSessions.list().length,
        modal: Boolean(document.querySelector('.modal-overlay')),
      };
    });
    assert(refused.ok === false && kept.loaded && kept.fileName === DOC_A && kept.dirty && kept.sessions === 1,
      `Opening or creating a document after the trap leaves the edited document in place (${JSON.stringify({ refused, kept })})`);
    assert(!kept.modal, 'No save prompt or file picker step starts on the stopped engine');
    await waitForToast(page, '문서 복구를 먼저 진행하세요');
    await screenshot(page, 'trap-recovery-0-open-refused');
    const rows = await openRecoveryDialogWhenSaved(page, 1);
    assert(rows[0]?.title === `${DOC_A} (화면)` && rows[0].status.startsWith('복구본 저장됨'),
      `The dialog shows the shown document with a fresh recovery copy (${JSON.stringify(rows)})`);
    await screenshot(page, 'trap-recovery-1-dialog');
    await reopenAll(page);
    await waitForState(page, 'the edited document reopened', (name) => window.__wasm.fileName === name
      && window.__wasm.pageCount > 0, DOC_A);
    await waitForToast(page, '문서 1개를 다시 열었습니다.');

    const [reopened] = await loadedSessions(page);
    assert(reopened?.text.startsWith(MARKER), `The typed text came back (${reopened?.text})`);
    assert(reopened?.dirty === true, 'The document is still marked as unsaved');
    assert(await linkedToFile(page, DOC_A), 'The document is linked to the same file again, so Save writes there');
    assert((await recoverableDraftNames(page)).length === 0, 'No recovery copy is left over for the startup dialog');
    assert(!(await genericRecoveryToastShown(page)), 'The generic autosave notice does not appear');
    await screenshot(page, 'trap-recovery-2-reopened-dirty');

    // 바뀌지 않은 문서는 복구본을 만들지 않고 그 파일에서 깨끗하게 돌아온다.
    await openFromFile(page, DOC_B);
    await simulateTrap(page);
    const cleanRows = await openRecoveryDialogWhenSaved(page, 1);
    assert(cleanRows[0]?.status === '변경 없음 · 파일에서 다시 엽니다',
      `A clean document is reopened from its file (${cleanRows[0]?.status})`);
    await reopenAll(page);
    await waitForToast(page, '문서 1개를 다시 열었습니다.');
    const [clean] = await loadedSessions(page);
    assert(clean?.fileName === DOC_B && clean.dirty === false, `The clean document reopened clean (${JSON.stringify(clean)})`);
    assert(await linkedToFile(page, DOC_B), 'It is linked to its file');
    assert(!(await genericRecoveryToastShown(page)), 'No autosave notice for the clean document');
    assertNoTrapPageErrors(page, 'after recovery');
  });

  await runTest('engine trap: background and shown documents return, and a document that traps again is held back', async ({ page }) => {
    watchConsole(page);
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 });

    // 문서 A: 고친 뒤 에이전트 턴을 연다. 문서 B: 에이전트가 일하는 동안 열어 화면에 둔다.
    await openFromFile(page, DOC_A);
    await typeAtStart(page, MARKER);
    await page.type('.ag-input', 'A 문서의 첫 문단을 정리해 주세요.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });
    const threadA = await page.evaluate(() => window.__documentSessions.attached().activeChat.sidebar.currentThreadId());
    assert(Boolean(threadA), 'The agent chat on A has a thread');
    await openFromFile(page, DOC_B);
    await waitForState(page, 'A in a background session', () => window.__documentSessions.list().length === 2);

    await simulateTrap(page);
    const rows = await openRecoveryDialogWhenSaved(page, 2);
    assert(rows[0]?.title === `${DOC_B} (화면)` && rows[0].status === '변경 없음 · 파일에서 다시 엽니다',
      `The shown clean document comes first (${JSON.stringify(rows[0])})`);
    assert(rows[1]?.title === DOC_A && rows[1].status.startsWith('복구본 저장됨')
      && rows[1].notes.includes('작업 중인 채팅은 중단됩니다'),
      `The background document has a copy and its working chat will stop (${JSON.stringify(rows[1])})`);
    await screenshot(page, 'trap-recovery-3-dialog-two-documents');
    await reopenAll(page);
    await waitForState(page, 'both documents reopened', (a, b) => {
      const sessions = window.__documentSessions.list().filter((session) => session.wasm.hasLoadedDocument());
      return sessions.length === 2 && window.__documentSessions.attached().wasm.fileName === b
        && sessions.some((session) => session.wasm.fileName === a);
    }, DOC_A, DOC_B);
    await waitForToast(page, '문서 2개를 다시 열었습니다.');

    const sessions = await loadedSessions(page);
    const a = sessions.find((session) => session.fileName === DOC_A);
    const b = sessions.find((session) => session.fileName === DOC_B);
    assert(a?.first === true && a.attached === false, 'A is back in the first session, off screen');
    assert(a?.text.startsWith(MARKER) && a.dirty, 'A kept its unsaved edit');
    assert(b?.attached === true && b.dirty === false, 'B is shown again, clean');
    assert(a?.threadId === threadA, `A's chat follows its interrupted thread (${a?.threadId} vs ${threadA})`);
    // 멈춘 채팅의 마지막 턴은 '문서 엔진 멈춤'으로 끊긴 턴이다 — 그 자리에 이유와 이어서 진행이 선다.
    const marker = await page.evaluate(async (threadId) => {
      const { getThread } = await import('/src/agent/threads.ts');
      const markers = getThread(threadId)?.messages.filter((message) => message.kind === 'turn') ?? [];
      return markers.at(-1) ?? null;
    }, threadA);
    assert(marker?.outcome === 'interrupted' && marker.interruption?.reason === 'engine-trap',
      `The interrupted chat records why it stopped (${JSON.stringify(marker?.interruption)})`);
    await waitForState(page, 'the interruption row in A\'s chat', () => {
      const sidebar = window.__documentSessions.list()[0].activeChat?.sidebar.root;
      return Boolean(sidebar?.querySelector('.ag-turn-interrupted .ag-turn-interrupted-resume:not([hidden])'));
    });
    const row = await page.evaluate(() => window.__documentSessions.list()[0].activeChat.sidebar.root
      .querySelector('.ag-turn-interrupted-text')?.textContent ?? null);
    assert(row === NOTICE, `The interrupted chat says why it stopped and offers 이어서 진행 (${row})`);
    assert(await linkedToFile(page, DOC_A) && await linkedToFile(page, DOC_B), 'Both documents are linked to their files');
    assert(!(await genericRecoveryToastShown(page)), 'The generic autosave notice does not appear');
    await screenshot(page, 'trap-recovery-4-two-documents-back');

    // 다시 여는 도중 B 가 또 엔진을 멈추게 한다 (B 파일을 읽을 때 모의 trap).
    await armTrapOnReopen(page, DOC_B);
    await simulateTrap(page);
    await openRecoveryDialogWhenSaved(page, 2);
    await reopenAll(page);
    await page.waitForSelector('.trap-recovery-result-dialog', { timeout: 30_000 });
    const stopped = await page.evaluate(() => ({
      lead: document.querySelector('.trap-recovery-result-dialog .trap-recovery-body p')?.textContent ?? '',
      open: window.__documentSessions.list().filter((session) => session.wasm.hasLoadedDocument())
        .map((session) => session.wasm.fileName),
      fired: sessionStorage.getItem('e2e-trap-on-open'),
    }));
    assert(stopped.fired === 'fired', 'The simulated trap hit while B was reopening');
    assert(stopped.lead.includes('엔진이 또 멈췄습니다'), `The result says recovery stopped (${stopped.lead})`);
    assert(stopped.open.length === 1 && stopped.open[0] === DOC_A, `Only A reopened before the trap (${stopped.open})`);
    await page.click('.trap-recovery-result-dialog .dialog-btn-primary');

    const carried = await openRecoveryDialogWhenSaved(page, 2);
    const suspectRow = carried.find((row) => row.title === DOC_B);
    assert(suspectRow?.status.includes('자동으로 열지 않습니다'), `B is listed as the document that stopped the engine (${suspectRow?.status})`);
    await screenshot(page, 'trap-recovery-5-dialog-with-suspect');
    await reopenAll(page);
    await page.waitForSelector('.trap-recovery-result-dialog [data-trap-result]', { timeout: 30_000 });
    const result = await page.evaluate(() => ({
      open: window.__documentSessions.list().filter((session) => session.wasm.hasLoadedDocument())
        .map((session) => session.wasm.fileName),
      rows: [...document.querySelectorAll('.trap-recovery-result-dialog [data-trap-result]')].map((row) => ({
        title: row.querySelector('.recovery-draft-title')?.textContent ?? '',
        text: row.querySelector('.trap-recovery-status')?.textContent ?? '',
        canOpen: Boolean(row.querySelector('.trap-recovery-open')),
      })),
    }));
    const bRow = result.rows.find((row) => row.title === DOC_B);
    assert(result.open.length === 1 && result.open[0] === DOC_A, `B is not reopened automatically (${result.open})`);
    assert(bRow?.text === '이 문서를 열다가 엔진이 다시 멈췄습니다.' && bRow.canOpen,
      `The result names B and offers to open it on purpose (${JSON.stringify(bRow)})`);
    const aAfter = (await loadedSessions(page)).find((session) => session.fileName === DOC_A);
    assert(aAfter?.text.startsWith(MARKER) && aAfter.dirty, 'A still has its unsaved edit after two recoveries');
    await screenshot(page, 'trap-recovery-6-result-suspect');

    await page.evaluate((name) => [...document.querySelectorAll('.trap-recovery-result-dialog [data-trap-result]')]
      .find((row) => row.querySelector('.recovery-draft-title')?.textContent === name)
      .querySelector('.trap-recovery-open').click(), DOC_B);
    await waitForState(page, 'B opened on request', (a2, b2) => {
      const files = window.__documentSessions.list().filter((session) => session.wasm.hasLoadedDocument())
        .map((session) => session.wasm.fileName);
      return files.includes(a2) && files.includes(b2) && window.__documentSessions.attached().wasm.fileName === b2;
    }, DOC_A, DOC_B);
    assert(true, 'Opening B from the result keeps A open and shows B');
    assertNoTrapPageErrors(page, 'after recovery');
  });

  await runTest('engine trap: a trap while reopening the first document keeps its copy for the next recovery', async ({ page }) => {
    watchConsole(page);
    await openFromFile(page, DOC_A);
    await typeAtStart(page, MARKER);
    // 다시 불러온 페이지가 A(기본 자리, 첫 세션)의 원본을 찾으며 읽을 때 엔진이 또 멈춘다.
    await armTrapOnReopen(page, DOC_A);
    await simulateTrap(page);
    await openRecoveryDialogWhenSaved(page, 1);
    await reopenAll(page);
    await page.waitForSelector('.trap-recovery-result-dialog', { timeout: 30_000 });
    const stopped = await page.evaluate(() => ({
      lead: document.querySelector('.trap-recovery-result-dialog .trap-recovery-body p')?.textContent ?? '',
      fired: sessionStorage.getItem('e2e-trap-on-open'),
    }));
    assert(stopped.fired === 'fired' && stopped.lead.includes('엔진이 또 멈췄습니다'),
      `The recovery stopped on the simulated trap while reopening A (${JSON.stringify(stopped)})`);
    // 일반 복구 제안(대화상자나 안내)은 이 결과 대화상자 바로 뒤에 열렸다. 그만큼 기다려 뜨지 않는지 본다.
    const offered = await page.waitForFunction(() => Boolean(document.querySelector(
      '.recovery-dialog:not(.trap-recovery-dialog):not(.trap-recovery-result-dialog)',
    )) || [...document.querySelectorAll('.rhwp-toast-message')]
      .some((message) => message.textContent?.includes('복구할 수 있는 자동 저장본')), { timeout: 3_000 })
      .then(() => true, () => false);
    assert(!offered, 'No generic "unsaved changes" recovery opens over the result on the stopped engine');
    assert((await recoverableDraftNames(page)).includes(DOC_A), 'A\'s recovery copy is still stored for the next recovery');
    await screenshot(page, 'trap-recovery-7-stopped-on-first');
    await page.click('.trap-recovery-result-dialog .dialog-btn-primary');

    const carried = await openRecoveryDialogWhenSaved(page, 1);
    assert(carried[0]?.title === DOC_A && carried[0].status.includes('자동으로 열지 않습니다'),
      `The next recovery holds A back as the document that stopped the engine (${JSON.stringify(carried)})`);
    await reopenAll(page);
    await page.waitForSelector('.trap-recovery-result-dialog [data-trap-result]', { timeout: 30_000 });
    await page.evaluate((name) => [...document.querySelectorAll('.trap-recovery-result-dialog [data-trap-result]')]
      .find((row) => row.querySelector('.recovery-draft-title')?.textContent === name)
      .querySelector('.trap-recovery-open').click(), DOC_A);
    // 열기가 끝나면 그 줄의 문구가 결과로 바뀐다.
    await waitForState(page, 'A opened on request', (name) => {
      const row = [...document.querySelectorAll('.trap-recovery-result-dialog [data-trap-result]')]
        .find((item) => item.querySelector('.recovery-draft-title')?.textContent === name);
      const text = row?.querySelector('.trap-recovery-status')?.textContent ?? '';
      return !text.startsWith('이 문서를 열다가') && window.__documentSessions.attached().wasm.fileName === name
        && window.__documentSessions.attached().wasm.hasLoadedDocument();
    }, DOC_A);
    const [back] = await loadedSessions(page);
    assert(back?.text.startsWith(MARKER) && back.dirty, `A comes back with its unsaved edit from the kept copy (${JSON.stringify(back)})`);
    assert(!(await genericRecoveryToastShown(page)), 'The generic autosave notice does not appear');
    assertNoTrapPageErrors(page, 'after recovery');
  });

  await runTest('engine trap: a clean document saved with its version history reopens from its .rhwpx file', async ({ page }) => {
    watchConsole(page);
    const bundleName = 'para-001.rhwpx';
    await openFromFile(page, DOC_A);
    // 기록을 포함해 저장한다. 저장 위치는 OPFS 의 .rhwpx 파일이고, 문서는 그 파일에 연결된다.
    const dispatched = await page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name).catch(() => {});
      const handle = await root.getFileHandle(name, { create: true });
      window.showSaveFilePicker = async () => handle;
      return window.__dispatcher.dispatch('file:save-with-history');
    }, bundleName);
    assert(dispatched, 'Save with history runs');
    await waitForState(page, 'the document saved into its .rhwpx file', async (name) => {
      if (window.__wasm.fileName !== name || window.__documentState.isDirty()) return false;
      const { listRecentDocs } = await import('/src/recent/recent-store.ts');
      return (await listRecentDocs()).some((entry) => entry.fileName === name && entry.handle);
    }, bundleName);

    await simulateTrap(page);
    const rows = await openRecoveryDialogWhenSaved(page, 1);
    assert(rows[0]?.status === '변경 없음 · 파일에서 다시 엽니다', `The bundle-backed document reopens from its file (${rows[0]?.status})`);
    await reopenAll(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.rhwp-toast-message')]
      .some((message) => message.textContent?.includes('다시 열었습니다'))
      || Boolean(document.querySelector('.trap-recovery-result-dialog')), { timeout: 30_000 });
    const result = await page.evaluate(() => [...document.querySelectorAll('.trap-recovery-result-dialog [data-trap-result]')]
      .map((row) => row.querySelector('.trap-recovery-status')?.textContent ?? ''));
    assert(result.length === 0, `No document failed to reopen (${JSON.stringify(result)})`);
    const [back] = await loadedSessions(page);
    assert(back?.fileName === bundleName && back.dirty === false && back.text.length > 0,
      `The document came back clean from inside the bundle (${JSON.stringify(back)})`);
    assert(await linkedToFile(page, bundleName), 'It is linked to its .rhwpx file again');
    await screenshot(page, 'trap-recovery-8-rhwpx-reopened');
    assertNoTrapPageErrors(page, 'after recovery');
  });

  await runTest('engine trap: a read-only preview comes back read-only and unchanged', async ({ page }) => {
    watchConsole(page);
    await loadApp(page, '/?templatePreview=1');
    // 파일 없이 받은 문서를 읽기 전용 창에 연다 (데스크톱의 생성 문서 미리보기 창과 같다).
    const opened = await page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const requestId = 'trap-e2e-read-only';
      return new Promise((resolve) => {
        const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
          if (payload?.requestId !== requestId) return;
          off();
          resolve(payload);
        });
        window.__eventBus.emit('open-document-bytes', { bytes, fileName: 'preview.hwp', requestId });
      });
    }, sampleFetchPath(DOC_B));
    assert(opened.ok === true, `The preview opened (${opened.error ?? 'ok'})`);
    await waitForState(page, 'the read-only preview shown', () => window.__wasm?.fileName === 'preview.hwp'
      && window.__wasm.pageCount > 0 && document.documentElement.dataset.documentReadOnly === 'true');
    // 데스크톱 창은 읽기 전용을 주소가 아니라 한 번 받은 값으로 안다. 다시 불러올 주소에서 뺀다.
    await page.evaluate(() => history.replaceState(null, '', window.location.pathname));

    await simulateTrap(page);
    const rows = await openRecoveryDialogWhenSaved(page, 1);
    assert(rows[0]?.status.startsWith('복구본 저장됨'), `The preview has a recovery copy (${rows[0]?.status})`);
    await reopenAll(page);
    await waitForToast(page, '문서 1개를 다시 열었습니다.');
    const back = await page.evaluate(() => ({
      fileName: window.__wasm.fileName,
      dirty: window.__documentState.isDirty(),
      readOnly: document.documentElement.dataset.documentReadOnly,
      location: window.location.search,
    }));
    assert(back.location === '' && back.fileName === 'preview.hwp' && back.readOnly === 'true',
      `The preview is read-only again (${JSON.stringify(back)})`);
    assert(back.dirty === false, 'It is not marked as unsaved: nothing in it could change');
    assert((await recoverableDraftNames(page)).length === 0, 'No recovery copy is left over for the startup dialog');
    await screenshot(page, 'trap-recovery-9-read-only-back');
    assertNoTrapPageErrors(page, 'after recovery');
  }, { skipLoadApp: true });

  await runTest('engine trap: a turn the trapped page could not stop is stopped after the reload', async ({ page }) => {
    watchConsole(page);
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30_000 });
    await openFromFile(page, DOC_A);
    await typeAtStart(page, MARKER);
    await page.type('.ag-input', 'A 문서의 첫 문단을 정리해 주세요.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.__agentBridge?.isTurnRunning?.() === true, { timeout: 30_000 });
    const threadA = await page.evaluate(() => window.__documentSessions.attached().activeChat.sidebar.currentThreadId());

    // 다시 불러온 페이지가 허브와 주고받는 프레임을 적는다.
    await page.evaluateOnNewDocument(() => {
      const frames = [];
      window.__e2eHubFrames = frames;
      const NativeWebSocket = window.WebSocket;
      const send = NativeWebSocket.prototype.send;
      NativeWebSocket.prototype.send = function sendRecorded(data) {
        try { frames.push({ dir: 'out', type: JSON.parse(data).type }); } catch { /* 바이너리 */ }
        return send.call(this, data);
      };
      window.WebSocket = class RecordedWebSocket extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', (event) => {
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === 'welcome') {
                frames.push({ dir: 'in', type: 'welcome', status: frame.session?.status ?? null, threadId: frame.session?.threadId ?? null });
              }
            } catch { /* 바이너리 */ }
          });
        }
      };
    });
    // 멈추는 순간 허브 연결이 끊겨 있다: 이 페이지가 보내는 멈춤은 허브에 닿지 않는다.
    await page.evaluate(() => {
      WebSocket.prototype.send = () => { throw new Error('e2e: hub connection lost'); };
    });
    await simulateTrap(page);
    const rows = await openRecoveryDialogWhenSaved(page, 1);
    assert(rows[0]?.notes.includes('작업 중인 채팅은 중단됩니다'), `The working chat is listed as stopping (${JSON.stringify(rows[0])})`);
    await reopenAll(page);
    await waitForToast(page, '문서 1개를 다시 열었습니다.');

    await waitForState(page, 'the first welcome after the reload', () => (window.__e2eHubFrames ?? [])
      .some((frame) => frame.type === 'welcome'));
    const welcome = await page.evaluate(() => window.__e2eHubFrames.find((frame) => frame.type === 'welcome'));
    assert(welcome.status === 'running' && welcome.threadId === threadA,
      `The hub still ran the interrupted turn when the page came back (${JSON.stringify(welcome)})`);
    await waitForState(page, 'the adopted turn stopped', () => window.__agentBridge?.isTurnRunning?.() === false
      && window.__e2eHubFrames.some((frame) => frame.dir === 'out' && frame.type === 'chat-interrupt'));
    const [back] = await loadedSessions(page);
    assert(back?.threadId === threadA && back.text.startsWith(MARKER) && back.dirty,
      `The reopened document follows its chat, and the turn no longer runs on it (${JSON.stringify(back)})`);
    // 다시 잡은 턴을 멈춘 끝이 사용자의 멈춤으로 이유를 덮지 않는다 — 마지막 턴은 여전히 엔진 멈춤으로 끊겼다.
    const stopped = await page.evaluate(async (threadId) => {
      const { getThread } = await import('/src/agent/threads.ts');
      const markers = getThread(threadId)?.messages.filter((message) => message.kind === 'turn') ?? [];
      return markers.at(-1) ?? null;
    }, threadA);
    assert(stopped?.outcome === 'interrupted' && stopped.interruption?.reason === 'engine-trap',
      `The chat still says the engine stop interrupted it (${JSON.stringify({ outcome: stopped?.outcome, interruption: stopped?.interruption })})`);
    const stoppedRow = await page.evaluate(() => window.__documentSessions.list()[0].activeChat?.sidebar.root
      .querySelector('.ag-turn-interrupted-text')?.textContent ?? null);
    assert(stoppedRow === NOTICE, `The chat shows why it stopped (${stoppedRow})`);
    assertNoTrapPageErrors(page, 'after recovery');
  });
} finally {
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(fixtureRoot);
}
