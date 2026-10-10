import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';

// #1491 Stage 1: undo/redo 뒤에 남은 표 로컬 resize 구간·bbox 캐시가 다음 resize 에 다시
// 적용되면 되돌린 너비가 되살아난다. 기록 이동은 그 캐시를 모두 비워야 한다.
const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
const { InputHandler } = await vite.ssrLoadModule('/src/engine/input-handler.ts') as typeof import('../src/engine/input-handler.ts');
test.after(() => vite.close());

function handlerWithResizeCache() {
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const markers: string[] = [];
  return Object.assign(Object.create(InputHandler.prototype), {
    markers,
    imeSession: { isComposing: false },
    wasm: {},
    history: {
      undo: () => pos,
      redo: () => pos,
      peekUndoTop: () => null,
      peekRedoTop: () => null,
      consumeLastExecutionEffects: () => undefined,
    },
    tableLocalResizeSegments: new Map([['table-0', [{ cellIdx: 0, width: 4000 }]]]),
    cachedTableRef: { sec: 0, ppi: 0, ci: 0 },
    cachedCellBboxes: [{ cellIdx: 0 }],
    tableBboxFetchFailures: new Set(['table-0']),
    lastCellKey: 'table-0:0',
    tableResizeRenderer: { clear: () => markers.push('cleared') },
    caretLayoutReveal: { requestFor() {} },
    flushDeferredPaginationIfNeeded() {},
    prepareTextMutationBeforeCursor: () => false,
    resetDerivedStateAfterHistoryJump() {},
    restoreEditContextAfterHistory() {},
    restoreSelectionAfterUndo() {},
    restoreSelectionAfterRedo() {},
    afterEdit() {},
  });
}

for (const step of ['handleUndo', 'handleRedo'] as const) {
  test(`${step} 는 표 로컬 resize 런타임 캐시를 비운다`, () => {
    const ih = handlerWithResizeCache();
    ih[step]();
    assert.equal(ih.tableLocalResizeSegments.size, 0);
    assert.equal(ih.cachedTableRef, null);
    assert.equal(ih.cachedCellBboxes, null);
    assert.equal(ih.tableBboxFetchFailures.size, 0);
    assert.equal(ih.lastCellKey, null);
    assert.deepEqual(ih.markers, ['cleared']);
  });
}
