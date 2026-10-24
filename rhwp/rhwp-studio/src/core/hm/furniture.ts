// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { EndnoteShapeSettings, NoteEditInfo, CursorRect, BodyFootnoteMarkerHit, FootnoteAtCursorResult, DeleteFootnoteResult, SelectionRect, CharProperties, ParaProperties, TextContent, RemovedParaMeta } from './bridge-types';

export function hitTestBodyFootnoteMarker(core: HmCore, pageNum: number, x: number, y: number): BodyFootnoteMarkerHit {
  throw unsupported('hitTestBodyFootnoteMarker');
}

export function insertTextContentInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, content: TextContent): string {
  throw unsupported('insertTextContentInHeaderFooter');
}

export function insertTextContentInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, content: TextContent): { ok: boolean; charOffset: number } {
  throw unsupported('insertTextContentInFootnote');
}

export function getHeaderFooterPictureProperties(core: HmCore, sec: number, outerPara: number, outerCtrl: number, innerPara: number, innerCtrl: number): import('../types').PictureProperties {
  throw unsupported('getHeaderFooterPictureProperties');
}

export function setHeaderFooterPictureProperties(core: HmCore, sec: number, outerPara: number, outerCtrl: number, innerPara: number, innerCtrl: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setHeaderFooterPictureProperties');
}

export function getNoteEquationProperties(core: HmCore, noteRef: import('../types').NoteControlRef): import('../types').EquationProperties {
  throw unsupported('getNoteEquationProperties');
}

export function setNoteEquationProperties(core: HmCore, noteRef: import('../types').NoteControlRef, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setNoteEquationProperties');
}

export function insertFootnote(core: HmCore, sec: number, para: number, charOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; footnoteNumber: number } {
  throw unsupported('insertFootnote');
}

export function insertEndnote(core: HmCore, sec: number, para: number, charOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; endnoteNumber: number } {
  throw unsupported('insertEndnote');
}

export function getEndnoteShape(core: HmCore, sec: number): EndnoteShapeSettings {
  throw unsupported('getEndnoteShape');
}

export function applyEndnoteShape(core: HmCore, sec: number, settings: EndnoteShapeSettings): { ok: boolean } {
  throw unsupported('applyEndnoteShape');
}

export function getFootnoteInfo(core: HmCore, sec: number, para: number, controlIdx: number): { ok: boolean; paraCount: number; totalTextLen: number; number: number; texts: string[] } {
  throw unsupported('getFootnoteInfo');
}

export function getFootnoteAtCursor(core: HmCore, sec: number, para: number, charOffset: number, direction: 'backward' | 'forward'): FootnoteAtCursorResult {
  throw unsupported('getFootnoteAtCursor');
}

export function deleteFootnote(core: HmCore, sec: number, para: number, controlIdx: number): DeleteFootnoteResult {
  throw unsupported('deleteFootnote');
}

export function insertTextInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, text: string): { ok: boolean; charOffset: number } {
  throw unsupported('insertTextInFootnote');
}

export function deleteTextInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, count: number): { ok: boolean; charOffset: number; deletedText: string } {
  throw unsupported('deleteTextInFootnote');
}

export function splitParagraphInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): { ok: boolean; fnParaIndex: number; charOffset: number } {
  throw unsupported('splitParagraphInFootnote');
}

export function mergeParagraphInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number): { ok: boolean; fnParaIndex: number; charOffset: number; removedParaMeta: RemovedParaMeta } {
  throw unsupported('mergeParagraphInFootnote');
}

export function getPageFootnoteInfo(core: HmCore, pageNum: number, footnoteIndex: number): { ok: boolean; sectionIdx: number; paraIdx: number; controlIdx: number; sourceType: string } | null {
  throw unsupported('getPageFootnoteInfo');
}

export function pageHasFootnoteFootholds(core: HmCore, pageNum: number): boolean {
  throw unsupported('pageHasFootnoteFootholds');
}

export function hitTestFootnote(core: HmCore, pageNum: number, x: number, y: number): { hit: boolean; footnoteIndex?: number } {
  throw unsupported('hitTestFootnote');
}

export function hitTestInFootnote(core: HmCore, pageNum: number, x: number, y: number): { hit: boolean; fnParaIndex?: number; charOffset?: number; footnoteIndex?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
  throw unsupported('hitTestInFootnote');
}

export function getCursorRectInFootnote(core: HmCore, pageNum: number, footnoteIndex: number, fnParaIdx: number, charOffset: number): { pageIndex: number; x: number; y: number; height: number } | null {
  throw unsupported('getCursorRectInFootnote');
}

export function getNoteEditInfo(core: HmCore, sec: number, para: number, controlIdx: number): NoteEditInfo | null {
  throw unsupported('getNoteEditInfo');
}

export function getCursorRectInNote(core: HmCore, sec: number, para: number, controlIdx: number, noteParaIdx: number, charOffset: number): CursorRect | null {
  throw unsupported('getCursorRectInNote');
}

export function getParaPropertiesInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number): ParaProperties {
  throw unsupported('getParaPropertiesInFootnote');
}

export function applyParaFormatInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, propsJson: string): string {
  throw unsupported('applyParaFormatInFootnote');
}

export function getCharPropertiesInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number): CharProperties {
  throw unsupported('getCharPropertiesInFootnote');
}

export function applyCharFormatInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
  throw unsupported('applyCharFormatInFootnote');
}

export function setCharShapeIdInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
  throw unsupported('setCharShapeIdInFootnote');
}

export function setParaShapeIdInFootnote(core: HmCore, sec: number, para: number, controlIdx: number, fnParaIdx: number, paraShapeId: number): string {
  throw unsupported('setParaShapeIdInFootnote');
}

export function getSelectionRectsInFootnote(core: HmCore, pageNum: number, footnoteIndex: number, startFnPara: number, startOffset: number, endFnPara: number, endOffset: number): SelectionRect[] {
  throw unsupported('getSelectionRectsInFootnote');
}

export function getParaPropertiesInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): ParaProperties {
  throw unsupported('getParaPropertiesInHf');
}

export function applyParaFormatInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, propsJson: string): string {
  throw unsupported('applyParaFormatInHf');
}

export function getCharPropertiesInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number): CharProperties {
  throw unsupported('getCharPropertiesInHf');
}

export function applyCharFormatInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
  throw unsupported('applyCharFormatInHf');
}

export function setCharShapeIdInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
  throw unsupported('setCharShapeIdInHf');
}

export function setParaShapeIdInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, paraShapeId: number): string {
  throw unsupported('setParaShapeIdInHf');
}

export function insertFieldInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, fieldType: number): { ok: boolean; charOffset: number; insertedAt: number; insertedLength: number } {
  throw unsupported('insertFieldInHf');
}

export function applyHfTemplate(core: HmCore, sec: number, isHeader: boolean, applyTo: number, templateId: number): { ok: boolean } {
  throw unsupported('applyHfTemplate');
}

export function getHeaderFooter(core: HmCore, sectionIdx: number, isHeader: boolean, applyTo: number): string {
  throw unsupported('getHeaderFooter');
}

export function createHeaderFooter(core: HmCore, sectionIdx: number, isHeader: boolean, applyTo: number): string {
  throw unsupported('createHeaderFooter');
}

export function insertTextInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, text: string): string {
  throw unsupported('insertTextInHeaderFooter');
}

export function deleteTextInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, count: number): string {
  throw unsupported('deleteTextInHeaderFooter');
}

export function splitParagraphInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
  throw unsupported('splitParagraphInHeaderFooter');
}

export function mergeParagraphInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string {
  throw unsupported('mergeParagraphInHeaderFooter');
}

export function getHeaderFooterParaInfo(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string {
  throw unsupported('getHeaderFooterParaInfo');
}

export function replaceRangeInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number, replacementText: string): { ok: boolean; hfParaIndex: number; charOffset: number } {
  throw unsupported('replaceRangeInHeaderFooter');
}

export function copySelectionInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number): { ok: boolean; text: string } {
  throw unsupported('copySelectionInHeaderFooter');
}

export function getCharPropertiesInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number): CharProperties {
  throw unsupported('getCharPropertiesInHeaderFooter');
}

export function applyCharFormatInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number, propsJson: string): string {
  throw unsupported('applyCharFormatInHeaderFooter');
}

export function getCursorRectInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, previewPage: number): CursorRect {
  throw unsupported('getCursorRectInHeaderFooter');
}

export function getSelectionRectsInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, pageNum: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number): SelectionRect[] {
  throw unsupported('getSelectionRectsInHeaderFooter');
}

export function hitTestHeaderFooter(core: HmCore, pageNum: number, x: number, y: number): { hit: boolean; isHeader?: boolean; sectionIndex?: number; applyTo?: number } {
  throw unsupported('hitTestHeaderFooter');
}

export function getHeaderFooterEditTarget(core: HmCore, pageNum: number, isHeader: boolean): { sectionIndex: number; applyTo: number } {
  throw unsupported('getHeaderFooterEditTarget');
}

export function getHeaderFooterPreviewPage(core: HmCore, sectionIdx: number): number {
  throw unsupported('getHeaderFooterPreviewPage');
}

export function hitTestInHeaderFooter(core: HmCore, pageNum: number, isHeader: boolean, x: number, y: number): { hit: boolean; sectionIndex?: number; applyTo?: number; paraIndex?: number; charOffset?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
  throw unsupported('hitTestInHeaderFooter');
}

export function hitTestInHeaderFooterTarget(core: HmCore, pageNum: number, sectionIdx: number, isHeader: boolean, applyTo: number, x: number, y: number): { hit: boolean; sectionIndex?: number; applyTo?: number; paraIndex?: number; charOffset?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
  throw unsupported('hitTestInHeaderFooterTarget');
}

export function renderHeaderFooterEditPreviewToCanvas(core: HmCore, pageNum: number, sectionIdx: number, isHeader: boolean, applyTo: number, canvas: HTMLCanvasElement, scale: number): void {
  throw unsupported('renderHeaderFooterEditPreviewToCanvas');
}

export function deleteHeaderFooter(core: HmCore, sectionIdx: number, isHeader: boolean, applyTo: number): void {
  throw unsupported('deleteHeaderFooter');
}

export function getHeaderFooterList(core: HmCore, currentSectionIdx: number, currentIsHeader: boolean, currentApplyTo: number): { ok: boolean; items: { sectionIdx: number; isHeader: boolean; applyTo: number; label: string }[]; currentIndex: number } {
  throw unsupported('getHeaderFooterList');
}

export function toggleHideHeaderFooter(core: HmCore, pageIndex: number, isHeader: boolean): { hidden: boolean } {
  throw unsupported('toggleHideHeaderFooter');
}

export function navigateHeaderFooterByPage(core: HmCore, currentPage: number, isHeader: boolean, direction: number): { ok: boolean; pageIndex?: number; sectionIdx?: number; isHeader?: boolean; applyTo?: number } {
  throw unsupported('navigateHeaderFooterByPage');
}
