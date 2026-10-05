/**
 * E2E 테스트: 조판 품질 검증 (문단부호 표시 상태)
 */
import {
  runTest,
  createNewDocument,
  clickEditArea,
  typeText,
  screenshot,
  assert,
  getPageCount,
  getParagraphCount,
  waitForPaint,
  waitForState,
} from './helpers.mjs';

runTest('조판 품질 검증 (문단부호 ON)', async ({ page }) => {
  await createNewDocument(page);

  // 1. 문단부호 켜기
  console.log('[1] 문단부호 켜기...');
  await page.evaluate(() => {
    window.__wasm?.setShowParagraphMarks(true);
    window.__eventBus?.emit('document-changed');
  });
  await waitForPaint(page);
  assert(
    await page.evaluate(() => window.__wasm.getShowParagraphMarks()),
    'Paragraph marks are enabled in the document renderer',
  );
  await screenshot(page, 'ts-01-paramark-empty');

  await clickEditArea(page);

  // 2. 한 줄 텍스트
  console.log('\n[2] 한 줄 텍스트 + 문단부호...');
  await typeText(page, 'Hello World');
  await screenshot(page, 'ts-02-single-line');

  // 3. 자동 줄바꿈
  console.log('\n[3] 자동 줄바꿈 (긴 텍스트)...');
  const longText = 'The quick brown fox jumps over the lazy dog. ';
  for (let i = 0; i < 5; i++) await typeText(page, longText);
  const wrapped = await page.evaluate(() => {
    const w = window.__wasm;
    return {
      start: w.getCursorRect(0, 0, 0),
      end: w.getCursorRect(0, 0, w.getParagraphLength(0, 0)),
      count: w.getParagraphCount(0),
    };
  });
  assert(
    wrapped.count === 1 && wrapped.end.y > wrapped.start.y,
    'Long text wraps within the same paragraph',
  );
  await screenshot(page, 'ts-03-line-wrap');

  // 4. Enter 문단 분리
  console.log('\n[4] 문단 분리 (Enter 3회)...');
  await page.keyboard.press('Enter');
  await waitForPaint(page);
  await typeText(page, 'Second paragraph with some text.');
  await page.keyboard.press('Enter');
  await waitForPaint(page);
  await typeText(page, 'Third paragraph.');
  assert(
    (await getParagraphCount(page)) === 3,
    'Enter creates three distinct paragraphs',
  );
  assert(
    (await page.evaluate(() =>
      window.__wasm.getTextRange(
        0,
        1,
        0,
        window.__wasm.getParagraphLength(0, 1),
      ),
    )) === 'Second paragraph with some text.',
    'Second paragraph content survives wrapping',
  );
  await screenshot(page, 'ts-04-multi-paragraph');

  // 5. 빈 줄 + 텍스트 교차
  console.log('\n[5] 빈 줄 + 텍스트 교차...');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await typeText(page, 'After two blank lines.');
  await page.keyboard.press('Enter');
  await typeText(page, 'Next line.');
  await screenshot(page, 'ts-05-blank-lines');

  // 6. 페이지 경계
  console.log('\n[6] 줄간격 + 페이지 경계...');
  for (let i = 0; i < 50; i++) await page.keyboard.press('Enter');
  await waitForPaint(page);
  await typeText(page, 'Text on page 2.');
  const pageCount = await getPageCount(page);
  console.log(`  페이지 수: ${pageCount}`);
  assert(pageCount >= 2, `페이지 넘김 확인 (${pageCount}페이지)`);
  await screenshot(page, 'ts-06-page-boundary');

  // 7. 1페이지 상단 스크롤
  console.log('\n[7] 1페이지 상단 전체 뷰...');
  await page.evaluate(() =>
    document.getElementById('scroll-container')?.scrollTo(0, 0),
  );
  await waitForPaint(page);
  await screenshot(page, 'ts-07-page1-top');

  // 8. 문단 병합
  console.log('\n[8] 문단 병합 후 조판 확인...');
  const beforeMerge = await page.evaluate(() => ({
    count: window.__wasm.getParagraphCount(0),
    first: window.__wasm.getTextRange(
      0,
      0,
      0,
      window.__wasm.getParagraphLength(0, 0),
    ),
    second: window.__wasm.getTextRange(
      0,
      1,
      0,
      window.__wasm.getParagraphLength(0, 1),
    ),
  }));
  await page.evaluate(() =>
    window.__inputHandler.cursor.moveTo({
      sectionIndex: 0,
      paragraphIndex: 1,
      charOffset: 0,
    }),
  );
  await page.keyboard.press('Backspace');
  await waitForState(
    page,
    'merged paragraph',
    (count) => window.__wasm.getParagraphCount(0) === count - 1,
    beforeMerge.count,
  );
  assert(
    (await page.evaluate(() =>
      window.__wasm.getTextRange(
        0,
        0,
        0,
        window.__wasm.getParagraphLength(0, 0),
      ),
    )) ===
      beforeMerge.first + beforeMerge.second,
    'Merge preserves both paragraph contents in order',
  );
  await screenshot(page, 'ts-08-after-merge');

  console.log('\n=== 조판 검증 완료 ===');
});
