import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

// 스냅샷 기록이 실패해도 기존 스냅샷을 먼저 지우면 안 되고, 실패를 성공으로 알리면 안 된다.
test('문서 이력 스냅샷 기록 실패는 기존 스냅샷을 지우지 않고 실패로 알린다', { timeout: 60_000 }, async () => {
  const executablePath = browserExecutable();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('hamaeditorDocHistory');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      const store = await import('/src/history/idb-store.ts');
      const snapshot = { label: 'x', paragraphs: [] } as never;
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const ids: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        ids.push((await store.saveHistoryIrSnapshot(`s${i}`, 'doc.hwpx', snapshot)).id);
        await sleep(2);
      }

      const originalPut = IDBObjectStore.prototype.put;
      const outcomes: Record<string, { rejected: boolean; ids: string[] }> = {};
      const attempt = async (name: string) => {
        let rejected = false;
        try {
          await store.saveHistoryIrSnapshot(name, 'doc.hwpx', snapshot);
        } catch {
          rejected = true;
        }
        outcomes[name] = { rejected, ids: (await store.listHistoryMeta()).map((row) => row.id) };
      };

      // 1) 요청 단계에서 할당량 초과.
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if (this.name === 'historyBlobs') throw new DOMException('quota', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      await attempt('sync-quota');
      // 2) 커밋 단계에서 트랜잭션 중단.
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        const request = originalPut.apply(this, args);
        if (this.name === 'historyBlobs') this.transaction.abort();
        return request;
      };
      await attempt('commit-abort');
      IDBObjectStore.prototype.put = originalPut;

      const saved = await store.saveHistoryIrSnapshot('after', 'doc.hwpx', snapshot);
      const afterIds = (await store.listHistoryMeta()).map((row) => row.id);

      // 3) 이번 세션에서 IndexedDB 를 열지 못해 메모리에만 저장한 스냅샷도 목록에 보인다.
      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function () { throw new Error('blocked'); };
      const memoryOnly = await store.saveHistoryIrSnapshot('memory', 'doc.hwpx', snapshot);
      IDBFactory.prototype.open = originalOpen;
      const mergedIds = (await store.listHistoryMeta()).map((row) => row.id);

      return { ids, outcomes, savedId: saved.id, afterIds, memoryId: memoryOnly.id, mergedIds };
    });

    for (const name of ['sync-quota', 'commit-abort']) {
      const outcome = result.outcomes[name];
      assert.equal(outcome.rejected, true, `${name}: 기록 실패를 성공으로 알리면 안 된다`);
      assert.deepEqual(new Set(outcome.ids), new Set(result.ids), `${name}: 가장 오래된 스냅샷까지 그대로 남아야 한다`);
    }
    assert.equal(result.afterIds.length, 24, '정상 기록은 한도를 지킨다');
    assert.ok(result.afterIds.includes(result.savedId));
    assert.ok(!result.afterIds.includes(result.ids[0]), '한도를 넘으면 가장 오래된 한 개만 지운다');
    assert.deepEqual(new Set(result.afterIds), new Set([...result.ids.slice(1), result.savedId]));
    assert.ok(result.mergedIds.includes(result.memoryId), '메모리에만 있는 스냅샷도 목록에 보인다');
    assert.equal(result.mergedIds.length, 25);
  } finally {
    await browser?.close();
    await server.close();
  }
});
