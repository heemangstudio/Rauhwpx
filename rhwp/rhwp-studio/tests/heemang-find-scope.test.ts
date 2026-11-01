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

function open(t: test.TestContext, sample: string) {
  const engine = new Engine();
  const doc = engine.open(readFileSync(new URL(`../../samples/${sample}`, import.meta.url)));
  const adapter = {
    documentInstance: 1, hmDoc: () => doc, hmStateJson() { return this.hmDoc().state(); }, hmEngine: () => engine,
    hasLoadedDocument: () => true, applyReceipt: () => {}, refreshLayout: () => {}, getSectionCount: () => 1,
  } as unknown as HeemangAdapter;
  t.after(() => { doc.free(); engine.free(); });
  return new HmCore(adapter);
}

type Core = ReturnType<typeof open>;
const where = (hit: { para?: number; charOffset?: number; cellPath?: { controlIndex: number; cellIndex: number }[] }) =>
  `${hit.para}:${hit.charOffset}${hit.cellPath?.length ? `/${hit.cellPath.map(e => `${e.controlIndex}.${e.cellIndex}`).join('/')}` : ''}`;

function walk(core: Core, query: string) {
  const seen: string[] = [];
  let at = { para: 0, char: 0, path: [] as never[] };
  for (let i = 0; i < 100; i += 1) {
    const r = api.searchText(core, query, 0, at.para, at.char, true, true, at.path);
    if (!r.found || r.wrapped) return seen;
    seen.push(where(r));
    at = { para: r.para!, char: r.charOffset! + 1, path: (r.cellPath ?? []) as never[] };
  }
  throw new Error('find never wrapped');
}

test('find skips notes and visits table cells in document order, then reports the wrap', t => {
  const core = open(t, 'footnote-01.hwp');
  // 각주 본문의 "3D"와 "플라스틱"은 찾지 않는다.
  assert.equal(api.searchAllText(core, '3D', true, true).length, 17);
  assert.equal(api.searchAllText(core, '3D', true, false).length, 14);
  assert.equal(api.searchAllText(core, '플라스틱', true, true).length, 1);
  assert.equal(api.searchAllText(core, '액체란', true, true).length, 0);
  const order = walk(core, '3D');
  assert.equal(order.length, 17);
  assert.deepEqual(order.slice(0, 3), ['0:0/3.0', '1:0/0.2', '5:0']);
  assert.equal(order.at(-1), '38:0/1.0');
  assert.equal(api.replaceAll(core, '3D', 'XR', true).count, 17);
  assert.equal(api.searchAllText(core, '3D', true, true).length, 0);
});

test('a match may span a footnote mark, and replacing it keeps the note', t => {
  const core = open(t, 'footnote-tbox-01.hwp');
  const box = { section: 0, steps: [{ para: 1, control: 0, index: 0 }] };
  const notes = () => core.paragraph(box, 0).controls.filter(c => c.kind === 'footnote').length;
  assert.equal(core.paragraph(box, 0).text, '여기에 각주가 들어있는');
  assert.equal(notes(), 1);
  // 본문 한 곳과 각주 번호를 사이에 둔 글상자 한 곳.
  assert.equal(api.searchAllText(core, '각주가', true, true).length, 2);
  assert.equal(api.replaceAll(core, '각주가', 'ZQZ', true).count, 2);
  assert.equal(core.paragraph(box, 0).text, '여기에 ZQZ 들어있는');
  assert.equal(notes(), 1);
  const noteList = { section: 0, steps: [...box.steps, { para: 0, control: core.paragraph(box, 0).controls.find(c => c.kind === 'footnote')!.index, index: 0 }] };
  assert.equal(core.paragraph(noteList, 0).text.trim(), '글상자 내부 각주');
});
