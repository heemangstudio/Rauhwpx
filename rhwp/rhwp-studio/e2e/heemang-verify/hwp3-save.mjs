// 실제 HWP3 파일을 UI로 편집하고 저장·취소·실패·재열기를 확인한다.
// 실행: HV_CANDIDATE_VITE_PORT=7722 HV_CANDIDATE_QUERY= node e2e/heemang-verify/hwp3-save.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';

const source = `${L.candidateRoot}/rhwp/rhwp-studio/tests/fixtures/hwp3-tabs.hwp`;
const out = L.ensureOut('hwp3-save');
const app = await L.startApp('candidate', L.candidateRoot, 5722);
let browser;
try {
  browser = await L.launchBrowser();
  const { page, log } = await L.newPage(browser);
  await L.loadApp(page, app.url);
  const text = () => page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, 100000));
  const dirty = () => page.evaluate(() => window.__documentState.isDirty());
  const dispatch = id => page.evaluate(cmd => window.__dispatcher.dispatch(cmd), id);
  async function editSource() {
    await L.openDocumentFile(page, source);
    const canvas = await page.$('#scroll-content canvas');
    await canvas.click({ offset: { x: 180, y: 160 } });
    await page.keyboard.down('Control');
    await page.keyboard.press('Home');
    await page.keyboard.up('Control');
    await page.keyboard.type('HWP3-LIVE ');
    await L.waitFor(page, 'typed HWP3', () => window.__wasm.getTextRange(0, 0, 0, 100000).includes('HWP3-LIVE'));
  }
  await editSource();
  assert.equal(await dirty(), true);
  await page.screenshot({ path: `${out}/edited.png` });
  const content = await text();
  await page.evaluate(() => {
    window.__wasm.currentFileHandle = null;
    window.showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError'); };
  });
  await dispatch('file:save');
  assert.equal(await dirty(), true);
  assert.equal(await text(), content);
  await page.evaluate(() => {
    window.showSaveFilePicker = async () => ({
      kind: 'file', name: 'failed.hwp',
      async createWritable() { throw new Error('disk failure'); },
      async queryPermission() { return 'granted'; },
    });
  });
  await dispatch('file:save');
  assert.equal(await dirty(), true);
  assert.equal(await text(), content);
  const results = [];
  for (const [cmd, format] of [
    ['file:save', 'hwp'], ['file:save-as-hwp', 'hwp'], ['file:save-as-hwpx', 'hwpx'],
  ]) {
    if (results.length) await editSource();
    await page.evaluate(fmt => {
      window.__saved = null;
      window.__wasm.currentFileHandle = null;
      window.showSaveFilePicker = async () => ({
        kind: 'file', name: `converted.${fmt}`,
        async getFile() { return new File([window.__saved ?? ''], `converted.${fmt}`); },
        async createWritable() {
          return { async write(blob) { window.__saved = blob; }, async close() {} };
        },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
      });
    }, format);
    await dispatch(cmd);
    await L.waitFor(page, `saved ${format}`, () => window.__saved);
    const bytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.__saved.arrayBuffer())]));
    assert.equal(bytes[0], format === 'hwp' ? 0xd0 : 0x50);
    assert.equal(await dirty(), false);
    const file = `${out}/${cmd.replaceAll(':', '-')}.${format}`;
    fs.writeFileSync(file, bytes);
    await L.openDocumentFile(page, file);
    assert.equal(await text(), content);
    results.push({ cmd, bytes: bytes.length, reopened: true });
  }
  assert.deepEqual(L.rhwpEngineRequests(log), []);
  assert.deepEqual(log.pageErrors, []);
  const report = {
    url: app.url, cancelPreservedDirty: true, failurePreservedDirty: true,
    results, pageErrors: log.pageErrors,
  };
  fs.writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await app.stop();
}
