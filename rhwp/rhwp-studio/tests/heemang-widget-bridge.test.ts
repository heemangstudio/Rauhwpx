import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('?url')) return { url: `data:text/javascript,export default ${JSON.stringify(specifier)}`, shortCircuit: true };
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') && url.includes('/src/core/hm/')) return {
      format: 'module', shortCircuit: true,
      source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts', target: 'es2022' }).code,
    };
    return next(url, context);
  },
});
initSync({ module: readFileSync(new URL('../vendor/hm-wasm/hm_wasm_bg.wasm', import.meta.url)) });
const { HmCore } = await import('../src/core/hm/core.ts');
const { api } = await import('../src/core/hm/api.ts');
await import('../src/core/hm/extensions.ts');

function open(t: test.TestContext, fixture = '../src/core/hm/blank.hwpx') {
  const engine = new Engine();
  const doc = engine.open(readFileSync(new URL(fixture, import.meta.url)));
  const adapter = {
    documentInstance: 1, hmDoc: () => doc, hmEngine: () => engine,
    hasLoadedDocument: () => true, applyReceipt: () => {}, refreshLayout: () => {}, getSectionCount: () => 1,
  } as unknown as HeemangAdapter;
  t.after(() => { doc.free(); engine.free(); });
  return { core: new HmCore(adapter), doc, engine };
}

test('widget format changes preserve exact shape runs across undo, clipboard paste and serialization', t => {
  const { core, doc, engine } = open(t);
  api.insertText(core, 0, 0, 0, 'Alpha Beta', false);
  const original = api.getCharShapeRuns(core, 0, 0, 0, 10);
  api.applyCharFormat(core, 0, 0, 0, 5, JSON.stringify({ bold: true, fontSize: 1800 }));
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 2).bold, true);
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 2).fontSize, 1800);
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 8).bold, false);
  api.copySelection(core, 0, 0, 0, 0, 5);
  assert.equal(api.getClipboardText(core), 'Alpha');
  const pasted = JSON.parse(api.pasteInternal(core, 0, 0, 10));
  assert.equal(pasted.charOffset, 15);
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 12).bold, true);
  core.mutate(value => value.undo());
  assert.equal(core.paragraph({ section: 0, steps: [] }, 0).text, 'Alpha Beta');
  api.setCharShapeRuns(core, 0, 0, 0, 10, original);
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 2).bold, false);
  api.applyCharFormat(core, 0, 0, 0, 5, JSON.stringify({ bold: true, fontSize: 1800 }));
  const reopened = engine.open(doc.serialize(false));
  try {
    const value = JSON.parse(reopened.query(JSON.stringify({ kind: 'formatContext', at: { section: 0, para: 0, offset: core.paragraph({ section: 0, steps: [] }, 0).caret[0] + 2 } })));
    assert.equal(value.characters.bold, true);
    assert.equal(value.characters.size, 1800);
  } finally { reopened.free(); }
});

test('format snapshots follow edits, undo, redo and document replacement without exposing shared values', t => {
  const { core, engine } = open(t);
  api.insertText(core, 0, 0, 0, 'one');
  const original = api.getParaPropertiesAt(core, 0, 0).indent;
  api.applyParaFormat(core, 0, 0, JSON.stringify({ indent: 1500 }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, 10);
  const props = api.getParaPropertiesAt(core, 0, 0);
  props.indent = 999;
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, 10);
  core.mutate(doc => doc.undo());
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, original);
  core.mutate(doc => doc.redo());
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, 10);
  const runs = api.getCharShapeRuns(core, 0, 0, 0, 3);
  const expected = structuredClone(runs);
  runs[0].charShapeId = 999;
  assert.deepEqual(api.getCharShapeRuns(core, 0, 0, 0, 3), expected);
  assert.throws(() => core.transact([
    { op: 'formatParas', from: { section: 0, para: 0, offset: 0 }, to: { section: 0, para: 0, offset: 3 }, patch: { indent: 3000 } },
    { op: 'insertText', at: { section: 99, para: 0, offset: 0 }, text: 'bad' },
  ]));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, 10);
  const replacement = engine.open(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)));
  try {
    core.adapter.hmDoc = () => replacement;
    core.adapter.documentInstance += 1;
    core.noteDocumentReplaced();
    assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, original);
  } finally { replacement.free(); }
});

test('find includes the starting word, wraps, and replace-all is one undo step', t => {
  const { core, doc } = open(t);
  api.insertText(core, 0, 0, 0, 'alpha alpha\tALPHA', false);
  const found = api.searchText(core, 'alpha', 0, 0, 0, true, false, []);
  assert.equal(found.charOffset, 0);
  assert.equal(found.wrapped, false);
  assert.equal(api.searchText(core, 'alpha', 0, 0, 17, true, false, []).wrapped, true);
  const before = core.state().undo;
  assert.equal(api.replaceAll(core, 'alpha', '한글', false).count, 3);
  assert.equal(core.paragraph({ section: 0, steps: [] }, 0).text, '한글 한글\t한글');
  assert.equal(core.state().undo, before + 1);
  core.mutate(value => value.undo());
  assert.equal(core.paragraph({ section: 0, steps: [] }, 0).text, 'alpha alpha\tALPHA');
  const bytes = doc.serialize(false);
  assert.throws(() => api.applyCharFormat(core, 0, 0, 0, 3, JSON.stringify({ bold: true, madeUpFormat: true })));
  assert.deepEqual(doc.serialize(false), bytes);
});

test('styles, paragraph margins, numbering and character counts use the document model', t => {
  const { core } = open(t);
  api.insertText(core, 0, 0, 0, 'A😀\tB', false);
  assert.equal(api.getDocumentCharacterCount(core), 4);
  assert.equal(api.getBodyRangeCharacterCount(core, 0, 0, 0, 0, 0, 1), 1);
  const id = api.createStyle(core, JSON.stringify({ name: '본문 검증', englishName: 'Widget test' }));
  api.updateStyleShapes(core, id, JSON.stringify({ bold: true, fontSize: 1600 }), JSON.stringify({ marginRight: 24 * 150 }));
  api.applyStyle(core, 0, 0, id);
  assert.equal(api.getStyleAt(core, 0, 0).name, '본문 검증');
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 1).fontSize, 1600);
  assert.equal(api.getParaPropertiesAt(core, 0, 0).marginRight, 24);
  // 문단 모양 대화상자는 10pt 를 저장값 2000 으로 보낸다.
  api.applyParaFormat(core, 0, 0, JSON.stringify({ spacingBefore: 2000, indent: -1500 }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).spacingBefore, 13.3);
  assert.equal(api.getParaPropertiesAt(core, 0, 0).indent, -10);
  const bullet = api.ensureDefaultBullet(core, '•');
  assert.equal(api.ensureDefaultBullet(core, '•'), bullet);
  api.applyParaFormat(core, 0, 0, JSON.stringify({ headType: 'Bullet', numberingId: bullet, paraLevel: 0 }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).headType, 'Bullet');
  const numbering = api.ensureDefaultNumbering(core);
  api.applyParaFormat(core, 0, 0, JSON.stringify({ headType: 'Number', numberingId: numbering }));
  assert.equal(api.getParaPropertiesAt(core, 0, 0).numberingId, numbering);
  assert.ok(api.getFontList(core).length > 0);
  const page = api.getPageDef(core, 0);
  assert.ok(page.width > 0 && page.marginLeft > 0);
});

test('deleting a style in use moves its body and cell paragraphs to 바탕글 in one undo step', t => {
  const { core } = open(t);
  api.insertText(core, 0, 0, 0, '본문', false);
  const table = api.createTable(core, 0, 0, 2, 1, 1);
  const id = api.createStyle(core, JSON.stringify({ name: '지울 스타일', englishName: 'Doomed' }));
  api.applyStyle(core, 0, 0, id);
  api.applyCellStyle(core, 0, table.paraIdx, table.controlIdx, 0, 0, id);
  const listed = () => api.getStyleList(core).some(style => style.name === '지울 스타일');
  const used = () => [api.getStyleAt(core, 0, 0).id, api.getCellStyleAt(core, 0, table.paraIdx, table.controlIdx, 0, 0).id];
  const before = core.state().undo;
  assert.equal(api.deleteStyle(core, id), true);
  assert.equal(core.state().undo, before + 1);
  assert.equal(listed(), false);
  assert.deepEqual(used(), [0, 0]);
  core.mutate(doc => doc.undo());
  assert.equal(listed(), true);
  assert.deepEqual(used(), [id, id]);
});

test('character effects from the toolbar and dialog reach the document and read back', t => {
  const { core, doc, engine } = open(t);
  api.insertText(core, 0, 0, 0, 'Effects 글자', false);
  const x0 = api.getCharPropertiesAt(core, 0, 0, 3).shadowOffsetX;
  api.applyCharFormat(core, 0, 0, 0, 7, JSON.stringify({
    superscript: true, emboss: true, underline: true, underlineType: 'Top', underlineShape: 2, underlineColor: '#0000ff',
    strikethrough: true, strikeShape: 3, strikeColor: '#00ff00', outlineType: 1, shadowType: 2, shadowColor: '#808080',
    shadowOffsetY: 15, emphasisDot: 2, shadeColor: '#ffff00', relativeSizes: Array(7).fill(90), charOffsets: Array(7).fill(-5),
  }));
  const read = (props = api.getCharPropertiesAt(core, 0, 0, 3)) => ({
    sup: props.superscript, emboss: props.emboss, ul: props.underlineType, ulShape: props.underlineShape, ulColor: props.underlineColor,
    strike: props.strikethrough, strikeShape: props.strikeShape, strikeColor: props.strikeColor, outline: props.outlineType,
    shadow: props.shadowType, shadowColor: props.shadowColor, offset: [props.shadowOffsetX, props.shadowOffsetY], dot: props.emphasisDot,
    shade: props.shadeColor, rel: props.relativeSizes?.[0], pos: props.charOffsets?.[0],
  });
  const expected = { sup: true, emboss: true, ul: 'Top', ulShape: 2, ulColor: '#0000ff', strike: true, strikeShape: 3, strikeColor: '#00ff00',
    outline: 1, shadow: 2, shadowColor: '#808080', offset: [x0, 15], dot: 2, shade: '#ffff00', rel: 90, pos: -5 };
  assert.deepEqual(read(), expected);
  assert.equal(api.getCharPropertiesAt(core, 0, 0, 9).superscript, false);
  // 아래 첨자는 위 첨자를, 색 없음은 음영을 지운다.
  api.applyCharFormat(core, 0, 0, 0, 7, JSON.stringify({ subscript: true, shadeColor: '#ffffff', shadowOffsetX: -8 }));
  const after = api.getCharPropertiesAt(core, 0, 0, 3);
  assert.deepEqual([after.superscript, after.subscript, after.shadowOffsetX, after.shadowOffsetY], [false, true, -8, 15]);
  core.mutate(value => value.undo());
  const reopened = engine.open(doc.serialize(false));
  try {
    const at = { section: 0, para: 0, offset: core.paragraph({ section: 0, steps: [] }, 0).caret[0] + 3 };
    const characters = JSON.parse(reopened.query(JSON.stringify({ kind: 'formatContext', at }))).characters;
    assert.deepEqual([characters.superscript, characters.underlineKind, characters.shadeColor, characters.outline], [true, 'above', 0x00FFFF, 1]);
  } finally { reopened.free(); }
  const beforeBorder = core.state().undo;
  api.applyCharFormat(core, 0, 0, 0, 3, JSON.stringify({ borderLeft: { type: 1, width: 1, color: '#000000' } }));
  assert.deepEqual(api.getCharPropertiesAt(core, 0, 0, 1).borderLeft, { type: 1, width: 1, color: '#000000' });
  assert.equal(core.state().undo, beforeBorder + 1);
  core.mutate(doc => doc.undo());
});

test('the numbering button reuses the document numbering before creating the Hancom default', t => {
  const { core } = open(t);
  api.insertText(core, 0, 0, 0, 'one', false);
  const first = api.ensureDefaultNumbering(core);
  assert.deepEqual(api.getNumberingList(core).find(item => item.id === first)!.levelFormats.slice(0, 3), ['^1.', '^2.', '^3)']);
  assert.equal(api.ensureDefaultNumbering(core), first);
  assert.equal(api.getNumberingList(core).length, 1);
});

test('character properties at an offset describe the character there, as the toolbar reads a selection start', t => {
  const { core } = open(t);
  api.insertText(core, 0, 0, 0, 'abcdef');
  api.applyCharFormat(core, 0, 0, 2, 4, JSON.stringify({ bold: true }));
  assert.deepEqual([1, 2, 3, 4].map(offset => api.getCharPropertiesAt(core, 0, 0, offset).bold), [false, true, true, false]);
  // 문단 앞에 글자처럼 놓인 표가 있어도 첫 글자를 읽는다.
  api.createTableEx(core, { sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: 1, colCount: 1, treatAsChar: true } as any);
  api.applyCharFormat(core, 0, 0, 0, 1, JSON.stringify({ bold: true }));
  assert.deepEqual([0, 1].map(offset => api.getCharPropertiesAt(core, 0, 0, offset).bold), [true, false]);
});
