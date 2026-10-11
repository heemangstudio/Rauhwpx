import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapturedSnapshotCommand } from '../src/engine/captured-snapshot-command.ts';
import type { WasmBridge } from '../src/core/wasm-bridge.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relativePath: string): string =>
  readFileSync(join(rootDir, relativePath), 'utf8');

test('captured snapshot callbacks run after their document restore', () => {
  const events: string[] = [];
  const wasm = {
    restoreSnapshot(id: number) { events.push(`restore:${id}`); },
  } as unknown as WasmBridge;
  const command = new CapturedSnapshotCommand(
    'version',
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 },
    10,
    20,
    {
      afterUndo() { events.push('branch:old'); },
      afterRedo() { events.push('branch:new'); },
    },
  );

  assert.deepEqual(command.undo(wasm), { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  assert.deepEqual(command.execute(wasm), { sectionIndex: 1, paragraphIndex: 2, charOffset: 3 });
  assert.deepEqual(events, ['restore:10', 'branch:old', 'restore:20', 'branch:new']);
});

// 큰 입력 한도는 정확한 로컬 파일 읽기에만 허용한다(보안). main.ts 배선은 앱 셸 없이 실행할 수
// 없어 소스로 확인한다.
test('WasmBridge exposes a separate trusted-local constructor path', () => {
  const bridge = source('src/core/wasm-bridge.ts');
  assert.match(
    bridge,
    /loadTrustedLocalFileOnce\(data: Uint8Array, fileName\?: string\): DocumentInfo \{[\s\S]*?fromTrustedLocalFileBytesWithFontMetrics\(bytes, DEFAULT_FONT_METRICS_POLICY\)/,
  );

  const main = source('src/main.ts');
  assert.match(
    main,
    /consumeExactLocalFileRead\(data, fileHandle\)[\s\S]*?loadTrustedLocalFileOnce\(data, fileName\)/,
  );
});
