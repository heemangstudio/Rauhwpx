/** 찾기·바꾸기 좌표를 엔진 wire 주소와 Studio 텍스트 오프셋 사이에서 바꾼다. */
import type { Address, EditOp, Match, SearchResult as HmSearchResult } from '../../../vendor/hm-wasm/hm_wasm';
import type { CellPathEntry, SearchHit, SearchResult, ReplaceResult, ReplaceOneResult, ReplaceAllResult } from '../types';
import type { HmCore } from './core';
import { bodyList, paraMap, pathTarget, stepsToPath, textAddress, textRangeToWire, toAddress, wireToText } from './address';
import { extendBridge } from './api';

function matches(core: HmCore, text: string, caseSensitive: boolean, extra: object = {}): Match[] {
  if (!text) return [];
  return (JSON.parse(core.call(doc => doc.search(JSON.stringify({ text, caseSensitive, limit: 0xFFFFFFFF, ...extra })))) as HmSearchResult).matches;
}

function hit(core: HmCore, match: Match): SearchHit {
  const { from, to } = match;
  const map = paraMap(core.paragraph({ section: from.section, steps: from.steps ?? [] }, from.para));
  const charOffset = wireToText(map, from.offset);
  const result: SearchHit = { sec: from.section, para: from.para, charOffset, length: wireToText(map, to.offset) - charOffset };
  if (from.steps?.length) {
    const outer = from.steps[0];
    result.para = outer.para;
    result.cellPath = stepsToPath(from.steps, from.para);
    result.cellContext = { parentPara: outer.para, ctrlIdx: outer.control, cellIdx: outer.index, cellPara: result.cellPath[0].cellParaIndex };
  }
  return result;
}

export function searchAllText(core: HmCore, query: string, caseSensitive: boolean, includeCells: boolean): SearchHit[] {
  return matches(core, query, caseSensitive).filter(match => includeCells || !match.from.steps?.length).map(match => hit(core, match));
}

export function searchText(core: HmCore, query: string, fromSec: number, fromPara: number, fromChar: number, forward: boolean, caseSensitive: boolean, fromPath: CellPathEntry[]): SearchResult {
  const target = fromPath.length ? pathTarget(fromSec, fromPara, fromPath) : { list: bodyList(fromSec), para: fromPara };
  const from = textAddress(core, target.list, target.para, fromChar);
  // 엔진은 시작 주소보다 뒤의 결과를 고르므로 현재 캐럿에서 시작하는 단어도 포함한다.
  const found = matches(core, query, caseSensitive, { from: { ...from, offset: forward ? Math.max(0, from.offset - 1) : from.offset }, backward: !forward })[0];
  if (!found) return { found: false };
  const sameList = JSON.stringify(found.from.steps ?? []) === JSON.stringify(from.steps ?? []);
  const before = found.from.section < from.section || (found.from.section === from.section && sameList
    && (found.from.para < from.para || (found.from.para === from.para && found.from.offset < from.offset)));
  const after = found.from.section > from.section || (found.from.section === from.section && sameList
    && (found.from.para > from.para || (found.from.para === from.para && found.from.offset >= from.offset)));
  return { found: true, wrapped: forward ? before : after, ...hit(core, found) };
}

function replacement(from: Address, to: Address, text: string): EditOp[] {
  const ops: EditOp[] = [{ op: 'delete', from, to }];
  if (text) ops.push({ op: 'insertText', at: from, text: text.replace(/\r\n?/g, '\n') });
  return ops;
}

export function replaceText(core: HmCore, sec: number, para: number, charOffset: number, length: number, newText: string): ReplaceResult {
  const list = bodyList(sec);
  const map = paraMap(core.paragraph(list, para));
  const [a, b] = textRangeToWire(map, charOffset, charOffset + length);
  core.transact(replacement(toAddress(list, para, a), toAddress(list, para, b), newText));
  return { ok: true, charOffset, newLength: newText.length };
}

export function replaceOne(core: HmCore, query: string, newText: string, caseSensitive: boolean): ReplaceOneResult {
  const found = matches(core, query, caseSensitive)[0];
  if (!found) return { ok: false };
  const result = hit(core, found);
  core.transact(replacement(found.from, found.to, newText));
  return { ok: true, sec: result.sec, para: result.para, charOffset: result.charOffset, newLength: newText.length };
}

export function replaceAll(core: HmCore, query: string, newText: string, caseSensitive: boolean): ReplaceAllResult {
  const found = matches(core, query, caseSensitive);
  // 같은 목록의 뒤부터 바꾸면 앞쪽 주소는 그대로다. 전체를 한 번의 되돌리기로 묶는다.
  core.transact(found.reverse().flatMap(match => replacement(match.from, match.to, newText)));
  return { ok: true, count: found.length };
}

extendBridge({ searchText, searchAllText, replaceText, replaceOne, replaceAll });
