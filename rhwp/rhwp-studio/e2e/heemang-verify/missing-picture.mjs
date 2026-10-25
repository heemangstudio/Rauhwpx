/** 실제 편집기에서 미지정 그림 더블클릭·파일 선택·취소·실패·실행 취소와 저장을 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as L from './lib.mjs';

const out = L.ensureOut('missing-picture');
const source = path.join(L.candidateRoot, 'rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx');
const missingHwpx = path.join(out, 'missing.hwpx');
// 원본 틀을 남기고 그림 참조를 미지정(0)으로 바꾼다. 선언한 리소스가 사라진 손상 파일과 구분한다.
execFileSync('python3', ['-c', `import sys,zipfile,re
with zipfile.ZipFile(sys.argv[1]) as src,zipfile.ZipFile(sys.argv[2],'w') as dst:
 for member in src.infolist():
  if member.filename.startswith('BinData/'): continue
  data=src.read(member.filename)
  if member.filename=='Contents/section0.xml': data=data.replace(b'binaryItemIDRef="image1"',b'binaryItemIDRef="0"')
  if member.filename=='Contents/content.hpf': data=re.sub(rb'<opf:item[^>]* id="image1"[^>]*/>',b'',data)
  dst.writestr(member,data)`, source, missingHwpx]);
const png = new L.PNG({ width: 32, height: 24 });
for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
  const offset = (y * png.width + x) * 4;
  png.data.set((x + y) % 8 < 4 ? [230, 40, 65, 255] : [250, 210, 40, 255], offset);
}
const image = L.PNG.sync.write(png);
const validFile = path.join(out, 'replacement.png');
const invalidFile = path.join(out, 'invalid.png');
fs.writeFileSync(validFile, image); fs.writeFileSync(invalidFile, 'This file is not an encoded image.');
const wasm = fs.readFileSync(path.join(L.candidateRoot, 'rhwp/rhwp-studio/vendor/hm-wasm/hm_wasm_bg.wasm'));
const app = await L.startApp('candidate', L.candidateRoot, 5723);
let browser, page, log;
const report = { url: app.url, provider: 'fixture-backed local hub; no provider calls',
  fixture: 'Real mixed-text picture frame with unassigned binDataId0 and no declared image item; HWP generated through exportHwp',
  wasmBytes: wasm.length, wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  replacement: { width: png.width, height: png.height, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') }, runs: [] };

try {
  browser = await L.launchBrowser();
  ({ page, log } = await L.newPage(browser));
  await L.loadApp(page, app.url);
  await L.openDocumentFile(page, missingHwpx);
  const missingHwp = path.join(out, 'missing.hwp');
  fs.writeFileSync(missingHwp, Buffer.from(await page.evaluate(() => [...window.__wasm.exportHwp()])));
  for (const [name, fixture] of [['hwpx', missingHwpx], ['hwp', missingHwp]]) {
    console.log(`${name}: missing-picture assignment`);
    await L.openDocumentFile(page, fixture);
    const target = await page.evaluate(() => {
      const image = window.__wasm.getPageControlLayout(0).controls.find(item => item.type === 'image');
      if (!image?.missing) throw new Error('The fixture did not expose a missing picture');
      return { section: image.secIdx, para: image.paraIdx, control: image.controlIdx };
    });
    const properties = () => page.evaluate(at => JSON.parse(window.__wasm.viewer.hmDoc().query(JSON.stringify({ kind: 'objectProperties', object: at }))), target);
    const state = () => page.evaluate(() => ({ bytes: [...window.__wasm.viewer.hmDoc().serialize(false)],
      undo: window.__inputHandler.canUndo(), redo: window.__inputHandler.canRedo() }));
    const data = () => page.evaluate(at => [...window.__wasm.getControlImageData(at.section, at.para, at.control)], target);
    const original = await properties();
    const before = await state();
    const frame = Object.fromEntries(['width', 'height', 'horzOffset', 'vertOffset', 'zOrder', 'instanceId', 'description', 'pictureMargins']
      .map(key => [key, original[key]]).filter(([, value]) => value !== undefined));
    const assertFrame = async () => {
      const current = await properties();
      for (const [key, value] of Object.entries(frame)) assert.deepEqual(current[key], value, key);
    };
    const openPicker = async () => {
      const point = await page.evaluate(at => {
        const image = window.__wasm.getPageControlLayout(0).controls.find(item => item.type === 'image'
          && item.secIdx === at.section && item.paraIdx === at.para && item.controlIdx === at.control);
        const content = document.querySelector('#scroll-content'), box = content.getBoundingClientRect();
        const view = window.__canvasView, zoom = view.getViewportManager().getZoom();
        return { x: box.left + view.getVirtualScroll().getPageLeftResolved(0, content.clientWidth) + (image.x + image.w / 2) * zoom,
          y: box.top + view.getVirtualScroll().getPageOffset(0) + (image.y + image.h / 2) * zoom };
      }, target);
      await page.mouse.click(point.x, point.y);
      await L.waitFor(page, 'missing picture selected by mouse', () => window.__inputHandler.cursor.getSelectedPictureRef()?.missing === true);
      const chooser = page.waitForFileChooser({ timeout: 10000 });
      await page.mouse.click(point.x, point.y, { count: 2 });
      return chooser;
    };
    await page.screenshot({ path: path.join(out, `${name}-missing.png`) });
    const cancelled = await openPicker();
    await cancelled.cancel();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
    assert.deepEqual(await state(), before, 'cancel leaves document and history unchanged');
    const invalid = await openPicker();
    await invalid.accept([invalidFile]);
    await L.waitFor(page, 'invalid image rejection toast', () => [...document.querySelectorAll('.rhwp-toast-message')]
      .some(element => element.textContent.includes('그림을 지정할 수 없습니다.')));
    assert.deepEqual(await state(), before, 'invalid image leaves document and history unchanged');
    await page.screenshot({ path: path.join(out, `${name}-invalid.png`) });
    for (const close of await page.$$('.rhwp-toast-close')) await close.click();
    const valid = await openPicker();
    await valid.accept([validFile]);
    await L.waitFor(page, 'assigned image appears', () => window.__wasm.getPageControlLayout(0).controls
      .filter(item => item.type === 'image').every(item => !item.missing));
    assert.deepEqual(await data(), [...image]); await assertFrame();
    assert.deepEqual((await properties()).crop, [0, 0, png.width * 75, png.height * 75]);
    await page.screenshot({ path: path.join(out, `${name}-assigned.png`) });
    const undo = async redo => {
      await page.evaluate(() => window.__inputHandler.focus());
      await page.keyboard.down('Meta'); if (redo) await page.keyboard.down('Shift');
      await page.keyboard.press('z'); if (redo) await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
    };
    await undo(false);
    await L.waitFor(page, 'assignment undo restores missing image', () => window.__wasm.getPageControlLayout(0).controls.some(item => item.type === 'image' && item.missing));
    await assertFrame(); assert.equal(await page.evaluate(() => window.__inputHandler.canUndo()), before.undo);
    assert.deepEqual((await properties()).crop, original.crop);
    await undo(true);
    await L.waitFor(page, 'assignment redo restores selected image', () => window.__wasm.getPageControlLayout(0).controls.filter(item => item.type === 'image').every(item => !item.missing));
    assert.deepEqual(await data(), [...image]); await assertFrame();
    const saved = [];
    for (const format of ['hwp', 'hwpx']) {
      try {
        const bytes = await page.evaluate(format => [...(format === 'hwp' ? window.__wasm.exportHwp() : window.__wasm.exportHwpx())], format);
        const output = path.join(out, `${name}-assigned.${format}`);
        fs.writeFileSync(output, Buffer.from(bytes)); await L.openDocumentFile(page, output);
        assert.deepEqual(await data(), [...image]); await assertFrame();
        assert.equal(await page.evaluate(() => window.__wasm.getPageControlLayout(0).controls.some(item => item.type === 'image' && item.missing)), false);
        saved.push({ format, bytes: bytes.length });
      } catch (error) { saved.push({ format, error: String(error) }); }
    }
    report.runs.push({ source: name, target, frame, cancelledAtomic: true, invalidAtomic: true,
      doubleClickPickerAssignment: true, undoRedo: true, saved });
  }
  assert.deepEqual(log.pageErrors, []); assert.deepEqual(L.rhwpEngineRequests(log), []);
  report.pageErrors = log.pageErrors; report.legacyEngineRequests = [];
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  assert.ok(report.runs.every(run => run.saved.every(saved => !saved.error)), 'every assigned image must save and reopen in both formats');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') });
  console.error(JSON.stringify({ pageErrors: log?.pageErrors, console: log?.console.slice(-10) }));
  throw error;
} finally { await browser?.close(); await app.stop(); }
