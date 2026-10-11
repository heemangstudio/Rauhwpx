import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('saved capture comments and images replay after reload and survive consume/discard', { timeout: 60_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const saved = await page.evaluate(async () => {
      const store = await import('/src/agent/agent-context-store.ts');
      const context = await import('/src/agent/inline-prompt-context.ts');
      const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 8;
      canvas.getContext('2d')!.fillRect(0, 0, 12, 8);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), 'image/png'));
      const file = new File([blob], 'region.png', { type: 'image/png' });
      const selection = context.bindInlineSelectionIdentity(context.buildInlineElementSelection([{
        kind: 'screenshot', captureId: '', comment: '지속되는 의견', attachmentName: file.name, recordAttachmentName: 'capture-record.json',
        pageRegions: [{ pageIndex: 2, pageWidth: 800, pageHeight: 1000, x: 30, y: 50, width: 100, height: 80 }],
      }], [file]), { documentId: 'doc-a', revision: 3 });
      const draft = await store.saveSelectionCapture(selection, '지속되는 의견', '문서.hwpx');
      const second = await store.saveSelectionCapture(selection, '두 번째 의견', '문서.hwpx');
      return { id: draft.id, secondId: second.id, size: file.size, context: draft.selection.contextBlock };
    });
    assert.ok(saved.context.includes(`capture-${saved.id}.json`));
    await page.reload();
    const restored = await page.evaluate(async (ids) => {
      const store = await import('/src/agent/agent-context-store.ts');
      const drafts = await store.listCaptureDrafts('doc-a');
      const other = await store.listCaptureDrafts('doc-b');
      const metadata = JSON.parse(await drafts[0]!.files.find((file) => file.type === 'application/json')!.text());
      await store.consumeCaptureDrafts([ids.id]); await store.removeCaptureDraft(ids.secondId);
      const queued = await store.listCaptureDrafts('doc-a');
      const retained = await new Promise<any[]>((resolve, reject) => {
        const request = indexedDB.open('rhwp-document-captures', 2);
        request.onsuccess = () => {
          const db = request.result; const transaction = db.transaction('captures'); const read = transaction.objectStore('captures').getAll();
          read.onsuccess = () => resolve(read.result); transaction.oncomplete = () => db.close();
        }; request.onerror = () => reject(request.error);
      });
      return { ids: drafts.map((draft) => draft.id), comment: drafts[0]!.comment, pngSize: drafts[0]!.files[0]!.size,
        metadataId: metadata.id, regions: metadata.selection.items[0].pageRegions, otherCount: other.length, queued: queued.length,
        states: retained.map(({ record }) => record.state).sort(), retainedSizes: retained.map(({ files }) => files[0].bytes.length) };
    }, saved);
    assert.deepEqual(new Set(restored.ids), new Set([saved.id, saved.secondId]));
    assert.equal(restored.comment, '지속되는 의견'); assert.equal(restored.pngSize, saved.size);
    assert.equal(restored.metadataId, saved.id); assert.equal(restored.regions[0].pageIndex, 2);
    assert.equal(restored.otherCount, 0); assert.equal(restored.queued, 0);
    assert.deepEqual(restored.states, ['consumed', 'discarded']); assert.deepEqual(restored.retainedSizes, [saved.size, saved.size]);

    const raster = await page.evaluate(async () => {
      const { renderDocumentRegion } = await import('/src/agent/document-region-capture.ts');
      const rendered: number[] = [];
      const file = await renderDocumentRegion({ renderPageToCanvas(pageIndex, canvas, scale) {
        rendered.push(pageIndex); canvas.width = 100 * scale; canvas.height = 100 * scale;
        const c = canvas.getContext('2d')!; c.fillStyle = pageIndex === 3 ? '#ff0000' : '#0000ff'; c.fillRect(0, 0, canvas.width, canvas.height);
      } }, { rect: { x: 20, y: 10, width: 40, height: 110 }, parts: [
        { rect: { x: 20, y: 10, width: 40, height: 40 }, pageRegion: { pageIndex: 3, pageWidth: 100, pageHeight: 100, x: 20, y: 10, width: 40, height: 40 } },
        { rect: { x: 20, y: 80, width: 40, height: 40 }, pageRegion: { pageIndex: 4, pageWidth: 100, pageHeight: 100, x: 20, y: 10, width: 40, height: 40 } },
      ] }, 2);
      const bitmap = await createImageBitmap(file); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const c = canvas.getContext('2d')!; c.drawImage(bitmap, 0, 0);
      const pixel = (y: number) => Array.from(c.getImageData(10, y, 1, 1).data);
      return { rendered, width: bitmap.width, height: bitmap.height, first: pixel(10), gap: pixel(100), last: pixel(200) };
    });
    assert.deepEqual(raster, { rendered: [3, 4], width: 80, height: 220, first: [255, 0, 0, 255], gap: [255, 255, 255, 255], last: [0, 0, 255, 255] });
  } finally { await browser?.close(); await server.close(); }
});
