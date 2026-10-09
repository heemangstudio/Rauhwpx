// 외부에서 들어온 그림·파일을 읽는 실제 경로가 할당·디코드 전에 크기 한도를 지키는지 본다.
//
// 그림 삽입·지정·붙여넣기·클립보드 변환·문서 그림 표시 경로를 실제 모듈로 실행하고,
// 브라우저 API(파일 선택 input, Image, ClipboardItem)만 기록용 가짜로 둔다.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { INSERTED_IMAGE_MAX_BYTES } from '../src/core/document-input-limits.ts';
import { isDomDisplayableFlowImage } from '../src/view/flow-image-clip.ts';
import { createTestModuleServer } from './support/module-server.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

/** 헤더만으로 4G×4G 픽셀을 선언하는 24바이트 PNG — 디코드하면 메모리가 폭발한다. */
function bombPng(): Uint8Array {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 0xffff_ffff, false);
  new DataView(png.buffer).setUint32(20, 0xffff_ffff, false);
  return png;
}

/** 크기 메타데이터만 한도를 넘는 파일. 실제로 읽으면 allocated 가 켜진다. */
function oversizedImageFile() {
  const file = {
    name: 'huge.png',
    type: 'image/png',
    size: INSERTED_IMAGE_MAX_BYTES + 1,
    allocated: false,
    async arrayBuffer() {
      file.allocated = true;
      return new ArrayBuffer(0);
    },
  };
  return file;
}

/** 어떤 속성·호출도 받아 주는 느슨한 DOM 값. 토스트 같은 부수 UI 를 조용히 흘려보낸다. */
function anything(): any {
  return new Proxy(function noop() {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* empty() {};
      if (key === 'length') return 0;
      return anything();
    },
    set: () => true,
    apply: () => anything(),
    construct: () => anything(),
  });
}

const fileInputs: Array<{ files?: unknown[]; onchange?: () => Promise<void> }> = [];
let imagesCreated = 0;
const warnings: unknown[][] = [];
const saved: Record<string, unknown> = {};
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['document', 'window', 'Image', 'ClipboardItem', 'requestAnimationFrame']) saved[key] = g[key];
  g.document = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'createElement') {
        return (tag: string) => {
          if (tag !== 'input') return anything();
          const input = { type: '', accept: '', click() {} } as { files?: unknown[]; onchange?: () => Promise<void> };
          fileInputs.push(input);
          return input;
        };
      }
      if (key === 'getElementById' || key === 'querySelector') return () => null;
      return anything();
    },
  });
  g.window = anything();
  // 디코드에 들어가면 바로 실패시켜 경로가 끝나게 한다 — 생성 횟수만 본다.
  g.Image = class {
    onerror: (() => void) | null = null;
    constructor() { imagesCreated += 1; }
    set src(_url: string) { queueMicrotask(() => this.onerror?.()); }
    decode() { return Promise.reject(new Error('decode blocked in test')); }
  };
  g.ClipboardItem = class {};
  g.requestAnimationFrame = () => 0;
  vite = await createTestModuleServer(rootDir);
});

after(async () => {
  await vite?.close();
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) g[key] = value;
});

beforeEach(() => {
  fileInputs.length = 0;
  imagesCreated = 0;
  warnings.length = 0;
});

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    return await run();
  } finally {
    console.warn = warn;
  }
}

/** 파일 선택 input 에 파일을 넣고 onchange 가 끝날 때까지 기다린다. */
async function choose(file: unknown): Promise<void> {
  const input = fileInputs.at(-1);
  assert.ok(input?.onchange, '파일 선택 input 을 열어야 한다');
  input.files = [file];
  await quietly(() => input.onchange!());
}

test('그림 삽입은 64 MiB 를 넘는 파일을 읽지 않고, 픽셀 폭탄을 디코드하지 않는다', async () => {
  const { insertCommands } = await vite.ssrLoadModule('/src/command/commands/insert.ts');
  const insertImage = insertCommands.find((command: { id: string }) => command.id === 'insert:image');
  const placed: unknown[] = [];
  const services = {
    getInputHandler: () => ({ enterImagePlacementMode: (...args: unknown[]) => placed.push(args) }),
  };

  const huge = oversizedImageFile();
  insertImage.execute(services);
  await choose(huge);
  assert.equal(huge.allocated, false);

  insertImage.execute(services);
  await choose(new File([bombPng()], 'bomb.png', { type: 'image/png' }));
  assert.equal(imagesCreated, 0, '선언 크기가 한도를 넘으면 Image 디코드를 시작하지 않는다');
  assert.deepEqual(placed, []);
  assert.equal(warnings.length, 2);
});

test('그림 지정도 같은 크기·픽셀 한도를 디코드 전에 적용한다', async () => {
  const { promptAssignPictureImage } = await vite.ssrLoadModule('/src/engine/input-handler-picture.ts');
  const operations: unknown[] = [];
  const handler = { executeOperation: (op: unknown) => operations.push(op) };
  const ref = { sec: 0, ppi: 0, ci: 0 };

  const huge = oversizedImageFile();
  promptAssignPictureImage.call(handler, ref);
  await choose(huge);
  assert.equal(huge.allocated, false);

  promptAssignPictureImage.call(handler, ref);
  await choose(new File([bombPng()], 'bomb.png', { type: 'image/png' }));
  assert.equal(imagesCreated, 0);
  assert.deepEqual(operations, []);
  assert.equal(warnings.length, 2);
});

test('클립보드 그림 붙여넣기는 큰 파일과 픽셀 폭탄을 문서에 넣지 않는다', async () => {
  const { onPaste } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
  const operations: unknown[] = [];
  const handler = {
    active: true,
    readOnly: false,
    userEditingLocked: false,
    cursor: {
      isInPictureObjectSelection: () => false,
      isInTableObjectSelection: () => false,
      isInHeaderFooter: () => false,
      isInFootnote: () => false,
      hasSelection: () => false,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    },
    wasm: { getClipboardText: () => '', hasInternalClipboard: () => false },
    executeOperation: (op: unknown) => operations.push(op),
  };
  const paste = (file: unknown) => new Promise<void>((resolve) => {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
      console.warn = warn;
      resolve();
    };
    onPaste.call(handler, {
      preventDefault() {},
      clipboardData: {
        getData: () => '',
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });
  });

  const huge = oversizedImageFile();
  await paste(huge);
  assert.equal(huge.allocated, false);

  await paste(new File([bombPng()], 'bomb.png', { type: 'image/png' }));
  assert.equal(imagesCreated, 0);
  assert.deepEqual(operations, []);
});

test('클립보드로 그림을 복사할 때 PNG 로 바꾸기 전에 픽셀 폭탄을 거부한다', async () => {
  const { writeImageToClipboard } = await vite.ssrLoadModule('/src/engine/input-handler-keyboard.ts');
  const jpegBomb = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01, 0x01,
    0xff, 0xd9,
  ]);
  const wasm = {
    getControlImageData: () => jpegBomb,
    getControlImageMime: () => 'image/jpeg',
  };
  await assert.rejects(() => writeImageToClipboard(wasm, 0, 0, 0, '', ''), /안전 한도/);
  assert.equal(imagesCreated, 0);
});

test('문서 속 그림은 선언 픽셀이 한도를 넘으면 DOM 이미지로 디코드하지 않는다', () => {
  const base64 = Buffer.from(bombPng()).toString('base64');
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/png', base64 }), false);

  const safe = bombPng();
  new DataView(safe.buffer).setUint32(16, 320, false);
  new DataView(safe.buffer).setUint32(20, 240, false);
  assert.equal(isDomDisplayableFlowImage({ mime: 'image/png', base64: Buffer.from(safe).toString('base64') }), true);
});

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} 확장 썸네일은 64 MiB 를 넘는 응답 본문을 읽지 않고 취소한다`, async () => {
    const { extractThumbnailFromUrl } = await import(`../../rhwp-${browser}/sw/thumbnail-extractor.js`);
    const previousFetch = globalThis.fetch;
    let pulled = 0;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled === 4) controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } });
    try {
      assert.equal(await extractThumbnailFromUrl(`https://example.com/${browser}-huge.hwp`), null);
    } finally {
      globalThis.fetch = previousFetch;
    }
    assert.equal(cancelled, true, '선언 크기만 보고 본문을 버려야 한다');
    assert.ok(pulled <= 1, `본문을 읽으면 안 된다: ${pulled}`);
  });
}
