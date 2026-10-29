/** MCP 글자 좌표와 core/hm 텍스트 오프셋은 모두 유니코드 scalar 다. 캐럿 좌표는 인라인 개체와 각주를 한 칸씩 더 센다. */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CellAddr } from './types.ts';

/** agent 텍스트 지점을 UI 전용 기하 API 에 넘기기 전에 한 번만 바꾼다. */
export function agentTextToLogicalOffset(wasm: WasmBridge, sec: number, para: number, offset: number, cell?: CellAddr): number {
  if (cell) {
    const path = cell.path?.length
      ? cell.path.map((entry, i) => i === cell.path!.length - 1 ? { ...entry, cellParaIndex: para } : entry)
      : [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: para }];
    return typeof wasm.textToLogicalOffsetInCellByPath === 'function'
      ? wasm.textToLogicalOffsetInCellByPath(sec, cell.paraIdx, JSON.stringify(path), offset) : offset;
  }
  return typeof wasm.textToLogicalOffset === 'function' ? wasm.textToLogicalOffset(sec, para, offset) : offset;
}
