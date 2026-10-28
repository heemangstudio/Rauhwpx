import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import {
  collectDragSources,
  DragExportRequests,
  FileDragStaging,
  fitFileNameToPath,
  normalizeDragItems,
} from '../desktop/file-drag-out.mjs';

const bytes = (text) => new TextEncoder().encode(text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'rhwp-drag-out-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'drag-out');
}

test('renderer drag items are validated before the desktop acts on them', () => {
  const items = normalizeDragItems([
    { kind: 'recent', documentId: 'doc-1', fileName: '보고서.hwp' },
    { kind: 'unsaved', documentId: '../escape', fileName: 'x' },
    { kind: 'bytes', fileName: '새 문서.hwpx', bytes: bytes('PK') },
    { kind: 'bytes', fileName: 'empty.hwpx', bytes: new Uint8Array() },
    { kind: 'path', path: '/etc/passwd' },
  ]);
  assert.deepEqual(items.map((item) => [item.kind, item.fileName]), [['recent', '보고서.hwp'], ['bytes', '새 문서.hwpx']]);
});

test('an edited document open in another window drags that window\'s export; a clean one drags its file', async () => {
  const asked = [];
  const { sources, failed } = await collectDragSources(normalizeDragItems([
    { kind: 'recent', documentId: 'edited', fileName: '보고서.hwp' },
    { kind: 'recent', documentId: 'clean', fileName: '회의록.hwpx' },
    { kind: 'recent', documentId: 'closed', fileName: '계획.hwp' },
    { kind: 'recent', documentId: 'gone', fileName: '없음.hwp' },
    { kind: 'unsaved', documentId: 'new-elsewhere', fileName: '새 문서.hwpx' },
    { kind: 'unsaved', documentId: 'new-orphan', fileName: '고아.hwpx' },
  ]), {
    ownerOf: (item) => (['edited', 'clean', 'new-elsewhere'].includes(item.documentId) ? 'window-b' : null),
    exportFrom: async (owner, documentId) => {
      asked.push([owner, documentId]);
      if (documentId === 'clean') return 'clean';
      return { fileName: `${documentId}.hwpx`, bytes: bytes(documentId) };
    },
    savedPath: async (documentId) => (documentId === 'gone' ? null : `/docs/${documentId}`),
  });
  assert.deepEqual(asked.sort(), [['window-b', 'clean'], ['window-b', 'edited'], ['window-b', 'new-elsewhere']]);
  assert.deepEqual(sources.map((source) => source.path ?? source.fileName), [
    'edited.hwpx', '/docs/clean', '/docs/closed', 'new-elsewhere.hwpx',
  ]);
  assert.deepEqual(failed.sort(), ['고아.hwpx', '없음.hwp']);
});

test('a window that does not answer falls back to the saved file', async () => {
  const requests = new DragExportRequests({ timeoutMs: 20 });
  const { sources } = await collectDragSources(normalizeDragItems([{ kind: 'recent', documentId: 'doc', fileName: 'a.hwp' }]), {
    ownerOf: () => 'window-b',
    exportFrom: (owner) => requests.request(owner, () => {}),
    savedPath: async () => '/docs/a.hwp',
  });
  assert.deepEqual(sources, [{ path: '/docs/a.hwp' }]);
});

test('only the asked window can answer an export request', async () => {
  const requests = new DragExportRequests({ timeoutMs: 5_000 });
  let requestId = null;
  const answer = requests.request('window-b', (id) => { requestId = id; });
  assert.equal(requests.reply('window-c', requestId, 'clean'), false);
  assert.equal(requests.reply('window-b', requestId, 'clean'), true);
  assert.equal(await answer, 'clean');

  const closed = requests.request('window-b', () => {});
  requests.forgetSession('window-b');
  assert.equal(await closed, null);
});

test('exports with the same name get their own folders and linger after the drop', async (t) => {
  const root = scratch(t);
  const staging = new FileDragStaging({ root, lingerMs: 30, abandonMs: 5_000 });
  const { token, paths } = await staging.stage('window-a', [
    { fileName: '새 문서.hwpx', bytes: bytes('one') },
    { fileName: '새 문서.hwpx', bytes: bytes('two') },
    { path: '/docs/saved.hwp' },
  ]);
  assert.equal(paths.length, 3);
  assert.equal(basename(paths[0]), '새 문서.hwpx');
  assert.notEqual(dirname(paths[0]), dirname(paths[1]));
  assert.deepEqual([readFileSync(paths[0], 'utf8'), readFileSync(paths[1], 'utf8')], ['one', 'two']);
  assert.equal(paths[2], '/docs/saved.hwp');
  assert.equal(staging.pathsFor('window-b', token), null, 'another window cannot start this drag');
  assert.deepEqual(staging.pathsFor('window-a', token), paths);

  assert.equal(staging.end('window-a', token), true);
  assert.equal(existsSync(paths[0]), true, 'the receiver may still read it right after the drop');
  await wait(120);
  assert.equal(existsSync(paths[0]), false);
  assert.equal(existsSync(paths[1]), false);
  assert.equal(staging.pathsFor('window-a', token), null);
});

test('a drag that never started is removed at once, and quit clears everything', async (t) => {
  const root = scratch(t);
  const staging = new FileDragStaging({ root, lingerMs: 60_000, abandonMs: 60_000 });
  const unused = await staging.stage('window-a', [{ fileName: 'a.hwpx', bytes: bytes('a') }]);
  staging.end('window-a', unused.token, { immediate: true });
  await wait(50);
  assert.equal(existsSync(unused.paths[0]), false);

  const dropped = await staging.stage('window-a', [{ fileName: 'b.hwpx', bytes: bytes('b') }]);
  staging.end('window-a', dropped.token);
  staging.clearSync();
  assert.equal(existsSync(root), false);
});

test('a drag the renderer never finishes is cleaned up', async (t) => {
  const root = scratch(t);
  const staging = new FileDragStaging({ root, lingerMs: 60_000, abandonMs: 30 });
  const { paths } = await staging.stage('window-a', [{ fileName: 'a.hwpx', bytes: bytes('a') }]);
  await wait(120);
  assert.equal(existsSync(paths[0]), false);
});

test('a staged copy keeps its whole path within Windows MAX_PATH and keeps its extension', async (t) => {
  const folder = String.raw`C:\Users\someone\AppData\Local\Temp\Rauhwpx-drag-0123abcd\89abcdef`;
  const long = `${'가'.repeat(150)}${'😀'.repeat(40)}.hwpx`;
  const fitted = fitFileNameToPath(folder, long);
  assert.ok(folder.length + 1 + fitted.length <= 259);
  assert.ok(fitted.endsWith('.hwpx'));
  assert.equal(fitted, fitted.toWellFormed(), 'no split surrogate pair');
  assert.equal(fitFileNameToPath(folder, '보고서.hwp'), '보고서.hwp');

  const root = scratch(t);
  const staging = new FileDragStaging({ root, lingerMs: 60_000, abandonMs: 60_000 });
  const { paths } = await staging.stage('window-a', [{ fileName: `${'나'.repeat(179)}.hwpx`, bytes: bytes('x') }]);
  assert.ok(paths[0].length <= 259, `${paths[0].length} units`);
  assert.ok(paths[0].endsWith('.hwpx'));
  assert.equal(readFileSync(paths[0], 'utf8'), 'x');
  staging.clearSync();
});

test('a staged copy dropped back into a window is recognised and names the window that owns its document', async (t) => {
  const root = scratch(t);
  const staging = new FileDragStaging({ root, lingerMs: 30, abandonMs: 60_000 });
  const { token, paths } = await staging.stage('window-a', [
    { fileName: 'mine.hwpx', bytes: bytes('a') },
    { fileName: 'theirs.hwpx', bytes: bytes('b'), owner: 'window-c' },
    { path: '/docs/saved.hwp' },
  ]);
  assert.deepEqual(staging.stagedCopy(paths[0]), { owner: 'window-a' });
  assert.deepEqual(staging.stagedCopy(paths[1]), { owner: 'window-c' });
  if (process.platform === 'win32') assert.deepEqual(staging.stagedCopy(paths[1].toUpperCase()), { owner: 'window-c' });
  assert.equal(staging.stagedCopy(paths[2]), null, 'a saved file opens as usual');
  assert.equal(staging.stagedCopy(join(root, '..', 'elsewhere.hwpx')), null);
  assert.equal(staging.stagedCopy(root), null);
  assert.deepEqual(staging.stagedCopy(join(root, 'leftover', 'old.hwpx')), { owner: null });

  staging.end('window-a', token);
  await wait(120);
  assert.deepEqual(staging.stagedCopy(paths[0]), { owner: null }, 'still ours after removal, owner forgotten');
});
