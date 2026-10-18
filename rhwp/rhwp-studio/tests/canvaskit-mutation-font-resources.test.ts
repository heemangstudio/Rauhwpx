import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

test('same-document cache invalidation retains exact font resources and in-flight preparation', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const previousFetch = globalThis.fetch;
  let renderer: any;
  const owned: Array<{ deleted: boolean }> = [];
  const resource = () => {
    const value = { deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
    owned.push(value); return value;
  };
  let complete: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const kit = {
      Typeface: { MakeFreeTypeFaceFromData() { return resource(); } },
      FontMgr: { FromData() { return Object.assign(resource(), { countFamilies: () => 1, getFamilyName: () => 'Prepared' }); } },
    };
    renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const face = resource(); const manager = resource(); const outline = resource(); const image = resource();
    renderer.localTypefaces.set('face', { typeface: face, fontManager: manager, fontFamily: 'Prepared' });
    renderer.localTypefaceRecords.set('face', {});
    renderer.retainSfntTypefaceSource(face, new Uint8Array([1, 2, 3]).buffer);
    renderer.sfntTypefaceSources.get(face).paths.set(1, outline);
    renderer.imageCache.set('old-image', { image });
    renderer.imageCachePixels = 100;
    renderer.svgGlyphPathCache.set('old-svg', []);
    globalThis.fetch = async (_input, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>(resolve => { complete = resolve; });
    };
    const pending = renderer.prepareBundledFonts([{ url: 'https://font.invalid/one.ttf', aliases: ['Prepared'] }]);
    assert.ok(complete && signal);
    renderer.resetDocumentResources({ preserveFonts: true });
    assert.equal(image.deleted, true, 'mutable page/image resources still invalidate');
    assert.equal(renderer.imageCache.size, 0);
    assert.equal(renderer.imageCachePixels, 0);
    assert.equal(renderer.svgGlyphPathCache.size, 0);
    assert.equal(renderer.localTypefaces.get('face').typeface, face);
    assert.equal(renderer.localTypefaceRecords.size, 1);
    assert.equal(renderer.sfntTypefaceSources.get(face).paths.get(1), outline);
    assert.ok(!face.deleted && !manager.deleted && !outline.deleted);
    assert.equal(signal!.aborted, false, 'same-document edit does not cancel valid font preparation');
    complete!(new Response(new Uint8Array([1, 2, 3])));
    assert.equal(await pending, 1);
    assert.equal(renderer.bundledTypefaces.size, 1);
    assert.equal(renderer.bundledTypefaceAliases.size, 1);
    renderer.resetDocumentResources({ preserveFonts: true });
    assert.equal(renderer.bundledTypefaces.size, 1);
    assert.equal(renderer.bundledTypefaceAliases.size, 1);
    const replacing = renderer.prepareBundledFonts([{ url: 'https://font.invalid/two.ttf', aliases: ['Other'] }]);
    const rejected = assert.rejects(replacing, /CanvasKit font source 준비 실패/);
    const ownedBeforeReplacement = owned.length;
    renderer.resetDocumentResources();
    assert.equal(signal!.aborted, true, 'new document cancels old font preparation');
    complete!(new Response(new Uint8Array([1, 2, 3])));
    await rejected;
    assert.equal(owned.length, ownedBeforeReplacement, 'cancelled preparation creates no replacement face');
    assert.equal(renderer.localTypefaces.size, 0);
    assert.equal(renderer.localTypefaceRecords.size, 0);
    assert.equal(renderer.sfntTypefaceSources.size, 0);
    assert.equal(renderer.bundledTypefaces.size, 0);
    assert.equal(renderer.bundledTypefaceAliases.size, 0);
    assert.ok(face.deleted && manager.deleted && outline.deleted);
    renderer.dispose(); renderer = null;
    assert.ok(owned.every(value => value.deleted));
  } finally { globalThis.fetch = previousFetch; renderer?.dispose(); await vite.close(); }
});
