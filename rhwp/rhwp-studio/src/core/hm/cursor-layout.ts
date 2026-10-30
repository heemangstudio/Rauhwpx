/** 다음 편집 개체 찾기와 쪽별 줄 배치를 엔진의 조회 결과로 제공한다. */
import type { HmCore } from './core';
import { px } from './core';
import { bodyList, paraMap, stepsToPath, wireToLogical, wireToText } from './address';
import type { LineLayoutItem } from '../types';
import { extendBridge } from './api';

export function getPageLineLayout(core: HmCore, pageNum: number): { lines: LineLayoutItem[] } {
  return { lines: core.adapter.page(pageNum).lines.map(line => {
    const map = paraMap(core.paragraph(line.list, line.para));
    const start = line.stops[0]?.[0] ?? map.lead, end = line.stops.at(-1)?.[0] ?? map.end;
    const xs = line.stops.map(stop => px(stop[1]));
    const left = xs.length ? Math.min(...xs) : 0, right = xs.length ? Math.max(...xs) : 0;
    const path = stepsToPath(line.list.steps, line.para);
    return { x: left, y: px(line.y), w: right - left, h: px(line.height), bl: px(line.baseline),
      sec: line.list.section, para: line.para, cs: wireToLogical(map, start), ce: wireToLogical(map, end),
      runs: line.stops.slice(0, -1).map((stop, index) => [px(stop[1]), px(line.stops[index + 1][1] - stop[1]), wireToLogical(map, stop[0]), wireToLogical(map, line.stops[index + 1][0])] as [number, number, number, number]),
      ...(path.length ? { cell: { pp: line.list.steps[0].para, path: path.map(entry => [entry.controlIndex, entry.cellIndex, entry.cellParaIndex] as [number, number, number]) } } : {}),
    };
  }) };
}

function controls(core: HmCore): Array<{ type: string; sec: number; para: number; ci: number; charPos: number }> {
  const out = [];
  for (let sec = 0; sec < core.adapter.getSectionCount(); sec++) {
    const list = bodyList(sec);
    for (let para = 0; para < core.paragraphCount(list); para++) {
      const info = core.paragraph(list, para), map = paraMap(info);
      for (const control of info.controls) {
        if (!['table', 'object', 'equation'].includes(control.kind)) continue;
        out.push({ type: control.kind === 'object' ? 'shape' : control.kind, sec, para, ci: control.index, charPos: wireToText(map, control.offset) });
      }
    }
  }
  return out;
}

export function findNextEditableControl(core: HmCore, sec: number, para: number, ctrlIdx: number, delta: number): { type: string; sec: number; para: number; ci: number } {
  const entries = controls(core);
  const index = entries.findIndex(item => item.sec === sec && item.para === para && item.ci === ctrlIdx);
  return entries[index + (delta < 0 ? -1 : 1)] ?? { type: 'none', sec, para, ci: -1 };
}

extendBridge({ getPageLineLayout, findNextEditableControl });
