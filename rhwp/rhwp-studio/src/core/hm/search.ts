// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { CellPathEntry } from './bridge-types';

export function searchText(core: HmCore, query: string, fromSec: number, fromPara: number, fromChar: number, forward: boolean, caseSensitive: boolean, fromPath: import('../types').CellPathEntry[]): import('../types').SearchResult {
  throw unsupported('searchText');
}

export function searchAllText(core: HmCore, query: string, caseSensitive: boolean, includeCells: boolean): import('../types').SearchHit[] {
  throw unsupported('searchAllText');
}

export function replaceText(core: HmCore, sec: number, para: number, charOffset: number, length: number, newText: string): import('../types').ReplaceResult {
  throw unsupported('replaceText');
}

export function replaceOne(core: HmCore, query: string, newText: string, caseSensitive: boolean): import('../types').ReplaceOneResult {
  throw unsupported('replaceOne');
}

export function replaceAll(core: HmCore, query: string, newText: string, caseSensitive: boolean): import('../types').ReplaceAllResult {
  throw unsupported('replaceAll');
}
