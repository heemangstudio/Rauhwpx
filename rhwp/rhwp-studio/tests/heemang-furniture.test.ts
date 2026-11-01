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
const furniture = await import('../src/core/hm/furniture-editing.ts');
const { getDocumentCharacterCount } = await import('../src/core/hm/document-counts.ts');

function open(t: test.TestContext, bytes = new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)))) {
  const engine = new Engine(), doc = engine.open(bytes);
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hmStateJson() { return this.hmDoc().state(); }, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  return { core: new HmCore(adapter), doc };
}

test('머리말의 이모지 편집과 쪽 번호는 저장 후에도 남고 실행 취소로 복원된다', t => {
  const { core, doc } = open(t);
  furniture.createHeaderFooter(core, 0, true, 0);
  const inserted = JSON.parse(furniture.insertTextInHeaderFooter(core, 0, true, 0, 0, 0, '머리😀말'));
  assert.equal(inserted.charOffset, 4);
  const removed = JSON.parse(furniture.deleteTextInHeaderFooter(core, 0, true, 0, 0, 2, 1));
  assert.equal(removed.deletedText, '😀');
  assert.equal(JSON.parse(furniture.getHeaderFooter(core, 0, true, 0)).text, '머리말');
  core.mutate(d => d.undo());
  assert.equal(JSON.parse(furniture.getHeaderFooter(core, 0, true, 0)).text, '머리😀말');
  const field = furniture.insertFieldInHf(core, 0, true, 0, 0, 4, 1);
  assert.equal(field.insertedLength, 1);
  assert.equal(JSON.parse(furniture.getHeaderFooterParaInfo(core, 0, true, 0, 0)).charCount, 5);
  furniture.insertTextInHeaderFooter(core, 0, true, 0, 0, 5, ' 끝');
  const reopened = open(t, doc.serialize(false)).core;
  assert.equal(JSON.parse(furniture.getHeaderFooter(reopened, 0, true, 0)).text, '머리😀말 끝');
  assert.equal(JSON.parse(furniture.getHeaderFooterParaInfo(reopened, 0, true, 0, 0)).charCount, 7);
  assert.ok(getDocumentCharacterCount(reopened) >= 6);
});

test('각주와 미주는 자기 문단 목록을 편집하고 HWP와 HWPX로 왕복한다', t => {
  const { core, doc } = open(t);
  const note = furniture.insertFootnote(core, 0, 0, 0);
  // 새 주석의 캐럿(엔진 영수증)은 번호 뒤다. 캐럿 0 은 번호 앞이다.
  const start = note.charOffset;
  assert.ok(start >= 1);
  furniture.insertTextInFootnote(core, 0, note.paraIdx, note.controlIdx, 0, start, '각주😀');
  // 주석 번호는 문단 맨 앞에 남고 입력은 그 뒤에 들어간다.
  const [list] = core.query<Array<{ kind: string; lists: Array<{ section: number; steps: [] }> }>>({ kind: 'controls' }).filter(c => c.kind === 'footnote')[0].lists;
  const first = core.query<Array<{ offsets: number[]; controls: Array<{ kind: string; offset: number }> }>>({ kind: 'paragraphs', list, from: 0, count: 1 })[0];
  assert.ok(first.controls.find(c => c.kind === 'autoNumber')!.offset < first.offsets[0]);
  furniture.splitParagraphInFootnote(core, 0, note.paraIdx, note.controlIdx, 0, start + 2);
  const prefix = furniture.getFootnoteInfo(core, 0, note.paraIdx, note.controlIdx).texts[0].slice(0, -2);
  assert.deepEqual(furniture.getFootnoteInfo(core, 0, note.paraIdx, note.controlIdx).texts, [`${prefix}각주`, '😀']);
  furniture.mergeParagraphInFootnote(core, 0, note.paraIdx, note.controlIdx, 1);
  const endnote = furniture.insertEndnote(core, 0, 0, 1);
  furniture.insertTextInFootnote(core, 0, endnote.paraIdx, endnote.controlIdx, 0, endnote.charOffset, '미주');
  for (const format of ['hwp5', 'hwpx']) {
    const reopened = open(t, doc.serializeAs(format, false)).core;
    assert.equal(furniture.getFootnoteInfo(reopened, 0, note.paraIdx, note.controlIdx).noteText, '각주😀');
    assert.equal(furniture.getFootnoteInfo(reopened, 0, endnote.paraIdx, endnote.controlIdx).noteText, '미주');
  }
  furniture.deleteFootnote(core, 0, note.paraIdx, note.controlIdx);
  core.mutate(d => d.undo());
  assert.equal(furniture.getFootnoteInfo(core, 0, note.paraIdx, note.controlIdx).noteText, '각주😀');
});

test('머리말 마당은 쪽 번호·파일 이름과 정렬·굵게를 넣는다', t => {
  const { core, doc } = open(t);
  furniture.createHeaderFooter(core, 0, true, 0);
  furniture.insertTextInHeaderFooter(core, 0, true, 0, 0, 0, '지울 글');
  assert.deepEqual(furniture.applyHfTemplate(core, 0, true, 0, 7), { ok: true });
  const reopened = open(t, doc.serialize(false)).core;
  const info = JSON.parse(furniture.getHeaderFooterParaInfo(reopened, 0, true, 0, 0));
  assert.deepEqual([info.text, info.charCount], ['', 1]);
  assert.equal(furniture.getParaPropertiesInHf(reopened, 0, true, 0, 0).alignment, 'center');
  assert.equal(furniture.getCharPropertiesInHf(reopened, 0, true, 0, 0, 0).bold, true);
  assert.deepEqual(furniture.applyHfTemplate(core, 0, true, 0, 4), { ok: true });
  assert.match(JSON.parse(furniture.getHeaderFooter(core, 0, true, 0)).text, /문서/);
});
