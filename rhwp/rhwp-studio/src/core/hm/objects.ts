// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { CellPathEntry, CellPathLike } from './bridge-types';

export function getShapeBBox(core: HmCore, sec: number, parentPara: number, controlIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
  throw unsupported('getShapeBBox');
}

export function getObjectBBox(core: HmCore, kind: 'image' | 'equation', sec: number, parentPara: number, controlIdx: number, cellIdx?: number, cellParaIdx?: number, innerControlIdx?: number, cellPath?: CellPathLike): { pageIndex: number; x: number; y: number; width: number; height: number } {
  throw unsupported('getObjectBBox');
}

export function insertPicture(core: HmCore, sec: number, paraIdx: number, charOffset: number, cellPathJson: string, imageData: Uint8Array, width: number, height: number, naturalWidthPx: number, naturalHeightPx: number, extension: string, description: string, paperOffsetXHu?: number, paperOffsetYHu?: number, placement?: 'inline' | 'floating'): { ok: boolean; paraIdx: number; controlIdx: number; logicalOffset?: number; sectionIdx?: number; cellPath?: CellPathEntry[] } {
  throw unsupported('insertPicture');
}

export function assignPictureImage(core: HmCore, sec: number, parentParaIdx: number, cellPathJson: string, controlIdx: number, imageData: Uint8Array, naturalWidthPx: number, naturalHeightPx: number, extension: string): { ok: boolean; binDataId: number } {
  throw unsupported('assignPictureImage');
}

export function getPictureProperties(core: HmCore, sec: number, para: number, ci: number): import('../types').PictureProperties {
  throw unsupported('getPictureProperties');
}

export function getCellShapePropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('../types').ShapeProperties {
  throw unsupported('getCellShapePropertiesByPath');
}

export function getCellPicturePropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('../types').PictureProperties {
  throw unsupported('getCellPicturePropertiesByPath');
}

export function setCellShapePropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setCellShapePropertiesByPath');
}

export function setPictureProperties(core: HmCore, sec: number, para: number, ci: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setPictureProperties');
}

export function setCellPicturePropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setCellPicturePropertiesByPath');
}

export function getEquationProperties(core: HmCore, sec: number, para: number, ci: number, cellIdx?: number, cellParaIdx?: number, innerControlIdx?: number): import('../types').EquationProperties {
  throw unsupported('getEquationProperties');
}

export function getEquationPropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('../types').EquationProperties {
  throw unsupported('getEquationPropertiesByPath');
}

export function setEquationProperties(core: HmCore, sec: number, para: number, ci: number, cellIdx: number | undefined, cellParaIdx: number | undefined, props: Record<string, unknown>, innerControlIdx?: number): { ok: boolean } {
  throw unsupported('setEquationProperties');
}

export function setEquationPropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setEquationPropertiesByPath');
}

export function renderEquationPreview(core: HmCore, script: string, fontSizeHwpunit: number, color: number, fontName?: string): string {
  throw unsupported('renderEquationPreview');
}

export function deletePictureControl(core: HmCore, sec: number, para: number, ci: number): { ok: boolean } {
  throw unsupported('deletePictureControl');
}

export function movePictureControlByPath(core: HmCore, sec: number, fromParentPara: number, fromPath: CellPathLike, fromControl: number, toParentPara: number, toPath: CellPathLike, toCharOffset: number): { ok: boolean; moved: boolean; paraIdx: number; controlIdx: number; cellPath: CellPathEntry[]; charOffset: number } {
  throw unsupported('movePictureControlByPath');
}

export function movePictureControl(core: HmCore, sec: number, fromPara: number, fromCi: number, toPara: number, toCharOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; moved: boolean } {
  throw unsupported('movePictureControl');
}

export function deleteCellPictureControlByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): { ok: boolean } {
  throw unsupported('deleteCellPictureControlByPath');
}

export function createShapeControl(core: HmCore, params: Record<string, unknown>): { ok: boolean; paraIdx: number; controlIdx: number } {
  throw unsupported('createShapeControl');
}

export function getShapeProperties(core: HmCore, sec: number, para: number, ci: number): import('../types').ShapeProperties {
  throw unsupported('getShapeProperties');
}

export function getShapeText(core: HmCore, sec: number, para: number, ci: number): { ok: boolean; text: string } {
  throw unsupported('getShapeText');
}

export function setShapeProperties(core: HmCore, sec: number, para: number, ci: number, props: Record<string, unknown>): { ok: boolean } {
  throw unsupported('setShapeProperties');
}

export function deleteShapeControl(core: HmCore, sec: number, para: number, ci: number): { ok: boolean } {
  throw unsupported('deleteShapeControl');
}

export function deleteEquationControl(core: HmCore, sec: number, para: number, ci: number): { ok: boolean } {
  throw unsupported('deleteEquationControl');
}

export function changeObjectZOrder(core: HmCore, sec: number, para: number, ci: number, operation: string): { ok: boolean; zOrder?: number } {
  throw unsupported('changeObjectZOrder');
}

export function groupShapes(core: HmCore, sec: number, targets: { paraIdx: number; controlIdx: number }[]): { ok: boolean; paraIdx: number; controlIdx: number } {
  throw unsupported('groupShapes');
}

export function insertEquation(core: HmCore, sec: number, para: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical: boolean): { ok: boolean; paraIdx: number; controlIdx: number } {
  throw unsupported('insertEquation');
}

export function promoteOleEquation(core: HmCore, sec: number, para: number, ci: number): { ok: boolean; paraIdx: number; controlIdx: number; script: string } {
  throw unsupported('promoteOleEquation');
}

export function insertEquationInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical: boolean): { ok: boolean; cellParaIdx: number; controlIdx: number } {
  throw unsupported('insertEquationInCell');
}

export function insertEquationInCellByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical: boolean): { ok: boolean; cellParaIdx: number; controlIdx: number } {
  throw unsupported('insertEquationInCellByPath');
}

export function deleteEquationControlInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): { ok: boolean } {
  throw unsupported('deleteEquationControlInCell');
}

export function deleteEquationControlInCellByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, eqControlIdx: number): { ok: boolean } {
  throw unsupported('deleteEquationControlInCellByPath');
}

export function getEquationScriptInCellAt(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): string | null {
  throw unsupported('getEquationScriptInCellAt');
}

export function moveLineEndpoint(core: HmCore, sec: number, para: number, ci: number, sx: number, sy: number, ex: number, ey: number): void {
  throw unsupported('moveLineEndpoint');
}

export function updateConnectorsInSection(core: HmCore, sec: number): void {
  throw unsupported('updateConnectorsInSection');
}

export function ungroupShape(core: HmCore, sec: number, para: number, ci: number): { ok: boolean } {
  throw unsupported('ungroupShape');
}

export function getControlImageData(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): Uint8Array {
  throw unsupported('getControlImageData');
}

export function getControlImageMime(core: HmCore, sec: number, para: number, ci: number, cellPathJson: string): string {
  throw unsupported('getControlImageMime');
}

export function updateStyleShapes(core: HmCore, styleId: number, charModsJson: string, paraModsJson: string): boolean {
  throw unsupported('updateStyleShapes');
}
