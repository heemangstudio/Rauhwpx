import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReferenceStore } from '../reference-store.mjs';
import {
  executeReferenceTool,
  planReferenceImageCall,
  rectToCropPx,
  referenceImageCall,
  referenceImageSize,
} from '../reference-tools.mjs';
import { koreanCidPdf } from './fixtures/korean-cid-pdf.mjs';

test('hub-local MCP search/read tools enforce active session scopes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-tools-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const visible = await store.addBuffer({
    scope: 'document', scopeId: 'doc-a', name: 'visible.txt', bytes: Buffer.from('문서별 참조에 출시 일정이 있습니다.'),
  });
  const hidden = await store.addBuffer({
    scope: 'chat', scopeId: 'chat-b', name: 'hidden.txt', bytes: Buffer.from('다른 채팅 비밀'),
  });
  const session = { threadId: 'chat-a', documentId: 'doc-a' };

  const searched = await executeReferenceTool({
    tool: 'search_reference_files', args: { query: '출시 일정', maxResults: 2 }, store, session,
  });
  assert.equal(searched.result.results[0].fileId, visible.id);
  assert.ok(!searched.result.results.some((result) => result.fileId === hidden.id));

  const read = await executeReferenceTool({
    tool: 'read_reference_chunk', args: { fileId: visible.id, chunkId: 'c0' }, store, session,
  });
  assert.match(read.result.text, /출시 일정/);
  await assert.rejects(
    executeReferenceTool({ tool: 'read_reference_chunk', args: { fileId: hidden.id, chunkId: 'c0' }, store, session }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
  assert.deepEqual(await executeReferenceTool({ tool: 'not_reference', args: {}, store, session }), { handled: false, result: null });
});

test('hub-local image reads return native vision payloads', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-image-tool-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const image = await store.addBuffer({ scope: 'chat', scopeId: 'chat-a', name: 'shot.png', mimeType: 'image/png', bytes });
  const plan = await planReferenceImageCall({
    tool: 'read_reference_image', args: { fileId: image.id }, store, session: { threadId: 'chat-a', documentId: null },
  });
  assert.equal(plan.forward, undefined);
  assert.equal(plan.result.image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(plan.result.image.data, 'base64'), bytes);
  assert.deepEqual([plan.result.widthPx, plan.result.heightPx], [1, 1]);
});

test('reference image crops and inserts resolve stored bytes for Studio without touching disk paths', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-image-resolve-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ root: path.join(parent, 'refs') }).init();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const image = await store.addBuffer({ scope: 'document', scopeId: 'doc-a', name: 'logo.png', mimeType: 'image/png', bytes });
  const hidden = await store.addBuffer({ scope: 'chat', scopeId: 'chat-b', name: 'other.png', mimeType: 'image/png', bytes });
  const session = { threadId: 'chat-a', documentId: 'doc-a' };

  assert.equal(referenceImageCall('read_reference_image', { fileId: image.id }), true);
  assert.equal(referenceImageCall('insert_image', { referenceFileId: image.id }), true);
  assert.equal(referenceImageCall('insert_image', { clipId: 'rabc234' }), true);
  assert.equal(referenceImageCall('insert_image', { imageBase64: 'AAAA' }), false);
  assert.equal(referenceImageCall('search_reference_files', { query: 'x' }), false);

  const insert = await planReferenceImageCall({
    tool: 'insert_image',
    args: { expectedRevision: 3, sectionIdx: 0, paraIdx: 1, charOffset: 0, referenceFileId: image.id, cropPx: { x: 0, y: 0, width: 1, height: 1 } },
    store,
    session,
  });
  assert.deepEqual(insert.forward, {
    expectedRevision: 3, sectionIdx: 0, paraIdx: 1, charOffset: 0,
    cropPx: { x: 0, y: 0, width: 1, height: 1 }, referenceFileId: image.id,
    imageBase64: bytes.toString('base64'), mimeType: 'image/png',
    extension: 'png', naturalWidthPx: 1, naturalHeightPx: 1,
  });

  const read = await planReferenceImageCall({
    tool: 'read_reference_image', args: { fileId: image.id, cropPx: { x: 0, y: 0, width: 1, height: 1 }, zoom: 3 }, store, session,
  });
  assert.equal(read.forward.name, 'logo.png');
  assert.equal(read.forward.zoom, 3);
  assert.equal(read.forward.imageBase64, bytes.toString('base64'));

  await assert.rejects(
    planReferenceImageCall({ tool: 'insert_image', args: { referenceFileId: hidden.id }, store, session }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
  await assert.rejects(
    planReferenceImageCall({ tool: 'insert_image', args: { referenceFileId: image.id, imagePath: '/tmp/x.png' }, store, session }),
    (error) => error.code === 'INVALID_ARGS',
  );
});

test('rectToCropPx covers the whole normalized region and stays inside the source', () => {
  assert.deepEqual(rectToCropPx([0.25, 0.5, 0.5, 0.25], 200, 100), { x: 50, y: 50, width: 100, height: 25 });
  // 가장자리는 바깥으로 넓혀 영역을 다 담는다.
  assert.deepEqual(rectToCropPx([0.333, 0.333, 0.334, 0.334], 10, 10), { x: 3, y: 3, width: 4, height: 4 });
  // 아주 작은 영역도 1픽셀은 남는다.
  assert.deepEqual(rectToCropPx([0.9999, 0.9999, 0.0001, 0.0001], 50, 50), { x: 49, y: 49, width: 1, height: 1 });
});

/** 세션 프로젝트를 흉내 낸다 — 항목 조회만 쓴다. */
function fakeProjectStore(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    async getItem(_projectId, id) {
      const item = byId.get(id);
      if (!item) throw Object.assign(new Error(`Item ${id} was not found`), { code: 'PROJECT_ITEM_NOT_FOUND' });
      return item;
    },
    async itemForFile(_projectId, fileId) {
      return items.find((item) => item.kind === 'file' && item.fileId === fileId) ?? null;
    },
  };
}

test('PDF pages and PDF clips forward a project source to Studio instead of bytes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-pdf-forward-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ format: 'project', root: path.join(parent, 'files') }).init();
  const projectId = 'pabcdefghij';
  const pdf = await store.addBuffer({
    scope: 'project', scopeId: projectId, name: 'scan.pdf', mimeType: 'application/pdf', bytes: koreanCidPdf('지침 본문'),
  });
  const items = [
    { id: 'fpdf234', kind: 'file', fileId: pdf.id, fileKind: 'pdf', pageCount: 3, title: 'scan.pdf' },
    { id: 'rclip23', kind: 'clip', sourceId: 'fpdf234', page: 2, rect: [0.1, 0.2, 0.5, 0.25], title: 'scan p.2 영역' },
    { id: 'nnote23', kind: 'note', title: '메모' },
  ];
  const projectStore = fakeProjectStore(items);
  const session = { threadId: 'chat-a', documentId: 'doc-a', projectId };
  const pdfSource = { projectId, itemId: 'fpdf234', fileId: pdf.id, name: 'scan.pdf', pageCount: 3 };

  const page = await planReferenceImageCall({
    tool: 'read_reference_image', args: { itemId: 'fpdf234', page: 3, rect: [0, 0, 1, 0.5], zoom: 2 }, store, session, projectStore,
  });
  assert.deepEqual(page, { forward: { pdfSource: { ...pdfSource, page: 3 }, rect: [0, 0, 1, 0.5], zoom: 2 } });
  assert.equal(JSON.stringify(page).includes('imageBase64'), false);

  // fileId 로 와도 프로젝트 항목을 찾아 쓴다. 쪽을 빼면 첫 쪽이다.
  const byFile = await planReferenceImageCall({ tool: 'read_reference_image', args: { fileId: pdf.id }, store, session, projectStore });
  assert.deepEqual(byFile.forward.pdfSource, { ...pdfSource, page: 1 });

  for (const args of [{ clipId: 'rclip23', zoom: 3 }, { itemId: 'rclip23', zoom: 3 }]) {
    const clip = await planReferenceImageCall({ tool: 'read_reference_image', args, store, session, projectStore });
    assert.deepEqual(clip.forward, { clipId: 'rclip23', pdfSource: { ...pdfSource, page: 2 }, rect: [0.1, 0.2, 0.5, 0.25], zoom: 3 });
  }

  const insert = await planReferenceImageCall({
    tool: 'insert_image', args: { expectedRevision: 4, sectionIdx: 0, paraIdx: 2, charOffset: 0, clipId: 'rclip23' }, store, session, projectStore,
  });
  assert.deepEqual(insert.forward, {
    expectedRevision: 4, sectionIdx: 0, paraIdx: 2, charOffset: 0,
    clipId: 'rclip23', pdfSource: { ...pdfSource, page: 2 }, rect: [0.1, 0.2, 0.5, 0.25],
  });

  await assert.rejects(
    planReferenceImageCall({ tool: 'read_reference_image', args: { itemId: 'fpdf234', page: 4 }, store, session, projectStore }),
    (error) => error.code === 'INVALID_ARGS' && /last page/.test(error.message),
  );
  await assert.rejects(
    planReferenceImageCall({ tool: 'read_reference_image', args: { clipId: 'nnote23' }, store, session, projectStore }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
  // 다른 프로젝트 세션은 같은 PDF 를 읽지 못한다.
  await assert.rejects(
    planReferenceImageCall({
      tool: 'read_reference_image', args: { itemId: 'fpdf234' }, store,
      session: { threadId: 'chat-b', projectId: 'pzzzzzzzzzz' }, projectStore,
    }),
    (error) => error.code === 'REFERENCE_NOT_FOUND',
  );
});

test('image clips become source-pixel crops of the stored image', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-image-clip-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const store = await new ReferenceStore({ format: 'project', root: path.join(parent, 'files') }).init();
  const projectId = 'pabcdefghij';
  // 4x2 PNG
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACQahZdAAAAEUlEQVR4nGP8z8Dwn4EIwAQAJEUC/kHWZ2kAAAAASUVORK5CYII=', 'base64');
  const image = await store.addBuffer({ scope: 'project', scopeId: projectId, name: 'figure.png', mimeType: 'image/png', bytes });
  const projectStore = fakeProjectStore([
    { id: 'fimg234', kind: 'file', fileId: image.id, fileKind: 'image', title: 'figure.png' },
    { id: 'rclip45', kind: 'clip', sourceId: 'fimg234', page: 1, rect: [0.5, 0, 0.5, 1], title: 'figure 영역' },
  ]);
  const session = { threadId: 'chat-a', projectId };
  const read = await planReferenceImageCall({ tool: 'read_reference_image', args: { clipId: 'rclip45' }, store, session, projectStore });
  assert.deepEqual(read.forward.cropPx, { x: 2, y: 0, width: 2, height: 2 });
  assert.equal(read.forward.clipId, 'rclip45');
  assert.equal(read.forward.itemId, 'fimg234');
  const insert = await planReferenceImageCall({
    tool: 'insert_image', args: { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, clipId: 'rclip45' }, store, session, projectStore,
  });
  assert.deepEqual(insert.forward.cropPx, { x: 2, y: 0, width: 2, height: 2 });
  assert.equal(insert.forward.referenceFileId, image.id);
  await assert.rejects(
    planReferenceImageCall({ tool: 'read_reference_image', args: { itemId: 'fimg234', page: 2 }, store, session, projectStore }),
    (error) => error.code === 'INVALID_ARGS',
  );
});

test('referenceImageSize reads WebP headers that the insertion parser rejects', () => {
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'ascii');
  vp8x.write('WEBP', 8, 'ascii');
  vp8x.write('VP8X', 12, 'ascii');
  vp8x.writeUIntLE(639, 24, 3);
  vp8x.writeUIntLE(479, 27, 3);
  assert.deepEqual(referenceImageSize(vp8x), { width: 640, height: 480 });
  assert.equal(referenceImageSize(Buffer.from('not an image at all, clearly')), null);
});
