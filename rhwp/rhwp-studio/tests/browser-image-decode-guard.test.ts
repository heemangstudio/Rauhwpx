import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function assertBefore(contents: string, first: string, second: string): void {
  const firstIndex = contents.indexOf(first);
  const secondIndex = contents.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing guard: ${first}`);
  assert.notEqual(secondIndex, -1, `missing decode path: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test('all file insertion and assignment paths guard encoded dimensions before Image decode', () => {
  const mainDrop = between(source('main.ts'), '    if (isImage) {', '    // HWP/HWPX/HML/RHWPX');
  assertBefore(mainDrop, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const assignment = between(
    source('engine/input-handler-picture.ts'),
    'export function promptAssignPictureImage',
    'export function findPictureAtClick',
  );
  assertBefore(assignment, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const picker = between(
    source('command/commands/insert.ts'),
    "    id: 'insert:image'",
    "    id: 'insert:textbox'",
  );
  assertBefore(picker, 'assertEncodedImageDecodeDimensions(data', 'new Image()');
});

test('clipboard conversion and paste guard encoded dimensions before Image decode', () => {
  const keyboard = source('engine/input-handler-keyboard.ts');
  const conversion = between(
    keyboard,
    'async function convertToPngBlob',
    '/** [Task #1161]',
  );
  assertBefore(conversion, "if (mime === 'image/png')", 'assertEncodedImageDecodeDimensions(data');
  assertBefore(conversion, 'assertEncodedImageDecodeDimensions(data', 'new Image()');

  const paste = between(
    keyboard,
    'async function pasteImageFile',
    '/** 기존 컨트롤 선택 상태를 모두 해제한다 */',
  );
  assertBefore(paste, 'assertEncodedImageDecodeDimensions(data', 'new Image()');
});

test('PageRenderer guards embedded raster data before DOM image decode', () => {
  const renderer = source('view/page-renderer.ts');
  const flowImages = between(
    renderer,
    '  private createOrReuseFlowImageLayer',
    '  private createOrReuseFilteredCanvasLayer',
  );
  // DOM 층은 모든 그림이 형식·크기 검사를 통과할 때만 `<img>` 디코드를 시작한다.
  assertBefore(flowImages, 'images.every(isDomDisplayableFlowImage)', 'new Image()');
  const displayable = between(
    source('view/flow-image-clip.ts'),
    'export function isDomDisplayableFlowImage',
    'export function visibleFlowImageBbox',
  );
  assert.match(displayable, /assertBase64EncodedImageDecodeDimensions\(image\.base64/);
});
