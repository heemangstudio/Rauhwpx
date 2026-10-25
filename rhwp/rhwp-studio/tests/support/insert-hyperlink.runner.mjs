// 실제 HeemangEngine(hm-wasm) + WasmBridge + PendingEditManager + AgentToolExecutor — insert_hyperlink 가
// 글자·링크·출처 각주를 한 변경으로 스테이징하고, 거절하면 문서가 그대로 돌아오며, 승인한 결과가
// HWP·HWPX 저장 뒤 다시 열어도 링크 주소·표시 글자·각주로 남는지 본다.
import assert from 'node:assert/strict';
import { startEditEngine } from './edit-history-env.ts';

const engine = await startEditEngine();
const { EventBus } = await engine.load('/src/core/event-bus.ts');
const { PendingEditManager } = await engine.load('/src/agent/pending-edits.ts');
const { AgentToolExecutor } = await engine.load('/src/agent/tool-executor.ts');
const { RevisionTracker } = await engine.load('/src/agent/revision.ts');

const BODY = '앞 문장입니다. 뒤 문장입니다.';
const target = { section: 0, para: 0, cellPath: [] };

function makeEnv() {
  const wasm = engine.newDocument();
  wasm.insertText(0, 0, 0, BODY);
  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const recorded = [];
  const editor = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    executeOperation: (op) => {
      if (op.kind === 'record') recorded.push(op.command);
      op.operation?.(wasm);
    },
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  };
  const pending = new PendingEditManager({ wasm, eventBus: bus, editor, overlay: { setOps: () => {}, clear: () => {} } });
  const executor = new AgentToolExecutor({ wasm, editor, documentState: { isDirty: () => false }, revision, pending });
  const call = (tool, args) => executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude');
  return { wasm, pending, recorded, call };
}

const footnotes = (d) => {
  const texts = [];
  for (let ci = 0; ci < 8; ci++) {
    try {
      const info = d.getFootnoteInfo(0, 0, ci);
      if (info.ok) texts.push(info.texts.join('').trim());
    } catch { /* 각주가 아닌 컨트롤 */ }
  }
  return texts;
};
const state = (d) => {
  const context = d.getHyperlinkContext(target);
  return {
    text: context.text,
    links: context.links.map(({ start, end, text, uri }) => ({ start, end, text, uri })),
    footnotes: footnotes(d),
  };
};
const reopen = (d, exporter) => engine.openDocument(d[exporter](), exporter === 'exportHwp' ? 'saved.hwp' : 'saved.hwpx');
async function rejects(promise, code, pattern) {
  await assert.rejects(promise, (e) => e?.code === code && (!pattern || pattern.test(e.message)), `${code} ${pattern ?? ''}`);
}

const QUOTE = '“세계는 넓고 할 일은 많다”라고 적었다.';
const URL_A = 'https://example.com/article?id=7#p2';
const NOTE = '출처: 세계 이야기, 예시 신문, 2026-10-01, https://example.com/article?id=7';
const insertArgs = { sectionIdx: 0, paraIdx: 0, charOffset: 8, url: URL_A, text: QUOTE, linkText: '세계는 넓고 할 일은 많다', footnote: NOTE };
const expected = {
  text: `앞 문장입니다.${QUOTE} 뒤 문장입니다.`,
  links: [{ start: 9, end: 23, text: '세계는 넓고 할 일은 많다', uri: URL_A }],
  footnotes: [NOTE],
};

// ── 거절: 글자·링크·각주가 함께 사라진다 ──────────────────────────────
{
  const h = makeEnv();
  const before = state(h.wasm);
  const r = await h.call('insert_hyperlink', insertArgs);
  assert.deepEqual(r.link, { fieldId: r.link.fieldId, start: 9, end: 23 });
  assert.equal(r.footnote.number, 1);
  assert.deepEqual(state(h.wasm), expected, '미리보기 = 승인 결과');
  const [set] = h.pending.getChangeSets();
  assert.equal(set.ops.length, 1, '변경 하나');
  assert.match(set.ops[0].obj.label, /^하이퍼링크 · 세계는 넓고 할 일은 많다 · 출처 각주$/);
  h.pending.reject(r.changeSetId);
  assert.deepEqual(state(h.wasm), before, '거절');
}

// ── 승인: 실행 취소 한 번에 묶이고, HWP·HWPX 로 저장해 다시 열어도 남는다 ─────────
{
  const h = makeEnv();
  const before = state(h.wasm);
  const r = await h.call('insert_hyperlink', insertArgs);
  assert.equal(h.pending.approve(r.changeSetId), true);
  assert.deepEqual(state(h.wasm), expected);
  assert.equal(h.recorded.length, 1);
  h.recorded[0].undo(h.wasm);
  assert.deepEqual(state(h.wasm), before, '승인 후 undo');
  h.recorded[0].execute(h.wasm);
  assert.deepEqual(state(h.wasm), expected, 'redo');
  for (const exporter of ['exportHwp', 'exportHwpx']) {
    const reopened = reopen(h.wasm, exporter);
    assert.deepEqual(state(reopened), expected, `${exporter} 후 다시 열기`);
  }

  // 같은 문단에 두 번째 인용을 이어 단다 (각주가 이미 든 문단).
  const second = await h.call('insert_hyperlink', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, length: 1, url: 'http://example.org/', footnote: '출처: 두 번째',
  });
  assert.equal(second.footnote.number, 1, '앞쪽 각주가 1번이 된다');
  assert.equal(h.pending.approve(second.changeSetId), true);
  const both = {
    text: expected.text,
    links: [{ start: 0, end: 1, text: '앞', uri: 'http://example.org/' }, ...expected.links],
    footnotes: ['출처: 두 번째', NOTE],
  };
  assert.deepEqual(state(h.wasm), both);
  for (const exporter of ['exportHwp', 'exportHwpx']) {
    assert.deepEqual(state(reopen(h.wasm, exporter)), both, `두 인용 ${exporter}`);
  }

  // 각주가 따로 든 자리(35)를 감싸는 범위는 엔진이 거절하고 배치는 되돌아간다.
  const note = await h.call('insert_footnote', { sectionIdx: 0, paraIdx: 0, charOffset: 35, text: '따로 단 각주' });
  assert.equal(h.pending.approve(note.changeSetId), true);
  // 잘못된 인자는 문서를 건드리지 않는다.
  const snapshot = JSON.stringify(state(h.wasm));
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 0, length: 1, url: 'javascript:alert(1)' }), 'INVALID_ARGS', /http/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 0, length: 1, url: 'file:///etc/passwd' }), 'INVALID_ARGS', /http/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '두\n줄', url: URL_A }), 'INVALID_ARGS', /one non-empty line/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '가', url: URL_A, footnote: '두\n줄' }), 'INVALID_ARGS', /single paragraph/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '가나', linkText: '다', url: URL_A }), 'INVALID_ARGS', /linkText/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 10, length: 3, url: URL_A }), 'INVALID_ARGS', /overlaps existing hyperlink/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 12, text: '끼움', url: URL_A }), 'INVALID_ARGS', /overlaps existing hyperlink/);
  await rejects(h.call('insert_hyperlink', { sectionIdx: 0, paraIdx: 0, charOffset: 34, length: 3, url: URL_A }), 'HYPERLINK_FAILED', /각주/);
  assert.equal(JSON.stringify(state(h.wasm)), snapshot);
  assert.equal(h.pending.getChangeSets().filter((set) => set.status === 'open' && set.ops.length > 0).length, 0);
}

// ── 전체 모드: 도구 호출 하나가 바로 확정되어 실행 취소 한 단계가 된다 ──────────
{
  const h = makeEnv();
  const before = state(h.wasm);
  h.pending.setDirectApply(true);
  await h.call('insert_hyperlink', insertArgs);
  assert.equal(h.pending.commitOpen(), true);
  assert.deepEqual(state(h.wasm), expected);
  assert.equal(h.recorded.length, 1);
  h.recorded[0].undo(h.wasm);
  assert.deepEqual(state(h.wasm), before, '전체 모드 undo');
}

// ── 인용 근거 그림: insert_image caption 이 "그림 N" 캡션으로 들어가고 저장 왕복에도 남는다 ─────
{
  const h = makeEnv();
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const CAPTION = '출처: 세계 이야기, 예시 신문, https://example.com/article?id=7';
  const before = state(h.wasm);
  const imageArgs = { sectionIdx: 0, paraIdx: 0, charOffset: 8, imageBase64: PNG, extension: 'png', naturalWidthPx: 1, naturalHeightPx: 1, widthMm: 30, caption: CAPTION };
  await rejects(h.call('insert_image', { ...imageArgs, caption: '두\n줄' }), 'INVALID_ARGS', /caption/);
  const captionOf = (d, controlIdx) => {
    const len = d.getCellParagraphLength(0, 0, controlIdx, 0, 0);
    return { text: d.getTextInCell(0, 0, controlIdx, 0, 0, 0, len), hasCaption: d.getPictureProperties(0, 0, controlIdx).hasCaption };
  };
  const rejected = await h.call('insert_image', imageArgs);
  assert.match(captionOf(h.wasm, rejected.image.controlIdx).text, /^그림 +출처: 세계 이야기/);
  h.pending.reject(rejected.changeSetId);
  assert.deepEqual(state(h.wasm), before);
  assert.throws(() => h.wasm.getPictureProperties(0, 0, rejected.image.controlIdx));
  const r = await h.call('insert_image', imageArgs);
  assert.equal(h.pending.approve(r.changeSetId), true);
  const expectedCaption = captionOf(h.wasm, r.image.controlIdx);
  assert.equal(expectedCaption.hasCaption, true);
  assert.ok(expectedCaption.text.endsWith(CAPTION));
  for (const exporter of ['exportHwp', 'exportHwpx']) {
    assert.deepEqual(captionOf(reopen(h.wasm, exporter), r.image.controlIdx), expectedCaption, `캡션 ${exporter}`);
  }
}

console.log('INSERT_HYPERLINK_OK');
