import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('?url')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('?url')) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)}` };
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: transformSync(new URL(url).pathname, readFileSync(new URL(url), 'utf8')).code };
    return next(url, context);
  },
});
initSync({ module: readFileSync(new URL('../vendor/hm-wasm/hm_wasm_bg.wasm', import.meta.url)) });
const { HmCore } = await import('../src/core/hm/core.ts');
const page = await import('../src/core/hm/page-settings.ts');
const fields = await import('../src/core/hm/fields-controls.ts');
await import('../src/core/hm/fields-forms.ts');
const { bodyList, logicalAddress } = await import('../src/core/hm/address.ts');

function open(t: test.TestContext, bytes = new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)))) {
  const engine = new Engine(), doc = engine.open(bytes);
  t.after(() => { doc.free(); engine.free(); });
  // 실 WASM 문서를 쓰고, 이 테스트와 무관한 화면 packet 전달만 생략한다.
  const adapter = { documentInstance: 1, hmDoc: () => doc, hmStateJson() { return this.hmDoc().state(); }, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  return { core: new HmCore(adapter), doc };
}

test('clearing an empty active-field session is safe on ordinary body caret updates', async t => {
  const { core } = open(t);
  const { api } = await import('../src/core/hm/api.ts');
  const before = core.state();
  api.clearActiveField(core);
  api.clearActiveField(core);
  assert.deepEqual(core.state(), before);
});

test('page and section changes survive native save/reopen and preserve other section bits', t => {
  const { core, doc } = open(t);
  const before = page.getPageDef(core, 0), section = page.getSectionDef(core, 0);
  page.setPageDefAll(core, { marginLeft: before.marginLeft + 720, landscape: !before.landscape });
  const nextSection = { ...section, hideFooter: !section.hideFooter, hideEmptyLine: !section.hideEmptyLine, pageNum: 7 };
  page.setSectionDef(core, 0, nextSection);
  page.setColumnDef(core, 0, 2, 0, 1, 720);
  const reopened = open(t, doc.serialize(false)).core;
  assert.deepEqual(page.getPageDef(reopened, 0), { ...before, marginLeft: before.marginLeft + 720, landscape: !before.landscape });
  assert.deepEqual(page.getSectionDef(reopened, 0), nextSection);
  assert.deepEqual(page.getColumnDef(reopened, 0), { columnCount: 2, columnType: 0, sameWidth: true, spacing: 720 });
  page.setPageHide(core, 0, 0, false, false, false, false, false, true);
  assert.equal(page.getPageHide(core, 0, 0).hidePageNum, true);
  page.setPageHide(core, 0, 0, false, false, false, false, false, false);
  assert.equal(page.getPageHide(core, 0, 0).exists, false);
});

test('clickhere values, UTF-16 metadata and bookmarks survive native save/reopen and undo', t => {
  const { core, doc } = open(t);
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const inserted = fields.insertClickHereField(core, pos, '입력 😀 HelpState:wstring:1:x', '메모: test', '이름', true);
  assert.equal(inserted.ok, true);
  const id = inserted.fieldId!;
  assert.deepEqual(fields.getClickHereProps(core, id), { ok: true, guide: '입력 😀 HelpState:wstring:1:x', memo: '메모: test', name: '이름', editable: true });
  assert.equal(fields.getFieldList(core).find(f => f.fieldId === id)!.guide, '입력 😀 HelpState:wstring:1:x');
  assert.equal(fields.getFieldInfoAt(core, pos).guideName, '입력 😀 HelpState:wstring:1:x');
  fields.setFieldValue(core, id, '값😀');
  assert.equal(fields.getFieldValueByName(core, '이름').value, '값😀');
  const reopened = open(t, doc.serialize(false)).core;
  assert.equal(fields.getFieldValue(reopened, id).value, '값😀');
  assert.deepEqual(fields.getClickHereProps(reopened, id), fields.getClickHereProps(core, id));
  core.mutate(d => d.undo());
  assert.equal(fields.getFieldValue(core, id).value, '');
  assert.equal(fields.addBookmark(core, 0, 0, 0, '책갈피').ok, true);
  const bookmark = fields.getBookmarks(core).find(b => b.name === '책갈피')!;
  assert.ok(bookmark);
  fields.renameBookmark(core, bookmark.sec, bookmark.para, bookmark.ctrlIdx, '새 이름');
  assert.equal(fields.getBookmarks(open(t, doc.serialize(false)).core)[0].name, '새 이름');
  const renamed = fields.getBookmarks(core)[0];
  fields.deleteBookmark(core, renamed.sec, renamed.para, renamed.ctrlIdx);
  assert.deepEqual(fields.getBookmarks(core), []);
});

test('hyperlink wrapping preserves text and character formatting and removes only the field', t => {
  const { core, doc } = open(t);
  const list = bodyList(0), target = { section: 0, para: 0, cellPath: [] };
  core.transact([{ op: 'insertText', at: logicalAddress(core, list, 0, 0), text: '가😀나다' }]);
  const from = logicalAddress(core, list, 0, 1), to = logicalAddress(core, list, 0, 3);
  core.transact([{ op: 'formatChars', from, to, patch: { bold: true } }]);
  const id = fields.insertHyperlink(core, target, 1, 2, 'https://example.com/a;b#c');
  assert.deepEqual(fields.getHyperlinkContext(core, target), { text: '가😀나다', links: [{ fieldId: id, start: 1, end: 2, text: '😀', uri: 'https://example.com/a;b#c' }] });
  const saved = open(t, doc.serialize(false)).core;
  assert.deepEqual(fields.getHyperlinkContext(saved, target), fields.getHyperlinkContext(core, target));
  const at = logicalAddress(core, list, 0, 2);
  assert.equal(core.query<{ characters: { bold: boolean } }>({ kind: 'formatContext', at }).characters.bold, true);
  fields.replaceHyperlinkText(core, target, id, '새 링크');
  fields.updateHyperlink(core, target, id, 'https://openai.com');
  assert.equal(fields.getHyperlinkContext(core, target).links[0].text, '새 링크');
  fields.removeHyperlink(core, target, id, false);
  assert.deepEqual(fields.getHyperlinkContext(core, target), { text: '가새 링크나다', links: [] });
});

test('page border lines, fill and hiding survive native save/reopen', t => {
  const { core, doc } = open(t);
  const before = page.getPageBorderFill(core, 0);
  const line = (type: number, width: number, color: string) => ({ type, width, color });
  const next = { ...before, basis: 'page' as const, spacingLeft: 1417, spacingTop: 850, headerInside: true, fillArea: 'border' as const,
    borderLeft: line(1, 3, '#ff0000'), borderRight: line(1, 3, '#ff0000'), borderTop: line(2, 5, '#0000ff'), borderBottom: line(8, 0, '#000000'),
    fillType: 'solid', fillColor: '#ffeecc', patternColor: '#000000', patternType: 0, hideBorder: true, hideFill: false };
  page.setPageBorderFill(core, 0, next);
  const expected = { ...next, attr: 1 | 2 | (2 << 3), borderFillId: page.getPageBorderFill(core, 0).borderFillId };
  assert.ok(expected.borderFillId > 0);
  assert.deepEqual(page.getPageBorderFill(core, 0), expected);
  assert.equal(page.getSectionDef(core, 0).hideBorder, true);
  const reopened = open(t, doc.serialize(false)).core;
  assert.deepEqual(page.getPageBorderFill(reopened, 0), expected);
  // 배경을 건드리지 않은 패치는 채우기를 그대로 둔다.
  const { fillType: _a, fillColor: _b, patternColor: _c, patternType: _d, ...linesOnly } = { ...expected, borderTop: line(0, 0, '#000000') };
  page.setPageBorderFill(core, 0, linesOnly as typeof expected);
  assert.equal(page.getPageBorderFill(core, 0).fillColor, '#ffeecc');
});

test('typing at an active empty click-here field fills the field', async t => {
  const { core, doc } = open(t);
  const { api } = await import('../src/core/hm/api.ts');
  const pos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const id = fields.insertClickHereField(core, pos, '이름을 입력', '', '성명', true).fieldId!;
  const start = { ...pos, charOffset: fields.getFieldInfoAt(core, pos).startCharIdx! };
  assert.equal(api.setActiveField(core, start), true);
  const typed = JSON.parse(api.insertText(core, 0, 0, start.charOffset, '홍', true));
  // IME 조합 갱신: 방금 친 글자를 바꾼다.
  api.replaceBodyTextLocal(core, 0, 0, start.charOffset, 1, '홍길', true);
  assert.equal(typed.charOffset, start.charOffset + 1);
  assert.equal(fields.getFieldValue(core, id).value, '홍길');
  api.clearActiveField(core);
  assert.equal(fields.getFieldValue(open(t, doc.serialize(false)).core, id).value, '홍길');
});

test('form controls report values, take new ones and survive native save/reopen', async t => {
  const { api } = await import('../src/core/hm/api.ts');
  const bytes = new Uint8Array(readFileSync(new URL('../../samples/form-01.hwp', import.meta.url)));
  const { core, doc } = open(t, bytes);
  const records = core.query<Array<{ target: { section: number; para: number; control: number; steps?: unknown[] }; offset: number; form?: { formType: string } }>>({ kind: 'controls' });
  const find = (type: string) => records.find(r => r.form?.formType === type && !r.target.steps?.length)!.target;
  const check = find('CheckBox'), edit = find('Edit');
  const was = api.getFormObjectInfo(core, check.section, check.para, check.control);
  assert.equal(was.ok, true);
  api.setFormValue(core, check.section, check.para, check.control, JSON.stringify({ value: was.value ? 0 : 1 }));
  api.setFormValue(core, edit.section, edit.para, edit.control, JSON.stringify({ text: '입력값' }));
  const reopened = open(t, doc.serialize(false)).core;
  assert.equal(api.getFormValue(reopened, check.section, check.para, check.control).value, was.value ? 0 : 1);
  assert.equal(api.getFormValue(reopened, edit.section, edit.para, edit.control).text, '입력값');
  const offset = records.find(r => r.target === check)!.offset;
  const caret = core.caret({ section: 0, para: check.para, offset }, 'downstream')!;
  const hit = api.getFormObjectAt(core, caret.page, caret.x / 75 + 4, (caret.y + caret.height) / 75 - 4);
  assert.deepEqual([hit.found, hit.para, hit.ci, hit.formType], [true, check.para, check.control, 'CheckBox']);
  assert.equal(api.getFormObjectAt(core, caret.page, 1, 1).found, false);
});
