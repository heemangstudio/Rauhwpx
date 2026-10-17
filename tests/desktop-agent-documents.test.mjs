import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentDocument,
  openAgentDocumentAtPath,
  sanitizeAgentDocumentName,
  validateAgentDocumentPath,
} from '../desktop/agent-documents.mjs';
import { DocumentLeaseManager } from '../desktop/document-leases.mjs';
import { NativeFileHandleRegistry } from '../desktop/native-file-handles.mjs';

const BLANK_HWPX = readFileSync(new URL('../rhwp/samples/tac-host-spacing.hwpx', import.meta.url));

function scratch() {
  // 실제 경로로 쓴다 (macOS /var → /private/var, Windows 8.3 이름). 폴더 검사는 링크 없는 실제 경로만 받는다.
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'rhwp-agent-doc-')));
}

function setup() {
  const dir = scratch();
  return {
    dir,
    nativeFiles: new NativeFileHandleRegistry(),
    documentLeases: new DocumentLeaseManager(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('새 문서 이름은 경로·제어 문자·Windows 예약 이름을 없애고 길이를 자른다', () => {
  assert.equal(sanitizeAgentDocumentName('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitizeAgentDocumentName('C:\\보고서'), 'C 보고서');
  assert.equal(sanitizeAgentDocumentName('회의\u0000록\u202e'), '회의록');
  assert.equal(sanitizeAgentDocumentName('보고서.hwpx'), '보고서');
  assert.equal(sanitizeAgentDocumentName('CON'), '_CON');
  assert.equal(sanitizeAgentDocumentName('lpt1.txt'), '_lpt1.txt');
  assert.equal(sanitizeAgentDocumentName('   '), '새 문서');
  assert.equal(sanitizeAgentDocumentName('..'), '새 문서');
  assert.equal(sanitizeAgentDocumentName(undefined), '새 문서');
  assert.equal([...sanitizeAgentDocumentName('가'.repeat(400))].length, 120);
  assert.equal(sanitizeAgentDocumentName(42), null);
});

test('문서 경로는 절대 경로의 hwp/hwpx/hml 만 받고 네트워크·장치 경로를 거절한다', () => {
  assert.equal(validateAgentDocumentPath('/home/a/보고서.hwpx', { platform: 'linux' }), '/home/a/보고서.hwpx');
  assert.equal(validateAgentDocumentPath('/home/a/x/../b.HWP', { platform: 'linux' }), '/home/a/b.HWP');
  for (const rejected of [
    'docs/a.hwp',
    '//server/share/a.hwp',
    '/home/a/\0.hwp',
    '/home/a/notes.txt',
    '/home/a/history.rhwpx',
    '',
    null,
  ]) {
    assert.equal(validateAgentDocumentPath(rejected, { platform: 'linux' }), null, String(rejected));
  }
  assert.equal(validateAgentDocumentPath('C:\\문서\\a.hml', { platform: 'win32' }), 'C:\\문서\\a.hml');
  assert.equal(validateAgentDocumentPath('C:/문서/a.hwpx', { platform: 'win32' }), 'C:\\문서\\a.hwpx');
  for (const rejected of ['\\\\server\\share\\a.hwp', '\\\\?\\C:\\a.hwp', '\\\\.\\pipe\\a.hwp', '\\a.hwp', 'C:a.hwp']) {
    assert.equal(validateAgentDocumentPath(rejected, { platform: 'win32' }), null, rejected);
  }
});

test('경로로 연 문서는 대화상자와 같은 핸들과 바이트를 돌려주고 이 창이 경로를 쥔다', async () => {
  const { dir, nativeFiles, documentLeases, cleanup } = setup();
  try {
    const path = join(dir, '보고서.hwpx');
    writeFileSync(path, BLANK_HWPX);
    const opened = await openAgentDocumentAtPath('window-1', path, { nativeFiles, documentLeases });
    assert.equal(opened.ok, true);
    assert.equal(opened.kind, 'file');
    assert.equal(opened.name, '보고서.hwpx');
    assert.equal(opened.saveTargetCreated, true);
    assert.deepEqual(Buffer.from(opened.bytes), BLANK_HWPX);
    assert.equal(await nativeFiles.ownerForPath(path), 'window-1');

    // 다른 창은 그 창을 앞으로 가져오지 않고 코드만 받는다. 쥔 창은 그대로다.
    const other = await openAgentDocumentAtPath('window-2', path, { nativeFiles, documentLeases });
    assert.deepEqual(other, { ok: false, code: 'DOC_OPEN_ELSEWHERE' });
    assert.equal(await nativeFiles.ownerForPath(path), 'window-1');
    assert.deepEqual(nativeFiles.descriptorsForSession('window-2'), []);
  } finally {
    cleanup();
  }
});

test('다른 창이 문서 점유로 쥔 경로나 문서 id 는 열지 않고 잡았던 핸들을 놓는다', async () => {
  const { dir, nativeFiles, documentLeases, cleanup } = setup();
  try {
    const path = join(dir, '계약서.hwpx');
    writeFileSync(path, BLANK_HWPX);
    // window-1 이 문서를 열어 기억하고 문서 점유를 잡은 뒤 핸들만 놓았다.
    const first = await nativeFiles.create('window-1', path);
    nativeFiles.rememberDocument('doc-1', 'window-1', first.descriptor.handleId, undefined);
    const reservation = documentLeases.reserve('window-1', { documentId: 'doc-1', sourceDigest: null }, null);
    documentLeases.commit('window-1', reservation.reservationId);
    nativeFiles.releaseHandle('window-1', first.descriptor.handleId);

    const byDocument = await openAgentDocumentAtPath('window-2', path, { nativeFiles, documentLeases });
    assert.deepEqual(byDocument, { ok: false, code: 'DOC_OPEN_ELSEWHERE' });
    assert.equal(await nativeFiles.ownerForPath(path), null);

    documentLeases.releaseSession('window-1');
    const second = await nativeFiles.create('window-1', path);
    const ownership = nativeFiles.pathForSender('window-1', second.descriptor.handleId);
    const pathReservation = documentLeases.reserve('window-1', { documentId: 'doc-x', sourceDigest: null }, ownership);
    documentLeases.commit('window-1', pathReservation.reservationId);
    nativeFiles.releaseHandle('window-1', second.descriptor.handleId);

    const byPath = await openAgentDocumentAtPath('window-2', path, { nativeFiles, documentLeases });
    assert.deepEqual(byPath, { ok: false, code: 'DOC_OPEN_ELSEWHERE' });
    assert.deepEqual(nativeFiles.descriptorsForSession('window-2'), []);
  } finally {
    cleanup();
  }
});

test('경로 열기는 링크·폴더·없는 파일·큰 파일을 코드로 거절한다', async () => {
  const { dir, nativeFiles, documentLeases, cleanup } = setup();
  try {
    const target = join(dir, '원본.hwpx');
    writeFileSync(target, BLANK_HWPX);
    const linked = join(dir, '링크.hwpx');
    symlinkSync(target, linked);
    mkdirSync(join(dir, '폴더.hwp'));
    const options = { nativeFiles, documentLeases };

    assert.deepEqual(await openAgentDocumentAtPath('w', linked, options), { ok: false, code: 'INVALID_PATH' });
    assert.deepEqual(await openAgentDocumentAtPath('w', join(dir, '폴더.hwp'), options), { ok: false, code: 'INVALID_PATH' });
    assert.deepEqual(await openAgentDocumentAtPath('w', join(dir, '없음.hwp'), options), { ok: false, code: 'NOT_FOUND' });
    assert.deepEqual(await openAgentDocumentAtPath('w', '//server/share/a.hwp', options), { ok: false, code: 'INVALID_PATH' });
    assert.deepEqual(await openAgentDocumentAtPath('w', join(dir, 'a.txt'), options), { ok: false, code: 'INVALID_PATH' });
    assert.deepEqual(
      await openAgentDocumentAtPath('w', target, { ...options, maxBytes: 16 }),
      { ok: false, code: 'TOO_LARGE' },
    );
    assert.deepEqual(nativeFiles.descriptorsForSession('w'), []);
  } finally {
    cleanup();
  }
});

test('새 문서는 기본 폴더를 만들고, 이름이 겹치면 (2)·(3) 으로 비켜 가며 덮어쓰지 않는다', async () => {
  const { dir, nativeFiles, cleanup } = setup();
  try {
    // 처음 쓰는 컴퓨터처럼 문서 폴더도 HamaEditor 폴더도 아직 없다.
    const defaultFolder = join(dir, 'Documents', 'HamaEditor');
    assert.equal(existsSync(join(dir, 'Documents')), false);
    const options = { nativeFiles, defaultFolder, home: dir };

    const first = await createAgentDocument('window-1', { name: '회의록', bytes: BLANK_HWPX }, options);
    assert.equal(first.ok, true);
    assert.equal(first.path, join(defaultFolder, '회의록.hwpx'));
    assert.equal(first.name, '회의록.hwpx');
    assert.equal(await nativeFiles.ownerForPath(first.path), 'window-1');
    assert.deepEqual(readFileSync(first.path), BLANK_HWPX);

    // 사용자가 둔 같은 이름의 파일은 그대로 남는다.
    const userFile = join(defaultFolder, '보고서.hwpx');
    writeFileSync(userFile, 'user content');
    const second = await createAgentDocument('window-1', { name: '보고서', bytes: BLANK_HWPX }, options);
    const third = await createAgentDocument('window-2', { name: '보고서.hwpx', bytes: BLANK_HWPX }, options);
    assert.equal(second.path, join(defaultFolder, '보고서 (2).hwpx'));
    assert.equal(third.path, join(defaultFolder, '보고서 (3).hwpx'));
    assert.equal(readFileSync(userFile, 'utf8'), 'user content');

    const unnamed = await createAgentDocument('window-1', { name: '  ', bytes: BLANK_HWPX }, options);
    assert.equal(unnamed.path, join(defaultFolder, '새 문서.hwpx'));
    // 임시 파일을 남기지 않는다.
    assert.deepEqual(
      readdirSync(defaultFolder).sort(),
      ['보고서 (2).hwpx', '보고서 (3).hwpx', '보고서.hwpx', '새 문서.hwpx', '회의록.hwpx'],
    );
  } finally {
    cleanup();
  }
});

test('새 문서는 주어진 폴더가 있는 절대 경로의 실제 폴더일 때만 쓰고 잘못된 입력은 코드로 거절한다', async () => {
  const { dir, nativeFiles, cleanup } = setup();
  try {
    const folder = join(dir, '프로젝트');
    mkdirSync(folder);
    const linkedFolder = join(dir, '링크 폴더');
    symlinkSync(folder, linkedFolder, 'junction');
    mkdirSync(join(folder, '하위'));
    const home = join(dir, 'home');
    mkdirSync(home);
    const homeFolder = join(home, '프로젝트');
    symlinkSync(folder, homeFolder, 'junction');
    const options = { nativeFiles, defaultFolder: join(dir, 'default'), home: dir };

    const created = await createAgentDocument('w', { name: '안내문', folder, bytes: BLANK_HWPX }, options);
    assert.equal(created.path, join(folder, '안내문.hwpx'));

    // 홈 밖의 폴더, 링크를 거치는 폴더(링크된 상위 폴더 포함)는 허브를 거치지 않고 와도 거절한다.
    assert.deepEqual(
      await createAgentDocument('w', { name: 'x', folder, bytes: BLANK_HWPX }, { ...options, home }),
      { ok: false, code: 'INVALID_FOLDER' },
    );
    for (const bad of ['relative/folder', join(dir, '없는 폴더'), linkedFolder, join(linkedFolder, '하위'), join(homeFolder, '하위'),
      '//server/share', join(folder, '안내문.hwpx')]) {
      assert.deepEqual(
        await createAgentDocument('w', { name: 'x', folder: bad, bytes: BLANK_HWPX }, options),
        { ok: false, code: 'INVALID_FOLDER' },
        bad,
      );
    }
    assert.deepEqual(
      await createAgentDocument('w', { name: 7, bytes: BLANK_HWPX }, options),
      { ok: false, code: 'INVALID_NAME' },
    );
    assert.deepEqual(
      await createAgentDocument('w', { name: '깨진 문서', folder, bytes: new Uint8Array([1, 2, 3]) }, options),
      { ok: false, code: 'WRITE_FAILED' },
    );
    assert.deepEqual(readdirSync(folder).sort(), ['안내문.hwpx', '하위']);
  } finally {
    cleanup();
  }
});
