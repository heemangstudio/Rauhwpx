/**
 * 에이전트 대량 편집 뒤 캔버스 컨텍스트가 복원돼도 보이는 쪽이 다시 그려지는지 검증한다.
 *
 * GPU 프로세스가 재시작하거나 GPU 메모리를 회수하면 Chromium 은 2D 컨텍스트를 잃었다가
 * 빈 비트맵으로 되살리고 contextrestored 를 보낸다. headless 는 GPU 가 없으므로 같은 상태
 * (비트맵 초기화 + contextrestored)를 직접 만든다.
 *
 * 실행: node e2e/canvas-context-restore.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1400, 1000);
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);

  const burst = await page.evaluate(async () => {
    const { executor, pendingEdits } = window.__agentBridge;
    const revision = async () => (await executor.execute('get_document_info', {}, 'claude')).revision;
    const paragraph = (i) => `${i}번 문단. ${'에이전트가 한 번에 많이 고치는 문장입니다. '.repeat(10)}\n`;
    pendingEdits.beginTurn('claude');
    for (let batch = 0; batch < 3; batch += 1) {
      const edits = Array.from({ length: 16 }, (_, i) => ({
        tool: 'insert_text',
        args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: paragraph(batch * 16 + i) },
      }));
      const result = await executor.execute(
        'apply_edits', { edits, expectedRevision: await revision() }, 'claude',
      );
      if (result?.error) throw new Error(JSON.stringify(result.error));
    }
    pendingEdits.endTurn('commit');
    return { pageCount: window.__wasm.pageCount, pending: pendingEdits.hasPending() };
  });
  assert.ok(burst.pageCount >= 3, `burst should span several pages (got ${burst.pageCount})`);
  assert.equal(burst.pending, false);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const inkOfVisiblePages = () => page.evaluate(() => {
    const container = document.getElementById('scroll-container');
    const box = container.getBoundingClientRect();
    return [...document.querySelectorAll('#scroll-content > canvas[data-rhwp-page-index]')]
      .filter((canvas) => {
        const r = canvas.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom && r.width > 0;
      })
      .map((canvas) => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < data.length; i += 4 * 31) if (data[i + 3] > 0 && data[i] < 128) ink += 1;
        return { page: Number(canvas.dataset.rhwpPageIndex), ink };
      });
  });

  const before = await inkOfVisiblePages();
  assert.ok(before.length > 0, 'at least one page is visible');
  for (const { page: p, ink } of before) assert.ok(ink > 50, `page ${p} is painted before restore`);

  // Chromium 의 복원과 같은 상태: 비트맵이 비고 contextrestored 가 온다.
  const cleared = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('#scroll-content > canvas[data-rhwp-page-index]')];
    for (const canvas of canvases) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      canvas.dispatchEvent(new Event('contextrestored'));
    }
    return canvases.length;
  });
  assert.ok(cleared > 0);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const after = await inkOfVisiblePages();
  console.log(JSON.stringify({ pageCount: burst.pageCount, before, after }));
  assert.deepEqual(after.map(({ page: p }) => p), before.map(({ page: p }) => p));
  for (const { page: p, ink } of after) assert.ok(ink > 50, `page ${p} is repainted after context restore`);
  console.log('PASS canvas context restore repaints visible pages');
} finally {
  await closeBrowser(browser);
}
