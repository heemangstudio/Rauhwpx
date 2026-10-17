import assert from 'node:assert/strict';
import test from 'node:test';

import { UnsavedDocumentRegistry } from '../desktop/unsaved-documents.mjs';

const doc = (documentId, extra = {}) => ({ documentId, fileName: '새 문서.hwpx', edited: true, createdAt: 1, ...extra });

test('each window sees every unsaved document and only its own as local', () => {
  const registry = new UnsavedDocumentRegistry();
  assert.equal(registry.set('window-a', [doc('a1')]), true);
  assert.equal(registry.set('window-b', [doc('b1'), doc('b2')]), true);

  const fromA = registry.listFor('window-a');
  assert.deepEqual(fromA.map((entry) => [entry.documentId, entry.local]), [['a1', true], ['b1', false], ['b2', false]]);
  assert.equal(registry.ownerOf('b2'), 'window-b');
});

test('an unchanged report does not broadcast and a closed window drops out', () => {
  const registry = new UnsavedDocumentRegistry();
  registry.set('window-a', [doc('a1')]);
  assert.equal(registry.set('window-a', [doc('a1')]), false);
  assert.equal(registry.forget('window-a'), true);
  assert.equal(registry.ownerOf('a1'), null);
  assert.deepEqual(registry.listFor('window-b'), []);
});

test('renderer reports are validated before other windows see them', () => {
  const registry = new UnsavedDocumentRegistry();
  registry.set('window-a', [
    doc('ok'),
    doc('ok'),
    { documentId: '../escape' },
    { documentId: 42 },
    doc('long-name', { fileName: 'x'.repeat(400), edited: 'yes', createdAt: 'soon' }),
  ]);
  const listed = registry.listFor('window-b');
  assert.deepEqual(listed.map((entry) => entry.documentId), ['ok', 'long-name']);
  assert.equal(listed[1].fileName.length, 255);
  assert.equal(listed[1].edited, false);
  assert.equal(listed[1].createdAt, 0);
  assert.equal(registry.set('window-a', 'not a list'), true);
  assert.deepEqual(registry.listFor('window-b'), []);
});
