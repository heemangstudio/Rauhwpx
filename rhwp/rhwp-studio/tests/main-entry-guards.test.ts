import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 남은 소스 가드 모음. main.ts 는 앱 진입점이라 Node·브라우저 단위 테스트에서 실행할 seam 이
// 없다. 각 배선의 핵심 동작(한도 함수, 저장 경로, 버전 컨트롤러, 읽기 전용 게이트)은 다른
// 파일이 실제 모듈로 검증하고, 여기서는 main.ts 가 그 동작을 잇는 지점만 지킨다.

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function between(start: string, end: string): string {
  const startIndex = main.indexOf(start);
  const endIndex = main.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return main.slice(startIndex, endIndex);
}

function assertBefore(contents: string, first: string, second: string): void {
  const firstIndex = contents.indexOf(first);
  const secondIndex = contents.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing: ${first}`);
  assert.notEqual(secondIndex, -1, `missing: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test('untrusted drops, dropped images, save identity reads and remote URLs stay bounded', () => {
  const droppedImage = between('    if (isImage) {', '    // HWP/HWPX/HML/RHWPX');
  assertBefore(droppedImage, "readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES, '그림')", 'new Image()');
  assertBefore(droppedImage, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  assert.match(main, /loadFile\(file, \{ fileHandle, untrustedSource: true \}\)/);
  assert.match(
    main,
    /options\.fileHandle && !options\.untrustedSource[\s\S]*?readFileFromHandle\(options\.fileHandle\)[\s\S]*?readBlobBytesWithLimit\(file, UNTRUSTED_DOCUMENT_MAX_BYTES/,
  );
  assert.match(main, /const targetBytes = await readBlobBytesWithLimit\([\s\S]*?EXACT_LOCAL_DOCUMENT_MAX_BYTES/);
  assert.match(main, /validatedRemoteUrl = validateRemoteDocumentUrl\(fileUrl\)/);
  assert.match(main, /hasExtensionRuntime && validatedRemoteUrl[\s\S]*?throw new ExtensionRemoteProxyUnavailableError\(\)/);
  assert.match(main, /fetch\(validatedRemoteUrl\?\.href \?\? fileUrl\)/);
});

test('template preview URLs open the document read-only', () => {
  assert.match(main, /documentReadOnly = new URLSearchParams[\s\S]*templatePreview/);
  // 문서 세션마다 읽기 전용을 묻지만, 템플릿 미리보기 플래그는 모든 세션에 먼저 걸린다.
  assert.match(main, /function sessionReadOnly\([^)]*\): boolean \{\s*return documentReadOnly \|\|/);
  assert.match(main, /isEditable: !sessionReadOnly\(\)/);
  assert.match(main, /inputHandler\??\.setReadOnly\(sessionReadOnly\(/);
});

test('host saves and embed exports share one HostSaveTracker (#2660)', () => {
  assert.match(main, /async function completeHostSave\(fileName\?: string\)[\s\S]*?hostSave\.complete\(fileName\)/);
  for (const method of ['exportHwp', 'exportHwpx', 'exportHml']) {
    assert.match(main, new RegExp(`async ${method}\\(\\) \\{[\\s\\S]*?hostSave\\.recordExport\\(\\);[\\s\\S]*?return wasm\\.${method}\\(\\)`));
  }
  assert.match(main, /\.rhwpStudio = \{\s*\n?\s*notifySaved:/);
  assert.match(main, /async notifySaved\(fileName\)[\s\S]*?completeHostSave\(fileName\)/);
});

test('document replacement waits for version work and republishes context on failure', () => {
  assert.match(main, /session\.versions = new DocumentVersionController\(/);
  assert.match(
    main,
    /const allowed = skipUnsavedGuard[\s\S]*?if \(!allowed\) return false;\s*await attachedSession\.versions\?\.whenIdle\(\);\s*return true;/,
  );
  for (const fn of ['async function loadBytesNow', 'async function createNewDocumentNow']) {
    assert.match(
      main,
      new RegExp(`${fn}[\\s\\S]*?catch \\(error\\) \\{[\\s\\S]*?attachedSession\\.documentId = null;\\s*eventBus\\.emit\\('document-context-changed'\\)`),
    );
  }
});

test('document identity follows verified grants and handle-backed saves', () => {
  assert.match(main, /const verifiedGrant = grant \?\?/);
  assert.match(main, /attachedSession\.documentId = ownership\.identity\.documentId/);
  assert.match(main, /getDocumentId: \(\) => session\.documentId/);
  assert.match(
    main,
    /eventBus\.on\('document-file-handle-saved',[\s\S]*?documentId = attachedSession\.documentId;[\s\S]*?rememberNativeDocument\(documentId, saved\.fileHandle[\s\S]*?addRecentDoc\(\{[\s\S]*?handle: saved\.fileHandle/,
  );
  assert.match(main, /rememberNativeDocument\(\s*ownership\.identity\.documentId,\s*fileHandle/);
});

test('only canonical history archives keep their handle for later saves', () => {
  assert.match(
    main,
    /retainPortableHistoryHandle[\s\S]*?!isLegacyPortableHistoryFolderHandle\(data\.fileHandle\)[\s\S]*?isPortableHistoryFileName/,
  );
  assert.match(main, /retainPortableHistoryHandle \? data\.fileHandle : null/);
  assert.match(main, /if \(!retainPortableHistoryHandle\) \{[\s\S]*?releaseUnusedSaveTarget/);
});

test('an agent editing lease blocks document replacement and file drops', () => {
  assert.match(main, /canReplaceCurrentDocument[\s\S]*if \(agentEditingLease\.active\)/);
  assert.match(main, /loadFile[\s\S]*canReplaceCurrentDocument\(options\.skipUnsavedGuard\)/);
  assert.match(main, /addEventListener\('drop'[\s\S]*if \(agentEditingLease\.active\)/);
  assert.match(main, /editorArea\?\.setAttribute\('aria-busy', lease\.active \? 'true' : 'false'\)/);
});
