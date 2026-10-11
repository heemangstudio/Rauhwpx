/**
 * 실제 CommandHistory 를 node --test 에서 쓴다. engine 모듈의 확장자 없는 import 를 node 가
 * 풀지 못하므로 undo-history-integrity.test.ts 처럼 본문만 잘라 가짜 의존성 위에서 만든다.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const historySource = readFileSync(new URL('../src/engine/history.ts', import.meta.url), 'utf8');

/** 테스트가 쓰는 만큼의 CommandHistory 모양. */
export interface TestCommandHistory {
  readonly version: number;
  execute(command: unknown, wasm: unknown): unknown;
  recordWithoutExecute(command: unknown, wasm?: unknown): void;
  undo(wasm: unknown): unknown;
  redo(wasm: unknown): unknown;
  canUndo(): boolean;
  peekUndoTop(): { type: string } | null;
  hasSnapshotCapacity(additionalIds: number): boolean;
  prepareSnapshotCapacity(wasm: unknown, additionalIds: number): void;
  retainExternalSnapshot(count?: number): void;
  releaseExternalSnapshot(count?: number): void;
  clear(wasm?: unknown): void;
}

export type TestCommandHistoryClass = new () => TestCommandHistory;

export function loadCommandHistory(): TestCommandHistoryClass {
  const body = historySource.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  return new Function('NO_TEXT_MUTATION_EFFECTS', `${stripTypeScriptTypes(body)}\nreturn CommandHistory;`)(
    Object.freeze({}),
  ) as TestCommandHistoryClass;
}
