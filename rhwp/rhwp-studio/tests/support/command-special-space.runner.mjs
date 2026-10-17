import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

// @/ 별칭 + 확장자 없는 상대 import 를 .ts 로 해석(tsconfig paths 재현).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@wasm/rhwp.js') {
      return { url: 'data:text/javascript,export class HwpDocument{};export function version(){return "test"};export default async function init(){}', shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const abs = join(srcDir, specifier.slice(2));
      const withTs = abs.endsWith('.ts') ? abs : abs + '.ts';
      return { url: pathToFileURL(withTs).href, shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[tj]s$/.test(specifier)) {
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : srcDir;
      return { url: pathToFileURL(join(parent, specifier + '.ts')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { DeleteTextCommand, DeleteTextInHeaderFooterCommand, DeleteTextInFootnoteCommand } = await import(pathToFileURL(join(srcDir, 'engine', 'command.ts')).href);
const { WasmBridge } = await import(pathToFileURL(join(srcDir, 'core', 'wasm-bridge.ts')).href);
const nb = { text: '\u00a0', specialSpaceOrigins: [{ charIndex: 0, origin: 'NbSpace' }] };
const fw = { text: '\u2007', specialSpaceOrigins: [{ charIndex: 0, origin: 'FwSpace' }] };
const bodyPos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
function mock(initial) {
  let state = structuredClone(initial);
  const calls = [];
  const remove = (offset, count) => {
    const chars = [...state.text]; const start = Math.min(offset, chars.length); const end = Math.min(start + count, chars.length);
    const removedContent = { text: chars.slice(start, end).join(''), specialSpaceOrigins: state.specialSpaceOrigins.filter(r => r.charIndex >= start && r.charIndex < end).map(r => ({ ...r, charIndex: r.charIndex - start })) };
    state.text = chars.slice(0, start).concat(chars.slice(end)).join('');
    state.specialSpaceOrigins = state.specialSpaceOrigins.filter(r => r.charIndex < start || r.charIndex >= end).map(r => ({ ...r, charIndex: r.charIndex >= end ? r.charIndex - (end - start) : r.charIndex }));
    return { ok: true, charOffset: start, removedStart: start, removedCount: end - start, removedContent };
  };
  const insert = (offset, content) => {
    calls.push(structuredClone(content)); const chars = [...state.text]; const at = Math.min(offset, chars.length); const n = [...content.text].length;
    state.text = chars.slice(0, at).join('') + content.text + chars.slice(at).join('');
    state.specialSpaceOrigins = state.specialSpaceOrigins.map(r => ({ ...r, charIndex: r.charIndex >= at ? r.charIndex + n : r.charIndex })).concat((content.specialSpaceOrigins ?? []).map(r => ({ ...r, charIndex: r.charIndex + at }))).sort((a, b) => a.charIndex - b.charIndex);
    return JSON.stringify({ ok: true, charOffset: at + n });
  };
  const wasm = {
    getTextRange: (_s, _p, at, n) => [...state.text].slice(at, at + n).join(''),
    replaceBodyTextLocal: (_s, _p, at, n, text, logical) => { assert.equal(logical, true); assert.equal(text, ''); return { ...remove(at, n), documentPaginationPending: true, flowChanged: false }; },
    deleteText: (_s, _p, at, n, logical) => { assert.equal(logical, true); return JSON.stringify(remove(at, n)); },
    insertTextContent: (_s, _p, at, content, logical) => { assert.equal(logical, true); return insert(at, content); },
    textToLogicalOffset: (_s, _p, at) => at,
  };
  return { wasm, calls, state: () => state, remove, insert };
}
// 실제 삭제 payload가 생성자에 주어진 텍스트보다 우선한다. undo/redo는 출처를 보존한다.
{
  const m = mock({ text: '😀\u00a0\u2007', specialSpaceOrigins: [{ charIndex: 1, origin: 'NbSpace' }, { charIndex: 2, origin: 'FwSpace' }] });
  const before = structuredClone(m.state()); const cmd = new DeleteTextCommand(bodyPos, 3, 'forward', '구형 부정확 텍스트');
  cmd.execute(m.wasm); assert.equal(m.state().text, ''); assert.equal(cmd.undo(m.wasm).charOffset, 3); assert.deepEqual(m.state(), before);
  cmd.execute(m.wasm); cmd.undo(m.wasm); assert.deepEqual(m.state(), before);
}
// Forward Delete와 Backspace의 병합은 원래 순서와 로컬 origin 위치를 보존한다.
for (const direction of ['forward', 'backward']) {
  const m = mock({ text: '\u00a0\u2007', specialSpaceOrigins: [{ charIndex: 0, origin: 'NbSpace' }, { charIndex: 1, origin: 'FwSpace' }] });
  const first = new DeleteTextCommand({ ...bodyPos, charOffset: direction === 'forward' ? 0 : 1 }, 1, direction, undefined, 100);
  first.execute(m.wasm); const second = new DeleteTextCommand(bodyPos, 1, direction, undefined, 110); second.execute(m.wasm);
  const combined = first.mergeWith(second); assert.ok(combined); combined.undo(m.wasm);
  assert.deepEqual(m.state(), { text: '\u00a0\u2007', specialSpaceOrigins: [{ charIndex: 0, origin: 'NbSpace' }, { charIndex: 1, origin: 'FwSpace' }] });
}
// Flat deferred 및 nested path 결과도 rich inverse로 복원한다.
for (const nested of [false, true]) {
  const pos = { ...bodyPos, parentParaIndex: 2, controlIndex: 0, cellIndex: 0, cellParaIndex: 0, ...(nested ? { cellPath: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }, { controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }] } : {}) };
  const m = mock(nb);
  m.wasm.getTextInCell = m.wasm.getTextInCellByPath = () => m.state().text;
  m.wasm.deleteTextInCellDeferredPagination = () => ({ ...m.remove(0, 1), paginationDeferred: true, cellFlowChanged: false });
  m.wasm.deleteTextInCellByPath = () => JSON.stringify(m.remove(0, 1));
  m.wasm.insertTextContentInCell = (_s, _p, _c, _ci, _cp, at, c, logical) => { assert.equal(logical, true); return m.insert(at, c); };
  m.wasm.insertTextContentInCellByPath = (_s, _p, path, at, c, logical) => { assert.equal(JSON.parse(path).length, 2); assert.equal(logical, true); return m.insert(at, c); };
  m.wasm.textToLogicalOffsetInCellByPath = (_s, _p, path, at) => { assert.equal(JSON.parse(path).length, nested ? 2 : 1); return at; };
  const cmd = new DeleteTextCommand(pos, 1, 'forward'); cmd.execute(m.wasm); cmd.undo(m.wasm); assert.deepEqual(m.state(), nb);
}
// HF/FN은 native가 반환한 실제 삭제 콘텐츠와 클램핑된 시작을 쓴다.
{
  let hfRestored; const wasm = { deleteTextInHeaderFooter: () => JSON.stringify({ ok: true, removedStart: 1, removedCount: 1, removedContent: nb }), insertTextContentInHeaderFooter: (...a) => { assert.equal(a[4], 1); hfRestored = a[5]; } };
  const cmd = new DeleteTextInHeaderFooterCommand({ sectionIdx: 0, isHeader: true, applyTo: 0 }, 0, 99, '잘못된 텍스트', 2); cmd.execute(wasm); cmd.undo(wasm); assert.deepEqual(hfRestored, nb);
  let fnRestored; const fn = { deleteTextInFootnote: () => ({ ok: true, removedStart: 1, removedCount: 1, removedContent: fw }), insertTextContentInFootnote: (...a) => { assert.equal(a[4], 1); fnRestored = a[5]; } };
  const note = new DeleteTextInFootnoteCommand({ sectionIdx: 0, paraIdx: 0, controlIdx: 0 }, 0, 99, '잘못된 텍스트', 2); note.execute(fn); note.undo(fn); assert.deepEqual(fnRestored, fw);
}
// Bridge 구형 API fallback는 후속 insert 응답으로 delete payload를 덮지 않는다.
{
  const bridge = Object.create(WasmBridge.prototype);
  const removal = { ok: true, charOffset: 1, removedStart: 1, removedCount: 1, removedContent: nb };
  // Flat native insert는 replace(0)의 실제 결과처럼 빈 removedContent도 반환한다.
  const insertOnly = { ok: true, charOffset: 2, cellFlowChanged: false, removedStart: 1, removedCount: 0, removedContent: { text: '', specialSpaceOrigins: [] } };
  bridge.doc = { deleteText: () => JSON.stringify(removal), insertText: () => '{"ok":true,"charOffset":2}', deleteTextInCell: () => JSON.stringify(removal), insertTextInCell: () => JSON.stringify(insertOnly) };
  assert.deepEqual(bridge.replaceBodyTextLocal(0, 0, 1, 1, 'X', true).removedContent, nb);
  const fallback = bridge.replaceTextInCellDeferredPagination(0, 0, 0, 0, 0, 1, 1, 'X', true);
  assert.equal(fallback.removedStart, 1); assert.equal(fallback.removedCount, 1); assert.deepEqual(fallback.removedContent, nb);
  assert.equal(fallback.charOffset, 2); assert.equal(fallback.paginationDeferred, false); assert.equal(fallback.cellFlowChanged, false);
  bridge.doc.replaceTextInCellDeferredPagination = () => JSON.stringify({ ...removal, charOffset: 2, cellFlowChanged: true });
  const direct = bridge.replaceTextInCellDeferredPagination(0, 0, 0, 0, 0, 1, 1, 'X', true);
  assert.deepEqual(direct.removedContent, nb); assert.equal(direct.paginationDeferred, true); assert.equal(direct.cellFlowChanged, true);
  let mutations = 0; bridge.doc.insertTextContent = () => { mutations++; };
  assert.throws(() => bridge.insertTextContent(0, 0, 0, { text: '\u00a0', specialSpaceOrigins: [{ charIndex: 0, origin: 'FwSpace' }] }));
  assert.equal(mutations, 0);
}
console.log('SPECIAL_SPACE_COMMAND_BEHAVIOUR_OK');
