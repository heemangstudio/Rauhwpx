/**
 * 실제 Studio 워크트리 생성·저장·닫기·복구·삭제·병합의 문서 격리와 기록 보존을 검증한다.
 * 실행: node e2e/worktree-lifecycle.test.mjs --mode=headless
 * 파일 picker만 메모리 핸들로 대체한다. 허브, 편집기, WASM, IndexedDB와 버전 UI는 실제 경로다.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureChromePath, findAvailablePort, openSample, removeTempDir, startHub, startVite, stopServer, writeFakePi,
} from './agent-bench-harness.mjs';

ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-worktree-lifecycle-'));
const hubPort = await findAvailablePort(5790);
const vitePort = await findAvailablePort(7790);
const token = 'worktree-lifecycle-test';
const { piRoot } = writeFakePi(fixtureRoot);
let hub;
let vite;

async function state(page) {
  return page.evaluate(() => ({
    ...window.__versionController.getState(),
    documentId: window.__documentSessions.attached().documentId,
    text: window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)),
    fileName: window.__wasm.fileName,
    hasHandle: window.__wasm.currentFileHandle !== null,
    dirtyDocument: window.__documentSessions.attached().documentState.isDirty(),
  }));
}

async function edit(page, marker, documentId = null) {
  await page.evaluate((text, id) => {
    const session = id
      ? window.__documentSessions.list().find((candidate) => candidate.documentId === id)
      : window.__documentSessions.attached();
    if (!session) throw new Error('편집할 문서 세션이 없습니다.');
    session.wasm.insertText(0, 0, 0, text);
    session.documentState.markDirty('worktree-lifecycle-edit');
    session.bus.emit('document-changed', 'worktree-lifecycle-edit');
  }, marker, documentId);
}

async function showWorktrees(page) {
  if (!await page.$('.ag-versions-open')) await page.locator('#agent-sidebar .ag-versions-btn').click();
  await page.waitForSelector('[data-tab="worktrees"]', { visible: true });
  await page.locator('#agent-sidebar [data-tab="worktrees"]').click();
}

async function createWorktree(page, name) {
  await showWorktrees(page);
  await page.locator('#agent-sidebar button[aria-label="워크트리 만들기"]').click();
  await page.waitForSelector('select.ag-version-prompt-input', { visible: true });
  await page.locator('.ag-version-prompt button[type="submit"]').click();
  await page.waitForSelector('input.ag-version-prompt-input', { visible: true });
  await page.$eval('input.ag-version-prompt-input', (input, value) => { input.value = value; }, name);
  await page.locator('.ag-version-prompt button[type="submit"]').click();
  await page.waitForFunction((branch) => window.__wasm.hasLoadedDocument()
    && window.__versionController.getState().activeBranch === branch
    && window.__versionController.getState().worktrees.some((tree) => tree.branch === branch && tree.isCurrent),
  { timeout: 20_000 }, name);
  return (await state(page)).worktrees.find((tree) => tree.branch === name);
}

async function worktreeAction(page, tree, action) {
  await showWorktrees(page);
  const selector = `#agent-sidebar .ag-versions-worktrees .ag-versions-worktree-row[data-worktree-id="${tree.id}"] button[aria-label="${tree.branch} 워크트리 ${action}"]`;
  await page.waitForSelector(selector, { visible: true });
  await page.locator(selector).click();
}

async function completeMerge(page) {
  await page.waitForSelector('.merge-primary-button', { visible: true, timeout: 20_000 });
  await page.locator('.merge-resolver-header-actions button[title="호환되는 변경 모두 수락"]').click();
  await page.waitForFunction(() => !document.querySelector('.merge-primary-button')?.disabled, { timeout: 20_000 });
  await page.locator('.merge-primary-button').click();
}

async function openPrimaryWithHandle(page) {
  await page.evaluate(async () => {
    const response = await fetch('/samples/para-001.hwp');
    const bytes = new Uint8Array(await response.arrayBuffer());
    window.__primaryWrites = [];
    const handle = {
      kind: 'file', name: 'para-001.hwp',
      async getFile() { return new File([bytes], this.name); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return other === handle; },
      async createWritable() {
        return {
          async write(blob) { window.__primaryWrites.push(new Uint8Array(await blob.arrayBuffer())); },
          async close() {},
        };
      },
    };
    const requestId = 'worktree-primary-open';
    const done = new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', (result) => {
        if (result.requestId !== requestId) return;
        off();
        if (result.ok) resolve(); else reject(new Error(result.error ?? '원본 열기 실패'));
      });
    });
    window.__eventBus.emit('open-document-bytes', {
      bytes, fileName: handle.name, fileHandle: handle, requestId,
      suppressDialogs: true, skipUnsavedGuard: true,
    });
    await done;
  });
}

async function verifyHistoryExport(page, browser, currentTree, { loadApp, screenshot }) {
  const privateTree = await createWorktree(page, 'lifecycle-private');
  await edit(page, 'PRIVATE-SIBLING-DRAFT ');
  await page.evaluate(() => window.__versionController.persistWorktree());
  const privateBlobId = await page.evaluate(async (id) => {
    const { VersionGraphStore } = await import('/src/versioning/store.ts');
    return (await new VersionGraphStore().getWorktree(id)).blobId;
  }, privateTree.id);
  await worktreeAction(page, privateTree, '닫기');
  await page.waitForFunction((id) => !window.__documentSessions.list().some((session) => session.documentId === id), {}, privateTree.documentId);
  await worktreeAction(page, currentTree, '열기');
  await page.waitForFunction((id) => window.__documentSessions.attached().documentId === id
    && window.__wasm.hasLoadedDocument(), {}, currentTree.documentId);
  const before = await state(page);
  const savedFingerprint = await page.evaluate(async (id) => {
    const { VersionGraphStore } = await import('/src/versioning/store.ts');
    return (await new VersionGraphStore().getWorktree(id)).savedFingerprint;
  }, currentTree.id);
  await page.evaluate(() => {
    window.__historyExport = null;
    window.showSaveFilePicker = async () => ({
      name: 'standalone.rhwpx',
      async getFile() { return new File([], this.name); },
      async isSameEntry() { return false; },
      async createWritable() {
        return { async write(blob) { window.__historyExport = blob; }, async close() {} };
      },
    });
    if (!window.__dispatcher.dispatch('file:save-with-history')) throw new Error('기록 내보내기가 비활성입니다.');
  });
  await page.waitForFunction(() => window.__historyExport !== null);
  const archive = await page.evaluate(async () => {
    const { whenSavesIdle } = await import('/src/command/commands/file.ts');
    const { openPortableHistoryBundle } = await import('/src/versioning/portable-bundle.ts');
    await whenSavesIdle();
    const bytes = new Uint8Array(await window.__historyExport.arrayBuffer());
    const bundle = openPortableHistoryBundle(bytes);
    const magicLength = new TextEncoder().encode('RAUHWPX-HISTORY\0').byteLength;
    const manifestLength = new DataView(bytes.buffer).getUint32(magicLength, true);
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(magicLength + 4, magicLength + 4 + manifestLength)));
    return {
      bytes: Array.from(bytes), metadata: manifest.repository,
      blobIds: bundle.snapshot.blobs.map((blob) => blob.id),
      branches: bundle.snapshot.refs.filter((ref) => ref.kind === 'branch').map((ref) => ref.name).sort(),
      currentBranch: bundle.activeBranch,
    };
  });
  const after = await state(page);
  assert.equal(after.documentId, before.documentId);
  assert.equal(after.fileName, before.fileName);
  assert.equal(after.hasHandle, false);
  assert.equal(after.dirtyDocument, before.dirtyDocument);
  assert.equal(await page.evaluate(async (id) => {
    const { VersionGraphStore } = await import('/src/versioning/store.ts');
    return (await new VersionGraphStore().getWorktree(id)).savedFingerprint;
  }, currentTree.id), savedFingerprint);
  assert.equal('worktrees' in archive.metadata, false);
  assert.equal(JSON.stringify(archive.metadata).includes(currentTree.id), false);
  assert.equal(JSON.stringify(archive.metadata).includes(privateTree.id), false);
  assert.equal(archive.blobIds.includes(privateBlobId), false);
  assert.equal(archive.currentBranch, currentTree.branch);

  const context = await browser.createBrowserContext();
  try {
    const importedPage = await context.newPage();
    await importedPage.setViewport({ width: 1280, height: 900 });
    await loadApp(importedPage);
    await importedPage.waitForFunction(() => Boolean(window.__versionController && window.__documentSessions));
    await importedPage.evaluate(async (bytes) => {
      const requestId = 'worktree-history-import';
      const done = new Promise((resolve, reject) => {
        const off = window.__eventBus.on('open-document-bytes:done', (result) => {
          if (result.requestId !== requestId) return;
          off();
          if (result.ok) resolve(); else reject(new Error(result.error ?? '기록 파일 열기 실패'));
        });
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes: new Uint8Array(bytes), fileName: 'standalone.rhwpx', requestId,
        suppressDialogs: true, skipUnsavedGuard: true,
      });
      await done;
    }, archive.bytes);
    const imported = await state(importedPage);
    assert.equal(imported.text, before.text);
    assert.equal(imported.activeBranch, currentTree.branch);
    assert.deepEqual(imported.branches.map((branch) => branch.name).sort(), archive.branches);
    assert.equal(imported.worktrees.length, 1);
    assert.equal(imported.worktrees[0].primary, true);
    assert.ok(!imported.worktrees.some((tree) => tree.id === currentTree.id || tree.id === privateTree.id));
    await showWorktrees(importedPage);
    await screenshot(importedPage, 'worktree-history-fresh-import');
  } finally {
    await context.close();
  }
}

try {
  hub = await startHub({ hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'worktree-lifecycle-hub.log' });
  vite = await startVite({ vitePort, hubPort, token, logName: 'worktree-lifecycle-vite.log' });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { runTest, loadApp, screenshot, assert: recordPass } = await import('./helpers.mjs');
  await runTest('워크트리 문서 격리와 저장·복구·삭제·병합', async ({ page, browser }) => {
    try {
      page.on('pageerror', (error) => console.error('[Studio]', error.stack));
      page.on('console', (message) => {
        if (message.type() === 'error') console.error('[Studio]', message.text());
      });
      await page.waitForFunction(() => Boolean(window.__versionController && window.__documentSessions));
      await page.evaluate(() => window.__versionController.setAiTitlesEnabled(false));
      await openPrimaryWithHandle(page);
      console.log('현재 문서 열기 완료');
      await page.waitForFunction(() => window.__versionController.getState().worktrees.some((tree) => tree.primary));
      const initial = await state(page);
      const primary = initial.worktrees.find((tree) => tree.primary);
      const primaryDocumentId = initial.documentId;

      // 디스크에 저장하지 않은 현재 문서의 변경을 출발점으로 복제한다.
      await edit(page, 'CURRENT-DIRTY ');
      const child = await createWorktree(page, 'lifecycle-copy');
      console.log('현재 변경을 포함한 작업 사본 생성 완료');
      const cloned = await state(page);
      assert.notEqual(cloned.documentId, primaryDocumentId);
      assert.equal(cloned.hasHandle, false);
      assert.ok(cloned.text.startsWith('CURRENT-DIRTY '));
      assert.equal(cloned.worktrees.filter((tree) => tree.primary).length, 1);
      await edit(page, 'CHILD-ONLY ');
      const parentText = await page.evaluate((id) => {
        const wasm = window.__documentSessions.list().find((session) => session.documentId === id).wasm;
        return wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0));
      }, primaryDocumentId);
      assert.ok(parentText.startsWith('CURRENT-DIRTY '));
      assert.ok(!parentText.includes('CHILD-ONLY '));
      await screenshot(page, 'worktree-independent-child');
      recordPass(true, '현재 미저장 변경을 복제하고 작업 사본의 편집을 원본에서 격리한다.');

      // Ctrl+S는 파일 picker 없이 로컬 기준점만 저장한다.
      await page.evaluate(() => {
        window.__worktreePickerCalls = 0;
        window.showSaveFilePicker = async () => { window.__worktreePickerCalls += 1; throw new Error('로컬 저장은 파일을 고르면 안 된다.'); };
        if (!window.__dispatcher.dispatch('file:save')) throw new Error('저장 명령이 비활성입니다.');
      });
      await page.waitForFunction(() => !window.__documentSessions.attached().documentState.isDirty());
      await page.evaluate(async () => {
        const { whenSavesIdle } = await import('/src/command/commands/file.ts');
        await whenSavesIdle();
      });
      assert.equal(await page.evaluate(() => window.__worktreePickerCalls), 0);
      assert.equal((await state(page)).documentId, cloned.documentId);
      assert.equal((await state(page)).fileName, cloned.fileName);

      // 내보낸 HWPX를 새 엔진에 열어 내용까지 확인하고 작업 공간의 연결은 유지한다.
      await edit(page, 'EXPORTED ');
      const beforeExport = await state(page);
      await page.evaluate(() => {
        window.__worktreeExport = null;
        window.showSaveFilePicker = async () => ({
          name: 'standalone.hwpx',
          async getFile() { return new File([], 'standalone.hwpx'); },
          async isSameEntry() { return false; },
          async createWritable() {
            return { async write(blob) { window.__worktreeExport = blob; }, async close() {} };
          },
        });
        if (!window.__dispatcher.dispatch('file:save-as-hwpx')) throw new Error('내보내기 명령이 비활성입니다.');
      });
      await page.waitForFunction(() => window.__worktreeExport !== null);
      const exported = await page.evaluate(async () => {
        const { whenSavesIdle } = await import('/src/command/commands/file.ts');
        await whenSavesIdle();
        const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
        const reopened = new WasmBridge();
        await reopened.initialize();
        reopened.loadDocument(new Uint8Array(await window.__worktreeExport.arrayBuffer()), 'standalone.hwpx');
        return { pages: reopened.pageCount, text: reopened.getTextRange(0, 0, 0, reopened.getParagraphLength(0, 0)) };
      });
      assert.ok(exported.pages > 0);
      assert.ok(exported.text.startsWith('EXPORTED CHILD-ONLY CURRENT-DIRTY '));
      const afterExport = await state(page);
      assert.equal(afterExport.documentId, beforeExport.documentId);
      assert.equal(afterExport.fileName, beforeExport.fileName);
      assert.equal(afterExport.hasHandle, false);
      assert.equal(afterExport.dirtyDocument, true);
      recordPass(true, '로컬 저장과 독립 HWPX 내보내기는 원본 파일을 쓰거나 작업 사본의 연결을 바꾸지 않는다.');
      await verifyHistoryExport(page, browser, child, { loadApp, screenshot });
      recordPass(true, '기록 파일에 현재 문서와 브랜치 기록을 담고 사적인 작업 공간을 제외해 새 환경에서 연다.');

      // 세션을 닫아 WASM을 해제한 뒤 IndexedDB의 현재 작업 내용을 다시 연다.
      await worktreeAction(page, child, '닫기');
      await page.waitForFunction((id) => !window.__documentSessions.list().some((session) => session.documentId === id), {}, cloned.documentId);
      await worktreeAction(page, child, '열기');
      await page.waitForFunction((id) => window.__documentSessions.attached().documentId === id
        && window.__wasm.hasLoadedDocument()
        && window.__documentSessions.attached().documentState.isDirty(), { timeout: 15_000 }, cloned.documentId);
      assert.equal((await state(page)).text, beforeExport.text);
      assert.equal((await state(page)).dirtyDocument, true);
      assert.equal((await state(page)).hasHandle, false);
      await worktreeAction(page, child, '삭제');
      await page.waitForSelector('.ag-sheet-confirm', { visible: true });
      await page.locator('.ag-sheet-confirm').click();
      await page.waitForFunction((id) => !window.__versionController.getState().worktrees.some((tree) => tree.id === id), {}, child.id);
      const removed = await state(page);
      assert.ok(removed.branches.some((branch) => branch.name === child.branch), '작업 공간 삭제 뒤에도 브랜치와 기록이 남는다.');
      assert.equal(removed.documentId, primaryDocumentId);
      recordPass(true, '닫고 다시 열어도 현재 변경을 복구하고 작업 공간 삭제 뒤 브랜치 기록을 유지한다.');

      // 다른 문서를 열어 원본 세션을 교체한 뒤 최근 문서의 디스크 핸들로 다시 연다.
      // 저장하지 않은 원본 작업 공간의 내용이 오래된 디스크 바이트보다 우선해야 한다.
      const recentId = await page.evaluate(async (id) => {
        const { listRecentDocs } = await import('/src/recent/recent-store.ts');
        return (await listRecentDocs()).find((entry) => entry.documentId === id)?.id;
      }, primaryDocumentId);
      assert.ok(recentId);
      await openSample(page, 'text-align-2.hwp');
      await page.evaluate((id) => {
        if (!window.__dispatcher.dispatch('file:open-recent', { id })) throw new Error('최근 문서 열기가 비활성입니다.');
      }, recentId);
      await page.waitForFunction((id) => window.__documentSessions.attached().documentId === id
        && window.__wasm.hasLoadedDocument() && window.__documentSessions.attached().documentState.isDirty(),
      { timeout: 20_000 }, primaryDocumentId);
      const recoveredPrimary = await state(page);
      assert.ok(recoveredPrimary.text.startsWith('CURRENT-DIRTY '));
      assert.equal(recoveredPrimary.hasHandle, true);
      assert.equal(await page.evaluate(() => window.__primaryWrites.length), 0);
      recordPass(true, '최근 문서의 원본 디스크 파일을 다시 열어도 저장하지 않은 작업 내용을 보존한다.');

      const mergedChild = await createWorktree(page, 'lifecycle-merge');
      await edit(page, 'MERGED ');
      await worktreeAction(page, mergedChild, '병합 후 삭제');
      await completeMerge(page);
      await page.waitForFunction((id) => !window.__versionController.getState().worktrees.some((tree) => tree.id === id), { timeout: 20_000 }, mergedChild.id);
      await page.waitForSelector('.merge-resolver-window', { hidden: true });
      const merged = await state(page);
      assert.equal(merged.documentId, primaryDocumentId);
      assert.ok(merged.text.startsWith('MERGED CURRENT-DIRTY '));
      assert.ok(merged.branches.some((branch) => branch.name === mergedChild.branch));
      await page.evaluate(() => {
        if (!window.__dispatcher.dispatch('edit:undo')) throw new Error('병합 실행 취소가 비활성입니다.');
      });
      await page.waitForFunction(() => window.__wasm.getTextRange(0, 0, 0, 20).startsWith('CURRENT-DIRTY '));
      assert.equal((await state(page)).text, recoveredPrimary.text);
      await page.evaluate(() => {
        if (!window.__dispatcher.dispatch('edit:redo')) throw new Error('병합 다시 실행이 비활성입니다.');
      });
      await page.waitForFunction(() => window.__wasm.getTextRange(0, 0, 0, 30).startsWith('MERGED CURRENT-DIRTY '));
      assert.equal((await state(page)).text, merged.text);
      assert.ok((await state(page)).branches.some((branch) => branch.name === mergedChild.branch));
      await screenshot(page, 'worktree-merged-primary');
      recordPass(true, '병합 후 작업 공간을 삭제해도 브랜치 기록과 대상 문서의 실행 취소·다시 실행을 유지한다.');

      // 병합 검토가 열린 뒤 원본에 생긴 변경은 병합 후 정리에서 삭제하지 않는다.
      const racingChild = await createWorktree(page, 'lifecycle-race');
      await edit(page, 'BEFORE-MERGE ');
      await worktreeAction(page, racingChild, '병합 후 삭제');
      await page.waitForSelector('.merge-primary-button', { visible: true, timeout: 20_000 });
      await edit(page, 'LATE-SOURCE ', racingChild.documentId);
      await completeMerge(page);
      await page.waitForFunction(() => window.__wasm.getTextRange(0, 0, 0, 40).startsWith('BEFORE-MERGE '), { timeout: 20_000 });
      const retained = await page.evaluate((id) => {
        const session = window.__documentSessions.list().find((candidate) => candidate.documentId === id);
        return session ? { dirty: session.documentState.isDirty(), text: session.wasm.getTextRange(0, 0, 0, 40) } : null;
      }, racingChild.documentId);
      assert.ok(retained?.dirty);
      assert.ok(retained.text.startsWith('LATE-SOURCE BEFORE-MERGE '));
      assert.ok((await state(page)).worktrees.some((tree) => tree.id === racingChild.id));
      assert.ok((await state(page)).branches.some((branch) => branch.name === racingChild.branch));
      recordPass(true, '병합 검토 중 원본에 추가된 변경과 작업 공간을 삭제하지 않는다.');

      // 두 번째 창은 같은 작업 공간의 잠금을 빼앗지 못한다. 소유 창을 닫은 뒤에는
      // 명시적으로 다시 열어 최신 문서 바이트와 편집 소유권을 함께 얻는다.
      await page.evaluate(async (id) => {
        const source = window.__documentSessions.list().find((session) => session.documentId === id);
        await source.versions.persistWorktree();
        await window.__versionController.whenIdle();
      }, racingChild.documentId);
      const otherWindow = await browser.newPage();
      try {
        await otherWindow.setViewport({ width: 1280, height: 900 });
        await loadApp(otherWindow);
        await otherWindow.waitForFunction(() => Boolean(window.__versionController && window.__documentSessions));
        await openPrimaryWithHandle(otherWindow);
        const denial = await otherWindow.evaluate(async (id) => {
          try { await window.__versionController.openWorktree(id); return null; }
          catch (error) { return error.message; }
        }, racingChild.id);
        assert.match(denial, /다른 창/);
        assert.equal(await otherWindow.evaluate((id) => window.__documentSessions.list()
          .some((session) => session.documentId === id && session.worktreeWritable)), false, racingChild.documentId);
        await page.close();
        await otherWindow.evaluate((id) => window.__versionController.openWorktree(id), racingChild.id);
        const takeover = await state(otherWindow);
        assert.equal(takeover.documentId, racingChild.documentId);
        assert.ok(takeover.text.startsWith('LATE-SOURCE BEFORE-MERGE '));
        assert.equal(takeover.dirtyDocument, true);
        assert.equal(await otherWindow.evaluate(() => window.__documentSessions.attached().worktreeWritable), true);
        await showWorktrees(otherWindow);
        await screenshot(otherWindow, 'worktree-second-window-takeover');
        recordPass(true, '두 번째 창의 소유권 획득을 거절하고 기존 창을 닫은 뒤 최신 내용으로 다시 연다.');
      } finally {
        await otherWindow.close();
      }
      console.log('워크트리 생성·격리·저장·내보내기·복구·삭제·병합·동시 편집 보존 통과');
    } catch (error) {
      console.error(error.stack);
      throw error;
    }
  });
} finally {
  await stopServer(vite);
  await stopServer(hub);
  removeTempDir(fixtureRoot);
}

// Puppeteer와 자식 프로세스의 남은 핸들이 종료를 막을 수 있다. 모든 검증·정리를 마친 뒤 종료한다.
process.exit(process.exitCode ? 1 : 0);
