import { extendBridge } from './api';
import type { HmCore, ListAddress } from './core';
import { bodyList, logicalAddress, pathTarget } from './address';

export function getDocumentCharacterCount(core: HmCore): number {
  return core.query<{ characters: number }>({ kind: 'count' }).characters;
}

function countRange(core: HmCore, list: ListAddress, startPara: number, startOffset: number, endPara: number, endOffset: number): number {
  return core.query<{ characters: number }>({
    kind: 'count',
    from: logicalAddress(core, list, startPara, startOffset),
    to: logicalAddress(core, list, endPara, endOffset),
  }).characters;
}

export function getBodyRangeCharacterCount(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): number {
  return core.query<{ characters: number }>({
    kind: 'count',
    from: logicalAddress(core, bodyList(startSec), startPara, startOffset),
    to: logicalAddress(core, bodyList(endSec), endPara, endOffset),
  }).characters;
}

export function getContainerCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  return core.query<{ characters: number }>({ kind: 'count', list: pathTarget(sec, parentPara, pathJson).list }).characters;
}

export function getContainerRangeCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number): number {
  return countRange(core, pathTarget(sec, parentPara, pathJson).list, startPara, startOffset, endPara, endOffset);
}

extendBridge({ getDocumentCharacterCount, getBodyRangeCharacterCount, getContainerCharacterCountByPath, getContainerRangeCharacterCountByPath });
