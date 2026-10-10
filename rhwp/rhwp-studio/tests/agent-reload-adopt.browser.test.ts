/**
 * 새로고침 뒤 사이드바는 허브가 아직 돌리는 이 창의 채팅을 다시 시작하지 않고 잇는다.
 *
 * 실제 initAgentSidebar 와 미리보기의 모의 브리지(시작·멈춤·중단 횟수를 센다)를 브라우저에서
 * 돌린다. 스레드는 앞 페이지가 IndexedDB 에 저장해 두고, 페이지를 새로 불러 허브의 첫 답(welcome)과
 * 저장소 준비 순서를 양쪽으로 맞춰 본다.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import puppeteer, { type Page } from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

const LIVE = 'reload-live-chat';
const RECENT = 'reload-recent-chat';
const OTHER_DOC = 'reload-other-document-chat';
const DOC_A = { documentId: 'doc-a', documentName: '제안서.hwpx' };
const DOC_B = { documentId: 'doc-b', documentName: '회의록.hwpx' };
const DOC_C = { documentId: 'doc-c', documentName: '예산.hwpx' };
const OTHER_TEXT = '현장 인터뷰 일정\n다시 확인';

type Order = 'welcome-first' | 'hydration-first';
interface MountOptions {
  live: string;
  question: boolean;
  order: Order | 'manual';
  document: { documentId: string | null; documentName: string | null };
}

/** 앞 페이지: 저장소를 비우고 세 채팅을 저장한 뒤 새로 불러온다. */
async function seedAndReload(page: Page, origin: string, withQuestion: boolean): Promise<void> {
  await page.goto(`${origin}/tests/fixtures/agent-sidebar-harness.html`);
  await page.evaluate(async (ids, docs, question) => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((done, fail) => {
      const request = indexedDB.deleteDatabase('rhwpAgentThreads');
      request.onsuccess = () => done();
      request.onerror = () => fail(request.error);
    });
    const threads = await import('/src/agent/threads.ts');
    const fixtures = await import('/src/sidebar-preview/fixtures.ts');
    const now = Date.now();
    const chat = (id: string, doc: { documentId: string; documentName: string }, text: string, age: number) => ({
      ...threads.createEmptyThread({ agent: 'claude', model: 'claude-sonnet-4-6', effort: 'medium', docKey: doc.documentName, documentId: doc.documentId }),
      id,
      title: text,
      updatedAt: now - age,
      messages: [{ role: 'user' as const, text }],
    });
    const live = chat(ids.live, docs.a, 'Live request kept running', 60 * 60_000);
    if (question) {
      const interaction = { ...fixtures.sampleReloadQuestion(), threadId: ids.live };
      live.pendingUserQuestion = { ...fixtures.sampleReloadQuestionDraft(now), interaction };
    }
    // 같은 문서의 더 최근 채팅 — "마지막 채팅 복원"이면 이 채팅을 열었을 것이다.
    threads.upsertThread(chat(ids.recent, docs.a, 'Most recent request', 60_000));
    threads.upsertThread(live);
    threads.upsertThread(chat(ids.otherDoc, docs.b, 'Other document request', 30 * 60_000));
    await threads.waitForThreadsPersistence();
    // upsertThread 는 저장 순서대로 활동 시각을 매긴다 — 가장 최근 채팅이 따로 있게 다시 저장한다.
    threads.upsertThread({ ...threads.getThread(ids.recent)!, messages: [...threads.getThread(ids.recent)!.messages, { role: 'assistant', text: 'Recent reply' }] });
    await threads.waitForThreadsPersistence();
  }, { live: LIVE, recent: RECENT, otherDoc: OTHER_DOC }, { a: DOC_A, b: DOC_B }, withQuestion);
  await page.reload();
}

/** 새로 불러온 페이지: 실제 사이드바를 모의 브리지로 띄운다. */
async function mount(page: Page, options: MountOptions): Promise<void> {
  await page.evaluate(async (opts, otherText) => {
    // welcome 이 먼저 오는 순서: 저장소 준비(IndexedDB 열기)를 welcome 뒤로 미룬다.
    let releaseStore = () => {};
    if (opts.order === 'welcome-first') {
      const gate = new Promise<void>((done) => { releaseStore = done; });
      const realOpen = IDBFactory.prototype.open;
      const onsuccess = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!;
      IDBFactory.prototype.open = function open(this: IDBFactory, name: string, version?: number) {
        const request = realOpen.call(this, name, version);
        if (name !== 'rhwpAgentThreads') return request;
        Object.defineProperty(request, 'onsuccess', {
          configurable: true,
          get: () => onsuccess.get!.call(request),
          set: (handler: ((event: Event) => void) | null) => onsuccess.set!.call(request, handler
            ? (event: Event) => { void gate.then(() => handler.call(request, event)); }
            : null),
        });
        return request;
      };
    }
    const { completeInitialSetup } = await import('/src/ui/initial-setup/state.ts');
    completeInitialSetup({ providerStep: 'configured', calibrationStep: 'skipped' });
    const { initAgentSidebar } = await import('/src/ui/agent-sidebar/index.ts');
    const { createMockBridge } = await import('/src/sidebar-preview/mock-bridge.ts');
    const { EventBus } = await import('/src/core/event-bus.ts');
    const threads = await import('/src/agent/threads.ts');
    const fixtures = await import('/src/sidebar-preview/fixtures.ts');
    const doc = { ...opts.document };
    const eventBus = new EventBus();
    const question = opts.question ? { ...fixtures.sampleReloadQuestion(), threadId: opts.live } : undefined;
    const mock = createMockBridge(() => {}, undefined, {
      liveChat: { threadId: opts.live, agent: 'claude', question, deferWelcome: true },
    });
    const sidebar = initAgentSidebar({
      bridge: mock.bridge,
      eventBus,
      getDocumentContext: () => ({ ...doc, selectionLabel: null }),
    });
    mock.boot();
    const threadCount = () => threads.listThreads().length;
    Object.assign(window, { harness: { mock, sidebar, eventBus, doc, threads, threadCount, otherText } });
    if (opts.order === 'welcome-first') {
      mock.deliverWelcome();
      releaseStore();
    } else if (opts.order === 'hydration-first') {
      await threads.waitForThreadsPersistence();
      mock.deliverWelcome();
    }
  }, options, OTHER_TEXT);
}

const counts = (page: Page) => page.evaluate(() => {
  const { chatStarts, stops, interrupts } = (window as any).harness.mock.snapshot();
  return { starts: chatStarts.length, stops, interrupts };
});

/** 사이드바가 시작 채팅을 고르고(저장소·허브 답) 한 박자 쉰 뒤의 화면. */
async function settled(page: Page, threadId: string | null): Promise<void> {
  await page.waitForFunction(async (id) => {
    const { harness } = window as any;
    await harness.threads.waitForThreadsPersistence();
    return harness.sidebar.currentThreadId() === id
      && document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true';
  }, { timeout: 10_000 }, threadId);
  await page.evaluate(() => new Promise((done) => setTimeout(done, 150)));
}

test('reload re-adopts the live chat in both arrival orders without restarting it', { timeout: 120_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    root: resolve(import.meta.dirname, '..'),
    server: { port: 0, open: false, hmr: false },
    // 앱 진입점(index.html)은 WASM 이 필요하다 — 이 테스트 페이지만 훑는다.
    optimizeDeps: { entries: ['tests/fixtures/agent-sidebar-harness.html'] },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;

    for (const order of ['welcome-first', 'hydration-first'] as const) {
      for (const question of [false, true]) {
        const label = `${order} ${question ? 'question' : 'running'}`;
        await seedAndReload(page, origin, question);
        await mount(page, { live: LIVE, question, order, document: DOC_A });
        await settled(page, LIVE);
        assert.deepEqual(await counts(page), { starts: 0, stops: 0, interrupts: 0 }, `${label}: no restart`);
        const view = await page.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>('.ag-input')!;
          return {
            request: document.querySelector('.ag-msg-user')?.textContent,
            stop: Boolean(document.querySelector('.ag-send.ag-stop')),
            questionStop: Boolean(document.querySelector('.ag-user-question[data-inactive="false"] .ag-question-stop')),
            running: (window as any).harness.mock.bridge.isTurnRunning(),
            step: document.querySelector('.ag-user-question[data-inactive="false"] .ag-question-step')?.textContent ?? null,
            value: input.value,
            label: input.getAttribute('aria-label'),
            anchored: Boolean(document.querySelector('.ag-messages > .ag-question-timeline-anchor')),
            systemLines: [...document.querySelectorAll('.ag-msg-system')].map((node) => node.textContent),
          };
        });
        assert.equal(view.request, 'Live request kept running', `${label}: the live chat, not the most recent one`);
        assert.equal(view.running, true, `${label}: the turn keeps running`);
        assert.deepEqual(view.systemLines, [], `${label}: no error line`);
        if (question) {
          assert.equal(view.step, '2/2', `${label}: the question returns at its step`);
          assert.equal(view.value, OTHER_TEXT, `${label}: the typed answer returns`);
          assert.equal(view.label, '현재 질문의 직접 답변', `${label}: the composer answers the question`);
          assert.equal(view.anchored, true, `${label}: the question keeps its transcript position`);
          assert.equal(view.questionStop, true, `${label}: the question card can stop the turn`);
        } else {
          assert.equal(view.stop, true, `${label}: the composer offers Stop for the running turn`);
          assert.equal(view.step, null);
        }
      }
    }

    // (g) 살아 있는 턴의 문서가 아직 열리지 않았다 — 기다렸다가, 그 문서가 열리면 잇는다.
    await seedAndReload(page, origin, false);
    await mount(page, { live: OTHER_DOC, question: false, order: 'hydration-first', document: { documentId: null, documentName: null } });
    await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    const before = await page.evaluate(() => (window as any).harness.threadCount());
    await page.evaluate(() => {
      const { mock } = (window as any).harness;
      mock.streamEvent({ type: 'text-delta', agent: 'claude', text: 'Orphan output that belongs to 회의록.' });
      // 재연결도 붙이지 않은 턴을 초안의 진행 중으로 보이게 하지 않는다(초안의 중지가 그 턴을 끊는다).
      mock.setConnection('connected');
    });
    await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    assert.equal(await page.$('.ag-send.ag-stop'), null, 'the draft does not offer to stop a turn it does not show');
    await page.evaluate(() => {
      (window as any).harness.mock.streamEvent({ type: 'turn-end', agent: 'claude', stopReason: 'end_turn' });
    });
    await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    assert.deepEqual(await page.evaluate(() => ({
      current: (window as any).harness.sidebar.currentThreadId(),
      assistant: document.querySelectorAll('.ag-msg-assistant').length,
      threads: (window as any).harness.threadCount(),
    })), { current: null, assistant: 0, threads: before }, 'the unbound turn is not drawn into or saved as the draft');
    assert.deepEqual(await counts(page), { starts: 0, stops: 0, interrupts: 0 }, 'waiting for the document stops nothing');
    // 앞의 turn-end 로 턴은 끝났다 — 다시 돌리고(허브가 여전히 돈다) 문서를 연다.
    await page.evaluate(() => {
      const { mock, doc, eventBus } = (window as any).harness;
      mock.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'preview-turn-2' });
      Object.assign(doc, { documentId: 'doc-b', documentName: '회의록.hwpx' });
      eventBus.emit('document-context-changed');
    });
    await settled(page, OTHER_DOC);
    assert.deepEqual(await counts(page), { starts: 0, stops: 0, interrupts: 0 }, 'opening the document adopts its live chat');

    // (h) 다른 문서가 화면에 있다 — 고칠 문서가 없는 턴은 한 번 멈춘다.
    await seedAndReload(page, origin, false);
    await mount(page, { live: OTHER_DOC, question: false, order: 'hydration-first', document: DOC_C });
    await settled(page, null);
    assert.deepEqual(await counts(page), { starts: 0, stops: 1, interrupts: 0 });
    assert.equal(await page.evaluate(() => (window as any).harness.mock.bridge.getHubChat()), null);

    // (i) 문서가 허브의 답보다 먼저 열린다 — 새 채팅을 시작하지 않고 기다렸다가 잇는다.
    await seedAndReload(page, origin, false);
    await mount(page, { live: LIVE, question: false, order: 'manual', document: { documentId: null, documentName: null } });
    await page.evaluate(async () => {
      const { doc, eventBus, threads, mock } = (window as any).harness;
      await threads.waitForThreadsPersistence();
      Object.assign(doc, { documentId: 'doc-a', documentName: '제안서.hwpx' });
      eventBus.emit('document-context-changed');
      await new Promise((done) => setTimeout(done, 100));
      mock.deliverWelcome();
    });
    await settled(page, LIVE);
    assert.deepEqual(await counts(page), { starts: 0, stops: 0, interrupts: 0 }, 'an early document does not start a chat over the live one');

    // (j) 사용자가 문서에 쓰는 중에 이어 붙인 질문은 띠로 미뤄 초점과 글을 빼앗지 않고, 쓰기를 멈추면 열린다.
    await seedAndReload(page, origin, true);
    await page.evaluate(() => {
      const field = document.createElement('textarea');
      field.className = 'harness-document-input';
      document.body.prepend(field);
    });
    await mount(page, { live: LIVE, question: true, order: 'manual', document: DOC_A });
    await page.evaluate(() => (window as any).harness.threads.waitForThreadsPersistence());
    await page.focus('.harness-document-input');
    await page.keyboard.type('문서에 쓰는 중', { delay: 40 });
    await page.evaluate(() => (window as any).harness.mock.deliverWelcome());
    await page.keyboard.type(' 계속', { delay: 40 });
    await settled(page, LIVE);
    assert.deepEqual(await page.evaluate(() => ({
      held: document.querySelector('.ag-user-question')?.getAttribute('data-held'),
      focused: document.activeElement?.className,
      typed: document.querySelector<HTMLTextAreaElement>('.harness-document-input')!.value,
    })), { held: 'true', focused: 'harness-document-input', typed: '문서에 쓰는 중 계속' },
    'a question adopted while the user types waits as a strip');
    await page.waitForFunction(() => document.querySelector('.ag-user-question[data-inactive="false"]:not([data-held]) .ag-question-step')?.textContent === '2/2',
      { timeout: 5_000 });
    assert.deepEqual(await page.evaluate(() => ({
      composer: document.querySelector<HTMLTextAreaElement>('.ag-input')!.value,
      focused: document.activeElement?.className,
    })), { composer: OTHER_TEXT, focused: 'harness-document-input' });
    assert.deepEqual(await counts(page), { starts: 0, stops: 0, interrupts: 0 });

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
