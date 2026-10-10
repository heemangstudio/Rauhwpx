/** 선택 의견은 명시적으로 준비하고, 로컬 저장 뒤 일반 입력기 보내기에서만 전달한다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import {
  ensureChat, ensureChromePath, findAvailablePort, startHub, stopServer, studioRoot, writeFakePi,
} from './agent-bench-harness.mjs';

ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-selection-e2e-'));
const { piRoot } = writeFakePi(fixtureRoot);
const hubPort = await findAvailablePort(5810);
const token = 'selection-fixture';
const hub = await startHub({ hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'selection-e2e-hub.log' });
process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`;
process.env.RHWP_AGENT_TOKEN = token;
process.env.RHWP_AGENT_PORT = String(hubPort);
const server = await createServer({
  configFile: path.join(studioRoot, 'vite.config.ts'), cacheDir: path.join(fixtureRoot, 'vite-cache'),
  server: {
    port: await findAvailablePort(7810), strictPort: true, host: '127.0.0.1', open: false,
    fs: { allow: [studioRoot, fs.realpathSync(path.join(studioRoot, '..', 'pkg')),
      path.join(studioRoot, '..', 'samples'), path.join(studioRoot, '..', 'npm', 'editor')] },
  },
  logLevel: 'warn',
});
await server.listen();
process.env.VITE_URL = `http://127.0.0.1:${server.httpServer.address().port}`;
const { runTest, createNewDocument, clickEditArea, typeText, waitForState, screenshot, setTestCase } = await import('./helpers.mjs');

try {
  await runTest('선택 의견 로컬 저장 및 일반 입력기 전송', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await createNewDocument(page);
    await ensureChat(page);
    await clickEditArea(page);
    await typeText(page, '선택 의견은 일반 입력기의 보내기를 눌러 전달합니다');
    await page.evaluate(() => {
      const bridge = window.__agentBridge;
      const original = bridge.sendUserMessage.bind(bridge);
      window.__captureSendCalls = [];
      bridge.sendUserMessage = (...args) => {
        window.__captureSendCalls.push(args);
        return original(...args);
      };
    });
    const drag = async (from = 0, to = 8) => {
      const points = await page.evaluate((a, b) => {
        const view = window.__canvasView;
        const content = document.getElementById('scroll-content');
        const bounds = content.getBoundingClientRect();
        const zoom = view.viewportManager.getZoom();
        const project = (offset) => {
          const rect = window.__wasm.getCursorRect(0, 0, offset);
          return {
            x: bounds.left + (view.virtualScroll.getPageLeft(rect.pageIndex) >= 0 ? view.virtualScroll.getPageLeft(rect.pageIndex) : (content.clientWidth - view.virtualScroll.getPageWidth(rect.pageIndex)) / 2) + rect.x * zoom,
            y: bounds.top + view.virtualScroll.getPageOffset(rect.pageIndex) + (rect.y + rect.height / 2) * zoom,
          };
        };
        return [project(a), project(b)];
      }, from, to);
      await page.mouse.move(points[0].x + 1, points[0].y);
      await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 8 });
      await page.mouse.up();
      await waitForState(page, 'settled selection check', () => window.__inlinePrompt.checkTimer === null && !window.__inlinePrompt.pointerActive);
    };
    const arm = async () => {
      await page.keyboard.press('Control');
      await page.keyboard.press('Control');
      await waitForState(page, 'armed next selection', () => document.getElementById('scroll-container').classList.contains('ag-inline-armed'));
    };

    setTestCase('일반 선택에는 칩이 없고 Ctrl 두 번은 다음 선택을 기다린다');
    await drag();
    assert.equal(await page.evaluate(() => !document.querySelector('.ag-inline-chip') || document.querySelector('.ag-inline-chip').hidden), true);
    await arm();
    assert.equal(await page.evaluate(() => !document.querySelector('.ag-inline-chip') || document.querySelector('.ag-inline-chip').hidden), true);
    await screenshot(page, 'selection-armed-border');
    await drag(2, 12);
    await waitForState(page, 'explicit selection chip', () => !document.querySelector('.ag-inline-chip').hidden);

    setTestCase('의견 첨부는 로컬에 저장하고 자동 전송하지 않는다');
    await page.click('.ag-inline-chip');
    await waitForState(page, 'selection opinion editor', () => !document.querySelector('.ag-inline-box').hidden);
    await page.type('.ag-inline-input', '이 부분을 간결하게 다듬어 주세요.');
    await page.click('.ag-inline-send');
    await waitForState(page, 'saved capture pill', () => !!document.querySelector('.ag-capture-pill') && document.querySelector('.ag-inline-box').hidden);
    assert.equal(await page.evaluate(() => window.__captureSendCalls.length), 0);
    const saved = await page.evaluate(async () => {
      const { listCaptureDrafts } = await import('/src/agent/agent-context-store.ts');
      const id = window.__agentBridge.getDocumentSelectionIdentity().documentId;
      const drafts = await listCaptureDrafts(id);
      window.__captureDocumentId = id;
      return drafts.map((draft) => ({ id: draft.id, comment: draft.comment, items: draft.selection.items, files: draft.files.map((file) => file.name) }));
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].comment, '이 부분을 간결하게 다듬어 주세요.');
    assert.equal(saved[0].items[0].kind, 'text');
    assert.ok(saved[0].files.some((name) => name.endsWith('.json')));
    await screenshot(page, 'selection-local-composer-pill');

    setTestCase('전송 거부 후에는 첨부와 본문을 보존하고 일반 보내기로 재시도한다');
    await page.evaluate(() => {
      const bridge = window.__agentBridge;
      window.__captureRealSend = bridge.sendUserMessage.bind(bridge);
      bridge.sendUserMessage = () => Promise.resolve(null);
    });
    await page.type('.ag-input', '첨부한 의견대로 수정해 주세요.');
    await page.click('.ag-send');
    await waitForState(page, 'rejected capture preserved', () => !document.querySelector('.ag-input').disabled && !!document.querySelector('.ag-capture-pill'));
    assert.equal(await page.$eval('.ag-input', (input) => input.value), '첨부한 의견대로 수정해 주세요.');
    assert.equal(await page.evaluate(async () => (await (await import('/src/agent/agent-context-store.ts')).listCaptureDrafts(window.__captureDocumentId)).length), 1);
    await page.evaluate(() => { window.__agentBridge.sendUserMessage = window.__captureRealSend; });
    await page.click('.ag-send');
    await waitForState(page, 'accepted capture consumed', () => !document.querySelector('.ag-capture-pill') && document.querySelector('.ag-input').value === '');
    assert.equal(await page.evaluate(() => window.__captureSendCalls.length), 1);
    const sent = await page.evaluate(() => window.__captureSendCalls[0]);
    assert.ok(sent[0].includes('[선택 컨텍스트]'));
    assert.ok(sent[0].includes('이 부분을 간결하게 다듬어 주세요.'));
    assert.equal(sent[2].length, 1, 'text annotation metadata is bundled into one attachment');
    assert.equal(sent[6].requireAcceptance, true);
    assert.equal(await page.evaluate(async () => (await (await import('/src/agent/agent-context-store.ts')).listCaptureDrafts(window.__captureDocumentId)).length), 0);
    const statuses = await page.evaluate(() => [...document.querySelectorAll('.ag-msg-attachment')].map((pill) => pill.textContent));
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((text) => !text.includes('처리 중')));
    await screenshot(page, 'selection-explicit-composer-sent');
    let chipVisible;
  setTestCase('이미지 선택은 정확한 주소와 실제 PNG 첨부를 캡처한다');
  await createNewDocument(page);
  const insertedImage = await page.evaluate(() => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const raw = atob(base64);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const result = window.__wasm.insertPicture(
      0, 0, 0, '[]', bytes, 7200, 3600, 1, 1, 'png', '선택 이미지', undefined, undefined, 'inline',
    );
    window.__eventBus.emit('document-mutated', 'inline-prompt-image-test');
    return result;
  });
  await arm();
  await page.evaluate(({ paraIdx, controlIdx }) => window.__inputHandler.selectPictureObject(0, paraIdx, controlIdx, 'image'), insertedImage);
  await waitForState(page, 'image chip', () => { const c=document.querySelector('.ag-inline-chip'); return c && !c.hidden && c.checkVisibility(); });
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '이미지를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await waitForState(page, 'PNG capture', () => window.__inlinePrompt?.captured?.attachments?.[0]?.size > 0);
  const imageCapture = await page.evaluate(() => {
    const captured = window.__inlinePrompt?.captured;
    const item = captured?.items?.[0];
    const attachment = captured?.attachments?.[0];
    return {
      kind: item?.kind,
      objectType: item?.objectType,
      controlIdx: item?.address?.controlIdx,
      description: item?.description,
      attachmentName: item?.attachmentName,
      attachmentType: attachment?.type,
      attachmentSize: attachment?.size ?? 0,
      revision: captured?.revision,
    };
  });
  assert(imageCapture.kind === 'object' && imageCapture.objectType === 'image', '이미지 typed item을 캡처해야 함');
  assert(imageCapture.controlIdx === insertedImage.controlIdx, '선택 이미지의 정확한 controlIdx를 보존해야 함');
  assert(imageCapture.description === '선택 이미지', '이미지 설명을 보존해야 함');
  assert(imageCapture.attachmentName === 'selected-image-1.png', '이미지 item과 첨부 이름을 연결해야 함');
  assert(imageCapture.attachmentType === 'image/png' && imageCapture.attachmentSize > 0,
    '선택 이미지의 실제 PNG 내용이 첨부되어야 함');
  assert(Number.isInteger(imageCapture.revision), '선택 캡처에 문서 revision이 있어야 함');
  const imageChip = await page.evaluate(() => ({
    text: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
    hasPreview: Boolean(document.querySelector('.ag-inline-selection-item img')),
  }));
  assert(imageChip.text === '이미지' && imageChip.hasPreview, '이미지 칩에 축소 미리보기를 표시해야 함');
  await page.keyboard.press('Escape');

  setTestCase('이미지 미리보기 캡처 실패는 전송을 막고 재시도를 안내한다');
  await page.evaluate(({ paraIdx, controlIdx }) => {
    const controller = window.__inlinePrompt;
    window.__origRenderObjectCrop = controller.renderObjectCrop;
    controller.renderObjectCrop = async () => null;
    window.__inputHandler.cursor.exitPictureObjectSelection();
  }, insertedImage);
  await arm();
  await page.evaluate(({ paraIdx, controlIdx }) => window.__inputHandler.selectPictureObject(0, paraIdx, controlIdx, 'image'), insertedImage);
  await waitForState(page, 'image reselect chip', () => { const c=document.querySelector('.ag-inline-chip'); return c && !c.hidden && c.checkVisibility(); });
  await page.click('.ag-inline-chip');
  await waitForState(page, 'capture failure', () => document.querySelector('.ag-inline-error')?.textContent?.includes('미리보기'));
  const failedImageCapture = await page.evaluate(() => ({
    boxVisible: !document.querySelector('.ag-inline-box')?.hidden,
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    sendDisabled: document.querySelector('.ag-inline-send')?.disabled ?? false,
    captured: window.__inlinePrompt?.captured ?? null,
  }));
  assert(failedImageCapture.boxVisible && failedImageCapture.error.includes('미리보기'),
    '캡처 실패 이유를 열린 상자에 표시해야 함');
  assert(failedImageCapture.sendDisabled && failedImageCapture.captured === null,
    '시각 자료 없이 이미지 선택을 전송할 수 없어야 함');
  await page.evaluate(() => {
    window.__inlinePrompt.renderObjectCrop = window.__origRenderObjectCrop;
  });
  await page.keyboard.press('Escape');

  setTestCase('수식 선택은 정확한 주소·스크립트·미리보기를 캡처한다');
  await createNewDocument(page);
  const insertedEquation = await page.evaluate(() => {
    const result = window.__wasm.insertEquation(0, 0, 0, 'x^2 + y^2', 1100, 0);
    window.__eventBus.emit('document-mutated', 'inline-prompt-equation-test');
    return result;
  });
  await arm();
  await page.evaluate(({ paraIdx, controlIdx }) => { window.__inputHandler.cursor.enterPictureObjectSelectionDirect(0, paraIdx, controlIdx, 'equation'); window.__eventBus.emit('picture-object-selection-changed', true); }, insertedEquation);
  await waitForState(page, 'equation chip', () => { const c=document.querySelector('.ag-inline-chip'); return c && !c.hidden && c.checkVisibility(); });
  await page.click('.ag-inline-chip');
  await waitForState(page, 'equation capture', () => window.__inlinePrompt?.captured?.items?.[0]?.kind === 'equation');
  const equationCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      kind: item?.kind,
      controlIdx: item?.address?.controlIdx,
      script: item?.script,
      attachmentName: item?.attachmentName,
      chipText: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
      hasPreview: Boolean(document.querySelector('.ag-inline-selection-item img')),
    };
  });
  assert(equationCapture.kind === 'equation' && equationCapture.controlIdx === insertedEquation.controlIdx,
    '수식 typed item에 정확한 controlIdx를 보존해야 함');
  assert(equationCapture.script === 'x^2 + y^2' && equationCapture.attachmentName,
    '수식 스크립트와 렌더링 첨부를 캡처해야 함');
  assert(equationCapture.chipText.includes('x^2 + y^2') && equationCapture.hasPreview,
    '수식 칩에 스크립트와 축소 미리보기를 표시해야 함');
  await page.keyboard.press('Escape');

  setTestCase('표 선택은 셀 구조와 전체 표 범위를 구분해 캡처한다');
  await createNewDocument(page);
  const insertedTable = await page.evaluate(() => {
    const result = window.__wasm.createTable(0, 0, 0, 2, 2);
    window.__eventBus.emit('document-mutated', 'inline-prompt-table-test');
    return result;
  });
  await arm();
  await page.evaluate(({ paraIdx, controlIdx }) => { window.__inputHandler.cursor.enterTableObjectSelectionDirect(0, paraIdx, controlIdx); window.__eventBus.emit('table-object-selection-changed', true); }, insertedTable);
  await waitForState(page, 'table chip', () => { const c=document.querySelector('.ag-inline-chip'); return c && !c.hidden && c.checkVisibility(); });
  chipVisible = await page.evaluate(() => {
    const chip = document.querySelector('.ag-inline-chip');
    return !!chip && !chip.hidden;
  });
  assert(chipVisible, '표를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await waitForState(page, 'table capture', () => window.__inlinePrompt?.captured?.items?.[0]?.kind === 'table');
  const tableCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      kind: item?.kind,
      controlIdx: item?.address?.controlIdx,
      rowCount: item?.rowCount,
      colCount: item?.colCount,
      cellCount: item?.cells?.length,
      selectedRange: item?.selectedRange,
    };
  });
  assert(tableCapture.kind === 'table', '표 typed item을 캡처해야 함');
  assert(tableCapture.controlIdx === insertedTable.controlIdx, '선택 표의 정확한 controlIdx를 보존해야 함');
  assert(tableCapture.rowCount === 2 && tableCapture.colCount === 2 && tableCapture.cellCount === 4,
    '표 크기와 셀 구조를 캡처해야 함');
  assert(tableCapture.selectedRange === undefined, '표 객체 선택을 셀 범위 선택으로 잘못 표시하면 안 됨');
  await page.keyboard.press('Escape');

  setTestCase('셀 범위 선택은 정확한 행·열 범위와 표 크기를 캡처한다');
  await arm();
  const selectedCells = await page.evaluate(async ({ paraIdx, controlIdx }) => {
    const ih = window.__inputHandler;
    const bboxes = window.__wasm.getTableCellBboxes(0, paraIdx, controlIdx, 0) || [];
    const cell = bboxes.find((box) => box.row === 1 && box.col === 1);
    ih.cursor.exitTableObjectSelection();
    ih.cursor.moveToCellByIndex(0, paraIdx, controlIdx, undefined, cell.cellIdx, 'start');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    ih.cursor.enterCellSelectionMode();
    ih.cursor.advanceCellSelectionPhase();
    ih.cursor.expandCellSelection(0, -1);
    window.__eventBus.emit('table-object-selection-changed', true);
    return ih.cursor.getSelectedCellRange();
  }, insertedTable);
  assert(selectedCells.startRow === 1 && selectedCells.endRow === 1
    && selectedCells.startCol === 0 && selectedCells.endCol === 1, '테스트 셀 범위를 준비해야 함');
  await waitForState(page, 'cell range chip', () => { const c=document.querySelector('.ag-inline-chip'); return c && !c.hidden && c.checkVisibility(); });
  chipVisible = await page.evaluate(() => !document.querySelector('.ag-inline-chip')?.hidden);
  assert(chipVisible, '셀 범위를 선택하면 인라인 프롬프트 칩이 보여야 함');
  await page.click('.ag-inline-chip');
  await waitForState(page, 'cell range capture', () => !!window.__inlinePrompt?.captured?.items?.[0]?.selectedRange);
  const cellRangeCapture = await page.evaluate(() => {
    const item = window.__inlinePrompt?.captured?.items?.[0];
    return {
      selectedRange: item?.selectedRange,
      chipText: document.querySelector('.ag-inline-selection-item-label')?.textContent ?? '',
    };
  });
  assert(JSON.stringify(cellRangeCapture.selectedRange) === JSON.stringify(selectedCells),
    'typed table item에 정확한 셀 범위를 보존해야 함');
  assert(cellRangeCapture.chipText === '표 2×2 · 2–2행, 1–2열', '표 칩에 크기와 셀 범위를 표시해야 함');

  setTestCase('캡처 뒤 revision 변경은 전송하지 않고 재선택을 요구한다');
  await page.type('.ag-inline-input', '이 셀들을 요약해 줘');
  await page.evaluate(() => {
    window.__staleSubmitCalls = 0;
    window.__inlinePrompt.deps.submit = () => {
      window.__staleSubmitCalls++;
      return Promise.resolve({ ok: true });
    };
    window.__eventBus.emit('document-mutated', 'inline-prompt-stale-test');
  });
  await page.keyboard.press('Enter');
  await waitForState(page, 'stale revision notice', () => document.querySelector('.ag-inline-error')?.textContent?.includes('다시 선택'));
  const staleState = await page.evaluate(() => ({
    calls: window.__staleSubmitCalls,
    draft: document.querySelector('.ag-inline-input')?.value ?? '',
    error: document.querySelector('.ag-inline-error')?.textContent ?? '',
    itemCount: window.__inlinePrompt?.captured?.items?.length ?? 0,
  }));
  assert(staleState.calls === 0 && staleState.error.includes('다시 선택'),
    'stale revision은 transport 호출 전에 차단해야 함');
  assert(staleState.draft === '이 셀들을 요약해 줘' && staleState.itemCount === 1,
    `stale revision에서도 초안과 typed 선택을 보존해야 함 (${JSON.stringify(staleState)})`);
  await page.keyboard.press('Escape');


    assert.deepEqual(errors, []);
  });
} finally {
  await server.close();
  await stopServer(hub);
}
