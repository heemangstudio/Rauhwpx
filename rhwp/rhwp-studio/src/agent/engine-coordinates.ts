/** MCP 글자 좌표는 scalar, Studio 캐럿 좌표는 UTF-16 + 인라인 개체 단위다. */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CellAddr } from './types.ts';
import type { CharShapeRun, SearchHit } from '../core/types.ts';

const wrappers = new WeakMap<WasmBridge, WasmBridge>();
const scalarLength = (text: string): number => [...text].length;

function utf16(text: string, offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return offset;
  let count = 0, units = 0;
  for (const char of text) {
    if (count >= offset) break;
    units += char.length;
    count++;
  }
  return units + Math.max(0, offset - count);
}
function scalar(text: string, offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return offset;
  return scalarLength(text.slice(0, offset)) + Math.max(0, offset - text.length);
}

/** core 없는 기존 scalar mock 은 그대로 돌려준다. hm-wasm 을 import 하지 않는다. */
export function agentEngineCoordinates(host: WasmBridge): WasmBridge {
  if (!host.core) return host;
  const cached = wrappers.get(host);
  if (cached) return cached;
  type Args = any[];
  type Handler = (...args: Args) => any;
  const methods = new Map<string, Handler>();
  const call = (name: string, args: Args): any => (host as any)[name](...args);
  // scope 는 텍스트 API 의 문단 주소 인자다. 경로 마지막 항목이 현재 셀 문단이다.
  type Scope = { kind: 'body' | 'cell' | 'path'; args: Args };
  const scope = (kind: Scope['kind'], args: Args): Scope => ({ kind, args: args.slice(0, kind === 'body' ? 2 : kind === 'cell' ? 5 : 3) });
  const atPara = (target: Scope, para: number): Scope => {
    const args = [...target.args];
    if (target.kind === 'path') {
      const path = JSON.parse(args[2]);
      const last = path[path.length - 1];
      if ('cellParaIndex' in last) last.cellParaIndex = para;
      else last.cellParaIdx = para;
      args[2] = JSON.stringify(path);
    } else args[target.kind === 'body' ? 1 : 4] = para;
    return { kind: target.kind, args };
  };
  const read = (target: Scope): string => call(target.kind === 'body' ? 'getTextRange' : target.kind === 'cell' ? 'getTextInCell' : 'getTextInCellByPath', [...target.args, 0, Number.MAX_SAFE_INTEGER, false]);
  const mapResult = (result: any, map: (value: any) => any): any => typeof result === 'string' ? JSON.stringify(map(JSON.parse(result))) : map(result);
  const runs = (values: CharShapeRun[], text: string, convert: typeof utf16): CharShapeRun[] => values.map(run => ({ ...run, startOffset: convert(text, run.startOffset), endOffset: convert(text, run.endOffset) }));

  for (const kind of ['body', 'cell', 'path'] as const) {
    const n = kind === 'body' ? 2 : kind === 'cell' ? 5 : 3;
    const names = kind === 'body'
      ? { read: 'getTextRange', length: 'getParagraphLength', toText: 'logicalToTextOffset', toLogical: 'textToLogicalOffset', props: 'getCharPropertiesAt', format: 'applyCharFormat', shape: 'setCharShapeId', getRuns: 'getCharShapeRuns', setRuns: 'setCharShapeRuns', suffix: '' }
      : kind === 'cell'
        ? { read: 'getTextInCell', length: 'getCellParagraphLength', toText: 'logicalToTextOffsetInCell', toLogical: '', props: 'getCellCharPropertiesAt', format: 'applyCharFormatInCell', shape: 'setCharShapeIdInCell', getRuns: '', setRuns: '', suffix: 'InCell' }
        : { read: 'getTextInCellByPath', length: 'getCellParagraphLengthByPath', toText: 'logicalToTextOffsetInCellByPath', toLogical: 'textToLogicalOffsetInCellByPath', props: 'getCellCharPropertiesAtByPath', format: 'applyCharFormatInCellByPath', shape: 'setCharShapeIdInCellByPath', getRuns: 'getCharShapeRunsInCellByPath', setRuns: 'setCharShapeRunsInCellByPath', suffix: 'InCellByPath' };
    methods.set(names.length, (...args) => scalarLength(read(scope(kind, args))));
    methods.set(names.toText, (...args) => scalar(read(scope(kind, args)), call(names.toText, args)));
    if (names.toLogical) methods.set(names.toLogical, (...args) => {
      const converted = [...args];
      converted[n] = utf16(read(scope(kind, args)), args[n]);
      return call(names.toLogical, converted);
    });
    for (const name of [names.props, names.format, names.shape, names.getRuns, names.setRuns].filter(Boolean)) {
      methods.set(name, (...args) => {
        const text = read(scope(kind, args));
        const converted = [...args];
        converted[n] = utf16(text, args[n]);
        if (name !== names.props) converted[n + 1] = utf16(text, args[n + 1]);
        if (name === names.setRuns) converted[n + 2] = runs(args[n + 2], text, utf16);
        const result = call(name, converted);
        return name === names.getRuns ? runs(result, text, scalar) : result;
      });
    }
    const operations = [
      [names.read, 'read'], [`insertText${names.suffix}`, 'insert'], [`insertTextContent${names.suffix}`, 'insert'],
      [`deleteText${names.suffix}`, 'delete'],
      ...(kind === 'body' ? [['replaceBodyTextLocal', 'replace']] : []),
      ...(kind === 'cell' ? [['insertTextInCellDeferredPagination', 'insert'], ['insertTextContentInCellDeferredPagination', 'insert'], ['deleteTextInCellDeferredPagination', 'delete'], ['replaceTextInCellDeferredPagination', 'replace']] : []),
    ];
    for (const [name, operation] of operations) methods.set(name, (...args) => {
      const logicalIndex = n + (operation === 'replace' ? 3 : 2);
      // logical=true 는 UI 좌표이므로 인자와 반환값을 그대로 둔다.
      if (args[logicalIndex] === true) return call(name, args);
      const target = scope(kind, args), before = read(target), converted = [...args];
      converted[n] = utf16(before, args[n]);
      if (operation !== 'insert') converted[n + 1] = utf16(before, args[n] + args[n + 1]) - converted[n];
      const result = call(name, converted);
      if (operation === 'read') return result;
      let afterTarget = target;
      const inserted = operation === 'insert' ? args[n + 1] : operation === 'replace' ? args[n + 2] : '';
      const insertedText = typeof inserted === 'string' ? inserted : inserted.text;
      const breaks = (insertedText.match(/\r\n|\r|\n/g) ?? []).length;
      if (breaks) {
        const para = kind === 'path' ? (() => { const path = JSON.parse(target.args[2]); return path.at(-1).cellParaIndex ?? path.at(-1).cellParaIdx; })() : target.args[kind === 'body' ? 1 : 4];
        afterTarget = atPara(target, para + breaks);
      }
      return mapResult(result, value => ({ ...value,
        ...(typeof value.charOffset === 'number' ? { charOffset: scalar(read(afterTarget), value.charOffset) } : {}),
        ...(typeof value.removedStart === 'number' ? { removedStart: scalar(before, value.removedStart) } : {}),
        // core deleteIn 의 removedCount 는 이미 scalar 단위다.
      }));
    });
  }

  for (const name of ['deleteRange', 'deleteRangeAcrossSections', 'deleteRangeInCell', 'deleteRangeInCellByPath', 'applyCharFormatAcrossSections']) {
    methods.set(name, (...args) => {
      const across = name.endsWith('AcrossSections');
      const kind = name.endsWith('ByPath') ? 'path' : name === 'deleteRangeInCell' ? 'cell' : 'body';
      const start = kind === 'path' ? 3 : kind === 'cell' ? 4 : 1;
      const end = start + (across ? 3 : 2);
      const logicalIndex = across ? 6 : kind === 'path' ? 7 : kind === 'body' ? 5 : -1;
      if (name !== 'applyCharFormatAcrossSections' && args[logicalIndex] === true) return call(name, args);
      const base = scope(kind, args);
      const a = atPara(base, args[start]);
      const b = atPara(across ? scope('body', [args[3], args[4]]) : base, args[end]);
      const before = read(a), converted = [...args];
      converted[start + 1] = utf16(before, args[start + 1]);
      converted[end + 1] = utf16(read(b), args[end + 1]);
      const result = call(name, converted);
      return name === 'applyCharFormatAcrossSections' ? result : mapResult(result, value => ({ ...value, charOffset: scalar(before, value.charOffset) }));
    });
  }

  methods.set('getControlTextPositions', (...args) => {
    const text = read(scope('body', args));
    return call('getControlTextPositions', args).map((offset: number) => scalar(text, offset));
  });

  const hitScope = (hit: SearchHit): Scope => hit.cellPath?.length
    ? scope('path', [hit.sec, hit.para, JSON.stringify(hit.cellPath)])
    : hit.cellContext
      ? scope('cell', [hit.sec, hit.cellContext.parentPara, hit.cellContext.ctrlIdx, hit.cellContext.cellIdx, hit.cellContext.cellPara])
      : scope('body', [hit.sec, hit.para]);
  const hit = (value: SearchHit): SearchHit => {
    const text = read(hitScope(value));
    const offset = scalar(text, value.charOffset);
    return { ...value, charOffset: offset, length: scalar(text, value.charOffset + value.length) - offset };
  };
  methods.set('searchAllText', (...args) => call('searchAllText', args).map(hit));
  methods.set('searchText', (...args) => {
    const converted = [...args];
    const target = args[6]?.length ? scope('path', [args[1], args[2], JSON.stringify(args[6])]) : scope('body', [args[1], args[2]]);
    converted[3] = utf16(read(target), args[3]);
    const result = call('searchText', converted);
    return result.found ? hit(result) : result;
  });
  methods.set('replaceText', (...args) => {
    const text = read(scope('body', args)), converted = [...args];
    converted[2] = utf16(text, args[2]);
    converted[3] = utf16(text, args[2] + args[3]) - converted[2];
    const result = call('replaceText', converted);
    return { ...result, ...(result.charOffset === undefined ? {} : { charOffset: scalar(text, result.charOffset) }), ...(result.newLength === undefined ? {} : { newLength: scalarLength(args[4].replace(/\r\n?/g, '\n')) }) };
  });
  methods.set('replaceOne', (...args) => {
    // 치환 뒤에는 원래 prefix 가 사라질 수 있으므로 변경 전 검색 좌표를 쓴다.
    const first = call('searchAllText', [args[0], args[2], false])[0];
    const offset = first ? hit(first).charOffset : undefined;
    const result = call('replaceOne', args);
    return result.ok ? { ...result, charOffset: offset, newLength: scalarLength(args[1].replace(/\r\n?/g, '\n')) } : result;
  });

  const proxy = new Proxy(host, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return methods.get(String(key)) ?? value.bind(target);
    },
    set(target, key, value) { return Reflect.set(target, key, value, target); },
  });
  wrappers.set(host, proxy);
  wrappers.set(proxy, proxy);
  return proxy;
}

/** agent 텍스트 지점을 UI 전용 기하 API 에 넘기기 전에 한 번만 바꾼다. */
export function agentTextToLogicalOffset(wasm: WasmBridge, sec: number, para: number, offset: number, cell?: CellAddr): number {
  if (cell) {
    const path = cell.path?.length
      ? cell.path.map((entry, i) => i === cell.path!.length - 1 ? { ...entry, cellParaIndex: para } : entry)
      : [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: para }];
    return typeof wasm.textToLogicalOffsetInCellByPath === 'function'
      ? wasm.textToLogicalOffsetInCellByPath(sec, cell.paraIdx, JSON.stringify(path), offset) : offset;
  }
  return typeof wasm.textToLogicalOffset === 'function' ? wasm.textToLogicalOffset(sec, para, offset) : offset;
}
