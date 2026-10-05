/**
 * 라이브러리 이동이 현재 문서 파일을 보존하는지 확인하는 E2E.
 *
 * 사이드바 문서 그룹의 이동 버튼은 현재 문서를 저장한 뒤 다른 문서를 연다. 예전에는 바뀐 내용이
 * 없어도 저장해, 원본 파일이 엔진이 다시 직렬화한 바이트로 덮어써졌다(탭 위치, 여백, 문단 ID 등
 * 한컴이 쓰는 값이 빠져 한컴에서 서식이 무너졌다).
 *
 * 검증:
 *   1. 실제 샘플(HWP·HWPX)을 파일 핸들로 연 뒤 이동하면 원본 핸들에 한 바이트도 쓰지 않는다.
 *   2. 편집한 문서는 일반 저장 경로로 한 번 저장한 뒤 이동한다.
 *
 * 실행: node e2e/library-move-preserves-file.test.mjs --mode=headless
 */
import { runTest, assert, sampleFetchPath } from './helpers.mjs';

const SAMPLES = [
  'biz_plan.hwp',
  'hwp_table_test.hwp',
  'bitmap.hwp',
  'hwp3-sample.hwp',
  'hwpx/hwpx-01.hwpx',
  'hwpx/business_overview.hwpx',
  'hwpx/2025년 2분기 해외직접투자 (최종).hwpx',
];

const TARGET_DOCUMENT_ID = 'library-move-target';

/** 쓰기를 기록하는 가짜 파일 핸들로 샘플을 연다. */
async function openWithRecordingHandle(page, sample) {
  const fileName = sample.split('/').pop();
  return page.evaluate(async ({ url, fileName }) => {
    const response = await fetch(url);
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const original = new Uint8Array(await response.arrayBuffer());
    const writes = [];
    window.__moveWrites = writes;
    const handle = {
      kind: 'file',
      name: fileName,
      async getFile() { return new File([original], fileName); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return other === handle; },
      async createWritable() {
        return {
          async write(blob) { writes.push(new Uint8Array(await new Blob([blob]).arrayBuffer())); },
          async close() {},
          async abort() {},
        };
      },
    };
    window.__moveHandle = handle;
    const requestId = `library-move-${Date.now()}`;
    const done = new Promise((resolve) => {
      const off = window.__eventBus.on('open-document-bytes:done', (outcome) => {
        if (outcome.requestId !== requestId) return;
        off();
        resolve(outcome);
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes: original,
      fileName,
      fileHandle: handle,
      requestId,
      skipUnsavedGuard: true,
    });
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: '열기 완료 이벤트 시간 초과' }), 20000);
    });
    const outcome = await Promise.race([done, timeout]);
    return { ok: outcome.ok, error: outcome.error, length: original.length };
  }, { url: sampleFetchPath(sample), fileName });
}

/** 다른 문서의 채팅 그룹을 만들어 사이드바에 이동 버튼이 생기게 한다. */
async function seedOtherDocumentGroup(page) {
  await page.evaluate(async (documentId) => {
    const threads = await import('/src/agent/threads.ts');
    const now = Date.now();
    threads.upsertThread({
      id: `thread-${documentId}`,
      title: '다른 문서',
      titleRequested: true,
      createdAt: now,
      updatedAt: now,
      agent: 'claude',
      model: 'default',
      effort: 'medium',
      serviceTier: 'standard',
      workflow: 'edit',
      docKey: '다른 문서.hwpx',
      documentId,
      activeTemplateId: null,
      messages: [{ id: 'm1', role: 'user', text: '안녕하세요', createdAt: now }],
    });
    // 대상 문서는 다시 열 수 없다. 열기 대화상자는 취소로 끝낸다 — 확인할 것은 현재 파일이다.
    window.showOpenFilePicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
  }, TARGET_DOCUMENT_ID);
}

async function clickMoveToOtherDocument(page) {
  await page.waitForFunction(
    () => document.querySelector('.ag-doc-jump') !== null,
    { timeout: 10000 },
  );
  await page.evaluate(() => document.querySelector('.ag-doc-jump').click());
  // 저장·열기 시도가 끝날 때까지 기다린다.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2500)));
}

async function writesSummary(page) {
  return page.evaluate(() => ({
    count: window.__moveWrites.length,
    lengths: window.__moveWrites.map((bytes) => bytes.length),
    dirty: window.__documentState.isDirty(),
  }));
}

await runTest('라이브러리 이동은 바뀌지 않은 문서 파일을 다시 쓰지 않는다', async ({ page }) => {
  await seedOtherDocumentGroup(page);
  for (const sample of SAMPLES) {
    const opened = await openWithRecordingHandle(page, sample);
    assert(opened.ok, `${sample} 열기 (${opened.error ?? ''})`);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)));
    await clickMoveToOtherDocument(page);
    const writes = await writesSummary(page);
    assert(
      writes.count === 0,
      `${sample}: 이동이 원본 파일을 다시 쓰지 않아야 함 (쓰기 ${writes.count}회, ${writes.lengths.join(',')}바이트, 원본 ${opened.length}바이트)`,
    );
  }
});

await runTest('라이브러리 이동은 편집한 문서를 일반 저장 경로로 저장한다', async ({ page }) => {
  await seedOtherDocumentGroup(page);
  const sample = 'biz_plan.hwp';
  const opened = await openWithRecordingHandle(page, sample);
  assert(opened.ok, `${sample} 열기 (${opened.error ?? ''})`);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)));
  const marker = '이동전편집';
  await page.evaluate((text) => {
    window.__wasm.insertText(0, 0, 0, text);
    window.__eventBus.emit('document-changed', 'e2e-edit');
  }, marker);
  await clickMoveToOtherDocument(page);
  const writes = await writesSummary(page);
  assert(writes.count === 1, `편집한 문서는 한 번 저장해야 함 (쓰기 ${writes.count}회)`);
  assert(!writes.dirty, '저장 후 문서는 깨끗해야 함');
  const hasMarker = await page.evaluate((text) => {
    const saved = window.__moveWrites[0];
    const info = window.__wasm.loadDocument(saved, 'saved.hwp');
    const para = window.__wasm.getTextRange(0, 0, 0, text.length);
    return { pages: info?.pageCount ?? 0, para };
  }, marker);
  assert(hasMarker.pages >= 1, `저장본을 다시 열 수 있어야 함 (${hasMarker.pages}쪽)`);
  assert(hasMarker.para === marker, `저장본에 편집이 들어 있어야 함 (${hasMarker.para})`);
});
