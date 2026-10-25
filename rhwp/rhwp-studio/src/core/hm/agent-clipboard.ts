/** 서식 틀 블록 삽입과 구역 안 선택 복사. 문서 사이 조각은 엔진 copy/paste 로 옮긴다. */
import type { ParagraphInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { copyRange } from './clipboard-native';
import { bodyList, logicalAddress } from './address';
import { api, extendBridge } from './api';

export function copySelectionAcrossSections(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
  if (startSec === endSec) return api.copySelection(core, startSec, startPara, startOffset, endPara, endOffset);
  copyRange(core, logicalAddress(core, bodyList(startSec), startPara, startOffset), logicalAddress(core, bodyList(endSec), endPara, endOffset));
  return JSON.stringify({ ok: true });
}

export function exportSelectionAcrossSectionsHtml(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
  if (startSec === endSec) return api.exportSelectionHtml(core, startSec, startPara, startOffset, endPara, endOffset);
  return copyRange(core, logicalAddress(core, bodyList(startSec), startPara, startOffset), logicalAddress(core, bodyList(endSec), endPara, endOffset)).html;
}

/**
 * 다른 문서의 본문 문단 범위를 대상 위치에 붙인다. 원본은 같은 엔진에서 열고 닫는다.
 * 사용자 클립보드를 건드리지 않는 엔진의 프로그램용 조각 이식 경로를 쓴다.
 */
export function pasteDocumentBlock(core: HmCore, sourceBytes: Uint8Array, sourceSection: number, startPara: number, endPara: number, targetSection: number, targetPara: number, targetCharOffset: number): string {
  if (!Number.isInteger(startPara) || !Number.isInteger(endPara) || startPara < 0 || endPara < startPara) {
    throw new RangeError('잘못된 원본 문단 범위');
  }
  const at = logicalAddress(core, bodyList(targetSection), targetPara, targetCharOffset);
  const source = core.adapter.hmEngine().open(sourceBytes);
  try {
    const paras = JSON.parse(source.query(JSON.stringify({
      kind: 'paragraphs', list: { section: sourceSection }, from: startPara, count: endPara - startPara + 1,
    }))) as ParagraphInfo[];
    if (paras.length !== endPara - startPara + 1) throw new RangeError('원본 문단 범위 초과');
    const range = {
      from: { section: sourceSection, para: startPara, offset: paras[0].caret[0] },
      to: { section: sourceSection, para: endPara, offset: paras[paras.length - 1].caret[1] },
    };
    core.mutate(doc => doc.pasteFrom(source, JSON.stringify(range), JSON.stringify({ at })));
    const controlCounts: Record<string, number> = {};
    for (const para of paras) for (const control of para.controls) controlCounts[control.kind] = (controlCounts[control.kind] ?? 0) + 1;
    return JSON.stringify({ ok: true, warnings: [], skippedFeatures: [], insertedParagraphCount: paras.length, controlCounts });
  } finally {
    source.close();
  }
}

extendBridge({ copySelectionAcrossSections, exportSelectionAcrossSectionsHtml, pasteDocumentBlock });
