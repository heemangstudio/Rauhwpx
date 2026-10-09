/**
 * 에이전트 도구 실행기 통합 테스트 환경 — executor → 실제 PendingEditManager →
 * 가짜 wasm 경로. agent-text-anchors.test.ts 와 agent-cheap-reads.test.ts 가 공유한다.
 */
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { RevisionTracker } from '../src/agent/revision.ts';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';
import { AgentToolError } from '../src/agent/types.ts';

export interface FakeTable {
  paraIdx: number;
  controlIdx: number;
  rows: number;
  cols: number;
  /** flat cellIdx → 셀 문단 텍스트 배열 */
  cells: string[][];
  /** charShapeModel 이 쓰는 셀 문단별 글자 모양 id (스냅샷에 함께 복제된다) */
  charShapes?: number[][][];
}

/** extend 는 가짜 wasm 에 조판·표 프로브를 덧붙인다 (쓰기 결과 보고 테스트). */
export function makeEnv(
  initialBody: string[],
  extend?: (wasm: Record<string, unknown>, body: string[], tables: FakeTable[]) => void,
) {
  const body = [...initialBody];
  const bodyParaShapes = body.map((_, i) => 10 + i);
  const tables: FakeTable[] = [];
  const calls: Array<{ m: string; a: unknown[] }> = [];
  const record = (m: string, ...a: unknown[]) => { calls.push({ m, a }); };
  const okJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

  const findTable = (para: number, ctrl: number): FakeTable => {
    const t = tables.find((x) => x.paraIdx === para && x.controlIdx === ctrl);
    if (!t) throw new Error(`표 없음 @${para}/${ctrl}`);
    return t;
  };

  const wasm = {
    // ─ 본문 ─
    getSectionCount: () => 1,
    getParagraphCount: () => body.length,
    getParagraphLength: (_s: number, p: number) => body[p].length,
    getTextRange: (_s: number, p: number, off: number, cnt: number) => body[p].slice(off, off + cnt),
    insertText: (_s: number, p: number, off: number, t: string) => {
      body[p] = body[p].slice(0, off) + t + body[p].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraph: (_s: number, p: number, off: number) => {
      const cur = body[p];
      body.splice(p, 1, cur.slice(0, off), cur.slice(off));
      bodyParaShapes.splice(p, 1, bodyParaShapes[p], bodyParaShapes[p]);
      for (const t of tables) if (t.paraIdx > p) t.paraIdx += 1;
      return okJson();
    },
    splitParagraphLogical(this: { splitParagraph(s: number, p: number, o: number): string }, s: number, p: number, o: number) {
      return this.splitParagraph(s, p, o);
    },
    deleteRange: (_s: number, sp: number, so: number, ep: number, eo: number) => {
      const removed = ep - sp;
      body.splice(sp, ep - sp + 1, body[sp].slice(0, so) + body[ep].slice(eo));
      bodyParaShapes.splice(sp + 1, removed);
      for (const t of tables) if (t.paraIdx > ep) t.paraIdx -= removed;
      return { ok: true };
    },
    get pageCount() { return 1; },
    getPageControlLayout: () => ({
      controls: tables.map((t) => ({ type: 'table', secIdx: 0, paraIdx: t.paraIdx, controlIdx: t.controlIdx })),
    }),
    // ─ 표 셀 ─
    getTableDimensions: (_s: number, para: number, ctrl: number) => {
      const t = findTable(para, ctrl);
      return { rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length };
    },
    getCellInfo: (_s: number, para: number, ctrl: number, idx: number) => {
      const t = findTable(para, ctrl);
      return { row: Math.floor(idx / t.cols), col: idx % t.cols, rowSpan: 1, colSpan: 1 };
    },
    getCellParagraphCount: (_s: number, para: number, ctrl: number, cell: number) =>
      findTable(para, ctrl).cells[cell].length,
    getCellParagraphLength: (_s: number, para: number, ctrl: number, cell: number, cp: number) =>
      findTable(para, ctrl).cells[cell][cp].length,
    getTextInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number, cnt: number) =>
      findTable(para, ctrl).cells[cell][cp].slice(off, off + cnt),
    insertTextInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number, t: string) => {
      const ft = findTable(para, ctrl);
      ft.cells[cell][cp] = ft.cells[cell][cp].slice(0, off) + t + ft.cells[cell][cp].slice(off);
      return okJson({ charOffset: off + t.length });
    },
    splitParagraphInCell: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number) => {
      const ft = findTable(para, ctrl);
      const cur = ft.cells[cell][cp];
      ft.cells[cell].splice(cp, 1, cur.slice(0, off), cur.slice(off));
      return okJson();
    },
    splitParagraphInCellLogical(this: { splitParagraphInCell: (...a: number[]) => string }, ...a: number[]) {
      return this.splitParagraphInCell(...a);
    },
    deleteRangeInCell: (_s: number, para: number, ctrl: number, cell: number, sp: number, so: number, ep: number, eo: number) => {
      const ft = findTable(para, ctrl);
      ft.cells[cell].splice(sp, ep - sp + 1, ft.cells[cell][sp].slice(0, so) + ft.cells[cell][ep].slice(eo));
      return { ok: true, paraIdx: sp, charOffset: so };
    },
    // ─ 서식 ─
    getCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    getCellCharPropertiesAt: () => ({ fontFamily: '바탕' }),
    applyCharFormat: (...a: unknown[]) => { record('applyCharFormat', ...a); return okJson(); },
    applyCharFormatInCell: (...a: unknown[]) => { record('applyCharFormatInCell', ...a); return okJson(); },
    getParaPropertiesAt: (_s: number, p: number) => ({ paraShapeId: bodyParaShapes[p], alignment: 'left' }),
    applyParaFormat: (_s: number, p: number, json: string) => {
      record('applyParaFormat', p, json);
      bodyParaShapes[p] = 99;
      return okJson();
    },
    setParaShapeId: (_s: number, p: number, id: number) => {
      record('setParaShapeId', p, id);
      bodyParaShapes[p] = id;
      return okJson();
    },
    getCellParaPropertiesAt: () => ({ paraShapeId: 55 }),
    applyParaFormatInCell: (...a: unknown[]) => { record('applyParaFormatInCell', ...a); return okJson(); },
    setCellParaShapeId: (...a: unknown[]) => { record('setCellParaShapeId', ...a); return okJson(); },
    findOrCreateFontId: (name: string) => (name === '바탕' ? 0 : 1),
    // ─ 기타 ─
    getSourceFormat: () => 'hwpx',
    getFieldList: () => [],
    getDocumentInfo: () => ({
      version: '5.0', sectionCount: 1, pageCount: 1, encrypted: false,
      fallbackFont: '바탕', fontsUsed: ['바탕'],
    }),
  };

  let snapshotId = 0;
  const snapshots = new Map<number, { body: string[]; shapes: number[]; tables: FakeTable[] }>();
  Object.assign(wasm, {
    saveSnapshot: () => {
      const id = ++snapshotId;
      snapshots.set(id, {
        body: structuredClone(body),
        shapes: structuredClone(bodyParaShapes),
        tables: structuredClone(tables),
      });
      return id;
    },
    restoreSnapshot: (id: number) => {
      const saved = snapshots.get(id)!;
      body.splice(0, body.length, ...structuredClone(saved.body));
      bodyParaShapes.splice(0, bodyParaShapes.length, ...structuredClone(saved.shapes));
      tables.splice(0, tables.length, ...structuredClone(saved.tables));
    },
    discardSnapshot: (id: number) => { snapshots.delete(id); },
    captureParagraph: (_s: number, p: number) => {
      record('captureParagraph', p);
      return ++snapshotId + 10_000;
    },
    restoreCapturedParagraph: (id: number, _s: number, p: number) => { record('restoreCapturedParagraph', p); },
    discardParagraphCapture: (_id: number) => {},
    getParagraphContentDigest: (_s: number, p: number) => JSON.stringify(body[p]),
  });

  extend?.(wasm as unknown as Record<string, unknown>, body, tables);

  const bus = new EventBus();
  // extend 가 documentInstance 를 달면 실제 브리지처럼 revision 을 문서 인스턴스에 묶는다.
  const revision = new RevisionTracker(bus, {
    documentInstance: () => (wasm as { documentInstance?: number }).documentInstance,
  });
  let released = 0;
  /** 승인이 히스토리에 남긴 명령 — undo/redo 검증용 */
  const recorded: Array<{ undo(w: unknown): unknown; execute(w: unknown): unknown }> = [];
  const inputHandler = {
    executeOperation: (op: { kind?: string; command?: (typeof recorded)[number]; operation?: (w: unknown) => unknown }) => {
      if (op.kind === 'record' && op.command) recorded.push(op.command);
      op.operation?.(wasm);
    },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => { released++; },
  };
  const pending = new PendingEditManager({
    wasm: wasm as never,
    eventBus: bus,
    editor: inputHandler as never,
    overlay: { setOps: () => {}, clear: () => {} } as never,
  });
  const executor = new AgentToolExecutor({
    wasm: wasm as never,
    editor: inputHandler as never,
    documentState: { isDirty: () => false } as never,
    revision,
    pending,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude') as Promise<Record<string, unknown>>;
  return { call, pending, revision, bus, body, tables, calls, wasm, recorded, releasedSnapshots: () => released };
}

/** charShapeModel 의 글자 모양 — 엔진처럼 속성이 같으면 같은 charShapeId 를 받는다. */
export interface FakeCharShape {
  bold: boolean; italic: boolean; underline: boolean; strikethrough: boolean;
  fontSize: number; textColor: string; fontId: number; ratios: number[]; spacings: number[];
}

const FONT_NAMES = ['바탕', '돋움'];
const PLAIN_SHAPE: FakeCharShape = {
  bold: false, italic: false, underline: false, strikethrough: false, fontSize: 1000, textColor: '#000000',
  fontId: 0, ratios: [100, 100, 100, 100, 100, 100, 100], spacings: [0, 0, 0, 0, 0, 0, 0],
};

/**
 * 글자마다 모양을 가진 가짜 엔진 — makeEnv(body, model.extend) 로 붙인다. 본문·셀 문단의 글자별
 * charShapeId 를 텍스트 변이와 함께 옮기고, 서식 적용·구간 읽기/쓰기·스냅샷을 엔진처럼 모사한다.
 * 셀은 단일 경로([{controlIndex, cellIndex, cellParaIndex}])만 다룬다.
 */
export function charShapeModel() {
  const shapes: FakeCharShape[] = [];
  const shapeIds = new Map<string, number>();
  const idOf = (shape: FakeCharShape): number => {
    const key = JSON.stringify(shape);
    let id = shapeIds.get(key);
    if (id === undefined) {
      id = shapes.length;
      shapes.push(structuredClone(shape));
      shapeIds.set(key, id);
    }
    return id;
  };
  idOf(PLAIN_SHAPE);
  let body: string[] = [];
  let tables: FakeTable[] = [];
  let bodyIds: number[][] = [];
  const layouts = { count: 0 };
  const runWrites = { count: 0 };

  /** 글자 수에 맞춘 모양 id 배열 (테스트가 텍스트를 직접 바꿨으면 끝 모양으로 채우거나 자른다) */
  const fit = (ids: number[], len: number): number[] => {
    while (ids.length < len) ids.push(ids.at(-1) ?? 0);
    ids.length = len;
    return ids;
  };
  const bodyAt = (p: number): number[] => fit(bodyIds[p] ??= [], body[p].length);
  const tableAt = (para: number, ctrl: number): FakeTable => {
    const t = tables.find((x) => x.paraIdx === para && x.controlIdx === ctrl);
    if (!t) throw new Error(`표 없음 @${para}/${ctrl}`);
    t.charShapes ??= [];
    return t;
  };
  const cellParas = (para: number, ctrl: number, cell: number): number[][] => {
    const t = tableAt(para, ctrl);
    const paras = t.charShapes![cell] ??= [];
    paras.length = t.cells[cell].length;
    return paras;
  };
  const cellAt = (para: number, ctrl: number, cell: number, cp: number): number[] => {
    const paras = cellParas(para, ctrl, cell);
    return fit(paras[cp] ??= [], tableAt(para, ctrl).cells[cell][cp].length);
  };
  const pathCell = (para: number, path: string): number[] => {
    const [{ controlIndex, cellIndex, cellParaIndex }] =
      JSON.parse(path) as Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;
    return cellAt(para, controlIndex, cellIndex, cellParaIndex);
  };

  const propsOf = (ids: number[], offset: number) => {
    const charShapeId = ids.length === 0 ? 0 : ids[Math.min(offset, ids.length - 1)];
    const shape = shapes[charShapeId];
    return { ...structuredClone(shape), fontFamily: FONT_NAMES[shape.fontId], charShapeId };
  };
  const format = (ids: number[], start: number, end: number, props: Partial<FakeCharShape>): void => {
    for (let i = start; i < end; i++) ids[i] = idOf({ ...shapes[ids[i]], ...props });
  };
  const runsOf = (ids: number[], start: number, end: number) => {
    const runs: Array<{ startOffset: number; endOffset: number; charShapeId: number }> = [];
    for (let i = start; i < end; i++) {
      const last = runs.at(-1);
      if (last && last.charShapeId === ids[i]) last.endOffset = i + 1;
      else runs.push({ startOffset: i, endOffset: i + 1, charShapeId: ids[i] });
    }
    return runs;
  };
  const setRuns = (ids: number[], start: number, end: number, runs: Array<{ startOffset: number; endOffset: number; charShapeId: number }>) => {
    // 브리지의 validateCharShapeRuns 와 같은 계약 — 빈틈 없이 [start, end) 를 덮어야 한다
    runWrites.count++;
    let next = start;
    for (const run of runs) {
      if (run.startOffset !== next || run.endOffset <= next || run.endOffset > end || !shapes[run.charShapeId]) {
        throw new Error('잘못된 글자 모양 구간');
      }
      ids.fill(run.charShapeId, run.startOffset, run.endOffset);
      next = run.endOffset;
    }
    if (next !== end) throw new Error('글자 모양 구간에 빈 범위가 있습니다');
    return JSON.stringify({ ok: true });
  };
  const inserted = (ids: number[], off: number, len: number): void => {
    ids.splice(off, 0, ...new Array<number>(len).fill(off > 0 ? ids[off - 1] : (ids[0] ?? 0)));
  };

  const extend = (wasm: Record<string, unknown>, b: string[], t: FakeTable[]): void => {
    body = b;
    tables = t;
    type Fn = (...a: never[]) => unknown;
    const orig = (name: string) => wasm[name] as Fn;
    const wrap = (name: string, before: (...a: never[]) => void): void => {
      const call = orig(name);
      wasm[name] = function (this: unknown, ...a: never[]) {
        before(...a);
        return call.apply(this, a);
      };
    };
    // 텍스트 변이 — 원래 함수가 텍스트를 바꾸기 전에 글자 모양 배열을 같은 모양으로 바꾼다
    wrap('insertText', (_s: number, p: number, off: number, text: string) => inserted(bodyAt(p), off, text.length));
    wrap('splitParagraph', (_s: number, p: number, off: number) => {
      const ids = bodyAt(p);
      bodyIds.splice(p, 1, ids.slice(0, off), ids.slice(off));
    });
    wrap('deleteRange', (_s: number, sp: number, so: number, ep: number, eo: number) => {
      bodyIds.splice(sp, ep - sp + 1, [...bodyAt(sp).slice(0, so), ...bodyAt(ep).slice(eo)]);
    });
    wrap('insertTextInCell', (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number, text: string) =>
      inserted(cellAt(para, ctrl, cell, cp), off, text.length));
    wrap('splitParagraphInCell', (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number) => {
      const ids = cellAt(para, ctrl, cell, cp);
      cellParas(para, ctrl, cell).splice(cp, 1, ids.slice(0, off), ids.slice(off));
    });
    wrap('deleteRangeInCell', (_s: number, para: number, ctrl: number, cell: number, sp: number, so: number, ep: number, eo: number) => {
      const merged = [...cellAt(para, ctrl, cell, sp).slice(0, so), ...cellAt(para, ctrl, cell, ep).slice(eo)];
      cellParas(para, ctrl, cell).splice(sp, ep - sp + 1, merged);
    });
    // 서식 — 적용 호출은 원래대로 calls 에도 남는다
    wrap('applyCharFormat', (_s: number, p: number, so: number, eo: number, json: string) =>
      format(bodyAt(p), so, eo, JSON.parse(json)));
    wrap('applyCharFormatInCell', (_s: number, para: number, ctrl: number, cell: number, cp: number, so: number, eo: number, json: string) =>
      format(cellAt(para, ctrl, cell, cp), so, eo, JSON.parse(json)));
    Object.assign(wasm, {
      getCharPropertiesAt: (_s: number, p: number, off: number) => propsOf(bodyAt(p), off),
      getCellCharPropertiesAt: (_s: number, para: number, ctrl: number, cell: number, cp: number, off: number) =>
        propsOf(cellAt(para, ctrl, cell, cp), off),
      getCellCharPropertiesAtByPath: (_s: number, para: number, path: string, off: number) => propsOf(pathCell(para, path), off),
      getCharShapeRuns: (_s: number, p: number, start: number, end: number) => runsOf(bodyAt(p), start, end),
      setCharShapeRuns: (_s: number, p: number, start: number, end: number, runs: never) => setRuns(bodyAt(p), start, end, runs),
      getCharShapeRunsInCellByPath: (_s: number, para: number, path: string, start: number, end: number) =>
        runsOf(pathCell(para, path), start, end),
      setCharShapeRunsInCellByPath: (_s: number, para: number, path: string, start: number, end: number, runs: never) =>
        setRuns(pathCell(para, path), start, end, runs),
      refreshLayout: () => { layouts.count++; },
    });
    // 스냅샷 — 본문 글자 모양도 함께 저장한다 (셀 모양은 표와 함께 복제된다)
    const saved = new Map<number, number[][]>();
    const save = orig('saveSnapshot') as () => number;
    const restore = orig('restoreSnapshot') as (id: number) => void;
    const discard = orig('discardSnapshot') as (id: number) => void;
    Object.assign(wasm, {
      saveSnapshot: () => {
        const id = save();
        saved.set(id, structuredClone(body.map((_, p) => bodyAt(p))));
        return id;
      },
      restoreSnapshot: (id: number) => {
        restore(id);
        bodyIds = structuredClone(saved.get(id)!);
      },
      discardSnapshot: (id: number) => {
        discard(id);
        saved.delete(id);
      },
    });
  };

  const shapeList = (ids: number[]) => ids.map((id) => shapes[id]);
  return {
    extend,
    layouts,
    runWrites,
    /** 본문 문단 p 의 [start, end) 에 서식을 바로 건다 (초기 문서 준비용) */
    format: (p: number, start: number, end: number, props: Partial<FakeCharShape>) => format(bodyAt(p), start, end, props),
    formatCell: (table: FakeTable, cell: number, cp: number, start: number, end: number, props: Partial<FakeCharShape>) =>
      format(cellAt(table.paraIdx, table.controlIdx, cell, cp), start, end, props),
    ids: (p: number) => [...bodyAt(p)],
    cellIds: (table: FakeTable, cell: number, cp: number) => [...cellAt(table.paraIdx, table.controlIdx, cell, cp)],
    shapes: (p: number) => shapeList(bodyAt(p)),
    cellShapes: (table: FakeTable, cell: number, cp: number) => shapeList(cellAt(table.paraIdx, table.controlIdx, cell, cp)),
  };
}

export function addTable(env: ReturnType<typeof makeEnv>, paraIdx: number, cells: string[][]): FakeTable {
  const t: FakeTable = { paraIdx, controlIdx: 0, rows: cells.length, cols: cells[0].length, cells: cells.flat().map((c) => [c]) };
  env.tables.push(t);
  return t;
}

export async function expectErr(p: Promise<unknown>, code: string): Promise<AgentToolError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentToolError, `AgentToolError 기대, 실제: ${e}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`${code} 오류를 기대했지만 성공함`);
}
