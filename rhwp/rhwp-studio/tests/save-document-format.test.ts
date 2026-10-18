import test from 'node:test';
import assert from 'node:assert/strict';

import { exportDocumentForFormat } from '../src/command/save-document-format.ts';

test('선택한 SaveFormat 하나가 대응하는 exporter만 호출한다', () => {
  const calls: string[] = [];
  const exporter = {
    exportHml: () => {
      calls.push('hml');
      return new TextEncoder().encode(
        '<HWPML xmlns="http://www.hancom.co.kr/hwpml/2011/core"><HEAD/></HWPML>',
      );
    },
    exportHwp: () => {
      calls.push('hwp');
      return new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    },
    exportHwpx: () => {
      calls.push('hwpx');
      return new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
    },
  };

  assert.equal(exportDocumentForFormat(exporter, 'hml')[0], 0x3C);
  assert.equal(exportDocumentForFormat(exporter, 'hwp')[0], 0xD0);
  assert.equal(exportDocumentForFormat(exporter, 'hwpx')[0], 0x50);
  assert.deepEqual(calls, ['hml', 'hwp', 'hwpx']);
});

test('잘못되거나 빈 exporter 결과는 기존 파일을 쓰기 전에 거부한다', () => {
  const exporter = {
    exportHml: () => new Uint8Array(),
    exportHwp: () => new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
    exportHwpx: () => new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
  };

  assert.throws(() => exportDocumentForFormat(exporter, 'hml'), /기존 파일은 변경하지 않았습니다/);
  assert.throws(() => exportDocumentForFormat(exporter, 'hwp'), /파일 형식\(hwpx\)/);
  assert.throws(() => exportDocumentForFormat(exporter, 'hwpx'), /파일 형식\(hwp\)/);
});

// 문서를 떠나며 저장한 뒤 버전 기록이 같은 내용을 다시 내보내면 큰 문서는 1초씩 더 멈춘다.
// 엔진 쓰기가 없었을 때만 같은 바이트를 함께 쓰고, 쓰기·다른 문서·다른 형식이면 새로 내보낸다.
test('같은 문서·형식의 연이은 내보내기는 엔진 쓰기가 없을 때만 바이트를 함께 쓴다', async () => {
  const { guardEngineCalls, resetEngineTrapForTests } = await import('../src/core/engine-trap.ts');
  const { forgetDocumentExportForTests } = await import('../src/command/save-document-format.ts');
  resetEngineTrapForTests();
  forgetDocumentExportForTests();
  let version = 0;
  let exports = 0;
  class FakeDocument {
    exportHwp(): Uint8Array {
      exports += 1;
      return new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, version]);
    }
    exportHwpx(): Uint8Array {
      exports += 1;
      return new Uint8Array([0x50, 0x4B, 0x03, 0x04, version]);
    }
    insertText(): void { version += 1; }
  }
  guardEngineCalls(FakeDocument.prototype);
  const doc = new FakeDocument();
  const exporter = (generation: number) => ({
    documentGeneration: generation,
    exportHml: () => { throw new Error('unused'); },
    exportHwp: () => doc.exportHwp(),
    exportHwpx: () => doc.exportHwpx(),
  });

  const saved = exportDocumentForFormat(exporter(7), 'hwp');
  assert.equal(exportDocumentForFormat(exporter(7), 'hwp'), saved);
  assert.equal(exports, 1);

  exportDocumentForFormat(exporter(8), 'hwp');
  assert.equal(exports, 2, '다른 문서');
  exportDocumentForFormat(exporter(8), 'hwpx');
  assert.equal(exports, 3, '다른 형식');

  doc.insertText();
  const edited = exportDocumentForFormat(exporter(8), 'hwpx');
  assert.equal(exports, 4, '엔진 쓰기 뒤');
  assert.equal(edited.at(-1), 1);

  // 다른 곳으로 옮겨진(transfer) 버퍼는 다시 내주지 않는다.
  structuredClone(edited.buffer, { transfer: [edited.buffer] });
  assert.equal(exportDocumentForFormat(exporter(8), 'hwpx').byteLength, 5);
  assert.equal(exports, 5);

  // 문서 번호를 모르는 exporter 는 함께 쓰지 않는다.
  const plain = { exportHml: () => new Uint8Array(), exportHwp: () => doc.exportHwp(), exportHwpx: () => doc.exportHwpx() };
  exportDocumentForFormat(plain, 'hwp');
  exportDocumentForFormat(plain, 'hwp');
  assert.equal(exports, 7);
  forgetDocumentExportForTests();
});
