import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUndoRedoRestores, documentFingerprint, pagesFingerprint, startEditEngine } from './support/edit-history-env.ts';

// 편집 명령 클래스와 CommandHistory 의 undo/redo 를 실제 엔진에서 검증한다.
// 문서 비교는 쪽 SVG 전체와 HWPX 바이트를 합친 지문으로 한다. undo 가 글자 하나, 서식 하나,
// 문단 모양 하나라도 다르게 되돌리면 지문이 달라진다.

const env = await startEditEngine();
const { PendingEditManager } = await env.load('/src/agent/pending-edits.ts');
const { runEngineEdits } = await env.load('/src/agent/engine-edit.ts');
const { InputHandler } = await env.load('/src/engine/input-handler.ts');
test.after(() => env.close());
const C = env.command;

const body = (paragraphIndex: number, charOffset = 0) => ({ sectionIndex: 0, paragraphIndex, charOffset });

function paragraphText(wasm: any, para: number): string {
  return wasm.getTextRange(0, para, 0, wasm.getParagraphLength(0, para));
}

function documentWith(...paragraphs: string[]) {
  const wasm = env.newDocument();
  paragraphs.forEach((text, index) => {
    if (index > 0) wasm.splitParagraph(0, index - 1, wasm.getParagraphLength(0, index - 1));
    wasm.insertText(0, index, 0, text);
  });
  return { wasm, host: env.createHost(wasm) };
}

// ─── 본문 입력 ─────────────────────────────────────────────

test('이모지를 이어 친 입력은 한 undo 칸이 되고 undo 는 그 글자만 지운다', () => {
  const { wasm, host } = documentWith('앞뒤');
  const before = documentFingerprint(wasm);

  host.executeOperation({ kind: 'command', command: new C.InsertTextCommand(body(0, 1), '😀', 1_000) });
  assert.equal(host.getCursorPosition().charOffset, 2, '캐럿은 엔진 글자 단위로 한 칸 전진한다');
  host.executeOperation({ kind: 'command', command: new C.InsertTextCommand(body(0, 2), 'x', 1_100) });
  assert.equal(paragraphText(wasm, 0), '앞😀x뒤');

  assertUndoRedoRestores(host, before);
  assert.equal(paragraphText(wasm, 0), '앞😀x뒤');
});

test('서식이 다른 연속 입력은 한 undo 칸으로 합치지 않는다', () => {
  for (const [second, afterUndo] of [[{ bold: true }, '가나'], [{ italic: true }, '가a나']] as const) {
    const { wasm, host } = documentWith('가나');
    host.executeOperation({ kind: 'command', command: new C.InsertTextCommand(body(0, 1), 'a', 1_000, { bold: true }) });
    host.executeOperation({ kind: 'command', command: new C.InsertTextCommand(body(0, 2), 'b', 1_100, second) });
    host.handleUndo();
    assert.equal(paragraphText(wasm, 0), afterUndo, JSON.stringify(second));
  }
});

// ─── 머리말/꼬리말·각주 편집 ───────────────────────────────

const HF = { sectionIdx: 0, isHeader: true, applyTo: 0, previewPage: 0 };

function headerDocument(...paragraphs: string[]) {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  wasm.createHeaderFooter(0, true, 0);
  paragraphs.forEach((text, index) => {
    if (index > 0) {
      const prev = JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, index - 1));
      wasm.splitParagraphInHeaderFooter(0, true, 0, index - 1, prev.charCount);
    }
    wasm.insertTextInHeaderFooter(0, true, 0, index, 0, text);
  });
  return { wasm, host: env.createHost(wasm) };
}

function headerText(wasm: any): string[] {
  const first = JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, 0));
  return Array.from({ length: first.paraCount }, (_, index) =>
    JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, index)).text);
}

function footnoteDocument(...paragraphs: string[]) {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  const note = wasm.insertFootnote(0, 0, 2);
  paragraphs.forEach((text, index) => {
    if (index > 0) wasm.splitParagraphInFootnote(0, note.paraIdx, note.controlIdx, index - 1, [...paragraphs[index - 1]].length);
    wasm.insertTextInFootnote(0, note.paraIdx, note.controlIdx, index, 0, text);
  });
  const target = { sectionIdx: 0, paraIdx: note.paraIdx, controlIdx: note.controlIdx, footnoteIndex: 0, pageNum: 0 };
  return { wasm, host: env.createHost(wasm), note, target };
}

/**
 * 머리말/꼬리말·각주 입력은 엔진에 먼저 적용한 뒤 kind:'record' 로 기록한다.
 * 실제 입력 경로와 같은 순서로 적용·기록하고 undo/redo 왕복을 확인한다.
 */
const SUBMODE_EDITS: Array<{
  name: string;
  mode: 'headerFooter' | 'footnote';
  run: () => { host: any; before: string };
}> = [
  {
    name: '머리말 글자 입력', mode: 'headerFooter', run: () => {
      const { wasm, host } = headerDocument('머리말');
      const before = documentFingerprint(wasm);
      wasm.insertTextInHeaderFooter(0, true, 0, 0, 1, '😀가');
      host.executeOperation({ kind: 'record', command: new C.InsertTextInHeaderFooterCommand(HF, 0, 1, '😀가') });
      return { host, before };
    },
  },
  {
    name: '머리말 글자 삭제', mode: 'headerFooter', run: () => {
      const { wasm, host } = headerDocument('머😀리말');
      const before = documentFingerprint(wasm);
      wasm.deleteTextInHeaderFooter(0, true, 0, 0, 1, 2);
      host.executeOperation({ kind: 'record', command: new C.DeleteTextInHeaderFooterCommand(HF, 0, 1, '😀리', 3) });
      assert.deepEqual(headerText(wasm), ['머말']);
      return { host, before };
    },
  },
  {
    name: '머리말 문단 나누기', mode: 'headerFooter', run: () => {
      const { wasm, host } = headerDocument('머리말');
      const before = documentFingerprint(wasm);
      const result = JSON.parse(wasm.splitParagraphInHeaderFooter(0, true, 0, 0, 2));
      host.executeOperation({ kind: 'record', command: new C.SplitParagraphInHeaderFooterCommand(HF, 0, 2, result.hfParaIndex) });
      return { host, before };
    },
  },
  {
    name: '머리말 문단 합치기(사라진 문단 모양 복원)', mode: 'headerFooter', run: () => {
      const { wasm, host } = headerDocument('머리', '말');
      wasm.applyParaFormatInHf(0, true, 0, 1, JSON.stringify({ alignment: 'center' }));
      const before = documentFingerprint(wasm);
      const result = JSON.parse(wasm.mergeParagraphInHeaderFooter(0, true, 0, 1));
      host.executeOperation({
        kind: 'record',
        command: new C.MergeParagraphInHeaderFooterCommand(HF, 1, result.hfParaIndex, result.charOffset, 1, 0, result.removedParaMeta),
      });
      return { host, before };
    },
  },
  {
    name: '각주 글자 입력', mode: 'footnote', run: () => {
      const { wasm, host, note, target } = footnoteDocument('각주');
      const before = documentFingerprint(wasm);
      wasm.insertTextInFootnote(0, note.paraIdx, note.controlIdx, 0, 1, '😀가');
      host.executeOperation({ kind: 'record', command: new C.InsertTextInFootnoteCommand(target, 0, 1, '😀가') });
      return { host, before };
    },
  },
  {
    name: '각주 글자 삭제', mode: 'footnote', run: () => {
      const { wasm, host, note, target } = footnoteDocument('각😀주문');
      const before = documentFingerprint(wasm);
      wasm.deleteTextInFootnote(0, note.paraIdx, note.controlIdx, 0, 1, 2);
      host.executeOperation({ kind: 'record', command: new C.DeleteTextInFootnoteCommand(target, 0, 1, '😀주', 3) });
      return { host, before };
    },
  },
  {
    name: '각주 문단 나누기', mode: 'footnote', run: () => {
      const { wasm, host, note, target } = footnoteDocument('각주');
      const before = documentFingerprint(wasm);
      const result = wasm.splitParagraphInFootnote(0, note.paraIdx, note.controlIdx, 0, 1);
      host.executeOperation({ kind: 'record', command: new C.SplitParagraphInFootnoteCommand(target, 0, 1, result.fnParaIndex) });
      return { host, before };
    },
  },
  {
    name: '각주 문단 합치기(사라진 문단 모양 복원)', mode: 'footnote', run: () => {
      const { wasm, host, note, target } = footnoteDocument('각', '주');
      wasm.applyParaFormatInFootnote(0, note.paraIdx, note.controlIdx, 1, JSON.stringify({ alignment: 'center' }));
      const before = documentFingerprint(wasm);
      const result = wasm.mergeParagraphInFootnote(0, note.paraIdx, note.controlIdx, 1);
      host.executeOperation({
        kind: 'record',
        command: new C.MergeParagraphInFootnoteCommand(target, 1, result.fnParaIndex, result.charOffset, 1, 0, result.removedParaMeta),
      });
      return { host, before };
    },
  },
];

for (const edit of SUBMODE_EDITS) {
  test(`${edit.name}: undo/redo 가 문서를 정확히 왕복하고 커서는 편집하던 영역에 남는다`, () => {
    const { host, before } = edit.run();
    assertUndoRedoRestores(host, before);
    const inMode = () => (edit.mode === 'headerFooter' ? host.cursor.isInHeaderFooter() : host.cursor.isInFootnote());
    assert.equal(inMode(), true, 'redo 뒤 커서는 머리말/각주 편집 상태다');
    host.handleUndo();
    assert.equal(inMode(), true, 'undo 뒤 커서는 머리말/각주 편집 상태다');
  });
}

test('머리말 편집 중 본문 명령을 되돌리면 머리말을 빠져나와 본문 위치로 간다', () => {
  const { wasm, host } = headerDocument('머리말');
  host.executeOperation({ kind: 'command', command: new C.InsertTextCommand(body(0, 2), '끝') });
  host.cursor.enterHeaderFooterMode(true, 0, 0, 0);
  const before = paragraphText(wasm, 0);
  host.handleUndo();
  assert.equal(host.cursor.isInHeaderFooter(), false);
  assert.deepEqual(host.getCursorPosition(), body(0, 2));
  assert.equal(before, '본문끝');
  assert.equal(paragraphText(wasm, 0), '본문');
});

test('양식 모드에서도 이미 적용한 편집의 기록은 남고, 스냅샷 편집은 막힌다', () => {
  const { wasm, host } = headerDocument('머리말');
  host.editMode = 'form';
  const before = documentFingerprint(wasm);
  wasm.insertTextInHeaderFooter(0, true, 0, 0, 0, '가');
  host.executeOperation({ kind: 'record', command: new C.InsertTextInHeaderFooterCommand(HF, 0, 0, '가') });
  assertUndoRedoRestores(host, before);

  const afterRecord = documentFingerprint(wasm);
  let ran = false;
  host.executeOperation({
    kind: 'snapshot', operationType: 'formBlocked',
    operation: (w: any) => { ran = true; w.insertText(0, 0, 0, 'x'); return body(0, 1); },
  });
  assert.equal(ran, false);
  assert.equal(documentFingerprint(wasm), afterRecord);
});

// ─── 이력 스택의 실패 처리 ─────────────────────────────────

function fakeCommand(name: string, log: string[], fail: { undo?: boolean; redo?: boolean } = {}) {
  let executed = false;
  return {
    type: name,
    timestamp: 0,
    execute() {
      if (executed && fail.redo) throw new Error(`${name} redo failed`);
      executed = true;
      log.push(`do:${name}`);
      return body(0);
    },
    undo() {
      if (fail.undo) throw new Error(`${name} undo failed`);
      log.push(`undo:${name}`);
      return body(0);
    },
    mergeWith: () => null,
    discard() { log.push(`discard:${name}`); },
  };
}

test('되돌릴 수 없는 이력 칸은 버리고 오류를 알린 뒤 다음 undo 는 더 오래된 칸을 되돌린다', () => {
  const log: string[] = [];
  const history = new env.CommandHistory();
  history.execute(fakeCommand('first', log), {});
  history.execute(fakeCommand('broken', log, { undo: true }), {});
  assert.throws(() => history.undo({}), /broken undo failed/);
  assert.ok(log.includes('discard:broken'), '실패한 칸의 스냅샷을 해제한다');
  history.undo({});
  assert.deepEqual(log.filter((entry) => entry.startsWith('undo:')), ['undo:first']);
  history.redo({});
  assert.equal(history.canUndo(), true, '성공한 칸은 잃지 않는다');
});

test('다시 실행할 수 없는 이력 칸도 버리고 오류를 알린다', () => {
  const log: string[] = [];
  const history = new env.CommandHistory();
  history.execute(fakeCommand('first', log), {});
  history.execute(fakeCommand('broken', log, { redo: true }), {});
  history.undo({});
  history.undo({});
  history.redo({});
  assert.throws(() => history.redo({}), /broken redo failed/);
  assert.ok(log.includes('discard:broken'));
  assert.equal(history.canRedo(), false, '같은 칸을 다시 시도하며 막히지 않는다');
  assert.equal(history.canUndo(), true);
});

// ─── 스냅샷 명령과 저장소 한도 ─────────────────────────────

/** 엔진 스냅샷 id 의 할당·해제를 지켜보는 브리지. failSave 번째 저장은 실패시킨다. */
function trackSnapshots(wasm: any, failSave?: number) {
  const live = new Set<number>();
  let saves = 0;
  const bridge = new Proxy(wasm, {
    get(target, key) {
      if (key === 'saveSnapshot') {
        return () => {
          saves += 1;
          if (saves === failSave) throw new Error('snapshot allocation failed');
          const id = target.saveSnapshot();
          live.add(id);
          return id;
        };
      }
      if (key === 'shareSnapshot') {
        return (source: number) => {
          const id = target.shareSnapshot(source);
          live.add(id);
          return id;
        };
      }
      if (key === 'discardSnapshot') {
        return (id: number) => {
          live.delete(id);
          target.discardSnapshot(id);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { bridge, live, saves: () => saves };
}

function appendSnapshotEdit(host: any, text: string): void {
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'appendText',
    operation: (wasm: any) => {
      const end = wasm.getParagraphLength(0, 0);
      wasm.insertText(0, 0, end, text);
      return body(0, end + text.length);
    },
  });
}

test('스냅샷 편집이 실패하면 문서를 되돌리고 잡았던 스냅샷을 모두 놓는다', () => {
  for (const failure of ['operation', 'after-save'] as const) {
    const { wasm } = documentWith('본문');
    const { bridge, live } = trackSnapshots(wasm, failure === 'after-save' ? 2 : undefined);
    const history = new env.CommandHistory();
    const before = documentFingerprint(wasm);
    const command = new C.SnapshotCommand('paste', body(0), body(0), (w: any) => {
      w.insertText(0, 0, 0, '붙여');
      if (failure === 'operation') throw new Error('paste failed');
      return body(0, 2);
    });
    assert.throws(() => history.execute(command, bridge), failure === 'operation' ? /paste failed/ : /allocation failed/);
    assert.equal(live.size, 0, `${failure}: 스냅샷 누수`);
    assert.equal(documentFingerprint(wasm), before, `${failure}: 문서 복원`);
    assert.equal(history.canUndo(), false);
  }
});

test('스냅샷 편집을 엔진 저장소 한도보다 많이 쌓고 섞어 되돌려도 남은 undo 는 모두 성공한다', () => {
  const { wasm, host } = documentWith('');
  // 한도를 채운 뒤 몇 칸 되돌리고 새로 편집한다. 새 편집이 before/after 를 저장하는 순간에도
  // 엔진 저장소가 넘치지 않아야 가장 오래된 undo 칸의 스냅샷이 몰래 지워지지 않는다.
  for (let i = 0; i < 70; i++) appendSnapshotEdit(host, 'a');
  for (let i = 0; i < 10; i++) host.handleUndo();
  for (let i = 0; i < 3; i++) appendSnapshotEdit(host, 'b');
  let undone = 0;
  while (host.history.canUndo()) {
    host.handleUndo();
    undone += 1;
  }
  assert.ok(undone > 20, `남은 undo 수 ${undone}`);
  assert.equal(paragraphText(wasm, 0).length, 60 + 3 - undone, '한 undo 가 정확히 한 편집을 되돌린다');
});

test('이력 밖에서 잡아 둔 스냅샷도 한도 계산에 들어가 이력과 함께 살아남는다', () => {
  const { wasm, host } = documentWith('');
  host.releaseExternalSnapshot(50); // 과하게 놓아도 이후 점유가 음수로 상쇄되지 않는다
  const held = Array.from({ length: 20 }, () => wasm.saveSnapshot());
  host.retainExternalSnapshot(held.length);
  for (let i = 0; i < 120; i++) appendSnapshotEdit(host, 'a');
  while (host.history.canUndo()) host.handleUndo();
  for (const id of held) wasm.restoreSnapshot(id);
  host.releaseExternalSnapshot(held.length);
  for (const id of held) wasm.discardSnapshot(id);
});

test('연속 스냅샷 편집은 직전 결과를 다시 복제하지 않고도 각 단계를 정확히 되돌린다', () => {
  const { wasm } = documentWith('');
  const { bridge, saves } = trackSnapshots(wasm);
  const host = env.createHost(bridge);
  const states = [documentFingerprint(wasm)];
  for (const text of ['a', 'b', 'c']) {
    appendSnapshotEdit(host, text);
    states.push(documentFingerprint(wasm));
  }
  assert.equal(saves(), 4, '두 번째 편집부터는 before 상태를 공유한다');
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), states[2]);
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), states[1]);
  appendSnapshotEdit(host, 'x');
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), states[1], '되돌린 뒤의 새 편집은 되돌린 상태를 before 로 쓴다');
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), states[0]);
});

test('이력 밖 변경 뒤의 스냅샷 편집은 옛 스냅샷을 before 로 공유하지 않는다', () => {
  const { wasm, host } = documentWith('본문 [agent]');
  appendSnapshotEdit(host, ' 붙여넣음');
  // 에이전트 제안 거절처럼 이력 밖에서 문서를 바꾼다.
  wasm.deleteText(0, 0, 2, ' [agent]'.length);
  host.history.invalidateCurrentSnapshot();
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteTail',
    operation: (w: any) => {
      const length = w.getParagraphLength(0, 0);
      w.deleteText(0, 0, length - ' 붙여넣음'.length, ' 붙여넣음'.length);
      return body(0, 2);
    },
  });
  host.handleUndo();
  assert.equal(paragraphText(wasm, 0), '본문 붙여넣음', '거절한 에이전트 글자가 되살아나지 않는다');
});

/** 무엇을 부르든 받아 주는 가짜 DOM 노드 — 실제 InputHandler 생성자의 화면 배선만 흡수한다. */
function fakeDomNode(): any {
  const target = function () {} as any;
  return new Proxy(target, {
    get(t, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === 'then') return undefined;
      if (!(key in t)) t[key] = fakeDomNode();
      return t[key];
    },
    set(t, key, value) { t[key] = value; return true; },
    apply: () => fakeDomNode(),
    construct: () => fakeDomNode(),
  });
}

test('실제 InputHandler 는 이력 밖 변경 알림에만 공유 스냅샷을 버린다', () => {
  const g = globalThis as any;
  const saved = { document: g.document, requestAnimationFrame: g.requestAnimationFrame };
  g.document = fakeDomNode();
  g.requestAnimationFrame = () => 0;
  try {
    const { wasm } = documentWith('본문 [agent]');
    const { bridge, saves } = trackSnapshots(wasm);
    const eventBus = new env.EventBus();
    const handler = new InputHandler(fakeDomNode(), bridge, eventBus, fakeDomNode(), fakeDomNode());
    handler.updateCaret = () => {};
    appendSnapshotEdit(handler, ' 붙여');
    appendSnapshotEdit(handler, '넣음');
    assert.equal(saves(), 3, '이력을 거친 편집 알림은 공유를 끊지 않는다');

    // 에이전트 제안 거절처럼 이력 밖에서 문서를 바꾸고 알린다.
    wasm.deleteText(0, 0, 2, ' [agent]'.length);
    eventBus.emit('document-mutated', 'agent-pending-edit');
    handler.executeOperation({
      kind: 'snapshot',
      operationType: 'deleteTail',
      operation: (w: any) => {
        const length = w.getParagraphLength(0, 0);
        w.deleteText(0, 0, length - 2, 2);
        return body(0, 2);
      },
    });
    handler.handleUndo();
    assert.equal(paragraphText(wasm, 0), '본문 붙여넣음', '거절한 에이전트 글자가 되살아나지 않는다');
  } finally {
    g.document = saved.document;
    g.requestAnimationFrame = saved.requestAnimationFrame;
  }
});

// ─── 이력 밖에서 이미 적용한 자율 편집 ─────────────────────

test('자율 편집은 한 undo 칸으로 기록되고 실패하면 문서와 이력을 그대로 둔다', () => {
  const { wasm, host } = documentWith('본문');
  const before = documentFingerprint(wasm);
  const result = host.executeAppliedSnapshot('agentEdit', (w: any) => {
    w.insertText(0, 0, 2, ' 추가');
    return 'done';
  });
  assert.equal(result, 'done');
  assertUndoRedoRestores(host, before);

  const committed = documentFingerprint(wasm);
  assert.throws(() => host.executeAppliedSnapshot('agentEdit', (w: any) => {
    w.insertText(0, 0, 0, '실패');
    throw new Error('verification failed');
  }), /verification failed/);
  assert.equal(documentFingerprint(wasm), committed);
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), before, '실패한 편집은 이력 칸을 만들지 않는다');
});

test('자율 편집은 커밋 뒤 화면 갱신이 실패해도 성공으로 끝나 재시도로 중복되지 않는다', () => {
  const { wasm, host } = documentWith('본문');
  const before = documentFingerprint(wasm);
  host.refreshAfterOperation = () => { throw new Error('canvas lost'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(host.executeAppliedSnapshot('agentEdit', (w: any) => { w.insertText(0, 0, 0, '새 '); return 1; }), 1);
  } finally {
    console.warn = warn;
  }
  delete host.refreshAfterOperation;
  assertUndoRedoRestores(host, before);
});

test('자율 편집은 저장소가 차 있으면 기존 undo 를 밀어내지 않고 거절한다', () => {
  const { wasm, host } = documentWith('');
  for (let i = 0; i < 120; i++) appendSnapshotEdit(host, 'a');
  const before = documentFingerprint(wasm);
  const countUndo = () => {
    let steps = 0;
    while (host.history.canUndo()) { host.history.undo(wasm); steps += 1; }
    while (host.history.canRedo()) host.history.redo(wasm);
    return steps;
  };
  const steps = countUndo();
  assert.throws(() => host.executeAppliedSnapshot('agentEdit', (w: any) => w.insertText(0, 0, 0, 'x')), /full/);
  assert.equal(documentFingerprint(wasm), before);
  assert.equal(countUndo(), steps, '기존 undo 칸을 하나도 잃지 않는다');

  host.editMode = 'form';
  assert.throws(() => host.executeAppliedSnapshot('agentEdit', (w: any) => w.insertText(0, 0, 0, 'x')), /form mode/);
  assert.equal(documentFingerprint(wasm), before);
});

test('문서 내용 통째 교체는 에이전트 엔진 편집으로 부를 수 없다', () => {
  // 교체는 편집기 이력 경로(replaceContentFromBytes → executeAppliedSnapshot)로만 한다.
  const { wasm } = documentWith('본문');
  const other = documentWith('다른 문서').wasm.exportHwpx();
  const before = documentFingerprint(wasm);
  const base64 = Buffer.from(other).toString('base64');
  assert.throws(
    () => runEngineEdits(wasm, [{ method: 'replaceContentFromBytes', args: [{ $base64: base64 }] }]),
    (error: any) => error.code === 'ENGINE_EDIT_NOT_ALLOWED',
  );
  assert.equal(documentFingerprint(wasm), before);
});

// ─── 선택 삭제·글자 서식·문단 병합 ─────────────────────────

/**
 * 바깥 2x2 표의 첫 셀 첫 문단에 안쪽 2x2 표를 넣은 문서.
 * 커서의 평면 필드(controlIndex/cellIndex/cellParaIndex)는 바깥 셀을 가리키므로, 안쪽 셀
 * 편집이 평면 좌표로 새면 바깥 셀이 바뀐다.
 */
function nestedTableDocument() {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, 'A');
  wasm.splitParagraph(0, 0, 1);
  const outer = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 1, rowCount: 2, colCount: 2 });
  const source = wasm.createTableEx({
    sectionIdx: 0, paraIdx: wasm.getParagraphCount(0) - 1, charOffset: 0, rowCount: 2, colCount: 2,
  });
  wasm.copyControl(0, source.paraIdx, source.controlIdx);
  wasm.pasteInternalInCell(0, outer.paraIdx, outer.controlIdx, 0, 0, 0);
  const ppi = outer.paraIdx;
  const ci = outer.controlIdx;
  // 바깥 첫 셀에도 문단을 둬서 평면 좌표로 새면 눈에 띄게 한다.
  const outerParas = wasm.getCellParagraphCount(0, ppi, ci, 0);
  wasm.insertTextInCell(0, ppi, ci, 0, outerParas - 1, 0, '바깥셀');
  for (let cell = 1; cell < 4; cell++) wasm.insertTextInCell(0, ppi, ci, cell, 0, 0, `바깥${cell}`);
  const innerPath = (cellIndex: number, cellParaIndex = 0) => [
    { controlIndex: ci, cellIndex: 0, cellParaIndex: 0 },
    { controlIndex: 0, cellIndex, cellParaIndex },
  ];
  const innerPos = (cellIndex: number, cellParaIndex: number, charOffset: number) => ({
    sectionIndex: 0, paragraphIndex: 0, charOffset,
    parentParaIndex: ppi, controlIndex: ci, cellIndex: 0, cellParaIndex: 0,
    cellPath: innerPath(cellIndex, cellParaIndex),
  });
  const setInnerParagraphs = (cellIndex: number, texts: string[]) => {
    texts.forEach((text, index) => {
      if (index > 0) {
        const prev = JSON.stringify(innerPath(cellIndex, index - 1));
        wasm.splitParagraphInCellByPath(0, ppi, prev, wasm.getCellParagraphLengthByPath(0, ppi, prev));
      }
      wasm.insertTextInCellByPath(0, ppi, JSON.stringify(innerPath(cellIndex, index)), 0, text);
    });
  };
  const innerTexts = (cellIndex: number) => {
    const count = wasm.getCellParagraphCountByPath(0, ppi, JSON.stringify(innerPath(cellIndex, 0)));
    return Array.from({ length: count }, (_, index) => {
      const path = JSON.stringify(innerPath(cellIndex, index));
      return wasm.getTextInCellByPath(0, ppi, path, 0, wasm.getCellParagraphLengthByPath(0, ppi, path));
    });
  };
  const outerTexts = () => [0, 1, 2, 3].map((cell) => {
    const count = wasm.getCellParagraphCount(0, ppi, ci, cell);
    return Array.from({ length: count }, (_, para) =>
      wasm.getTextInCell(0, ppi, ci, cell, para, 0, wasm.getCellParagraphLength(0, ppi, ci, cell, para)));
  });
  return { wasm, host: env.createHost(wasm), ppi, ci, innerPath, innerPos, setInnerParagraphs, innerTexts, outerTexts };
}

test('여러 문단에 걸친 선택 삭제는 undo 로 문단 구조와 서식까지 그대로 돌아온다', () => {
  const { wasm, host } = documentWith('head5AAA', 'BBB', 'CCCtail7');
  wasm.applyCharFormat(0, 1, 0, 3, JSON.stringify({ bold: true }));
  wasm.applyParaFormat(0, 1, JSON.stringify({ alignment: 'center' }));
  const before = documentFingerprint(wasm);
  host.executeOperation({ kind: 'command', command: new C.DeleteSelectionCommand(body(0, 5), body(2, 3)) });
  assert.equal(wasm.getParagraphCount(0), 1);
  assert.equal(paragraphText(wasm, 0), 'head5tail7');
  assertUndoRedoRestores(host, before);
});

test('중첩 표 안쪽 셀의 여러 문단 선택 삭제는 안쪽 셀만 지우고 undo 로 돌아온다', () => {
  const t = nestedTableDocument();
  t.setInnerParagraphs(1, ['zzz', 'abc', 'def', 'ghi']);
  const outerBefore = t.outerTexts();
  const before = documentFingerprint(t.wasm);
  t.host.executeOperation({
    kind: 'command',
    command: new C.DeleteSelectionCommand(t.innerPos(1, 1, 1), t.innerPos(1, 3, 1)),
  });
  assert.deepEqual(t.innerTexts(1), ['zzz', 'ahi']);
  assert.deepEqual(t.outerTexts(), outerBefore, '바깥 표는 그대로다');
  assertUndoRedoRestores(t.host, before);
});

test('선택 삭제를 많이 반복해도 스냅샷 한도 안에서 남은 undo 가 모두 성공한다', () => {
  const { wasm, host } = documentWith('x'.repeat(80));
  for (let i = 0; i < 70; i++) {
    host.executeOperation({ kind: 'command', command: new C.DeleteSelectionCommand(body(0, 0), body(0, 1)) });
  }
  for (let i = 0; i < 5; i++) host.handleUndo();
  host.executeOperation({ kind: 'command', command: new C.DeleteSelectionCommand(body(0, 0), body(0, 1)) });
  let undone = 0;
  while (host.history.canUndo()) {
    host.handleUndo();
    undone += 1;
  }
  assert.equal(paragraphText(wasm, 0).length, 80 - 66 + undone);
});

function charRuns(wasm: any, para: number) {
  return wasm.getCharShapeRuns(0, para, 0, wasm.getParagraphLength(0, para));
}

test('글자 서식 undo/redo 는 범위 안의 글자 모양 구간을 하나하나 되살린다', () => {
  const { wasm, host } = documentWith('abcdefgh', '둘째 문단');
  wasm.applyCharFormat(0, 0, 2, 4, JSON.stringify({ bold: true }));
  wasm.applyCharFormat(0, 0, 4, 6, JSON.stringify({ underline: true }));
  const runsBefore = charRuns(wasm, 0);
  const before = pagesFingerprint(wasm);
  host.executeOperation({
    kind: 'command',
    command: new C.ApplyCharFormatCommand([
      { target: { kind: 'body', sectionIndex: 0, paragraphIndex: 0 }, startOffset: 1, endOffset: 7 },
      { target: { kind: 'body', sectionIndex: 0, paragraphIndex: 1 }, startOffset: 0, endOffset: 2 },
    ], { italic: true }, body(0, 1)),
  });
  const runsAfter = charRuns(wasm, 0);
  assertUndoRedoRestores(host, before, '', pagesFingerprint);
  assert.deepEqual(charRuns(wasm, 0), runsAfter);
  host.handleUndo();
  assert.deepEqual(charRuns(wasm, 0), runsBefore);
});

test('중첩 표 안쪽 셀 문단의 글자 서식은 그 문단에만 적용되고 undo 로 돌아온다', () => {
  const t = nestedTableDocument();
  t.setInnerParagraphs(1, ['첫 문단', '둘째 문단']);
  const innerRuns = () => {
    const path = JSON.stringify(t.innerPath(1, 1));
    return t.wasm.getCharShapeRunsInCellByPath(0, t.ppi, path, 0, t.wasm.getCellParagraphLengthByPath(0, t.ppi, path));
  };
  t.wasm.applyCharFormatInCellByPath(0, t.ppi, JSON.stringify(t.innerPath(1, 1)), 0, 2, JSON.stringify({ bold: true }));
  const runsBefore = innerRuns();
  const outerBefore = t.outerTexts();
  const before = pagesFingerprint(t.wasm);
  const target = {
    kind: 'container', sectionIndex: 0, parentParagraphIndex: t.ppi, paragraphIndex: 1,
    controlIndex: t.ci, cellIndex: 0, cellPath: t.innerPath(1, 1), isTextBox: false,
  };
  t.host.executeOperation({
    kind: 'command',
    command: new C.ApplyCharFormatCommand([{ target, startOffset: 1, endOffset: 5 }], { italic: true }, t.innerPos(1, 1, 1)),
  });
  assert.notDeepEqual(innerRuns(), runsBefore);
  assertUndoRedoRestores(t.host, before, '', pagesFingerprint);
  t.host.handleUndo();
  assert.deepEqual(innerRuns(), runsBefore);
  assert.deepEqual(t.outerTexts(), outerBefore);
});

test('문단 병합 undo 는 사라졌던 문단의 모양을 되살린다', () => {
  for (const merge of ['backspace', 'delete'] as const) {
    const { wasm, host } = documentWith('첫 문단', '가운데 문단');
    wasm.applyParaFormat(0, 1, JSON.stringify({ alignment: 'center' }));
    const before = documentFingerprint(wasm);
    const command = merge === 'backspace'
      ? new C.MergeParagraphCommand(body(1, 0))
      : new C.MergeNextParagraphCommand(body(0, wasm.getParagraphLength(0, 0)));
    host.executeOperation({ kind: 'command', command });
    assert.equal(wasm.getParagraphCount(0), 1);
    assertUndoRedoRestores(host, before, merge);
  }
});

test('중첩 표 안쪽 셀의 문단 나누기·합치기는 안쪽 셀 문단 축으로 왕복한다', () => {
  const cases = [
    { name: 'split', make: (t: any) => new C.SplitParagraphInCellCommand(t.innerPos(1, 1, 1)), expected: ['가가', '나', '나', '다다'], caret: [2, 0] },
    { name: 'merge', make: (t: any) => new C.MergeParagraphInCellCommand(t.innerPos(1, 2, 0)), expected: ['가가', '나나다다'], caret: [1, 2] },
    { name: 'mergeNext', make: (t: any) => new C.MergeNextParagraphInCellCommand(t.innerPos(1, 1, 2)), expected: ['가가', '나나다다'], caret: [1, 2] },
  ];
  for (const { name, make, expected, caret } of cases) {
    const t = nestedTableDocument();
    t.setInnerParagraphs(1, ['가가', '나나', '다다']);
    t.wasm.applyParaFormatInCellByPath(0, t.ppi, JSON.stringify(t.innerPath(1, 2)), JSON.stringify({ alignment: 'center' }));
    const outerBefore = t.outerTexts();
    const before = documentFingerprint(t.wasm);
    t.host.executeOperation({ kind: 'command', command: make(t) });
    assert.deepEqual(t.innerTexts(1), expected, name);
    const position = t.host.getCursorPosition();
    assert.deepEqual([position.cellPath.at(-1).cellParaIndex, position.charOffset], caret, `${name}: 캐럿은 안쪽 셀 문단에 있다`);
    assert.deepEqual(t.outerTexts(), outerBefore, `${name}: 바깥 표는 그대로다`);
    assertUndoRedoRestores(t.host, before, name);
  }
});

test('표 이동 undo 는 엔진이 알려 준 실제 문단으로 커서를 돌려보낸다', () => {
  // 글자처럼 취급하는 표는 이동하면서 문단을 건너가고, 되돌릴 때 원래 문단이 아닐 수 있다.
  const moves: number[][] = [];
  const wasm = {
    moveTableOffset: (_sec: number, ppi: number, _ci: number, _dh: number, dv: number) => {
      moves.push([ppi, dv]);
      return dv > 0 ? { ok: true, ppi: ppi + 2, ci: 0 } : { ok: true, ppi: ppi - 3, ci: 1 };
    },
  };
  const command = new C.MoveTableCommand(0, 5, 0, 0, 3000, 5, 0);
  assert.equal(command.execute(wasm).paragraphIndex, 7);
  assert.equal(command.undo(wasm).paragraphIndex, 4);
  assert.equal(command.execute(wasm).paragraphIndex, 6);
  assert.deepEqual(moves, [[5, 3000], [7, -3000], [4, 3000]]);
});

// ─── undo/redo 뒤 화면 상태 정리 ───────────────────────────

test('undo/redo 는 살아 있는 IME 조합을 먼저 확정하고, 조합이 없으면 건드리지 않는다', () => {
  for (const composing of [true, false]) {
    for (const action of ['handleUndo', 'handleRedo'] as const) {
      const { host } = documentWith('본문');
      appendSnapshotEdit(host, '1');
      if (action === 'handleRedo') host.handleUndo();
      const order: string[] = [];
      if (composing) host.imeSession.start();
      host.finalizeCompositionBeforeCursorMove = () => { order.push('finalize'); host.imeSession.reset(); };
      const history = host.history;
      const undo = history.undo.bind(history);
      const redo = history.redo.bind(history);
      history.undo = (w: any) => { order.push('history'); return undo(w); };
      history.redo = (w: any) => { order.push('history'); return redo(w); };
      host[action]();
      assert.deepEqual(order, composing ? ['finalize', 'history'] : ['history'], `${action} composing=${composing}`);
    }
  }
});

test('undo/redo 는 옛 문서를 가리키는 선택·개체 선택·표 크기 캐시를 비우고 history-jumped 를 알린다', () => {
  for (const action of ['handleUndo', 'handleRedo'] as const) {
    for (const selected of ['picture', 'table'] as const) {
      const label = `${action} ${selected}`;
      const { wasm, host } = documentWith('첫 문단 글자', '둘째 문단');
      const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 1, charOffset: 0, rowCount: 2, colCount: 2 });
      appendSnapshotEdit(host, ' 추가');
      if (action === 'handleRedo') host.handleUndo();

      host.cursor.moveTo(body(0, 1));
      host.cursor.setAnchor();
      host.cursor.moveTo(body(0, 4));
      host.cursor.enterBlockSelectionMode();
      if (selected === 'table') host.cursor.enterTableObjectSelectionDirect(0, table.paraIdx, table.controlIdx);
      else host.cursor.enterPictureObjectSelectionRef({ sec: 0, ppi: table.paraIdx, ci: table.controlIdx, type: 'shape' });
      host.cachedTableRef = { sec: 0, ppi: table.paraIdx, ci: table.controlIdx };
      host.cachedCellBboxes = [{ cellIdx: 0 }];
      host.tableBboxFetchFailures.add('stale');
      const events: unknown[][] = [];
      for (const name of ['history-jumped', 'picture-object-selection-changed', 'table-object-selection-changed']) {
        host.eventBus.on(name, (...args: unknown[]) => events.push([name, ...args]));
      }

      host[action]();
      assert.equal(host.cursor.hasSelection(), false, label);
      assert.equal(host.cursor.isInBlockSelectionMode(), false, label);
      assert.equal(host.cursor.isInPictureObjectSelection(), false, label);
      assert.equal(host.cursor.isInTableObjectSelection(), false, label);
      assert.equal(host.cachedTableRef, null, label);
      assert.equal(host.cachedCellBboxes, null, label);
      assert.equal(host.tableBboxFetchFailures.size, 0, label);
      assert.deepEqual(events, [[`${selected}-object-selection-changed`, false], ['history-jumped']], label);
    }
  }
});

test('undo 는 표 셀 블록 선택도 해제한다', () => {
  const { wasm, host } = documentWith('본문');
  const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 2, colCount: 2 });
  appendSnapshotEdit(host, ' 추가');
  host.cursor.moveTo({
    sectionIndex: 0, paragraphIndex: 0, charOffset: 0,
    parentParaIndex: table.paraIdx, controlIndex: table.controlIdx, cellIndex: 0, cellParaIndex: 0,
  });
  assert.equal(host.cursor.enterCellSelectionMode(), true);
  let cleared = 0;
  host.cellSelectionRenderer = { clear: () => { cleared += 1; } };
  host.handleUndo();
  assert.equal(host.cursor.isInCellSelectionMode(), false);
  assert.equal(cleared, 1, '셀 하이라이트도 지운다');
});

test('편집 뒤에도 표 크기 캐시를 비워 구조가 바뀐 표의 옛 셀 경계를 쓰지 않는다', () => {
  const { wasm, host } = documentWith('본문');
  const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 3, colCount: 2 });
  host.cachedTableRef = { sec: 0, ppi: table.paraIdx, ci: table.controlIdx };
  host.cachedCellBboxes = [{ cellIdx: 5 }];
  host.tableBboxFetchFailures.add('stale');
  host.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteTableRow',
    operation: (w: any) => { w.deleteTableRow(0, table.paraIdx, table.controlIdx, 0); return body(0); },
  });
  assert.equal(host.cachedTableRef, null);
  assert.equal(host.cachedCellBboxes, null);
  assert.equal(host.tableBboxFetchFailures.size, 0);
});

// ─── 에이전트 제안 승인·거절 ───────────────────────────────

function agentReview(host: any) {
  const manager = new PendingEditManager({
    wasm: host.wasm,
    eventBus: host.eventBus,
    inputHandler: host,
    canvasView: {},
    overlay: { setOps() {}, clear() {} },
  });
  manager.beginTurn('claude');
  return manager;
}

test('스냅샷 저장소가 찬 상태에서 승인해도 승인 칸과 남은 undo 가 모두 되돌아간다', () => {
  const { wasm, host } = documentWith('본문');
  // 이력보다 먼저 잡아 둔 이력 밖 스냅샷(검토 중인 다른 제안의 되돌림 기준 등)도 살아남아야 한다.
  const held = [wasm.saveSnapshot(), wasm.saveSnapshot()];
  host.retainExternalSnapshot(held.length);
  for (let i = 0; i < 120; i++) appendSnapshotEdit(host, 'a');
  const beforeAgent = paragraphText(wasm, 0);
  const manager = agentReview(host);
  for (let round = 0; round < 3; round++) {
    const { changeSetId } = manager.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, `제안${round} `);
    assert.equal(manager.approve(changeSetId), true);
  }
  const approved = paragraphText(wasm, 0);
  assert.equal(approved, `제안2 제안1 제안0 ${beforeAgent}`);
  host.handleUndo();
  assert.equal(paragraphText(wasm, 0), `제안1 제안0 ${beforeAgent}`);
  host.handleRedo();
  assert.equal(paragraphText(wasm, 0), approved);
  let undone = 0;
  while (host.history.canUndo()) {
    host.handleUndo();
    undone += 1;
  }
  assert.equal(paragraphText(wasm, 0), `본문${'a'.repeat(120 + 3 - undone)}`);
  for (const id of held) {
    wasm.restoreSnapshot(id);
    assert.equal(paragraphText(wasm, 0), '본문');
  }
  manager.dispose();
});

function applyTemplate(manager: any, wasm: any) {
  return manager.addTemplateMutation('claude', '양식 적용', 1, () => {
    wasm.applyParaFormat(0, 0, JSON.stringify({ alignment: 'center' }));
    wasm.splitParagraph(0, 0, 1);
    wasm.insertText(0, 1, 0, '양식 문단 ');
    return { affectedSections: [0] };
  });
}

test('양식 전송 거절은 전송 전 문서를 그대로 되살리고 편집 잠금을 한 번씩만 바꾼다', () => {
  const { wasm, host } = documentWith('본문', '둘째');
  const locks: unknown[] = [];
  host.eventBus.on('agent-template-lock-changed', (locked: unknown) => locks.push(locked));
  const before = documentFingerprint(wasm);
  const manager = agentReview(host);
  const { changeSetId } = applyTemplate(manager, wasm);
  applyTemplate(manager, wasm);
  assert.notEqual(documentFingerprint(wasm), before);
  // 검토 중 사용자 편집 신호가 와도 양식 미리보기는 되돌릴 대상으로 남는다.
  host.eventBus.emit('document-mutated', 'input-handler-edit');
  manager.reject(changeSetId);
  assert.equal(documentFingerprint(wasm), before);
  assert.deepEqual(locks, [true, false]);
  manager.dispose();
});

test('양식 전송 승인은 한 undo 칸이 되고, 실패한 전송은 문서를 되돌린다', () => {
  const { wasm, host } = documentWith('본문', '둘째');
  const before = documentFingerprint(wasm);
  const manager = agentReview(host);
  const { changeSetId } = applyTemplate(manager, wasm);
  const templated = documentFingerprint(wasm);
  assert.equal(manager.approve(changeSetId), true);
  assert.equal(documentFingerprint(wasm), templated);
  assertUndoRedoRestores(host, before);

  assert.throws(() => manager.addTemplateMutation('claude', '실패', 2, () => {
    wasm.insertText(0, 0, 0, '깨진 ');
    throw new Error('transfer failed');
  }), /transfer failed/);
  assert.equal(documentFingerprint(wasm), templated);
  assert.equal(manager.hasPending(), false);
  manager.dispose();
});

test('검토 중인 글자 제안이 있으면 양식 전송을 시작하지 않는다', () => {
  const { wasm, host } = documentWith('본문');
  const manager = agentReview(host);
  manager.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, '제안 ');
  const staged = documentFingerprint(wasm);
  assert.throws(() => applyTemplate(manager, wasm), (error: any) => error.code === 'TEMPLATE_PENDING_CONFLICT');
  assert.equal(documentFingerprint(wasm), staged);
  manager.dispose();
});
