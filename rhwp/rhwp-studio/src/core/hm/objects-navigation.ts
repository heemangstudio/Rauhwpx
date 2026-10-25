/** F11·Shift+F11 의 가장 가까운 개체 찾기와 셀 범위 나누기. */
import type { ControlInfo, EditOp } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { bodyList, paraMap, wireToLogical } from './address';
import { extendBridge } from './api';
import { objectProperties } from './objects-editing';
import { tableAddress, tableAddressByPath, tableInfo } from './table-editing';
import type * as cursorStubs from './cursor';
import type * as tableStubs from './table';
import type { TableAddress } from '../../../vendor/hm-wasm/hm_wasm';

type Found = ReturnType<typeof cursorStubs.findNearestControlForward>;

/** 선택할 수 있는 컨트롤의 종류. 그 밖의 컨트롤(구역·단 정의 등)은 건너뛴다. */
function classify(core: HmCore, sec: number, para: number, c: ControlInfo): string | null {
  switch (c.kind) {
    case 'table': case 'equation': case 'field': case 'bookmark': return c.kind;
    case 'object':
      return objectProperties(core, { section: sec, para, control: c.index }).kind === 'picture' ? 'picture' : 'shape';
    default: return null;
  }
}

/** 커서 문단부터 같은 구역을 훑고, 없으면 다음(이전) 구역들로 넘어가 찾는다. */
function nearest(core: HmCore, sec: number, para: number, offset: number, step: 1 | -1): Found {
  const sections = core.adapter.getSectionCount();
  for (let s = sec; s >= 0 && s < sections; s += step) {
    const list = bodyList(s);
    const count = core.paragraphCount(list);
    const first = s === sec ? Math.min(para, count - 1) : step > 0 ? 0 : count - 1;
    for (let p = first; p >= 0 && p < count; p += step) {
      const info = core.paragraph(list, p);
      const map = paraMap(info);
      const controls = step > 0 ? info.controls : [...info.controls].reverse();
      for (const c of controls) {
        // 커서 문단에서는 커서 앞(뒤)의 컨트롤만 본다. 위치는 캐럿과 같은 논리 오프셋이다(개체 하나가 1).
        const pos = wireToLogical(map, c.offset);
        if (s === sec && p === para && (step > 0 ? pos <= offset : pos >= offset)) continue;
        const type = classify(core, s, p, c);
        if (type) return { type, sec: s, para: p, ci: c.index, charPos: pos };
      }
    }
  }
  return { type: 'none', sec, para, ci: -1 };
}

export const findNearestControlBackward: typeof cursorStubs.findNearestControlBackward = (core, sec, para, offset) => nearest(core, sec, para, offset, -1);
export const findNearestControlForward: typeof cursorStubs.findNearestControlForward = (core, sec, para, offset) => nearest(core, sec, para, offset, 1);

/**
 * 범위 안의 셀마다 nRows×mCols 로 나눈다. 셀 하나를 나누면 그 아래 행·오른쪽 열의 번호가 늘어난
 * 줄·칸 수만큼 밀리므로, 남은 셀의 주소를 그만큼 옮기며 하나씩 나눈다.
 */
function splitRange(core: HmCore, table: TableAddress, startRow: number, startCol: number, endRow: number, endCol: number, rows: number, columns: number, equalRowHeight: boolean) {
  let info = tableInfo(core, table);
  const targets = info.cells
    .filter(c => c.row >= startRow && c.row <= endRow && c.column >= startCol && c.column <= endCol)
    .map(c => ({ row: c.row, column: c.column }));
  for (let i = 0; i < targets.length; i++) {
    const { row, column } = targets[i];
    const before = { rows: info.rows, columns: info.columns };
    core.transact([{ op: 'splitTableCell', table, row, column, rows, columns, equalRowHeight } as EditOp]);
    info = tableInfo(core, table);
    const dr = info.rows - before.rows, dc = info.columns - before.columns;
    for (const t of targets.slice(i + 1)) {
      if (t.row > row) t.row += dr;
      if (t.column > column) t.column += dc;
    }
  }
  return { ok: true, cellCount: info.cells.length };
}

export const splitTableCellsInRange: typeof tableStubs.splitTableCellsInRange = (core, s, p, c, r0, c0, r1, c1, rows, cols, equal) =>
  splitRange(core, tableAddress(s, p, c), r0, c0, r1, c1, rows, cols, equal);
export const splitTableCellsInRangeByPath: typeof tableStubs.splitTableCellsInRangeByPath = (core, s, p, path, r0, c0, r1, c1, rows, cols, equal) =>
  splitRange(core, tableAddressByPath(s, p, path), r0, c0, r1, c1, rows, cols, equal);

extendBridge({ findNearestControlBackward, findNearestControlForward, splitTableCellsInRange, splitTableCellsInRangeByPath });
