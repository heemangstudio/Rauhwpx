// IME 입력 경로의 행동 계약.
//
// 실제 InputHandler 프로토타입 메서드와 input-handler-text 함수를 그대로 쓰고, 엔진 문서·
// 커서·캐럿·히스토리만 가짜로 둔다. 가짜 문서는 WASM 계약대로 Unicode scalar 단위로
// 글자를 지우고 넣는다.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createTestModuleServer } from './support/module-server.ts';
import type { CursorRect, DocumentPosition } from '../src/core/types.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let proto: any;
let ImeSession: any;
let CaretRenderer: any;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  proto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
  ImeSession = (await vite.ssrLoadModule('/src/engine/ime-session.ts')).ImeSession;
  CaretRenderer = (await vite.ssrLoadModule('/src/engine/caret-renderer.ts')).CaretRenderer;
});

after(async () => {
  await vite?.close();
});

/** 숨은 textarea. 프로그램이 value 를 대입한 기록과 브라우저(IME)가 바꾼 값을 구분한다. */
function fakeTextarea() {
  let value = '';
  const writes: string[] = [];
  return {
    writes,
    style: {} as Record<string, string>,
    get value() { return value; },
    set value(next: string) { writes.push(next); value = next; },
    /** IME 가 value 를 바꾼다 — 프로그램 대입으로 기록하지 않는다. */
    browserSet(next: string) { value = next; },
    focus() {},
    blur() {},
  };
}

interface Operation { kind: string; command: any }

/** 한 문단짜리 문서 위의 InputHandler. 프로토타입 메서드는 실제 구현이다. */
function createHandler(initialText: string, caretOffset: number, options: Record<string, unknown> = {}) {
  const doc = [...initialText];
  const ops: Operation[] = [];
  const caretCalls: string[] = [];
  const textarea = fakeTextarea();
  let position: DocumentPosition = { sectionIndex: 0, paragraphIndex: 0, charOffset: caretOffset };
  const rectAt = (offset: number): CursorRect => ({ pageIndex: 0, x: 100 + offset * 10, y: 50, height: 12 });

  const cursor = {
    headerFooterMode: 'none',
    getPosition: () => ({ ...position }),
    moveTo(pos: DocumentPosition) { position = { ...pos }; },
    getRect: () => rectAt(position.charOffset),
    isInHeaderFooter: () => false,
    isInFootnote: () => false,
    hasSelection: () => false,
    setAnchor() {},
    clearSelection() {},
  };

  const handler: any = Object.create(proto);
  Object.assign(handler, {
    active: true,
    readOnly: false,
    userEditingLocked: false,
    agentTemplateLocked: false,
    _isIOS: false,
    _iosAnchor: null,
    _iosLength: 0,
    _iosInputTimer: null,
    _pendingNavAfterIME: null,
    headerFooterSelectionComposition: false,
    compositionAnchor: null,
    compositionAnchorRect: null,
    compositionLength: 0,
    textareaConsumed: 0,
    imeSession: new ImeSession(),
    textarea,
    cursor,
    caret: {
      hideComposition: () => caretCalls.push('hideComposition'),
      showCompositionUnderline: () => caretCalls.push('showCompositionUnderline'),
      update: () => caretCalls.push('update'),
      hide: () => caretCalls.push('hide'),
    },
    wasm: {},
    // 엔진 문서 대신 scalar 배열을 고친다.
    replaceTextAtRaw(pos: DocumentPosition, deleteCount: number, text: string) {
      doc.splice(pos.charOffset, deleteCount, ...text);
    },
    executeOperation(op: Operation) {
      ops.push(op);
      // 'record' 는 이미 문서에 반영된 편집을 기록만 한다. 'command' 는 실제로 실행한다.
      if (op.kind === 'command') {
        const { position: at, text } = op.command;
        doc.splice(at.charOffset, 0, ...text);
        position = { ...at, charOffset: at.charOffset + [...text].length };
      }
    },
    resetRawTextMutationEffects() {},
    consumeRawTextMutationBeforeCursor: () => false,
    afterTextInputEdit() {},
    updateCaret() {},
    getNonEmptyHeaderFooterSelection: () => null,
    canInsertTextInFormMode: () => true,
    canDeleteSelectionInFormMode: () => true,
    prepareClickHereInputPosition: () => cursor.getPosition(),
    isClickHereGuidePosition: () => false,
    refreshClickHereAfterFirstInput() {},
    applyPendingCharFormatToInsertedRange() {},
    peekPendingCharFormat: () => undefined,
    flushDeferredPaginationIfNeeded() {},
    ...options,
  });
  return { handler, doc, ops, textarea, caretCalls, text: () => doc.join('') };
}

const composing = (data: string) => ({ inputType: 'insertCompositionText', data, isComposing: true });

/** 브라우저가 한 음절을 조합해 확정하는 순서를 그대로 흉내 낸다. */
function composeSyllable(
  h: ReturnType<typeof createHandler>,
  typedBefore: string,
  steps: string[],
  finalData = steps[steps.length - 1],
) {
  h.handler.onCompositionStart();
  for (const step of steps) {
    h.textarea.browserSet(typedBefore + step);
    h.handler.onCompositionUpdate({ data: step });
    h.handler.onInput(composing(step));
  }
  h.handler.onCompositionEnd({ data: finalData });
}

test('조합 길이는 Unicode scalar 로 세어 astral 문자 뒤 글자를 지우지 않는다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '𝒜' });
  h.handler.onCompositionUpdate({ data: '𝒜𝒜' });
  assert.equal(h.text(), 'X𝒜𝒜Y', 'preedit 교체가 뒤 글자 Y 를 지우면 안 된다');

  h.handler.onCompositionEnd({ data: '𝒜𝒜' });
  assert.equal(h.text(), 'X𝒜𝒜Y');
  assert.deepEqual(h.ops.map((op) => [op.kind, op.command.text]), [['record', '𝒜𝒜']]);
  assert.deepEqual(h.handler.cursor.getPosition().charOffset, 3, '캐럿도 scalar 축으로 전진한다');
});

test('iOS 조합 폴백도 이전 삽입을 scalar 길이로 교체한다', () => {
  const h = createHandler('XY', 1, { _isIOS: true });
  h.textarea.browserSet('𝒜');
  h.handler.onInput({ inputType: 'insertText', data: '𝒜', isComposing: false });
  h.textarea.browserSet('𝒜𝒜');
  h.handler.onInput({ inputType: 'insertText', data: '𝒜', isComposing: false });
  assert.equal(h.text(), 'X𝒜𝒜Y');
});

test('타이핑 중에는 textarea value 를 대입하지 않고 반영한 prefix 만 전진한다', () => {
  const h = createHandler('', 0);
  composeSyllable(h, '', ['ㄱ', '가']);
  // 다음 음절은 앞 음절이 남아 있는 value 뒤에 이어 조합된다. 끝 data 가 비면
  // 미반영 슬라이스만 커밋해야 한다.
  composeSyllable(h, '가', ['ㄴ', '나'], '');
  h.textarea.browserSet('가나 ');
  h.handler.onInput({ inputType: 'insertText', data: ' ', isComposing: false });

  assert.deepEqual(h.textarea.writes, [], '조합이 살아 있을 수 있는 동안 value 를 바꾸면 IME 가 조합을 파기한다');
  assert.equal(h.text(), '가나 ');
  assert.deepEqual(h.ops.map((op) => op.command.text), ['가', '나', ' ']);
});

test('textarea 정리는 IME 가 쉬는 지점에서 value 와 prefix 를 함께 비운다', () => {
  const h = createHandler('', 0);
  composeSyllable(h, '', ['가']);
  h.handler.finalizeCompositionBeforeCursorMove();
  assert.deepEqual(h.textarea.writes, ['']);

  h.textarea.browserSet('다');
  assert.equal(h.handler.unconsumedTextareaValue(), '다', '비운 뒤 새 입력을 앞 prefix 로 잘라내지 않는다');
});

test('compositionstart 가 빠진 조합 입력은 일반 텍스트가 아니라 preedit 으로 들어간다', () => {
  const h = createHandler('XY', 1);
  h.textarea.browserSet('ㄱ');
  h.handler.onInput(composing('ㄱ'));

  assert.equal(h.handler.imeSession.isComposing, true);
  assert.equal(h.text(), 'XㄱY');
  assert.deepEqual(h.ops, [], '자모가 확정 텍스트로 히스토리에 박히면 안 된다');

  h.textarea.browserSet('가');
  h.handler.onInput(composing('가'));
  h.handler.onCompositionEnd({ data: '가' });
  assert.equal(h.text(), 'X가Y');
  assert.deepEqual(h.ops.map((op) => [op.kind, op.command.text]), [['record', '가']]);
});

test('조합 중에는 숨은 textarea 를 움직이지 않는다', () => {
  const h = createHandler('', 0, {
    container: {
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
      clientWidth: 800,
    },
    virtualScroll: { getPageLeftResolved: () => 5, getPageOffset: () => 7 },
  });
  const rect: CursorRect = { pageIndex: 0, x: 30, y: 40, height: 12 };

  h.handler.onCompositionStart();
  h.handler.positionImeInput(rect, 1);
  assert.deepEqual(h.textarea.style, {}, '조합 중 입력 요소 기하가 바뀌면 macOS IME 가 조합을 중간 확정한다');

  h.handler.onCompositionEnd({ data: '' });
  h.handler.positionImeInput(rect, 1);
  assert.equal(h.textarea.style.left, '45px');
  assert.equal(h.textarea.style.top, '67px');
});

test('중복 compositionstart 는 진행 중인 조합을 중간 커밋하지 않는다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: 'ㅂ' });
  h.handler.onCompositionStart();
  assert.deepEqual(h.ops, [], '자모 단위로 잘린 글자가 확정되면 안 된다');

  h.handler.onCompositionUpdate({ data: '비' });
  h.handler.onCompositionEnd({ data: '비' });
  assert.equal(h.text(), 'X비Y');
  assert.deepEqual(h.ops.map((op) => op.command.text), ['비']);
});

test('조합 종료는 예외로 끝나도 조합 추적 상태를 비운다', () => {
  const h = createHandler('XY', 1, {
    executeOperation() { throw new Error('history failure'); },
  });
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '가' });
  assert.throws(() => h.handler.onCompositionEnd({ data: '가' }), /history failure/);
  assert.equal(h.handler.compositionAnchor, null);
  assert.equal(h.handler.compositionAnchorRect, null);
  assert.equal(h.handler.compositionLength, 0);
});

test('세션이 닫혔는데 남은 preedit 은 커밋하지 않고 되돌린다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '가' });
  h.handler.imeSession.reset();
  h.handler.onCompositionEnd({ data: '가' });

  assert.equal(h.text(), 'XY');
  assert.deepEqual(h.ops, []);
  assert.equal(h.handler.compositionAnchor, null);
});

test('preedit 은 문서에만 반영하고 히스토리에는 커밋만 한 번 기록한다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  for (const step of ['ㅎ', '하', '한']) h.handler.onCompositionUpdate({ data: step });
  assert.equal(h.text(), 'X한Y');
  assert.deepEqual(h.ops, []);

  h.handler.onCompositionEnd({ data: '한' });
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, 'record', '이미 문서에 있는 글자를 다시 실행하지 않는다');
  assert.equal(h.ops[0].command.constructor.name, 'InsertTextCommand');
  assert.equal(h.text(), 'X한Y');
});

test('최종 커밋이 preedit 과 다르면 문서를 커밋 텍스트로 맞춘 뒤 기록한다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '하' });
  h.handler.onCompositionEnd({ data: '한글' });
  assert.equal(h.text(), 'X한글Y');
  assert.deepEqual(h.ops.map((op) => op.command.text), ['한글']);
});

test('빈 커밋과 취소는 문서의 preedit 을 되돌리고 기록하지 않는다', () => {
  const h = createHandler('XY', 1);
  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '가' });
  h.handler.onCompositionEnd({ data: '' });
  // finish 는 빈 data 일 때 textarea 슬라이스로 물러나므로 value 도 비어 있어야 빈 커밋이다.
  assert.equal(h.text(), 'XY');

  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '나' });
  h.handler.imeSession.cancel();
  h.handler.onCompositionEnd({ data: '나' });
  assert.equal(h.text(), 'XY');
  assert.deepEqual(h.ops, []);
});

test('머리말 조합 커밋은 preedit 을 다시 넣지 않고 머리말 명령으로 기록한다', () => {
  const inserted: string[] = [];
  const h = createHandler('XY', 1);
  Object.assign(h.handler.cursor, {
    headerFooterMode: 'header',
    hfSectionIdx: 0,
    hfApplyTo: 0,
    hfParaIdx: 0,
    hfPreviewPage: 0,
    hfCharOffset: 1,
    isInHeaderFooter: () => true,
    setHfCursorPosition(_para: number, offset: number) {
      h.handler.cursor.hfCharOffset = offset;
    },
  });
  const replace = h.handler.replaceTextAtRaw;
  h.handler.replaceTextAtRaw = (pos: DocumentPosition, count: number, text: string) => {
    inserted.push(text);
    replace(pos, count, text);
  };

  h.handler.onCompositionStart();
  h.handler.onCompositionUpdate({ data: '머' });
  h.handler.onCompositionEnd({ data: '머' });

  assert.equal(h.text(), 'X머Y');
  assert.deepEqual(inserted, ['머']);
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, 'record');
  assert.equal(h.ops[0].command.constructor.name, 'InsertTextInHeaderFooterCommand');
});

test('조합 시작 좌표는 시작 때 한 번 잡아 조합 내내 재사용하고 종료 때 버린다', () => {
  let exactLookups = 0;
  const h = createHandler('XY', 1, {
    wasm: {
      getCursorRect() { exactLookups += 1; return { pageIndex: 0, x: 999, y: 0, height: 12 }; },
    },
  });
  h.handler.onCompositionStart();
  const captured = h.handler.compositionStartRect();
  assert.equal(captured.x, 110, '시작 시점 커서 좌표를 쓴다');

  h.handler.onCompositionUpdate({ data: '가' });
  assert.equal(h.handler.compositionStartRect().x, 110);
  assert.equal(exactLookups, 0, '캐시가 있으면 엔진 exact 조회를 하지 않는다');

  h.handler.onCompositionEnd({ data: '가' });
  assert.equal(h.handler.compositionAnchorRect, null);
});

// 실측 좌표: samples/143E433F503322BD33.hwp 구역 0 / 문단 1, wrap 경계 offset 22 (#6553).
const EXACT_PREV_LINE_END: CursorRect = { pageIndex: 0, x: 394.0, y: 125.8, height: 21.3 };
const NEXT_LINE_START: CursorRect = { pageIndex: 0, x: 121.6, y: 146.5, height: 21.3 };

function startRectHandler(anchor: DocumentPosition, cursorOverrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string, result: unknown) => (...args: unknown[]) => {
    calls.push([name, args]);
    return result;
  };
  const h = createHandler('', 0, {
    compositionAnchor: anchor,
    wasm: {
      getCursorRect: record('getCursorRect', EXACT_PREV_LINE_END),
      getCursorRectByPath: record('getCursorRectByPath', EXACT_PREV_LINE_END),
      getCursorRectInHeaderFooter: record('getCursorRectInHeaderFooter', EXACT_PREV_LINE_END),
      getCursorRectInFootnote: record('getCursorRectInFootnote', EXACT_PREV_LINE_END),
      getLineInfo: record('getLineInfo', { lineIndex: 1, lineCount: 2, charStart: 22, charEnd: 45 }),
      getLineInfoInCell: record('getLineInfoInCell', { lineIndex: 1, lineCount: 2, charStart: 22, charEnd: 45 }),
      getCursorRectOnLine: record('getCursorRectOnLine', NEXT_LINE_START),
    },
  });
  Object.assign(h.handler.cursor, cursorOverrides);
  return { handler: h.handler, calls };
}

test('soft-wrap 경계의 조합 시작 좌표는 글자가 놓인 줄 기준으로 잡아 캐시한다', () => {
  const { handler, calls } = startRectHandler({ sectionIndex: 0, paragraphIndex: 1, charOffset: 22 });
  const rect = handler.compositionStartRect();

  assert.deepEqual([rect.x, rect.y], [NEXT_LINE_START.x, NEXT_LINE_START.y]);
  assert.deepEqual([handler.compositionAnchorRect.x, handler.compositionAnchorRect.y], [121.6, 146.5],
    '캐시된 값은 다시 보정되지 않으므로 캐시 전에 보정해야 한다');
  const onLine = calls.find(([name]) => name === 'getCursorRectOnLine');
  assert.deepEqual(onLine?.[1].slice(0, 4), [0, 1, 1, false]);
});

test('줄 affinity 를 물을 수 없는 머리말·각주·2단 중첩 셀은 exact 좌표를 쓴다', () => {
  const nestedAnchor: DocumentPosition = {
    sectionIndex: 0, paragraphIndex: 1, charOffset: 22, parentParaIndex: 1,
    cellPath: [
      { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
      { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 },
    ],
  };
  const nested = startRectHandler(nestedAnchor);
  assert.equal(nested.handler.compositionStartRect().x, EXACT_PREV_LINE_END.x);
  assert.equal(nested.calls.some(([name]) => name === 'getCursorRectOnLine'), false);

  const header = startRectHandler({ sectionIndex: 0, paragraphIndex: 0, charOffset: 22 }, {
    headerFooterMode: 'header',
    hfSectionIdx: 0, hfApplyTo: 0, hfParaIdx: 0, hfPreviewPage: 2,
    isInHeaderFooter: () => true,
    getRect: () => ({ pageIndex: 5, x: 0, y: 0, height: 12 }),
  });
  assert.equal(header.handler.compositionStartRect().x, EXACT_PREV_LINE_END.x);
  assert.equal(header.calls.some(([name]) => name === 'getCursorRectOnLine'), false);
  // [#6453] 머리말 조합 캐럿은 커서 rect 의 쪽이 아니라 대표 편집 쪽을 쓴다.
  const hfLookup = header.calls.find(([name]) => name === 'getCursorRectInHeaderFooter');
  assert.equal(hfLookup?.[1][5], 2);

  const footnote = startRectHandler({ sectionIndex: 0, paragraphIndex: 0, charOffset: 22 }, {
    fnPageNum: 0, fnFootnoteIndex: 0, fnInnerParaIdx: 0,
    isInFootnote: () => true,
  });
  assert.equal(footnote.handler.compositionStartRect().x, EXACT_PREV_LINE_END.x);
  assert.equal(footnote.calls.some(([name]) => name === 'getCursorRectOnLine'), false);
});

function updateCaretHandler(startRect: CursorRect, caretRect: CursorRect) {
  const h = createHandler('', 0, {
    compositionAnchor: { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    compositionAnchorRect: startRect,
    compositionLength: 1,
    viewportManager: { getZoom: () => 1 },
    hasNonCollapsedTextSelection: () => false,
    adjustExitedFieldEndCaretRect: (rect: CursorRect) => rect,
    positionImeInput() {},
    scrollCaretIntoView() {},
    updateSelection() {},
    emitCursorFormatState() {},
    updateFieldMarkers() {},
    eventBus: { emit() {} },
  });
  delete h.handler.updateCaret;
  h.handler.imeSession.start();
  h.handler.cursor.getRect = () => caretRect;
  return h;
}

test('한 줄 안의 조합에만 밑줄을 긋고 줄을 넘으면 일반 캐럿으로 물러난다', () => {
  const sameLine = updateCaretHandler(
    { pageIndex: 0, x: 100, y: 50, height: 12 },
    { pageIndex: 0, x: 120, y: 53, height: 12 },
  );
  sameLine.handler.updateCaret(true);
  assert.ok(sameLine.caretCalls.includes('showCompositionUnderline'));

  const wrapped = updateCaretHandler(EXACT_PREV_LINE_END, { pageIndex: 0, x: 134.9, y: 147.1, height: 21.3 });
  wrapped.handler.updateCaret(true);
  assert.equal(wrapped.caretCalls.includes('showCompositionUnderline'), false);
  assert.deepEqual(wrapped.caretCalls.slice(-2), ['hideComposition', 'update']);
});

function underlineFor(startRect: CursorRect, endRect: CursorRect) {
  const renderer: any = Object.create(CaretRenderer.prototype);
  renderer.underlineEl = { style: {} as Record<string, string> };
  renderer.virtualScroll = { getPageOffset: () => 0 };
  renderer.ensureAttached = () => {};
  renderer.calcPageLeft = () => 0;
  renderer.showCompositionUnderline(startRect, endRect, 1);
  return renderer.underlineEl.style;
}

test('조합 밑줄은 표 셀 경계 안으로 잘린다', () => {
  const cellBounds = { x: 50, y: 0, w: 100, h: 40 };
  const style = underlineFor(
    { pageIndex: 0, x: 120, y: 10, height: 12, cellBounds },
    { pageIndex: 0, x: 190, y: 10, height: 12, cellBounds },
  );
  assert.equal(style.display, 'block');
  assert.equal(style.left, '120px');
  assert.equal(style.width, '30px');
});

test('글꼴 크기가 섞인 같은 줄에서도 밑줄을 그리고 폭이 없으면 숨긴다', () => {
  const mixed = underlineFor(
    { pageIndex: 0, x: 100, y: 40, height: 20 },
    { pageIndex: 0, x: 130, y: 48, height: 12 },
  );
  assert.equal(mixed.display, 'block');
  assert.equal(mixed.width, '30px');

  const empty = underlineFor(
    { pageIndex: 0, x: 100, y: 40, height: 12 },
    { pageIndex: 0, x: 100, y: 40, height: 12 },
  );
  assert.equal(empty.display, 'none');
});

test('셀 입력이 가시 높이를 넘으면 쪽 단위 갱신 대신 즉시 전체 페이지네이션을 한다', () => {
  const events: string[] = [];
  const moves: DocumentPosition[] = [];
  const h = createHandler('', 0, {
    wasm: { flushDeferredPagination: () => events.push('flush') },
    eventBus: { emit: (name: string) => events.push(name) },
    deferredPaginationRunner: { cancel() {} },
    deferredPaginationFlushTimer: null,
    deferredPaginationPending: true,
  });
  h.handler.cursor.getRect = () => ({ pageIndex: 0, x: 0, y: 0, height: 12, cellOverflowed: true });
  h.handler.cursor.moveTo = (pos: DocumentPosition) => moves.push(pos);

  h.handler.afterPageLocalEdit();
  assert.equal(events[0], 'flush');
  assert.equal(events.includes('document-page-invalidated'), false);
  assert.equal(h.handler.deferredPaginationPending, false);
  assert.equal(moves.length, 1, '새 레이아웃 기준으로 커서 좌표를 다시 잡는다');
});

test('조합 중 되돌리기·다시 실행은 조합을 먼저 확정하고 페이지네이션을 마감한 뒤 실행한다', () => {
  for (const action of ['undo', 'redo'] as const) {
    const order: string[] = [];
    const h = createHandler('XY', 1, {
      flushDeferredPaginationIfNeeded: (reason: string) => order.push(`flush:${reason}`),
      history: {
        undo: () => { order.push('undo'); return null; },
        redo: () => { order.push('redo'); return null; },
      },
    });
    const execute = h.handler.executeOperation;
    h.handler.executeOperation = (op: Operation) => { order.push(`commit:${op.command.text}`); execute(op); };

    h.handler.onCompositionStart();
    h.handler.onCompositionUpdate({ data: '가' });
    if (action === 'undo') h.handler.handleUndo();
    else h.handler.handleRedo();
    assert.deepEqual(order, ['commit:가', `flush:before-${action}`, action]);
    assert.equal(h.handler.imeSession.isComposing, false);
  }
});

test('문서 전환은 조합 중인 preedit 을 확정하지 않고 되돌린 뒤 입력 상태를 비운다', () => {
  const stub = () => {};
  const h = createHandler('XY', 1, {
    cancelPicturePreviewDrags: stub,
    caretLayoutReveal: { clear: stub },
    deferredPaginationRunner: { cancel: stub },
    deferredPaginationFlushTimer: null,
    clearPendingCharFormat: stub,
    fieldMarker: { hide: stub },
    selectionRenderer: { clear: stub },
    eventBus: { emit: stub },
    history: { clear: stub },
  });
  Object.assign(h.handler.cursor, {
    exitPictureObjectSelection: stub,
    exitTableObjectSelection: stub,
    exitCellSelectionMode: stub,
  });

  h.handler.onCompositionStart();
  h.textarea.browserSet('가');
  h.handler.onCompositionUpdate({ data: '가' });
  h.handler.deactivate();

  assert.equal(h.text(), 'XY', '교체 중인 문서에 이전 preedit 이 남으면 안 된다');
  assert.deepEqual(h.ops, []);
  assert.equal(h.handler.imeSession.isComposing, false);
  assert.equal(h.handler.compositionAnchor, null);
  assert.equal(h.handler.compositionAnchorRect, null);
  assert.equal(h.textarea.value, '');
  assert.equal(h.handler.unconsumedTextareaValue(), '');
});
