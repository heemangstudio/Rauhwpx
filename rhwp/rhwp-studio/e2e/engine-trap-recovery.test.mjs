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
 * 2. 두 문서: 에이전트가 일하던 문서는 뒤의 세션으로, 보던 문서는 화면에 돌아오고, 멈춘 채팅에는
 *    중단 안내가 남는다. 이어서 다시 여는 도중 또 멈추면 그 문서는 다음 복구에서 자동으로 열지 않고
 *    결과에서 직접 열 수 있다.
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
const NOTICE = '문서 엔진이 멈춰 이 작업이 중단되었습니다.';

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
    runTest, assert, screenshot, sampleFetchPath, waitForState, clickEditArea,
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
    const trapErrors = (page.__pageErrors ?? []).slice(errorsBefore).filter((text) => /EngineTrapped|ENGINE_TRAPPED/.test(text));
    assert(trapErrors.length === 0, `Command-state refresh after the trap does not call the stopped engine (${trapErrors[0] ?? 'no errors'})`);
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
    const notice = await page.evaluate(async (threadId) => {
      const { getThread } = await import('/src/agent/threads.ts');
      return getThread(threadId)?.messages.at(-1) ?? null;
    }, threadA);
    assert(notice?.role === 'system' && notice.text.startsWith(NOTICE), `The interrupted chat says why it stopped (${notice?.text})`);
    assert(await linkedToFile(page, DOC_A) && await linkedToFile(page, DOC_B), 'Both documents are linked to their files');
    assert(!(await genericRecoveryToastShown(page)), 'The generic autosave notice does not appear');
    await screenshot(page, 'trap-recovery-4-two-documents-back');

    // 다시 여는 도중 B 가 또 엔진을 멈추게 한다 (B 파일을 읽을 때 모의 trap).
    await page.evaluateOnNewDocument((name) => {
      const original = FileSystemFileHandle.prototype.getFile;
      FileSystemFileHandle.prototype.getFile = async function getFileWithTrap(...args) {
        if (this.name === name && sessionStorage.getItem('e2e-trap-on-open') === 'armed') {
          sessionStorage.setItem('e2e-trap-on-open', 'fired');
          const { reportEngineTrap } = await import('/src/core/engine-trap.ts');
          console.log(`[e2e] simulated engine trap while reopening ${name}`);
          reportEngineTrap(new WebAssembly.RuntimeError('unreachable'));
        }
        return original.apply(this, args);
      };
    }, DOC_B);
    await page.evaluate(() => sessionStorage.setItem('e2e-trap-on-open', 'armed'));
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
  });
} finally {
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(fixtureRoot);
}
