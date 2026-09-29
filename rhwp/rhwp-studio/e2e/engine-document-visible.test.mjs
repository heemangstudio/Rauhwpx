/**
 * 에이전트 편집 뒤에도 문서가 화면에 남는지 검증한다.
 *
 * 1. 수식이 있는 문단을 거듭 다시 조판해도 wasm externref 표가 자라지 않는다.
 *    (null 측정 결과에 Reflect.get 을 부르던 누수 — 표가 1천만 칸에 닿으면 엔진이 trap 한다)
 * 2. 에이전트가 용지를 뷰포트보다 넓게 바꿔도 용지가 화면 밖으로 밀려나지 않는다.
 *
 * 실행: node e2e/engine-document-visible.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import { launchBrowser, createPage, closeBrowser, loadApp, createNewDocument } from './helpers.mjs';

const browser = await launchBrowser();
try {
  const page = await createPage(browser, 1400, 900);
  await loadApp(page);
  await page.waitForFunction(() => !!window.__agentBridge?.pendingEdits);
  await createNewDocument(page);

  const leak = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/pkg\/rhwp\.js/.test(name));
    const exports = await (await import(url)).default();
    const table = exports.__wbindgen_externrefs;
    const doc = window.__wasm.doc;
    doc.insertText(0, 0, 0, '수식 ');
    doc.insertEquation(0, 0, 3, '{2 sqrt 5} over 5', 1200, 0);
    doc.getCursorRect(0, 0, 1);
    const before = table.length;
    for (let i = 0; i < 300; i += 1) {
      doc.insertText(0, 0, 0, 'a');
      doc.getCursorRect(0, 0, 1);
    }
    return { before, after: table.length };
  });
  console.log(JSON.stringify({ externrefTable: leak }));
  assert.equal(leak.after, leak.before, 'equation relayout must not leak externref slots');

  await createNewDocument(page);
  const layout = await page.evaluate(async () => {
    const { executor, pendingEdits } = window.__agentBridge;
    const revision = (await executor.execute('get_document_info', {}, 'claude')).revision;
    pendingEdits.beginTurn('claude');
    // 사용자 세션의 첫 배치: B4 용지로 바꾸고 쪽 나눔용 표지 문단을 넣었다가 지운다.
    const marks = ['EXAM_PAGE_1', 'EXAM_PAGE_2', 'EXAM_PAGE_3'];
    await executor.execute('apply_edits', {
      expectedRevision: revision,
      edits: [
        { tool: 'set_page_layout', args: { sectionIdx: 0, paper: { widthMm: 257, heightMm: 364 } } },
        { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: marks.join('\n') } },
        ...marks.slice(1).map((text) => ({ tool: 'apply_para_format', args: { anchor: { text }, pageBreakBefore: true } })),
        ...marks.map((text) => ({ tool: 'delete_range', args: { anchor: { text } } })),
      ],
    }, 'claude');
    pendingEdits.endTurn('commit');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const container = document.getElementById('scroll-container');
    const box = container.getBoundingClientRect();
    const pages = [...document.querySelectorAll('#scroll-content > canvas')]
      .map((canvas) => canvas.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    return {
      viewportWidth: container.clientWidth,
      scrollLeft: Math.round(container.scrollLeft),
      pageWidth: Math.round(pages[0]?.width ?? 0),
      visible: pages.filter((rect) => rect.right > box.left + 40 && rect.left < box.right - 40).length,
    };
  });
  console.log(JSON.stringify({ layout }));
  assert.ok(layout.pageWidth > layout.viewportWidth, 'the paper is wider than the viewport');
  assert.ok(layout.visible > 0, 'the widened paper stays on screen');
  console.log('PASS document stays visible after agent edits');
} finally {
  await closeBrowser(browser);
}
