// list_documents({path}) 의 경로 검사·동의·핸들과, Studio 문서 목록에 허브가 더하는 내용.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DOCUMENT_PATH_MAX_BYTES,
  MAX_DOCUMENT_PATH_HANDLES,
  OPEN_DOCUMENT_MAX_BYTES,
  OPENABLE_DOCUMENT_EXTENSIONS,
  assertDocumentPathConsent,
  defaultDocumentFolder,
  enrichDocumentList,
  normalizeNewDocumentName,
  readDocumentPathContent,
  refreshDocumentPath,
  rememberDocumentPath,
  validateDocumentFolder,
  validateDocumentPath,
} from '../document-paths.mjs';

function tempRoot(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rhwp-document-paths-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const codeOf = async (promise) => promise.then(() => 'ok', (error) => error.code);

test('path reads accept plain hwp/hwpx/hml/hwpml files up to 24 MiB and nothing else', async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, '계약서.HWPX');
  writeFileSync(file, 'PK');
  const valid = await validateDocumentPath(file);
  assert.equal(valid.path, file);
  assert.equal(valid.name, '계약서.HWPX');
  assert.equal(valid.size, 2);

  writeFileSync(path.join(root, 'notes.txt'), 'text');
  assert.equal(await codeOf(validateDocumentPath(path.join(root, 'notes.txt'))), 'PATH_REJECTED');
  assert.equal(await codeOf(validateDocumentPath('relative/form.hwp')), 'PATH_INVALID');
  assert.equal(await codeOf(validateDocumentPath(`${file}\0.hwp`)), 'PATH_INVALID');
  assert.equal(await codeOf(validateDocumentPath(path.join(root, 'missing.hwp'))), 'PATH_NOT_FOUND');
  for (const remote of ['\\\\server\\share\\form.hwp', '//server/share/form.hwp', '\\\\?\\C:\\form.hwp', '\\\\.\\PhysicalDrive0\\form.hwp', '/\\server\\form.hwp']) {
    assert.equal(await codeOf(validateDocumentPath(remote)), 'PATH_REJECTED', `${remote} never reaches the file system`);
  }

  const link = path.join(root, 'link.hwpx');
  symlinkSync(file, link);
  assert.equal(await codeOf(validateDocumentPath(link)), 'PATH_REJECTED', 'a symlinked file');
  mkdirSync(path.join(root, 'real'));
  writeFileSync(path.join(root, 'real', 'form.hwp'), 'hwp');
  symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
  assert.equal(await codeOf(validateDocumentPath(path.join(root, 'linked', 'form.hwp'))), 'PATH_REJECTED', 'a symlinked parent');
  mkdirSync(path.join(root, 'folder.hwp'));
  assert.equal(await codeOf(validateDocumentPath(path.join(root, 'folder.hwp'))), 'PATH_REJECTED');
  writeFileSync(path.join(root, 'empty.hwp'), '');
  assert.equal(await codeOf(validateDocumentPath(path.join(root, 'empty.hwp'))), 'PATH_REJECTED');

  const large = path.join(root, 'large.hwp');
  writeFileSync(large, '');
  truncateSync(large, DOCUMENT_PATH_MAX_BYTES + 1);
  assert.equal(await codeOf(validateDocumentPath(large)), 'PATH_TOO_LARGE');
});

test('documents opened for linking must be re-savable and may exceed the read cap', async (t) => {
  const root = tempRoot(t);
  const open = { extensions: OPENABLE_DOCUMENT_EXTENSIONS, maxBytes: OPEN_DOCUMENT_MAX_BYTES };
  const markup = path.join(root, 'legacy.hwpml');
  writeFileSync(markup, '<HWPML/>');
  assert.equal((await validateDocumentPath(markup)).name, 'legacy.hwpml', 'reads keep hwpml');
  assert.equal(await codeOf(validateDocumentPath(markup, open)), 'PATH_REJECTED');
  const large = path.join(root, 'large.hwp');
  writeFileSync(large, 'x');
  truncateSync(large, DOCUMENT_PATH_MAX_BYTES + 1);
  assert.equal(await codeOf(validateDocumentPath(large)), 'PATH_TOO_LARGE');
  assert.equal((await validateDocumentPath(large, open)).size, DOCUMENT_PATH_MAX_BYTES + 1);
  assert.equal(await codeOf(validateDocumentPath('\\\\server\\share\\a.hwp', open)), 'PATH_REJECTED');
});

test('new document folders are real folders inside home; names are plain file names', async (t) => {
  const home = tempRoot(t);
  const outside = tempRoot(t);
  const folder = path.join(home, '문서', '보고서');
  mkdirSync(folder, { recursive: true });
  assert.equal(await validateDocumentFolder(folder, { home }), folder);
  assert.equal(await validateDocumentFolder(home, { home }), home);
  assert.equal(await codeOf(validateDocumentFolder(outside, { home })), 'PATH_REJECTED');
  assert.equal(await codeOf(validateDocumentFolder(path.join(home, 'missing'), { home })), 'PATH_NOT_FOUND');
  assert.equal(await codeOf(validateDocumentFolder('relative/folder', { home })), 'PATH_INVALID');
  assert.equal(await codeOf(validateDocumentFolder('//server/share', { home })), 'PATH_REJECTED');
  writeFileSync(path.join(home, 'file.hwpx'), 'PK');
  assert.equal(await codeOf(validateDocumentFolder(path.join(home, 'file.hwpx'), { home })), 'PATH_REJECTED');
  symlinkSync(outside, path.join(home, 'escape'));
  assert.equal(await codeOf(validateDocumentFolder(path.join(home, 'escape'), { home })), 'PATH_REJECTED');
  mkdirSync(path.join(outside, 'inner'));
  assert.equal(await codeOf(validateDocumentFolder(path.join(home, 'escape', 'inner'), { home })), 'PATH_REJECTED');

  assert.equal(defaultDocumentFolder({ env: {}, home }), path.join(home, 'Documents', 'HamaEditor'));
  assert.equal(defaultDocumentFolder({ env: { RHWP_DOCUMENTS_DIR: outside }, home }), path.join(outside, 'HamaEditor'));
  assert.equal(defaultDocumentFolder({ env: { RHWP_DOCUMENTS_DIR: 'relative' }, home }), path.join(home, 'Documents', 'HamaEditor'));

  assert.equal(normalizeNewDocumentName('  사업 계획.hwpx '), '사업 계획');
  assert.equal(normalizeNewDocumentName('회의록'), '회의록');
  for (const bad of ['', '.hwpx', '../a', 'a/b', 'a\\b', 'a:b', 'CON', 'name.', '..', 'a\u0001b', 'x'.repeat(121)]) {
    assert.throws(() => normalizeNewDocumentName(bad), { code: 'INVALID_ARGS' }, JSON.stringify(bad));
  }
});

test('path consent: desktop root agent with other-documents, local-execution or 전체 mode', () => {
  const codeFor = (input) => {
    try {
      assertDocumentPathConsent({ homeAccess: true, root: true, permissionProfile: 'safe', grants: [], ...input });
      return 'ok';
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(codeFor({ grants: ['other-documents'] }), 'ok');
  assert.equal(codeFor({ grants: ['local-execution'] }), 'ok');
  assert.equal(codeFor({ permissionProfile: 'unrestricted' }), 'ok');
  assert.equal(codeFor({ grants: ['project-edit', 'browser'] }), 'PERMISSION_REQUIRED');
  assert.equal(codeFor({ root: false, grants: ['other-documents'] }), 'ROOT_INTERACTION_REQUIRED');
  assert.equal(codeFor({ homeAccess: false, permissionProfile: 'unrestricted' }), 'PATH_UNAVAILABLE');
  assert.throws(
    () => assertDocumentPathConsent({ homeAccess: true, root: true, permissionProfile: 'safe', grants: [] }),
    /request_permission with capability "other-documents"/,
  );
});

test('file handles are per session, reused per path, bounded, and follow file changes', async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'a.hwp');
  writeFileSync(file, 'one');
  const paths = new Map();
  const handle = rememberDocumentPath(paths, await validateDocumentPath(file));
  assert.match(handle, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(rememberDocumentPath(paths, await validateDocumentPath(file)), handle, 'the same path keeps its handle');

  const first = await refreshDocumentPath(paths, handle);
  assert.deepEqual({ ...first, mtimeMs: 0 }, { kind: 'file', handle, name: 'a.hwp', size: 3, mtimeMs: 0 });
  writeFileSync(file, 'changed');
  const changed = await refreshDocumentPath(paths, handle);
  assert.equal(changed.size, 7, 'the source stamp follows the file');
  assert.equal(paths.get(handle).size, 7);

  await assert.rejects(refreshDocumentPath(new Map(), handle), { code: 'SOURCE_NOT_FOUND' });
  await assert.rejects(refreshDocumentPath(paths, 'unknown'), { code: 'SOURCE_NOT_FOUND' });
  rmSync(file);
  symlinkSync(path.join(root, 'elsewhere.hwp'), file);
  writeFileSync(path.join(root, 'elsewhere.hwp'), 'swap');
  await assert.rejects(refreshDocumentPath(paths, handle), { code: 'SOURCE_UNREADABLE' }, 'a file replaced by a link');
  assert.equal((await readDocumentPathContent(paths, handle)).status, 409);
  rmSync(file);
  await assert.rejects(refreshDocumentPath(paths, handle), { code: 'SOURCE_NOT_FOUND' });
  assert.equal((await readDocumentPathContent(paths, handle)).status, 404);

  for (let index = 0; index <= MAX_DOCUMENT_PATH_HANDLES; index += 1) {
    rememberDocumentPath(paths, { path: path.join(root, `${index}.hwp`), name: `${index}.hwp`, size: 1, mtimeMs: 0 });
  }
  assert.equal(paths.size, MAX_DOCUMENT_PATH_HANDLES);
  assert.equal(paths.has(handle), false, 'the least recently used handle is dropped');
});

test('content reads return the bytes and refuse files that grew past the cap', async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'b.hwpx');
  writeFileSync(file, 'PK-bytes');
  const paths = new Map();
  const handle = rememberDocumentPath(paths, await validateDocumentPath(file));
  const content = await readDocumentPathContent(paths, handle);
  assert.equal(content.status, 200);
  assert.equal(content.bytes.toString(), 'PK-bytes');
  truncateSync(file, DOCUMENT_PATH_MAX_BYTES + 1);
  assert.equal((await readDocumentPathContent(paths, handle)).status, 413);
});

test('document lists gain other-window state and project members, filtered and capped', () => {
  const studio = {
    documents: [
      { documentId: 'doc-live', name: '본문.hwpx', state: 'open' },
      { documentId: 'doc-other-window', name: '예산.hwp', state: 'closed' },
      { documentId: 'doc-recent', name: '회의록.hwpx', state: 'closed', dirty: false },
    ],
    truncated: false,
  };
  const listed = enrichDocumentList({
    result: studio,
    query: 'ＡＢＣ',
    liveDocumentId: 'doc-live',
    openElsewhere: (id) => id === 'doc-other-window' || id === 'doc-member-elsewhere',
    projectMembers: [
      { documentId: 'doc-recent', name: '회의록.hwpx' },
      { documentId: 'doc-member', name: 'abc 계획.HWP' },
      { documentId: 'doc-member-elsewhere', name: 'ABC 보고.hwpx' },
      { documentId: 'doc-unmatched', name: '다른 문서.hwp' },
    ],
  });
  // 전각 ＡＢＣ 는 NFC 로 바뀌지 않는다 — query 는 덧붙인 항목에만 걸린다.
  assert.deepEqual(listed.documents.map((entry) => [entry.documentId, entry.state]), [
    ['doc-live', 'open'], ['doc-other-window', 'open-elsewhere'], ['doc-recent', 'closed'],
  ]);

  const matched = enrichDocumentList({
    result: studio,
    query: '  abc ',
    liveDocumentId: 'doc-live',
    openElsewhere: (id) => id === 'doc-member-elsewhere',
    projectMembers: [
      { documentId: 'doc-member', name: 'abc 계획.HWP' },
      { documentId: 'doc-member-elsewhere', name: 'ABC 보고.hwpx' },
      { documentId: 'doc-unmatched', name: '다른 문서.hwp' },
    ],
  });
  assert.deepEqual(matched.documents.slice(3), [
    { documentId: 'doc-member', name: 'abc 계획.HWP', format: 'hwp', state: 'closed', project: true },
    { documentId: 'doc-member-elsewhere', name: 'ABC 보고.hwpx', format: 'hwpx', state: 'open-elsewhere', project: true },
  ]);
  assert.equal(matched.truncated, false);

  const decomposed = enrichDocumentList({
    result: { documents: [] },
    query: '계획',
    projectMembers: [{ documentId: 'doc-nfd', name: '사업 계획.hwp'.normalize('NFD') }],
  });
  assert.equal(decomposed.documents.length, 1, 'NFD names match an NFC query');

  const many = enrichDocumentList({
    result: { documents: Array.from({ length: 45 }, (_, index) => ({ documentId: `s${index}`, name: `s${index}.hwp`, state: 'closed' })) },
    projectMembers: Array.from({ length: 10 }, (_, index) => ({ documentId: `m${index}`, name: `m${index}.hwp` })),
  });
  assert.equal(many.documents.length, 50);
  assert.equal(many.truncated, true);
});
