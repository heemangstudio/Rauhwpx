/**
 * 채팅 저장소(IndexedDB) — 한 번 읽어 들인 뒤의 저장은 저장소 전체를 다시 읽지 않고, 다른 탭의
 * 변경은 BroadcastChannel 로 받는다.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import puppeteer, { type Page } from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

const HARNESS = '/tests/fixtures/agent-sidebar-harness.html';
/** threads.ts 의 MAX_THREADS — 넘치면 가장 오래된 채팅을 지운다. */
const MAX_THREADS = 40;

async function openStore(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}${HARNESS}`);
  await page.evaluate(async () => {
    const threads = await import('/src/agent/threads.ts');
    await threads.waitForThreadsPersistence();
    Object.assign(window, { threads });
  });
}

test('thread writes after hydration keep evicted chats gone and still sync across tabs', { timeout: 60_000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const server = await createServer({
    root,
    configFile: false,
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false },
    optimizeDeps: { entries: [HARNESS.slice(1)] },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    const tabA = await browser.newPage();
    await tabA.goto(`${origin}${HARNESS}`);
    await tabA.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((done, fail) => {
        const request = indexedDB.deleteDatabase('rhwpAgentThreads');
        request.onsuccess = () => done();
        request.onerror = () => fail(request.error);
      });
    });
    await openStore(tabA, origin);

    // 저장소를 가득 채운다 — 처음 쓴 채팅이 가장 오래됐다.
    const oldest = await tabA.evaluate(async (max) => {
      const { threads } = window as any;
      const ids: string[] = [];
      for (let i = 0; i < max; i += 1) {
        const thread = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
        thread.messages = [{ role: 'user', text: `chat ${i}` }];
        threads.upsertThread(thread);
        ids.push(thread.id);
        // 저장 시각이 겹치지 않게 한다 — 같은 밀리초면 어느 채팅이 가장 오래됐는지 정해지지 않는다.
        await new Promise((done) => setTimeout(done, 3));
      }
      await threads.waitForThreadsPersistence();
      return ids[0];
    }, MAX_THREADS);

    // 한 개 더 쓰면 가장 오래된 채팅이 밀려난다. 목록은 그 채팅을 다시 보여 주지 않는다.
    const eviction = await tabA.evaluate(async (evicted) => {
      const { threads } = window as any;
      const seen: string[][] = [];
      const off = threads.subscribeThreadChanges(() => {
        seen.push(threads.listThreads().map((thread: { id: string }) => thread.id));
      });
      const newest = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
      newest.messages = [{ role: 'user', text: 'one more chat' }];
      threads.upsertThread(newest);
      await threads.waitForThreadsPersistence();
      off();
      return {
        resurrected: seen.filter((ids) => ids.includes(evicted)).length,
        notifications: seen.length,
        finalCount: threads.listThreads().length,
        stillThere: Boolean(threads.getThread(evicted)),
      };
    }, oldest);
    assert.equal(eviction.resurrected, 0, '밀려난 채팅이 저장 도중 목록에 되살아나지 않는다');
    assert.ok(eviction.notifications >= 1);
    assert.equal(eviction.finalCount, MAX_THREADS);
    assert.equal(eviction.stillThere, false);

    // 모듈을 거치지 않고 레거시 localStorage 에 쓴 채팅은 다시 읽기를 부르면 나타나고 IndexedDB 로 옮겨진다.
    // 그 사이 저장소 준비를 기다리는 쪽은 다시 읽기가 끝난 뒤에 풀린다.
    const legacy = await tabA.evaluate(async () => {
      const { threads } = window as any;
      const seeded = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
      seeded.messages = [{ role: 'user', text: 'seeded outside the store' }];
      seeded.updatedAt = Date.now() + 60_000;
      localStorage.setItem('rhwp-agent-threads', JSON.stringify([seeded]));
      const reloading = threads.reloadThreadsFromStorage();
      await threads.waitForThreadsPersistence();
      const seenByWaiter = Boolean(threads.getThread(seeded.id));
      await reloading;
      return { id: seeded.id, seenByWaiter, migrated: localStorage.getItem('rhwp-agent-threads') === null };
    });
    assert.deepEqual({ seenByWaiter: legacy.seenByWaiter, migrated: legacy.migrated }, { seenByWaiter: true, migrated: true });
    await tabA.evaluate(async (id) => {
      const { threads } = window as any;
      threads.removeThread(id);
      await threads.waitForThreadsPersistence();
    }, legacy.id);

    // 두 번째 탭: 같은 저장소를 읽고, 두 탭의 쓰기·지우기가 서로에게 전해진다.
    const tabB = await browser.newPage();
    await openStore(tabB, origin);
    const fromA = await tabA.evaluate(async () => {
      const { threads } = window as any;
      const thread = threads.createEmptyThread({ agent: 'codex', model: 'gpt', effort: 'medium' });
      thread.messages = [{ role: 'user', text: 'written in tab A' }];
      threads.upsertThread(thread);
      await threads.waitForThreadsPersistence();
      return thread.id;
    });
    await tabB.waitForFunction((id) => (window as any).threads.getThread(id)?.messages[0]?.text === 'written in tab A', { timeout: 5_000 }, fromA);
    const fromB = await tabB.evaluate(async () => {
      const { threads } = window as any;
      const thread = threads.createEmptyThread({ agent: 'codex', model: 'gpt', effort: 'medium' });
      thread.messages = [{ role: 'user', text: 'written in tab B' }];
      threads.upsertThread(thread);
      await threads.waitForThreadsPersistence();
      return thread.id;
    });
    await tabA.waitForFunction((id) => Boolean((window as any).threads.getThread(id)), { timeout: 5_000 }, fromB);
    await tabB.evaluate(async (id) => {
      const { threads } = window as any;
      threads.removeThread(id);
      await threads.waitForThreadsPersistence();
    }, fromA);
    await tabA.waitForFunction((id) => !(window as any).threads.getThread(id), { timeout: 5_000 }, fromA);

    // 앞 탭이 다시 써도 다른 탭의 채팅을 지우지 않고, 지운 채팅을 되살리지 않는다.
    await tabA.evaluate(async (id) => {
      const { threads } = window as any;
      const thread = threads.getThread(id);
      threads.upsertThread({ ...thread, messages: [...thread.messages, { role: 'assistant', text: 'reply in tab A' }] });
      await threads.waitForThreadsPersistence();
    }, fromB);
    const reopened = await browser.newPage();
    await openStore(reopened, origin);
    assert.deepEqual(await reopened.evaluate((ids) => {
      const { threads } = window as any;
      return {
        fromA: Boolean(threads.getThread(ids.fromA)),
        fromB: threads.getThread(ids.fromB)?.messages.map((message: { text: string }) => message.text) ?? null,
        count: threads.listThreads().length,
      };
    }, { fromA, fromB }), {
      fromA: false,
      fromB: ['written in tab B', 'reply in tab A'],
      // 두 탭의 새 채팅은 한도 안에서 가장 오래된 채팅을 밀어냈고, 지운 채팅 하나만큼 줄었다.
      count: MAX_THREADS - 1,
    });
  } finally {
    await browser.close();
    await server.close();
  }
});

test('reading one chat copies only that chat, so it costs the same however many large chats are stored', { timeout: 120_000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const server = await createServer({
    root,
    configFile: false,
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false },
    optimizeDeps: { entries: [HARNESS.slice(1)] },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    const page = await browser.newPage();
    await page.goto(`${origin}${HARNESS}`);
    await page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((done, fail) => {
        const request = indexedDB.deleteDatabase('rhwpAgentThreads');
        request.onsuccess = () => done();
        request.onerror = () => fail(request.error);
      });
    });
    await openStore(page, origin);
    const timings = await page.evaluate(async (max) => {
      const { threads } = window as any;
      /** 도구 기록이 든 턴 40개 — 채팅 하나가 수백 KB 다. */
      const large = (label: string) => {
        const thread = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
        thread.title = label;
        for (let turn = 0; turn < 40; turn += 1) {
          thread.messages.push({ role: 'user', text: `요청 ${turn} ${'u'.repeat(200)}` });
          thread.messages.push({
            role: 'assistant', kind: 'activity', activityId: `a${turn}`, status: 'completed', startedAt: 1, completedAt: 2, text: '',
            tools: Array.from({ length: 8 }, (_, call) => ({
              callId: `c${turn}-${call}`, tool: 'mcp__rhwp__apply_edits', status: 'completed', elapsedMs: 10,
              argsJson: JSON.stringify({ edits: [{ text: 'x'.repeat(500) }] }), resultPreview: 'ok '.repeat(100),
            })),
          });
          thread.messages.push({ role: 'assistant', text: `완료 ${turn} ${'a'.repeat(1500)}` });
        }
        return thread;
      };
      const read = (id: string) => {
        let best = Infinity;
        for (let run = 0; run < 5; run += 1) {
          const started = performance.now();
          const thread = threads.getThread(id);
          best = Math.min(best, performance.now() - started);
          if (thread?.messages.length !== 120) throw new Error('getThread lost the chat');
        }
        return best;
      };
      const target = large('target');
      threads.upsertThread(target);
      await threads.waitForThreadsPersistence();
      const alone = read(target.id);
      for (let i = 1; i < max; i += 1) threads.upsertThread(large(`other ${i}`));
      await threads.waitForThreadsPersistence();
      const crowded = read(target.id);
      // 돌려준 복사본을 고쳐도 저장된 채팅은 그대로다.
      const copy = threads.getThread(target.id);
      copy.messages.length = 0;
      copy.title = 'changed';
      const again = threads.getThread(target.id);
      return { alone, crowded, stored: threads.listThreads().length, isolated: again.title === 'target' && again.messages.length === 120 };
    }, MAX_THREADS);
    assert.equal(timings.stored, MAX_THREADS);
    assert.equal(timings.isolated, true, 'getThread returns a copy');
    assert.ok(timings.crowded <= timings.alone * 4 + 15,
      `getThread took ${timings.crowded.toFixed(1)} ms with ${MAX_THREADS} chats vs ${timings.alone.toFixed(1)} ms alone`);
  } finally {
    await browser.close();
    await server.close();
  }
});

/** 비운 저장소를 연 탭 하나로 시험한다. openTab 은 같은 저장소를 읽은 새 탭을 연다. */
async function withFreshStore(run: (page: Page, openTab: () => Promise<Page>) => Promise<void>): Promise<void> {
  const root = resolve(import.meta.dirname, '..');
  const server = await createServer({
    root,
    configFile: false,
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false },
    optimizeDeps: { entries: [HARNESS.slice(1)] },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
    const page = await browser.newPage();
    await page.goto(`${origin}${HARNESS}`);
    await page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((done, fail) => {
        const request = indexedDB.deleteDatabase('rhwpAgentThreads');
        request.onsuccess = () => done();
        request.onerror = () => fail(request.error);
      });
    });
    await openStore(page, origin);
    await run(page, async () => {
      const tab = await browser.newPage();
      await openStore(tab, origin);
      return tab;
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

test('back-to-back saves of one chat are written once with the newest content, and deletes still win', { timeout: 60_000 }, async () => {
  await withFreshStore(async (page, openTab) => {
    const other = await openTab();
    const result = await page.evaluate(async () => {
      const { threads } = window as any;
      const puts: string[] = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: any, key?: IDBValidKey) {
        if (this.name === 'threads') puts.push(value.id);
        return put.call(this, value, key);
      };
      const make = (text: string) => {
        const thread = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
        thread.messages = [{ role: 'user', text }];
        return thread;
      };
      // 한 턴 안의 저장처럼 같은 채팅을 잇달아 저장한다. 메모리의 채팅은 저장마다 곧바로 바뀐다.
      const burst = make('step 0');
      const seenRightAway: number[] = [];
      for (let step = 1; step < 10; step += 1) {
        burst.messages.push({ role: 'assistant', text: `step ${step}` });
        threads.upsertThread(burst);
        seenRightAway.push(threads.getThread(burst.id)?.messages.length ?? 0);
      }
      // 저장했다가 곧바로 지운 채팅은 남지 않고, 지운 뒤 다시 저장한 채팅은 남는다.
      const gone = make('deleted right away');
      threads.upsertThread(gone);
      threads.removeThread(gone.id);
      const revived = make('saved again after delete');
      threads.upsertThread(revived);
      threads.removeThread(revived.id);
      threads.upsertThread({ ...revived, messages: [...revived.messages, { role: 'assistant', text: 'back' }] });
      await threads.waitForThreadsPersistence();
      IDBObjectStore.prototype.put = put;
      return {
        ids: { burst: burst.id, gone: gone.id, revived: revived.id },
        burstWrites: puts.filter((id) => id === burst.id).length,
        seenRightAway,
      };
    });
    assert.deepEqual(result.seenRightAway, [2, 3, 4, 5, 6, 7, 8, 9, 10], 'every save updates the in-memory chat at once');
    assert.equal(result.burstWrites, 1, 'queued saves of the same chat collapse into one IndexedDB write');
    // 다른 창은 저장마다 알림을 받아 마지막 내용을 본다.
    await other.waitForFunction((id) => (window as any).threads.getThread(id)?.messages.length === 10, { timeout: 5_000 }, result.ids.burst);
    const reopened = await openTab();
    assert.deepEqual(await reopened.evaluate((ids) => {
      const { threads } = window as any;
      return {
        burst: threads.getThread(ids.burst)?.messages.map((message: { text: string }) => message.text) ?? null,
        gone: threads.hasThread(ids.gone),
        revived: threads.getThread(ids.revived)?.messages.length ?? 0,
      };
    }, result.ids), {
      burst: Array.from({ length: 10 }, (_, step) => `step ${step}`),
      gone: false,
      revived: 2,
    });
  });
});

test('rail and archive listings copy no conversations and match the full listings', { timeout: 60_000 }, async () => {
  await withFreshStore(async (page) => {
    const result = await page.evaluate(async () => {
      const { threads } = window as any;
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const thread = threads.createEmptyThread({ agent: i % 2 ? 'codex' : 'claude', model: 'm', effort: 'medium' });
        thread.title = `chat ${i}`;
        thread.documentId = i === 0 ? 'doc-1' : null;
        thread.docKey = i === 0 ? 'a.hwpx' : null;
        thread.messages = [{ role: 'user', text: 'x'.repeat(10_000) }];
        threads.upsertThread(thread);
        ids.push(thread.id);
        await new Promise((done) => setTimeout(done, 3));
      }
      threads.pinThread(ids[1]);
      threads.archiveThread(ids[2]);
      await threads.waitForThreadsPersistence();
      let copies = 0;
      const clone = window.structuredClone;
      window.structuredClone = ((value: any, options?: StructuredSerializeOptions) => {
        if (value && Array.isArray(value.messages)) copies += 1;
        return clone(value, options);
      }) as typeof structuredClone;
      const summaries = threads.listThreadSummaries();
      const archived = threads.listArchivedThreadSummaries();
      const present = threads.hasThread(ids[0]);
      const link = threads.getThreadLink(ids[0]);
      const listingCopies = copies;
      window.structuredClone = clone;
      const pick = (thread: any) => ({ id: thread.id, title: thread.title, pinOrder: thread.pinOrder, docKey: thread.docKey });
      return {
        listingCopies,
        withMessages: [...summaries, ...archived].filter((summary: object) => 'messages' in summary).length,
        summaries: summaries.map(pick),
        full: threads.listThreads().map(pick),
        archived: archived.map(pick),
        fullArchived: threads.listArchivedThreads().map(pick),
        present,
        link,
      };
    });
    assert.equal(result.listingCopies, 0, 'listing and link reads do not deep-copy any stored chat');
    assert.equal(result.withMessages, 0);
    assert.equal(result.summaries.length, 3);
    assert.deepEqual(result.summaries, result.full);
    assert.equal(result.archived.length, 1);
    assert.deepEqual(result.archived, result.fullArchived);
    assert.equal(result.present, true);
    assert.equal(result.link.documentId, 'doc-1');
    assert.equal(result.link.docKey, 'a.hwpx');
  });
});

test('the settings archive list stays untouched while hidden and is current when opened or shown', { timeout: 60_000 }, async () => {
  await withFreshStore(async (page) => {
    const result = await page.evaluate(async () => {
      const { threads } = window as any;
      const { createArchiveSettingsPane } = await import('/src/ui/agent-sidebar/settings-archive.ts');
      let shown = false;
      const pane = createArchiveSettingsPane({ deleteThread: async () => false, isShown: () => shown });
      document.body.append(pane.element);
      const rows = () => [...pane.element.querySelectorAll('.ag-archive-title')].map((node) => node.textContent);
      const make = (title: string) => {
        const thread = threads.createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium' });
        thread.title = title;
        thread.messages = [{ role: 'user', text: title }];
        threads.upsertThread(thread);
        return thread;
      };
      const first = make('first');
      threads.archiveThread(first.id);
      // 숨은 보관함은 저장마다 다시 그리지 않는다.
      let mutations = 0;
      const observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(pane.element, { childList: true, subtree: true, attributes: true });
      const busy = make('busy');
      for (let i = 0; i < 5; i += 1) {
        busy.messages.push({ role: 'assistant', text: `reply ${i}` });
        threads.upsertThread(busy);
      }
      await new Promise((done) => setTimeout(done, 0));
      const hiddenMutations = mutations;
      observer.disconnect();
      // 열면 그사이 보관한 채팅이 보인다.
      shown = true;
      pane.open();
      const opened = rows();
      // 보이는 동안에는 저장소의 변경을 곧바로 따른다.
      const second = make('second');
      threads.archiveThread(second.id);
      const afterArchive = rows();
      pane.element.querySelector<HTMLButtonElement>(`[data-thread-id="${first.id}"] .ag-archive-restore`)!.click();
      const afterRestore = rows();
      await threads.waitForThreadsPersistence();
      return {
        hiddenMutations,
        opened,
        afterArchive,
        afterRestore,
        restoredListed: threads.listThreadSummaries().some((thread: { id: string }) => thread.id === first.id),
      };
    });
    assert.equal(result.hiddenMutations, 0, 'saves while the archive is hidden do not rebuild it');
    assert.deepEqual(result.opened, ['first']);
    assert.deepEqual(result.afterArchive, ['second', 'first']);
    assert.deepEqual(result.afterRestore, ['second']);
    assert.equal(result.restoredListed, true);
  });
});
