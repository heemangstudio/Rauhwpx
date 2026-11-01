// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';

export function copySelection(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
  throw unsupported('copySelection');
}

export function copySelectionAcrossSections(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
  throw unsupported('copySelectionAcrossSections');
}

export function copySelectionInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  throw unsupported('copySelectionInCell');
}

export function copySelectionInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  throw unsupported('copySelectionInCellByPath');
}

export function pasteInternal(core: HmCore, sec: number, para: number, charOffset: number): string {
  throw unsupported('pasteInternal');
}

export function pasteDocumentBlock(core: HmCore, sourceBytes: Uint8Array, sourceSection: number, startPara: number, endPara: number, targetSection: number, targetPara: number, targetCharOffset: number): string {
  throw unsupported('pasteDocumentBlock');
}

export function pasteInternalInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, cells?: 'overwrite' | 'nest'): string {
  throw unsupported('pasteInternalInCell');
}

export function pasteInternalInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, cells?: 'overwrite' | 'nest'): string {
  throw unsupported('pasteInternalInCellByPath');
}

export function hasInternalClipboard(core: HmCore): boolean {
  throw unsupported('hasInternalClipboard');
}

export function getClipboardText(core: HmCore): string {
  throw unsupported('getClipboardText');
}

export function copyControl(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  throw unsupported('copyControl');
}

export function exportControlHtml(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  throw unsupported('exportControlHtml');
}

export function clipboardHasControl(core: HmCore): boolean {
  throw unsupported('clipboardHasControl');
}

export function clipboardIsSingleControl(core: HmCore): boolean {
  throw unsupported('clipboardIsSingleControl');
}

export function pasteControl(core: HmCore, sec: number, para: number, charOffset: number): string {
  throw unsupported('pasteControl');
}

export function exportSelectionHtml(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
  throw unsupported('exportSelectionHtml');
}

export function exportSelectionAcrossSectionsHtml(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
  throw unsupported('exportSelectionAcrossSectionsHtml');
}

export function exportSelectionInCellHtml(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  throw unsupported('exportSelectionInCellHtml');
}

export function exportSelectionInCellByPathHtml(core: HmCore, sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
  throw unsupported('exportSelectionInCellByPathHtml');
}

export function pasteHwpJson(core: HmCore, sec: number, para: number, charOffset: number, json: string): string {
  throw unsupported('pasteHwpJson');
}

export function pasteHtml(core: HmCore, sec: number, para: number, charOffset: number, html: string): string {
  throw unsupported('pasteHtml');
}

export function pasteHtmlInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, html: string): string {
  throw unsupported('pasteHtmlInCell');
}

export function pasteHtmlInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, html: string): string {
  throw unsupported('pasteHtmlInCellByPath');
}
