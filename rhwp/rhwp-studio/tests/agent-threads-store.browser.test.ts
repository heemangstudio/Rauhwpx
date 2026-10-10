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
