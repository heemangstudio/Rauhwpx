/** 직선 끝점 옮기기와 개체 묶기·풀기. 각 호출이 엔진 이력 한 칸이다. */
import type { EditOp } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { extendBridge } from './api';
import type * as original from './objects';
import { objectAddress, pageObjects } from './objects-editing';

/** 본문 개체가 놓인 쪽 상자(HU). */
function laidBox(core: HmCore, sec: number, para: number, ci: number): { x: number; y: number } {
  for (let page = 0; page < core.state().pageCount; page++) {
    const found = pageObjects(core, page).find(o => o.section === sec && o.para === para && o.control === ci
      && !o.steps?.length && !o.furniture);
    if (found) return found;
  }
  throw new Error('개체가 표시된 쪽을 찾을 수 없습니다');
}

/** 끝점은 쪽 좌표(HU)다. 엔진은 지금 개체 상자 왼쪽 위 기준으로 받는다. */
export const moveLineEndpoint: typeof original.moveLineEndpoint = (core, sec, para, ci, sx, sy, ex, ey) => {
  const box = laidBox(core, sec, para, ci);
  core.transact([{ op: 'setLineEnds', object: objectAddress(sec, para, ci),
    start: [Math.round(sx - box.x), Math.round(sy - box.y)], end: [Math.round(ex - box.x), Math.round(ey - box.y)] } as EditOp]);
};

/** 묶음은 문서 순서로 첫 개체 자리에 들어간다. 뒤 개체만 빠지므로 그 번호가 그대로 묶음 번호다. */
export const groupShapes: typeof original.groupShapes = (core, sec, targets) => {
  const first = [...targets].sort((a, b) => a.paraIdx - b.paraIdx || a.controlIdx - b.controlIdx)[0];
  if (!first) throw new RangeError('묶을 개체가 없습니다');
  core.transact([{ op: 'groupObjects', objects: targets.map(t => objectAddress(sec, t.paraIdx, t.controlIdx)) } as EditOp]);
  return { ok: true, paraIdx: first.paraIdx, controlIdx: first.controlIdx };
};

export const ungroupShape: typeof original.ungroupShape = (core, sec, para, ci) => {
  core.transact([{ op: 'ungroupObject', object: objectAddress(sec, para, ci) } as EditOp]);
  return { ok: true };
};

extendBridge({ moveLineEndpoint, groupShapes, ungroupShape });
