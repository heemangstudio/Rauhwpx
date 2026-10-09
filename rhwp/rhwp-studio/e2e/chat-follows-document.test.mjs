/**
 * 채팅을 따라 문서를 옮기는 E2E.
 *
 * 채팅 목록은 문서와 상관없이 한 줄로 선다. 다른 문서의 채팅을 누르면 지금 문서를
 * 저장하고, 버전 기록이 켜져 있으면 커밋한 뒤, 그 문서를 열어 채팅을 잇는다.
 * 저장이 끝난 직후 버전 기록이 저장 지점을 고치는 중이라 커밋이 STALE_WORKSPACE 로
 * 조용히 빠진 적이 있다.
 *
 * 검증:
 *   1. 편집한 문서는 한 번 저장되고 버전 기록에 커밋이 하나 생긴다.
 *   2. 옮겨 간 문서는 다시 쓰지 않는다.
 *   3. 그 문서의 채팅이 현재 채팅이 되고, 읽기 전용이 아니다.
 *
 * 실행: npm run dev 로 Studio(7700)를 띄운 뒤
 *       node e2e/chat-follows-document.test.mjs --mode=headless
 */
import { runTest, assert, sampleFetchPath } from './helpers.mjs';

/** 쓰기를 기록하는 가짜 파일 핸들로 샘플을 연다. 저장본은 다음 getFile 이 돌려준다. */
async function openWithHandle(page, sample, key) {
  const fileName = sample.split('/').pop();
  return page.evaluate(async ({ url, fileName, key }) => {
    const original = new Uint8Array(await (await fetch(url)).arrayBuffer());
    window.__writes = window.__writes || {};
    const writes = (window.__writes[key] = []);
    const handle = {
      kind: 'file', name: fileName,
      async getFile() { return new File([writes.at(-1) ?? original], fileName); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return other === handle; },
      async createWritable() {
        return { async write(blob) { writes.push(new Uint8Array(await new Blob([blob]).arrayBuffer())); }, async close() {}, async abort() {} };
      },
    };
    const requestId = `live-${key}-${Date.now()}`;
    const done = new Promise((resolve) => {
      const off = window.__eventBus.on('open-document-bytes:done', (o) => { if (o.requestId === requestId) { off(); resolve(o); } });
    });
    window.__eventBus.emit('open-document-bytes', { bytes: original, fileName, fileHandle: handle, requestId, skipUnsavedGuard: true });
    const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), 20000))]);
    return { ok: outcome.ok, error: outcome.error };
  }, { url: sampleFetchPath(sample), fileName, key });
}

const sleep = (page, ms) => page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), ms);

await runTest('다른 문서의 채팅을 누르면 저장·커밋 후 그 문서를 열고 채팅을 잇는다', async ({ page }) => {
  const a = await openWithHandle(page, 'hwpx/business_overview.hwpx', 'A');
  assert(a.ok, `A 열기 ${a.error ?? ''}`);
  await sleep(page, 1000);
  const docA = await page.evaluate(() => window.__versionController.getState().documentId);
  assert(Boolean(docA), `A documentId ${docA}`);
  const threadA = await page.evaluate(async (documentId) => {
    const t = await import('/src/agent/threads.ts');
    const th = t.createEmptyThread({ agent: 'claude', model: 'default', effort: 'medium', docKey: 'business_overview.hwpx', documentId });
    th.title = '문서 A 채팅'; th.titleRequested = true;
    th.messages.push({ role: 'user', text: '문서 A 에서 하던 이야기' });
    t.upsertThread(th);
    await t.waitForThreadsPersistence();
    return th.id;
  }, docA);

  const b = await openWithHandle(page, 'biz_plan.hwp', 'B');
  assert(b.ok, `B 열기 ${b.error ?? ''}`);
  await sleep(page, 1200);
  const docB = await page.evaluate(() => window.__versionController.getState().documentId);
  assert(docB && docB !== docA, `B documentId ${docB}`);
  await page.evaluate(async () => { await window.__versionController.enable(); });
  await sleep(page, 500);
  const before = await page.evaluate(() => window.__versionController.getState().commits.length);
  await page.evaluate(() => {
    window.__wasm.insertText(0, 0, 0, '전환전편집');
    window.__eventBus.emit('document-changed', 'live-edit');
  });
  await sleep(page, 600);
  await page.evaluate((docB) => {
    window.__bCommits = [];
    window.__versionController.subscribe((s) => { if (s.documentId === docB) window.__bCommits.push(s.commits.length); });
  }, docB);
  const row = `.ag-threads-item[data-thread-id="${threadA}"]`;
  await page.waitForFunction((sel) => document.querySelector(sel), { timeout: 10000 }, row);
  await page.evaluate((sel) => document.querySelector(sel).click(), row);
  await page.waitForFunction((docA) => window.__versionController.getState().documentId === docA, { timeout: 20000 }, docA);
  await sleep(page, 1500);
  const result = await page.evaluate((threadA) => ({
    bWrites: window.__writes.B.length,
    aWrites: window.__writes.A.length,
    bCommitsSeen: Math.max(0, ...window.__bCommits),
    fileName: window.__wasm.fileName,
    active: document.querySelector('.ag-threads-item.ag-active')?.dataset.threadId ?? null,
    readonly: document.querySelector('.ag-composer')?.classList.contains('ag-readonly'),
    userMsg: [...document.querySelectorAll('.ag-msg-user')].map((n) => n.textContent).join('|'),
    threadA,
  }), threadA);
  assert(result.bWrites === 1, `B 를 한 번 저장 (${result.bWrites})`);
  assert(result.bCommitsSeen === before + 1, `B 에 커밋 하나 (${before} → ${result.bCommitsSeen})`);
  assert(result.aWrites === 0, `A 는 다시 쓰지 않음 (${result.aWrites})`);
  assert(result.fileName === 'business_overview.hwpx', `A 가 열림 (${result.fileName})`);
  assert(result.active === threadA, `A 채팅이 현재 채팅 (${result.active})`);
  assert(result.readonly === false, '입력 가능');
  assert(result.userMsg.includes('문서 A 에서 하던 이야기'), `A 채팅 내용 (${result.userMsg})`);
});
