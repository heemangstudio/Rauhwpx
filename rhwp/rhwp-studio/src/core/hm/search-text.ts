/** 찾기·바꾸기 좌표를 엔진 wire 주소와 Studio 텍스트 오프셋 사이에서 바꾼다. */
import type { Address, EditOp, Match, SearchResult as HmSearchResult, Step } from '../../../vendor/hm-wasm/hm_wasm';
import type { ListAddress } from './core';
import type { CellPathEntry, SearchHit, SearchResult, ReplaceResult, ReplaceOneResult, ReplaceAllResult } from '../types';
import type { HmCore } from './core';
import { bodyList, paraMap, pathTarget, stepsToPath, textAddress, textRangeToWire, toAddress, wireToText } from './address';
import { extendBridge } from './api';

/**
 * 찾는 범위. 각주·미주·머리말·꼬리말·바탕쪽, 표·개체의 캡션과 묶음 도형의 글은 어느 범위에도 들지 않는다.
 * - body: 본문 문단만.
 * - next: 다음 찾기. 본문과 표 셀(표 안의 표 포함).
 * - all: 모두 찾기·모두 바꾸기. 본문, 본문 표의 셀, 본문 글상자.
 */
type Scope = 'body' | 'next' | 'all';

function inScope(kinds: readonly string[], scope: Scope): boolean {
  if (!kinds.length) return true;
  if (scope === 'next') return kinds.every(kind => kind === 'table');
  return scope === 'all' && kinds.length === 1 && (kinds[0] === 'table' || kinds[0] === 'object');
}

interface Found { match: Match; key: number[] }

/**
 * 컨트롤 안 목록의 종류. 캡션은 컨트롤의 마지막 목록이다. 개체는 자기 글상자 글만 'object'이고
 * 묶음 안 도형의 글은 'group'이다.
 */
function listKinds(core: HmCore, at: { section: number; steps: Step[]; para: number; control: number }, info: { kind: string; lists: number }): (index: number) => string {
  const address = at.steps.length ? at : { section: at.section, para: at.para, control: at.control };
  try {
    if (info.kind === 'table') {
      const caption = core.query<{ caption: unknown }>({ kind: 'tableProperties', table: address }).caption ? info.lists - 1 : -1;
      return index => index === caption ? 'caption' : 'table';
    }
    if (info.kind === 'object' && info.lists > 0) {
      const props = core.query<{ caption?: { list: number } | null; text?: string }>({ kind: 'objectProperties', object: address });
      const caption = props.caption?.list ?? -1;
      return index => index === caption ? 'caption' : props.text !== undefined && index === 0 ? 'object' : 'group';
    }
  } catch {
    // 속성을 읽지 못하는 컨트롤은 컨트롤 종류 그대로 본다.
  }
  return () => info.kind;
}

/** 문서 순서대로 고른 일치. 셀과 글상자의 일치는 그 컨트롤이 놓인 본문 자리에 끼운다. */
function matches(core: HmCore, text: string, caseSensitive: boolean, scope: Scope): Found[] {
  if (!text) return [];
  // 구 엔진처럼 문단 안 컨트롤(각주 번호, 필드, 개체 칸)을 건너뛰고 글자만 맞춘다.
  const result = JSON.parse(core.call(doc => doc.search(JSON.stringify({ text, caseSensitive, limit: 0xFFFFFFFF, acrossControls: true })))) as HmSearchResult;
  // 컨트롤마다 한 번만 속성을 읽는다. 셀·글상자 번호는 목록 종류를 고를 때만 쓴다.
  const controls = new Map<string, { kind: (index: number) => string; offset: number } | undefined>();
  const control = (section: number, steps: readonly Step[], depth: number) => {
    const step = steps[depth];
    const id = JSON.stringify([section, steps.slice(0, depth), step.para, step.control]);
    if (!controls.has(id)) {
      const list: ListAddress = { section, steps: steps.slice(0, depth) };
      const info = core.paragraph(list, step.para).controls.find(c => c.index === step.control);
      controls.set(id, info && { kind: listKinds(core, { section, steps: list.steps, para: step.para, control: step.control }, info), offset: info.offset });
    }
    const found = controls.get(id);
    return found && { kind: found.kind(step.index), offset: found.offset };
  };
  const found: Found[] = [];
  for (const match of result.matches) {
    const steps = match.from.steps ?? [];
    const kinds: string[] = [];
    const key = [match.from.section];
    for (let depth = 0; depth < steps.length; depth += 1) {
      const info = control(match.from.section, steps, depth);
      kinds.push(info?.kind ?? '');
      key.push(steps[depth].para, info?.offset ?? 0, steps[depth].index);
    }
    if (!inScope(kinds, scope)) continue;
    key.push(match.from.para, match.from.offset);
    found.push({ match, key });
  }
  return found.sort((a, b) => compareKeys(a.key, b.key));
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** 시작 주소의 문서 순서 키. */
function addressKey(core: HmCore, address: Address): number[] {
  const steps = address.steps ?? [];
  const key = [address.section];
  steps.forEach((step, depth) => {
    const info = core.paragraph({ section: address.section, steps: steps.slice(0, depth) }, step.para).controls.find(c => c.index === step.control);
    key.push(step.para, info?.offset ?? 0, step.index);
  });
  key.push(address.para, address.offset);
  return key;
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
  return matches(core, query, caseSensitive, includeCells ? 'all' : 'body').map(found => hit(core, found.match));
}

export function searchText(core: HmCore, query: string, fromSec: number, fromPara: number, fromChar: number, forward: boolean, caseSensitive: boolean, fromPath: CellPathEntry[]): SearchResult {
  const found = matches(core, query, caseSensitive, 'next');
  if (!found.length) return { found: false };
  const target = fromPath.length ? pathTarget(fromSec, fromPara, fromPath) : { list: bodyList(fromSec), para: fromPara };
  const here = addressKey(core, textAddress(core, target.list, target.para, fromChar));
  // 앞으로 찾으면 캐럿에서 시작하는 단어도 포함한다. 끝을 지나면 처음부터 다시 찾는다.
  const before = found.filter(f => compareKeys(f.key, here) < 0).length;
  const index = forward ? (before < found.length ? before : -1) : before - 1;
  const wrapped = index < 0;
  const pick = found[wrapped ? (forward ? 0 : found.length - 1) : index];
  return { found: true, wrapped, ...hit(core, pick.match) };
}

/**
 * [from, to) 를 text 로 바꾸는 편집. 범위 안의 컨트롤(각주 번호, 필드 등)은 지우지 않고
 * 그 사이의 글자만 지운 뒤 새 글을 범위 앞에 넣는다.
 */
function replacement(core: HmCore, from: Address, to: Address, text: string): EditOp[] {
  const list: ListAddress = { section: from.section, steps: from.steps ?? [] };
  const map = paraMap(core.paragraph(list, from.para));
  const runs: [number, number][] = [];
  for (let k = 0; k < map.textLength; k += 1) {
    const start = map.textStops[k];
    const end = start + map.textWidths[k];
    if (start < from.offset || end > to.offset) continue;
    const last = runs.at(-1);
    if (last && last[1] === start) last[1] = end;
    else runs.push([start, end]);
  }
  if (!runs.length) runs.push([from.offset, to.offset]);
  const ops: EditOp[] = runs.reverse().map(([a, b]) => ({ op: 'delete', from: toAddress(list, from.para, a), to: toAddress(list, from.para, b) }));
  if (text) ops.push({ op: 'insertText', at: from, text: text.replace(/\r\n?/g, '\n') });
  return ops;
}

export function replaceText(core: HmCore, sec: number, para: number, charOffset: number, length: number, newText: string): ReplaceResult {
  const list = bodyList(sec);
  const map = paraMap(core.paragraph(list, para));
  const [a, b] = textRangeToWire(map, charOffset, charOffset + length);
  core.transact(replacement(core, toAddress(list, para, a), toAddress(list, para, b), newText));
  return { ok: true, charOffset, newLength: newText.length };
}

export function replaceOne(core: HmCore, query: string, newText: string, caseSensitive: boolean): ReplaceOneResult {
  const found = matches(core, query, caseSensitive, 'all')[0];
  if (!found) return { ok: false };
  const result = hit(core, found.match);
  core.transact(replacement(core, found.match.from, found.match.to, newText));
  return { ok: true, sec: result.sec, para: result.para, charOffset: result.charOffset, newLength: newText.length };
}

export function replaceAll(core: HmCore, query: string, newText: string, caseSensitive: boolean): ReplaceAllResult {
  const found = matches(core, query, caseSensitive, 'all');
  // 문서 순서의 뒤부터 바꾸면 앞쪽 주소는 그대로다. 전체를 한 번의 되돌리기로 묶는다.
  core.transact(found.reverse().flatMap(({ match }) => replacement(core, match.from, match.to, newText)));
  return { ok: true, count: found.length };
}

extendBridge({ searchText, searchAllText, replaceText, replaceOne, replaceAll });
