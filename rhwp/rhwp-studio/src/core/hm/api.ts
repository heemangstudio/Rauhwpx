/**
 * WasmBridge 가 위임하는 함수 표. 영역 파일(document·cursor·text…)의 함수를 모으고,
 * 다른 작업 줄기는 extendBridge 로 자기 파일의 구현을 덮어 등록한다 (README.md).
 */
import * as clipboard from './clipboard';
import * as cursor from './cursor';
import * as document from './document';
import * as fields from './fields';
import * as format from './format';
import * as furniture from './furniture';
import * as objects from './objects';
import * as page from './page';
import * as search from './search';
import * as table from './table';
import * as text from './text';

export const api = {
  ...document, ...cursor, ...text, ...format, ...table, ...clipboard, ...search, ...objects, ...furniture, ...fields, ...page,
};

export type HmApi = typeof api;

/** 같은 이름·시그니처의 구현으로 바꾼다. 모듈을 불러올 때 한 번 부른다. */
export function extendBridge(impls: Partial<HmApi>): void {
  Object.assign(api, impls);
}
