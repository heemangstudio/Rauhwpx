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
const text = await import('../src/core/hm/text.ts');
const fields = await import('../src/core/hm/fields-controls.ts');
const { bodyList, logicalAddress, logicalLength, paraMap } = await import('../src/core/hm/address.ts');

function open(t: test.TestContext) {
  const engine = new Engine(), doc = engine.open(new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url))));
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  const core = new HmCore(adapter);
  // 캐럿 둘레에 글자 폭이 없는 책갈피와 누름틀이 있는 문단.
  core.transact([{ op: 'insertText', at: logicalAddress(core, bodyList(0), 0, 0), text: '가나다😀라마바' }]);
  assert.equal(fields.addBookmark(core, 0, 0, 2, '표시').ok, true);
  assert.equal(fields.insertClickHereField(core, { sectionIndex: 0, paragraphIndex: 0, charOffset: 5 }, '안내', '', '칸', true).ok, true);
  return { core, doc };
}

const paragraph = (core: InstanceType<typeof HmCore>) => {
  const info = core.paragraph(bodyList(0), 0);
  return { text: info.text, controls: info.controls.map(c => [c.kind, c.offset]) };
};

// IME 조합 갱신은 지우기와 넣기를 한 트랜잭션으로 한다. 따로 할 때와 문서·캐럿·지운 내용이 같아야 한다.
test('a composition replace in one transaction edits exactly like delete then insert', t => {
  const probe = open(t).core;
  const length = logicalLength(paraMap(probe.paragraph(bodyList(0), 0)));
  let compared = 0;
  for (let offset = 0; offset < length; offset++) {
    for (const count of [1, 2]) {
      const fused = open(t).core, split = open(t).core;
      const before = paragraph(fused);
      let expected;
      try {
        const removal = text.deleteIn(split, bodyList(0), 0, offset, count, true);
        expected = { removal: { ...removal, charOffset: undefined }, caret: text.insertIn(split, bodyList(0), 0, offset, '한글', true) };
      } catch {
        continue;
      }
      const result = text.replaceBodyTextLocal(fused, 0, 0, offset, count, '한글', true);
      const { charOffset, ok: _ok, documentPaginationPending: _p, flowChanged: _f, ...removal } = result;
      assert.deepEqual({ removal: { ...removal, charOffset: undefined }, caret: charOffset }, expected, `offset ${offset} count ${count}`);
      assert.deepEqual(paragraph(fused), paragraph(split), `offset ${offset} count ${count}`);
      assert.equal(fused.state().undo, split.state().undo - 1, 'one history step instead of two');
      const after = paragraph(fused);
      fused.mutate(doc => doc.undo());
      assert.deepEqual(paragraph(fused), before, 'undo restores text and controls together');
      fused.mutate(doc => doc.redo());
      assert.deepEqual(paragraph(fused), after, 'redo restores the complete replacement');
      compared += 1;
    }
  }
  assert.ok(compared >= length, `compared ${compared} edits`);
});
