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
const { bodyList, cellList, logicalAddress, logicalLength, paraMap } = await import('../src/core/hm/address.ts');

type Container = 'body' | 'cell';
function open(t: test.TestContext, container: Container) {
  const engine = new Engine(), doc = engine.open(new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url))));
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hmStateJson() { return this.hmDoc().state(); }, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  const core = new HmCore(adapter);
  let list = bodyList(0), control = 0;
  if (container === 'cell') {
    core.transact([{ op:'createTable', at:logicalAddress(core,list,0,0), rows:1, columns:1 }]);
    control = core.paragraph(list,0).controls.find(c => c.kind === 'table')!.index;
    list = cellList(0,0,control,0);
  }
  // 캐럿 둘레에 글자 폭이 없는 책갈피와 누름틀이 있는 문단.
  core.transact([{ op:'insertText', at:logicalAddress(core,list,0,0), text:'가나다😀라마바' }]);
  core.transact([{ op:'insertBookmark', at:logicalAddress(core,list,0,2), name:'표시' }]);
  const position = { sectionIndex:0, paragraphIndex:0, charOffset:5,
    ...(container === 'cell' ? { parentParaIndex:0, controlIndex:control, cellIndex:0, cellParaIndex:0 } : {}) };
  assert.equal(fields.insertClickHereField(core,position,'안내','','칸',true).ok,true);
  return { core, list, control };
}

type Fixture = ReturnType<typeof open>;
const snapshot = ({core,list}: Fixture) => ({
  paragraphs:Array.from({length:core.paragraphCount(list)},(_,para) => core.paragraph(list,para)),
  fields:core.query({kind:'fields'}),
});
const replace = (fixture: Fixture, container: Container, offset: number, count: number, value: string) => container === 'body'
  ? text.replaceBodyTextLocal(fixture.core,0,0,offset,count,value,true)
  : text.replaceTextInCellDeferredPagination(fixture.core,0,0,fixture.control,0,0,offset,count,value,true);

// 두 주소 체계에서 문서·캐럿·지운 내용과 원자적 Undo/Redo를 실제 엔진으로 비교한다.
for (const container of ['body','cell'] as const) test(`atomic replacement preserves ${container} text and controls across Unicode, tabs and paragraphs`, t => {
  const probe = open(t,container);
  const length = logicalLength(paraMap(probe.core.paragraph(probe.list,0)));
  for (const value of ['한글','\t😀','새\r\n줄','😀한\t글\n끝']) {
    let compared = 0;
    for (let offset = 0; offset < length; offset++) {
      for (const count of [1,2]) {
        const fused = open(t,container), split = open(t,container);
        const before = snapshot(fused), label = `${container} ${JSON.stringify(value)} offset ${offset} count ${count}`;
        let expected;
        try {
          const removal = text.deleteIn(split.core,split.list,0,offset,count,true);
          expected = { removal:{...removal,charOffset:undefined}, caret:text.insertIn(split.core,split.list,0,offset,value,true) };
        } catch {
          assert.throws(() => replace(fused,container,offset,count,value),label);
          assert.deepEqual(snapshot(fused),before,'rejected replacement preserves text and controls');
          continue;
        }
        const result = replace(fused,container,offset,count,value);
        const removal = { removedStart:result.removedStart, removedCount:result.removedCount,
          removedContent:result.removedContent, charOffset:undefined };
        assert.deepEqual({removal,caret:result.charOffset},expected,label);
        assert.deepEqual(snapshot(fused),snapshot(split),label);
        assert.equal(fused.core.state().undo,split.core.state().undo-1,'one history step instead of two');
        const after = snapshot(fused);
        fused.core.mutate(doc => doc.undo());
        assert.deepEqual(snapshot(fused),before,'undo restores every paragraph and exact field/control metadata');
        fused.core.mutate(doc => doc.redo());
        assert.deepEqual(snapshot(fused),after,'redo restores the complete replacement');
        compared += 1;
      }
    }
    assert.ok(compared >= length,`${container} ${JSON.stringify(value)} compared ${compared} edits`);
  }
});
