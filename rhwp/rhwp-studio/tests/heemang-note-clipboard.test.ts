/**
 * 본문에서 각주 표시가 든 범위를 복사·잘라내어 붙이면 주석이 함께 간다 (한컴 c08a·c08b).
 * HM_WASM_PKG 에 hm-wasm 빌드 폴더를 주면 번들 대신 그 엔진으로 돈다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'rolldown/utils';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';

const pkg = process.env.HM_WASM_PKG ? pathToFileURL(`${process.env.HM_WASM_PKG.replace(/\/$/, '')}/`) : new URL('../vendor/hm-wasm/', import.meta.url);
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
const wasm = await import(new URL('hm_wasm.js', pkg).href) as typeof import('../vendor/hm-wasm/hm_wasm.js');
wasm.initSync({ module: readFileSync(new URL('hm_wasm_bg.wasm', pkg)) });
const { HmCore } = await import('../src/core/hm/core.ts');
await import('../src/core/hm/extensions.ts');
const notes = await import('../src/core/hm/furniture-editing.ts');
const clipboard = await import('../src/core/hm/clipboard-native.ts');
const text = await import('../src/core/hm/text.ts');

/** "abcdef" 의 c 뒤에 각주 "NOTE" 를 단 문서. 캐럿 칸으로 a b c [각주] d e f 이다. */
function open(t: test.TestContext) {
  const engine = new wasm.Engine();
  const doc = engine.open(new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url))));
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hmEngine: () => engine, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  const core = new HmCore(adapter);
  text.insertText(core, 0, 0, 0, 'abcdef', true);
  const note = notes.insertFootnote(core, 0, 0, 3);
  const start = notes.getFootnoteInfo(core, 0, note.paraIdx, note.controlIdx).textStart;
  notes.insertTextInFootnote(core, 0, note.paraIdx, note.controlIdx, start.fnParaIndex, start.charOffset, 'NOTE');
  const footnotes = () => core.paragraph({ section: 0, steps: [] }, 0).controls.filter(c => c.kind === 'footnote')
    .map(c => ({ number: c.number, text: notes.getFootnoteInfo(core, 0, 0, c.index).noteText }));
  return { core, footnotes, body: () => core.paragraph({ section: 0, steps: [] }, 0).text };
}

test('각주 표시를 복사해 붙이면 붙인 쪽이 제 각주와 다음 번호를 얻는다', t => {
  const { core, footnotes, body } = open(t);
  clipboard.copySelection(core, 0, 0, 2, 0, 5);
  clipboard.pasteInternal(core, 0, 0, 7);
  assert.equal(body(), 'abcdefcd');
  assert.deepEqual(footnotes(), [{ number: 1, text: 'NOTE' }, { number: 2, text: 'NOTE' }]);
  // 앞에 붙이면 번호가 다시 매겨진다.
  clipboard.pasteInternal(core, 0, 0, 0);
  assert.deepEqual(footnotes().map(note => note.number), [1, 2, 3]);
});

test('각주 표시를 잘라내어 붙이면 각주가 글자와 함께 옮겨 간다', t => {
  const { core, footnotes, body } = open(t);
  clipboard.copySelection(core, 0, 0, 2, 0, 5);
  text.deleteRange(core, 0, 0, 2, 0, 5, true);
  assert.deepEqual(footnotes(), []);
  clipboard.pasteInternal(core, 0, 0, 4);
  assert.equal(body(), 'abefcd');
  assert.deepEqual(footnotes(), [{ number: 1, text: 'NOTE' }]);
});
