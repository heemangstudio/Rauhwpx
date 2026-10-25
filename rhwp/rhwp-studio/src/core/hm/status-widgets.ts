/** 기존 용지·글자 수 위젯을 엔진 모델 조회로 채운다. */
import type { HmCore } from './core';
import type { PageInfo as HmPage } from '../../../vendor/hm-wasm/hm_wasm';
import { bodyList, logicalAddress, pathTarget } from './address';
import { pageDef } from '../heemang-format';
import { extendBridge } from './api';

export function getPageDef(core: HmCore, sectionIdx: number): ReturnType<typeof pageDef> {
  const page = (JSON.parse(core.call(doc => doc.pages())) as HmPage[]).find(item => item.section === sectionIdx);
  if (!page) throw new RangeError(`구역 ${sectionIdx} 이 없습니다`);
  return pageDef(page);
}

export function getDocumentCharacterCount(core: HmCore): number {
  return core.query<{ characters: number }>({ kind: 'count' }).characters;
}

export function getBodyRangeCharacterCount(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): number {
  return core.query<{ characters: number }>({ kind: 'count',
    from: logicalAddress(core, bodyList(startSec), startPara, startOffset),
    to: logicalAddress(core, bodyList(endSec), endPara, endOffset),
  }).characters;
}

export function getContainerCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  const { list } = pathTarget(sec, parentPara, pathJson);
  return core.query<{ characters: number }>({ kind: 'count', list }).characters;
}

export function getContainerRangeCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number): number {
  const { list } = pathTarget(sec, parentPara, pathJson);
  return core.query<{ characters: number }>({ kind: 'count',
    from: logicalAddress(core, list, startPara, startOffset), to: logicalAddress(core, list, endPara, endOffset),
  }).characters;
}

extendBridge({ getPageDef, getDocumentCharacterCount, getBodyRangeCharacterCount, getContainerCharacterCountByPath, getContainerRangeCharacterCountByPath });
