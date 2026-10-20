import './support/wasm-liftoff.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requireWasmPackage } from './browser-support.ts';
import { createTestModuleServer } from './support/module-server.ts';

// hwpctl SaveAs 가 내려받는 파일의 확장자는 실제로 쓴 바이트 형식과 같아야 한다.
// 형식 인자와 파일명이 엇갈리면 ZIP(HWPX)이 .hwp 로 내려가 한글에서 손상된 파일로 열렸다.
requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const { initSync, HwpDocument } = await import('../../pkg/rhwp.js');
initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { HwpCtrl } = await vite.ssrLoadModule('/src/hwpctl/index.ts') as typeof import('../src/hwpctl/index.ts');
test.after(() => vite.close());

async function saveAs(filename: string, format?: string) {
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const anchor = { href: '', download: '', click: () => downloads.push({ name: anchor.download, blob: blobs.get(anchor.href)! }) };
      return anchor;
    },
  };
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  try {
    const document = HwpDocument.createEmpty();
    document.createBlankDocument();
    assert.equal(new HwpCtrl(document).SaveAs(filename, format), true);
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
  assert.equal(downloads.length, 1);
  const bytes = new Uint8Array(await downloads[0]!.blob.arrayBuffer());
  return { name: downloads[0]!.name, bytes };
}

function containerOf(bytes: Uint8Array) {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return '.hwp';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '.hwpx';
  if (new TextDecoder().decode(bytes.subarray(0, 512)).includes('<HWPML')) return '.hml';
  return 'unknown';
}

test('SaveAs names the download after the format it actually wrote', async () => {
  for (const [filename, format, expectedName] of [
    ['보고서.hwp', 'HWPX', '보고서.hwpx'],
    ['보고서.hwpx', 'HWP', '보고서.hwp'],
    ['REPORT.HWP', undefined, 'REPORT.hwp'],
    ['REPORT.HWPX', undefined, 'REPORT.hwpx'],
    ['보고서', 'HWP', '보고서.hwp'],
  ] as const) {
    const { name, bytes } = await saveAs(filename, format);
    assert.equal(name, expectedName, `${filename} + ${format}`);
    assert.equal(name.slice(name.lastIndexOf('.')), containerOf(bytes), `${filename} + ${format}`);
  }
});
