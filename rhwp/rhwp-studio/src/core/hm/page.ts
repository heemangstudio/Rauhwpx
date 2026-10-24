// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { PageDef, SectionDef, PageBorderFillSettings } from './bridge-types';

export function getPageDef(core: HmCore, sectionIdx: number): PageDef {
  throw unsupported('getPageDef');
}

export function setPageDef(core: HmCore, sectionIdx: number, pageDef: PageDef): { ok: boolean; pageCount: number } {
  throw unsupported('setPageDef');
}

export function setPageDefAll(core: HmCore, patch: Partial<PageDef>): { ok: boolean; pageCount: number } {
  throw unsupported('setPageDefAll');
}

export function getSectionDef(core: HmCore, sectionIdx: number): SectionDef {
  throw unsupported('getSectionDef');
}

export function setSectionDef(core: HmCore, sectionIdx: number, sectionDef: SectionDef): { ok: boolean; pageCount: number } {
  throw unsupported('setSectionDef');
}

export function setSectionDefAll(core: HmCore, sectionDef: SectionDef): { ok: boolean; pageCount: number } {
  throw unsupported('setSectionDefAll');
}

export function getPageBorderFill(core: HmCore, sectionIdx: number): PageBorderFillSettings {
  throw unsupported('getPageBorderFill');
}

export function setPageBorderFill(core: HmCore, sectionIdx: number, settings: PageBorderFillSettings): { ok: boolean; pageCount: number } {
  throw unsupported('setPageBorderFill');
}

export function insertPageBreak(core: HmCore, sec: number, para: number, charOffset: number): string {
  throw unsupported('insertPageBreak');
}

export function insertColumnBreak(core: HmCore, sec: number, para: number, charOffset: number): string {
  throw unsupported('insertColumnBreak');
}

export function getColumnDef(core: HmCore, sec: number): { columnCount: number; columnType: number; sameWidth: boolean; spacing: number } {
  throw unsupported('getColumnDef');
}

export function insertNewNumber(core: HmCore, sec: number, para: number, charOffset: number, startNum: number): string {
  throw unsupported('insertNewNumber');
}

export function setColumnDef(core: HmCore, sec: number, columnCount: number, columnType: number, sameWidth: number, spacingHu: number): string {
  throw unsupported('setColumnDef');
}

export function getPageHide(core: HmCore, sec: number, para: number): Record<string, unknown> {
  throw unsupported('getPageHide');
}

export function setPageHide(core: HmCore, sec: number, para: number, hideHeader: boolean, hideFooter: boolean, hideMaster: boolean, hideBorder: boolean, hideFill: boolean, hidePageNum: boolean): string {
  throw unsupported('setPageHide');
}
