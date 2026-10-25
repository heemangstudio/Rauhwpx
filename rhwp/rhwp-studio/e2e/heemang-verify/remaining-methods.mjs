/** 실제 메뉴로 전치 붙여넣기·실행 취소·저장 재열기를 검증한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

const app = await L.startApp('candidate', L.candidateRoot, 5723);
const browser = await L.launchBrowser();
const { page, log } = await L.newPage(browser);
const out = L.ensureOut('remaining-methods');
try {
  await L.loadApp(page, app.url + '&renderer=canvaskit');
  await L.openDocumentFile(page, path.join(L.candidateRoot, 'rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx'));
  const table = await page.evaluate(() => {
    const w = window.__wasm, ih = window.__inputHandler;
    const table = w.createTable(0, 0, 0, 2, 3);
    for (let i = 0; i < 6; i++) w.insertTextInCell(0, table.paraIdx, table.controlIdx, i, 0, 0, `LIVE${i}`);
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: table.paraIdx, controlIndex: table.controlIdx, cellIndex: 0, cellParaIndex: 0 });
    window.__eventBus.emit('document-changed');
    ih.focus();
    return table;
  });
  await page.keyboard.press('F5'); await page.keyboard.press('F5'); await page.keyboard.press('F5');
  assert.equal(await page.evaluate(() => window.__inputHandler.isInCellSelectionMode()), true);
  // 같은 production context-menu 항목을 실제 마우스로 누른다.
  await page.evaluate(() => window.__inputHandler.contextMenu.show(450, 300, [
    { type: 'command', commandId: 'table:transpose-copy' },
    { type: 'command', commandId: 'table:transpose-paste' },
  ]));
  await page.click('.context-menu [data-cmd="table:transpose-copy"]');
  assert.equal(await page.evaluate(() => window.__wasm.hasTableTransposeClipboard()), true);
  await page.evaluate(() => window.__inputHandler.contextMenu.show(450, 300, [
    { type: 'command', commandId: 'table:transpose-paste' },
  ]));
  await page.click('.context-menu [data-cmd="table:transpose-paste"]');
  const result = await page.evaluate(t => {
    const w = window.__wasm;
    return { dimensions: w.getTableDimensions(0,t.paraIdx,t.controlIdx),
      text: w.core.paragraph({section:0,steps:[{para:t.paraIdx,control:t.controlIdx,index:1}]},0).text,
      backend: window.__renderBackend, replay: typeof w.getCanvasKitReplayPlan, preflight: typeof w.getCanvasKitDocumentPreflight };
  }, table);
  assert.equal(result.dimensions.rowCount, 3); assert.equal(result.dimensions.colCount, 2); assert.equal(result.text, 'LIVE3');
  assert.equal(result.backend, 'canvas2d'); assert.equal(result.replay, 'undefined'); assert.equal(result.preflight, 'undefined');
  await page.screenshot({ path: path.join(out, 'transposed-table.png') });
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  await L.waitFor(page, 'transpose undo', t => window.__wasm.getTableDimensions(0,t.paraIdx,t.controlIdx).rowCount === 2, { args: [table] });
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  await L.waitFor(page, 'transpose redo', t => window.__wasm.getTableDimensions(0,t.paraIdx,t.controlIdx).rowCount === 3, { args: [table] });
  const saved = await page.evaluate(t => {
    const w=window.__wasm;
    return ['hwp5','hwpx'].map(format => {
      const doc=w.viewer.hmEngine().open(w.viewer.hmDoc().serializeAs(format,false));
      try { const list={section:0,steps:[{para:t.paraIdx,control:t.controlIdx,index:1}]}; const text=JSON.parse(doc.query(JSON.stringify({kind:'paragraphs',list})))[0].text; return {format,text}; } finally {doc.free();}
    });
  },table);
  for (const value of saved) assert.equal(value.text,'LIVE3');
  await page.evaluate(t => {
    const ih=window.__inputHandler;
    ih.cursor.exitCellSelectionMode();
    ih.cursor.moveTo({sectionIndex:0,paragraphIndex:0,charOffset:0,parentParaIndex:t.paraIdx,controlIndex:t.controlIdx,cellIndex:0,cellParaIndex:0});
    ih.focus();
  },table);
  await page.keyboard.press('F5');
  await page.evaluate(() => {
    window.__cellClipboardFixture = new DataTransfer();
    window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:window.__cellClipboardFixture}));
  });
  await L.waitFor(page,'cell-block clipboard',()=>window.__wasm.getClipboardText()==='LIVE0');
  await page.evaluate(t => {
    const w=window.__wasm;
    w.clearTableCellRange(0,t.paraIdx,JSON.stringify([{controlIndex:t.controlIdx,cellIndex:0,cellParaIndex:0}]),0,0,0,0);
    window.__eventBus.emit('document-changed');
    window.__inputHandler.focus();
  },table);
  await page.evaluate(() => window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:window.__cellClipboardFixture})));
  await L.waitFor(page,'cell-block paste',t=>window.__wasm.core.paragraph({section:0,steps:[{para:t.paraIdx,control:t.controlIdx,index:0}]},0).text==='LIVE0',{args:[table]});
  // 기존 머리말 서식 명령의 실행 취소를 실제 키 입력으로 확인한다.
  await page.evaluate(() => {
    const w=window.__wasm,ih=window.__inputHandler;
    ih.cursor.exitCellSelectionMode();
    w.createHeaderFooter(0,true,0); w.insertTextInHeaderFooter(0,true,0,0,0,'A😀B');
    w.applyCharFormatInHf(0,true,0,0,0,3,'{"bold":false}');
    ih.history.clear(w);
    ih.cursor.enterHeaderFooterMode(true,0,0,0);
    ih.cursor.selectAllInHeaderFooter();
    ih.focus(); window.__eventBus.emit('document-changed');
  });
  await page.keyboard.down('Meta'); await page.keyboard.press('b'); await page.keyboard.up('Meta');
  await L.waitFor(page,'header bold',()=>window.__wasm.getCharPropertiesInHf(0,true,0,0,1).bold===true);
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  await L.waitFor(page,'header shape restore',()=>window.__wasm.getCharPropertiesInHf(0,true,0,0,1).bold===false);
  assert.equal(L.rhwpEngineRequests(log).length,0);
  const report={url:app.url,action:'Context-menu transpose copy/paste, keyboard undo/redo, HWP/HWPX save/reopen, fixture-backed browser clipboard events for cell-block copy/paste, header bold/undo',result,saved,pageErrors:log.pageErrors};
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({pageErrors:log.pageErrors.slice(-5),console:log.console.slice(-8),state:await page.evaluate(()=>({bold:window.__wasm?.getCharPropertiesInHf(0,true,0,0,1),history:window.__inputHandler?.history?.canUndo(),hf:window.__inputHandler?.cursor?.isInHeaderFooter()})).catch(()=>null)}));
  throw error;
} finally { await browser.close(); await app.stop(); }
