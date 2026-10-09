/**
 * Task #1448 — 미저장 문서 자동 백업 복구 E2E
 *
 * 예전 draft(문서 ID 없음)는 HWP 로 연결 없이 열리고, 문서 ID 와 원본 핸들이 있는 draft 는
 * 원래 문서로 다시 열린다. 원본 파일은 OPFS 핸들로 만든다.
 *
 * 실행:
 *   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   VITE_URL=http://localhost:7700 \
 *   node e2e/autosave-recovery.test.mjs --mode=headless
 */
import {
  runTest,
  waitForCanvas,
  screenshot,
  assert,
  setTestCase,
} from './helpers.mjs';

const SAMPLE_HWP = '셀보호2.hwp';
const SAMPLE_HWPX = '셀보호2.hwpx';
const LINKED_SAMPLE = 'shift-return.hwp';
const APP_URL = process.env.VITE_URL || 'http://localhost:7700';

function sampleUrl(filename) {
  return `/samples/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

async function clearAutosaveDb(page) {
  await page.evaluate(async () => {
    const req = indexedDB.deleteDatabase('rhwpStudioAutosave');
    await new Promise((resolve) => {
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
}

/** 앱이 쓰는 스키마(drafts·draftMeta·draftBases)에 draft 를 직접 넣는다. */
async function putDraft(page, draft) {
  await page.evaluate(async (input) => {
    // 앱 저장소 모듈이 DB 를 현재 스키마로 만들게 한 뒤 행을 직접 넣는다.
    await (await import('/src/recovery/autosave-store.ts')).listAutosaveDrafts();
    const req = indexedDB.open('rhwpStudioAutosave');
    const db = await new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'draftMeta'], 'readwrite');
      tx.objectStore('drafts').put({ ...input, data: new Uint8Array(input.data).buffer });
      const { data: _data, ...meta } = input;
      tx.objectStore('draftMeta').put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, draft);
}

/** 복구한 창이 같은 id 로 다시 기록했으면 lock 소유 표시(ownerInstanceId)가 붙는다. */
async function draftAdoptedByLivePage(page, id) {
  return await page.evaluate(async (draftId) => {
    const req = indexedDB.open('rhwpStudioAutosave');
    const db = await new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    const found = await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const getReq = tx.objectStore('drafts').get(draftId);
      getReq.onsuccess = () => resolve(Boolean(getReq.result?.ownerInstanceId));
      getReq.onerror = () => reject(getReq.error);
    });
    db.close();
    return found;
  }, id);
}

async function fetchSampleBytes(page, filename) {
  return await page.evaluate(async (url) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Array.from(new Uint8Array(await resp.arrayBuffer()));
  }, sampleUrl(filename));
}

async function navigateApp(page, search = '') {
  await page.goto(`${APP_URL}${search}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.__wasm && !!window.__canvasView, { timeout: 15000 });
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
}

async function exportHwpFromSample(page, filename) {
  return await page.evaluate(async ({ fname, url }) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    window.__wasm.loadDocument(bytes, fname);
    return Array.from(window.__wasm.exportHwp());
  }, { fname: filename, url: sampleUrl(filename) });
}

async function exportNewDocument(page) {
  return await page.evaluate(() => {
    window.__wasm.createNewDocument();
    return {
      fileName: window.__wasm.fileName || '새 문서.hwp',
      sourceFormat: window.__wasm.getSourceFormat(),
      data: Array.from(window.__wasm.exportHwp()),
    };
  });
}

/**
 * OPFS 에 원본 파일을 만들고, 그 파일을 열어 둔 창이 크래시로 남긴 draft 를 넣는다.
 * disk: 'same' 은 파일을 그대로, 'changed' 는 다른 내용으로 바꾸고, 'deleted' 는 지운다.
 */
async function seedLinkedDraft(page, { id, documentId, fileName, disk }) {
  return await page.evaluate(async ({ draftId, docId, name, diskState, url }) => {
    const [{ WasmBridge }, { documentSourceDigest }] = await Promise.all([
      import('/src/core/wasm-bridge.ts'),
      import('/src/recent/document-preflight.ts'),
    ]);
    const original = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const bridge = new WasmBridge();
    await bridge.initialize();
    bridge.loadDocument(original, name);
    const base = bridge.exportHwp();
    bridge.insertText(0, 0, bridge.getParagraphLength(0, 0), ':DRAFT');
    const draft = bridge.exportHwp();
    bridge.loadDocument(base, name);
    bridge.insertText(0, 0, 0, 'DISK:');
    const changed = bridge.exportHwp();
    bridge.releaseDocument();

    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name).catch(() => {});
    const handle = await root.getFileHandle(name, { create: true });
    const write = async (bytes) => {
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    };
    await write(base);
    if (diskState === 'changed') await write(changed);
    if (diskState === 'deleted') await root.removeEntry(name);

    await (await import('/src/recovery/autosave-store.ts')).listAutosaveDrafts();
    const req = indexedDB.open('rhwpStudioAutosave');
    const db = await new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    const digest = documentSourceDigest(base);
    const meta = {
      id: draftId, fileName: name, sourceFormat: 'hwp', savedAt: Date.now(), byteLength: draft.byteLength,
      documentId: docId, dataFormat: 'hwp', base: { digest, byteLength: base.byteLength, mergeable: true },
      handleKind: 'browser', dirtyReason: 'e2e-linked',
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'draftMeta', 'draftBases'], 'readwrite');
      tx.objectStore('drafts').put({ ...meta, fileHandle: handle, data: draft.slice().buffer });
      tx.objectStore('draftMeta').put(meta);
      tx.objectStore('draftBases').put({ id: draftId, digest, byteLength: base.byteLength, data: base.slice().buffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return {
      diskDigest: diskState === 'deleted' ? null : documentSourceDigest(diskState === 'changed' ? changed : base),
    };
  }, { draftId: id, docId: documentId, name: fileName, diskState: disk, url: sampleUrl(LINKED_SAMPLE) });
}

async function linkedState(page, fileName) {
  return await page.evaluate(async (name) => {
    const { documentSourceDigest } = await import('/src/recent/document-preflight.ts');
    const root = await navigator.storage.getDirectory();
    let diskDigest = null;
    let sameHandle = false;
    try {
      const fileHandle = await root.getFileHandle(name);
      diskDigest = documentSourceDigest(new Uint8Array(await (await fileHandle.getFile()).arrayBuffer()));
      sameHandle = window.__wasm.currentFileHandle
        ? await window.__wasm.currentFileHandle.isSameEntry(fileHandle)
        : false;
    } catch {
      // 지운 파일
    }
    const req = indexedDB.open('rhwpStudioRecent');
    const db = await new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    const recents = db.objectStoreNames.contains('recent')
      ? await new Promise((resolve, reject) => {
        const getAll = db.transaction('recent', 'readonly').objectStore('recent').getAll();
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      })
      : [];
    db.close();
    const versions = window.__versionController?.getState();
    return {
      fileName: window.__wasm.fileName,
      hasHandle: Boolean(window.__wasm.currentFileHandle),
      sameHandle,
      diskDigest,
      isDirty: window.__documentState.isDirty(),
      recentDocumentIds: recents.map((row) => row.documentId),
      versionDocumentId: versions?.documentId ?? null,
      commitTitles: versions?.commits.map((commit) => commit.title) ?? [],
    };
  }, fileName);
}

async function openRecoveryDialog(page, expectedFileNamePart) {
  await navigateApp(page);
  await page.waitForSelector('.modal-overlay .dialog-wrap', { timeout: 5000 });
  const dialogText = await page.$eval('.modal-overlay .dialog-wrap', el => el.textContent || '');
  assert(dialogText.includes('문서 복구'), '복구 대화상자 표시');
  assert(dialogText.includes('원래 문서로 다시 열립니다'), '원래 문서로 다시 연다는 안내 표시');
  assert(dialogText.includes(expectedFileNamePart), `복구 후보 파일명 표시 (${expectedFileNamePart})`);
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('.modal-overlay .dialog-btn'))
      .find((btn) => (btn.textContent || '').trim() === '복구');
    if (!button) throw new Error('복구 버튼을 찾을 수 없습니다');
    button.click();
  });
}

async function openAndRestore(page, expectedFileNamePart) {
  await openRecoveryDialog(page, expectedFileNamePart);
  await waitForCanvas(page, 10000);
  await page.evaluate(() => new Promise(r => setTimeout(r, 800)));
}

async function documentState(page) {
  return await page.evaluate(() => ({
    fileName: window.__wasm.fileName,
    sourceFormat: window.__wasm.getSourceFormat(),
    pageCount: window.__wasm.pageCount,
    isDirty: window.__documentState.isDirty(),
  }));
}

async function resetForNextCase(page) {
  await page.evaluate(() => window.__documentState?.markClean?.('e2e-next-case'));
  await clearAutosaveDb(page);
}

runTest('Task #1448 자동 백업 복구', async ({ page }) => {
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  setTestCase('TC-0: 초기화와 기존 복구 DB 정리');
  await navigateApp(page, `?url=${encodeURIComponent(sampleUrl(SAMPLE_HWP))}&filename=${encodeURIComponent(SAMPLE_HWP)}`);
  await clearAutosaveDb(page);
  // 앱이 자동 저장 DB 를 현재 스키마로 다시 만들게 한다.
  await navigateApp(page);

  setTestCase('TC-1: 예전 새 문서 draft 복구');
  const newDocument = await exportNewDocument(page);
  await putDraft(page, {
    id: 'e2e-new-draft',
    fileName: newDocument.fileName,
    sourceFormat: newDocument.sourceFormat,
    savedAt: Date.now(),
    byteLength: newDocument.data.length,
    data: newDocument.data,
    dirtyReason: 'e2e-new-document',
  });
  await openAndRestore(page, newDocument.fileName);
  const newDocState = await documentState(page);
  assert(newDocState.pageCount >= 1, `새 문서 페이지 수 확인 (${newDocState.pageCount})`);
  assert(!newDocState.fileName.includes('복구본') && newDocState.fileName.endsWith('.hwp'),
    `새 문서는 원래 이름의 HWP 로 열린다 (${newDocState.fileName})`);
  assert(newDocState.isDirty === true, '새 문서 복구는 저장 전 dirty 상태 유지');
  assert(await draftAdoptedByLivePage(page, 'e2e-new-draft'), '복구한 창이 같은 id 로 이어 쓴다');
  await screenshot(page, 'autosave-recovery-new-document');
  await resetForNextCase(page);

  setTestCase('TC-2: 예전 HWP draft 복구');
  const hwpBytes = await fetchSampleBytes(page, SAMPLE_HWP);
  await putDraft(page, {
    id: 'e2e-hwp-draft',
    fileName: SAMPLE_HWP,
    sourceFormat: 'hwp',
    savedAt: Date.now(),
    byteLength: hwpBytes.length,
    data: hwpBytes,
    dirtyReason: 'e2e-hwp',
  });
  await openAndRestore(page, SAMPLE_HWP);
  const hwpState = await documentState(page);
  assert(hwpState.pageCount >= 1, `HWP 페이지 수 확인 (${hwpState.pageCount})`);
  assert(hwpState.fileName === SAMPLE_HWP, `HWP draft 는 원래 이름으로 열린다 (${hwpState.fileName})`);
  assert(hwpState.isDirty === true, '복구 문서는 저장 전 dirty 상태 유지');
  assert(await draftAdoptedByLivePage(page, 'e2e-hwp-draft'), 'HWP draft 를 복구한 창이 이어 쓴다');
  await screenshot(page, 'autosave-recovery-hwp');
  await resetForNextCase(page);

  setTestCase('TC-3: 예전 HWPX 출처 draft는 HWP 로 열린다');
  await navigateApp(page, `?url=${encodeURIComponent(sampleUrl(SAMPLE_HWPX))}&filename=${encodeURIComponent(SAMPLE_HWPX)}`);
  const hwpxAsHwpBytes = await exportHwpFromSample(page, SAMPLE_HWPX);
  await putDraft(page, {
    id: 'e2e-hwpx-draft',
    fileName: SAMPLE_HWPX,
    sourceFormat: 'hwpx',
    savedAt: Date.now(),
    byteLength: hwpxAsHwpBytes.length,
    data: hwpxAsHwpBytes,
    dirtyReason: 'e2e-hwpx',
  });
  await openAndRestore(page, SAMPLE_HWPX);
  const hwpxState = await documentState(page);
  assert(hwpxState.fileName === '셀보호2.hwp', `HWPX 출처 예전 draft 는 .hwp 이름 (${hwpxState.fileName})`);
  assert(hwpxState.sourceFormat === 'hwp', `복구 데이터는 HWP로 로드됨 (${hwpxState.sourceFormat})`);
  assert(hwpxState.isDirty === true, 'HWPX 출처 draft 도 저장 전 dirty 상태 유지');
  assert(await draftAdoptedByLivePage(page, 'e2e-hwpx-draft'), 'HWPX 출처 draft 를 복구한 창이 이어 쓴다');
  await screenshot(page, 'autosave-recovery-hwpx');
  await resetForNextCase(page);

  setTestCase('TC-4: 그대로인 원본은 같은 문서로 다시 열린다');
  const unchanged = await seedLinkedDraft(page, {
    id: 'e2e-linked-same', documentId: 'e2e-doc-same', fileName: 'recover-same.hwp', disk: 'same',
  });
  await openAndRestore(page, 'recover-same.hwp');
  const sameState = await linkedState(page, 'recover-same.hwp');
  assert(sameState.fileName === 'recover-same.hwp', `원래 이름 유지 (${sameState.fileName})`);
  assert(sameState.sameHandle, '원본 파일 핸들에 다시 연결');
  assert(sameState.isDirty === true, '복구한 변경은 저장 전 dirty');
  assert(sameState.diskDigest === unchanged.diskDigest, '복구만으로는 원본 파일을 쓰지 않는다');
  assert(sameState.recentDocumentIds.includes('e2e-doc-same'), '최근 문서에 같은 문서 ID 로 남는다');
  assert(!sameState.versionDocumentId || sameState.versionDocumentId === 'e2e-doc-same',
    `같은 문서 ID 로 열린다 (${sameState.versionDocumentId})`);
  assert(await draftAdoptedByLivePage(page, 'e2e-linked-same'), '복구한 창이 같은 draft id 로 이어 쓴다');
  await screenshot(page, 'autosave-recovery-linked-same');
  await resetForNextCase(page);

  setTestCase('TC-5: 바뀐 원본은 외부 변경으로 기록하고 병합 창을 연다');
  const changed = await seedLinkedDraft(page, {
    id: 'e2e-linked-changed', documentId: 'e2e-doc-changed', fileName: 'recover-changed.hwp', disk: 'changed',
  });
  await openRecoveryDialog(page, 'recover-changed.hwp');
  await page.waitForSelector('.merge-resolver-window', { timeout: 30000 });
  const resolver = await page.evaluate(() => ({
    direction: document.querySelector('.merge-direction')?.textContent ?? '',
    versionName: document.querySelector('.merge-title-input')?.value ?? '',
  }));
  assert(resolver.direction.startsWith('복구 ') && resolver.direction.endsWith('→ main'),
    `복구 브랜치를 현재 브랜치로 병합 (${resolver.direction})`);
  assert(resolver.versionName === '자동 저장본 복구', `병합 결과 버전 이름 (${resolver.versionName})`);
  const changedState = await linkedState(page, 'recover-changed.hwp');
  assert(changedState.sameHandle, '디스크 파일에 연결된 채로 병합한다');
  assert(changedState.commitTitles[0] === '외부 변경', `외부 변경 커밋 기록 (${changedState.commitTitles.join(', ')})`);
  assert(changedState.commitTitles.includes('자동 저장 기준') && changedState.commitTitles.includes('자동 저장된 변경'),
    '자동 저장 기준과 자동 저장된 변경을 복구 브랜치에 기록');
  assert(changedState.commitTitles.length === 3, `디스크 내용을 두 번 기록하지 않는다 (${changedState.commitTitles.length})`);
  assert(changedState.diskDigest === changed.diskDigest, '병합 전에는 원본 파일을 쓰지 않는다');
  await screenshot(page, 'autosave-recovery-linked-changed');
  await page.click('.merge-close-button');
  await page.waitForSelector('.merge-resolver-window', { hidden: true });
  await resetForNextCase(page);

  setTestCase('TC-6: 사라진 원본은 같은 이름으로 연결 없이 열린다');
  await seedLinkedDraft(page, {
    id: 'e2e-linked-deleted', documentId: 'e2e-doc-deleted', fileName: 'recover-deleted.hwp', disk: 'deleted',
  });
  await openAndRestore(page, 'recover-deleted.hwp');
  const deletedState = await linkedState(page, 'recover-deleted.hwp');
  assert(deletedState.fileName === 'recover-deleted.hwp', `원래 이름 유지 (${deletedState.fileName})`);
  assert(!deletedState.hasHandle, '파일 핸들 없이 열린다');
  assert(deletedState.isDirty === true, '저장 전 dirty');
  await screenshot(page, 'autosave-recovery-linked-deleted');
});
