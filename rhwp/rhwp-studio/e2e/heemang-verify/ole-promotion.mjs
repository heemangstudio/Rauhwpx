/** 레거시 OLE 수식의 변환·편집 진입·실행 취소와 저장 파일 재열기를 실제 UI에서 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as L from './lib.mjs';

const app = await L.startApp('candidate', L.candidateRoot, 5723);
const browser = await L.launchBrowser();
const { page, log } = await L.newPage(browser);
const out = L.ensureOut('ole-promotion');
const fixture = path.join(L.candidateRoot, 'rhwp/tests/fixtures/legacy-equation-body.hwpx');
const object = { section: 0, para: 4, control: 0 };
const select = () => page.evaluate(() => {
  const ih = window.__inputHandler;
  ih.selectPictureObject(0, 4, 0, 'ole'); ih.focus();
  ih.contextMenu.show(450, 300, [{ type: 'command', commandId: 'insert:equation-edit', label: '수식으로 변환하여 편집...' }]);
});
try {
  await L.loadApp(page, app.url);
  await L.openDocumentFile(page, fixture);
  const before = await page.evaluate(o => JSON.parse(window.__wasm.viewer.hmDoc().query(JSON.stringify({ kind: 'objectProperties', object: o }))), object);
  assert.equal(before.objectId, 1701116216); assert.equal(before.instanceId, 627374393);
  await select();
  await page.click('.context-menu [data-cmd="insert:equation-edit"]');
  await page.waitForSelector('.eq-dialog .eq-script', { visible: true });
  const script = await page.$eval('.eq-dialog .eq-script', element => element.value);
  assert.match(script, /TIMES/); assert.match(script, /over\s*\{75\}/);
  const converted = await page.evaluate(() => window.__wasm.getEquationProperties(0, 4, 0));
  for (const key of ['width', 'height', 'zOrder', 'instanceId']) assert.equal(converted[key], before[key], key);
  assert.equal(converted.fontSize, 950); assert.equal(converted.baseline, 60);
  await page.screenshot({ path: path.join(out, 'equation-editor.png') });
  await page.click('.eq-dialog .dialog-close');
  await page.evaluate(() => window.__inputHandler.focus());
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  await L.waitFor(page, 'OLE promotion undo', () => window.__wasm.core.paragraph({ section: 0, steps: [] }, 4).controls[0].kind !== 'equation');
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  await L.waitFor(page, 'OLE promotion redo', () => window.__wasm.core.paragraph({ section: 0, steps: [] }, 4).controls[0].kind === 'equation');
  const saved = [];
  for (const format of ['hwp5', 'hwpx']) {
    const bytes = await page.evaluate(format => [...window.__wasm.viewer.hmDoc().serializeAs(format, false)], format);
    const target = path.join(out, `promoted.${format === 'hwp5' ? 'hwp' : 'hwpx'}`);
    fs.writeFileSync(target, Buffer.from(bytes));
    await L.openDocumentFile(page, target);
    const reopened = await page.evaluate(() => window.__wasm.getEquationProperties(0, 4, 0));
    assert.equal(reopened.script, script); assert.equal(reopened.instanceId, before.instanceId);
    assert.equal(reopened.width, before.width); assert.equal(reopened.height, before.height);
    saved.push({ format, script: reopened.script, instanceId: reopened.instanceId });
  }
  // 읽을 수 없는 OLE 저장소를 가진 실제 문서로 같은 메뉴 동작의 실패 경로를 확인한다.
  const unknown = path.join(out, 'unknown-ole.hwpx');
  execFileSync('python3', ['-c', `import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2],'w') as dst:\n for member in src.infolist():\n  data=b'Unknown OLE storage' if member.filename.lower().endswith('.ole') else src.read(member.filename)\n  dst.writestr(member,data)`, fixture, unknown]);
  await L.openDocumentFile(page, unknown);
  const failureBefore = await page.evaluate(() => ({ bytes: [...window.__wasm.viewer.hmDoc().serialize(false)], undo: window.__inputHandler.canUndo() }));
  await select();
  const rejection = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { page.off('console', onConsole); reject(new Error('OLE rejection was not reported')); }, 10000);
    const onConsole = message => {
      if (message.type() === 'error' && message.text().includes('insert:equation-edit')) {
        clearTimeout(timer); page.off('console', onConsole); resolve();
      }
    };
    page.on('console', onConsole);
  });
  await page.click('.context-menu [data-cmd="insert:equation-edit"]');
  await rejection;
  const failureAfter = await page.evaluate(() => ({ bytes: [...window.__wasm.viewer.hmDoc().serialize(false)], undo: window.__inputHandler.canUndo(), dialog: !!document.querySelector('.eq-dialog')?.getClientRects().length }));
  assert.deepEqual(failureAfter.bytes, failureBefore.bytes); assert.equal(failureAfter.undo, failureBefore.undo); assert.equal(failureAfter.dialog, false);
  assert.equal(L.rhwpEngineRequests(log).length, 0);
  const report = { url: app.url, script, sourceIdentity: { objectId: before.objectId, instanceId: before.instanceId }, frame: { width: converted.width, height: converted.height, instanceId: converted.instanceId }, saved, unknownOleAtomic: true, pageErrors: log.pageErrors };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({ pageErrors: log.pageErrors.slice(-5), console: log.console.slice(-8) }));
  throw error;
} finally { await browser.close(); await app.stop(); }
