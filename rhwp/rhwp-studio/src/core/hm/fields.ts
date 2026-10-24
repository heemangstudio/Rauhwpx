// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { DocumentPosition, FieldInfoResult, BookmarkInfo, HyperlinkTarget, HyperlinkContext } from './bridge-types';

export function getFieldList(core: HmCore): Array<{
    fieldId: number;
    fieldType: string;
    name: string;
    guide: string;
    command: string;
    value: string;
    location: { sectionIndex: number; paraIndex: number; path?: Array<any> };
    startCharIdx?: number;
    endCharIdx?: number;
    editableInForm?: boolean;
  }> {
  throw unsupported('getFieldList');
}

export function getFieldValue(core: HmCore, fieldId: number): { ok: boolean; value: string } {
  throw unsupported('getFieldValue');
}

export function getFieldValueByName(core: HmCore, name: string): { ok: boolean; fieldId: number; value: string } {
  throw unsupported('getFieldValueByName');
}

export function setFieldValue(core: HmCore, fieldId: number, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
  throw unsupported('setFieldValue');
}

export function setFieldValueByName(core: HmCore, name: string, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
  throw unsupported('setFieldValueByName');
}

export function getHyperlinkContext(core: HmCore, target: HyperlinkTarget): HyperlinkContext {
  throw unsupported('getHyperlinkContext');
}

export function insertHyperlink(core: HmCore, target: HyperlinkTarget, start: number, end: number, uri: string): number {
  throw unsupported('insertHyperlink');
}

export function updateHyperlink(core: HmCore, target: HyperlinkTarget, fieldId: number, uri: string): boolean {
  throw unsupported('updateHyperlink');
}

export function replaceHyperlinkText(core: HmCore, target: HyperlinkTarget, fieldId: number, text: string): boolean {
  throw unsupported('replaceHyperlinkText');
}

export function removeHyperlink(core: HmCore, target: HyperlinkTarget, fieldId: number, restoreFormatting: boolean): void {
  throw unsupported('removeHyperlink');
}

export function getFieldInfoAt(core: HmCore, pos: DocumentPosition): FieldInfoResult {
  throw unsupported('getFieldInfoAt');
}

export function removeFieldAt(core: HmCore, pos: DocumentPosition): { ok: boolean } {
  throw unsupported('removeFieldAt');
}

export function setActiveField(core: HmCore, pos: DocumentPosition): boolean {
  throw unsupported('setActiveField');
}

export function clearActiveField(core: HmCore): void {
  throw unsupported('clearActiveField');
}

export function getClickHereProps(core: HmCore, fieldId: number): { ok: boolean; guide?: string; memo?: string; name?: string; editable?: boolean } {
  throw unsupported('getClickHereProps');
}

export function updateClickHereProps(core: HmCore, fieldId: number, guide: string, memo: string, name: string, editable: boolean): { ok: boolean } {
  throw unsupported('updateClickHereProps');
}

export function insertClickHereField(core: HmCore, pos: DocumentPosition, guide: string, memo: string, name: string, editable: boolean): { ok: boolean; fieldId?: number; charOffset?: number } {
  throw unsupported('insertClickHereField');
}

export function getFormObjectAt(core: HmCore, pageNum: number, x: number, y: number): import('../types').FormObjectHitResult {
  throw unsupported('getFormObjectAt');
}

export function getFormValue(core: HmCore, sec: number, para: number, ci: number): import('../types').FormValueResult {
  throw unsupported('getFormValue');
}

export function setFormValue(core: HmCore, sec: number, para: number, ci: number, valueJson: string): { ok: boolean } {
  throw unsupported('setFormValue');
}

export function setFormValueInCell(core: HmCore, sec: number, tablePara: number, tableCi: number, cellIdx: number, cellPara: number, formCi: number, valueJson: string): { ok: boolean } {
  throw unsupported('setFormValueInCell');
}

export function getFormObjectInfo(core: HmCore, sec: number, para: number, ci: number): import('../types').FormObjectInfoResult {
  throw unsupported('getFormObjectInfo');
}

export function getBookmarks(core: HmCore): BookmarkInfo[] {
  throw unsupported('getBookmarks');
}

export function addBookmark(core: HmCore, sec: number, para: number, charOffset: number, name: string): { ok: boolean; error?: string } {
  throw unsupported('addBookmark');
}

export function deleteBookmark(core: HmCore, sec: number, para: number, ctrlIdx: number): { ok: boolean; error?: string } {
  throw unsupported('deleteBookmark');
}

export function renameBookmark(core: HmCore, sec: number, para: number, ctrlIdx: number, newName: string): { ok: boolean; error?: string } {
  throw unsupported('renameBookmark');
}
