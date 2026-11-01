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
const furniture = await import('../src/core/hm/furniture-editing.ts');
const { createTableEx } = await import('../src/core/hm/table-properties.ts');
const clipboard = await import('../src/core/hm/clipboard-native.ts');

function open(t: test.TestContext, bytes = new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)))) {
  const engine = new Engine(), doc = engine.open(bytes);
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hmStateJson() { return this.hmDoc().state(); }, hmEngine: () => engine, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  return { core: new HmCore(adapter), doc };
}

// Shift+Enter 와 지운 글자 되돌리기는 줄바꿈이 든 평문을 넣는다. 옛 Studio 처럼 같은 문단 안 강제 줄바꿈이어야 한다.
test('평문 입력의 줄바꿈은 문단을 나누지 않는 강제 줄바꿈이고, 지웠다 다시 넣어도 저장 후에도 남는다', t => {
  const { core, doc } = open(t);
  const typed = JSON.parse(text.insertText(core, 0, 0, 0, 'ab\ncd\r\nef', true));
  assert.equal(text.getParagraphCount(core, 0), 1);
  assert.equal(text.getTextRange(core, 0, 0, 0, 100, true), 'ab\ncd\nef');
  assert.equal(typed.charOffset, 8);
  const removed = JSON.parse(text.deleteText(core, 0, 0, 1, 3, true));
  assert.equal(removed.removedContent.text, 'b\nc');
  text.insertText(core, 0, 0, 1, removed.removedContent.text, true);
  assert.equal(text.getTextRange(core, 0, 0, 0, 100, true), 'ab\ncd\nef');

  const table = createTableEx(core, { sectionIdx: 0, paraIdx: 0, charOffset: 8, rowCount: 1, colCount: 1 });
  text.insertTextInCell(core, 0, table.paraIdx, table.controlIdx, 0, 0, 0, '셀\n둘째 줄', true);
  assert.equal(text.getCellParagraphCount(core, 0, table.paraIdx, table.controlIdx, 0), 1);

  furniture.createHeaderFooter(core, 0, true, 0);
  furniture.insertTextInHeaderFooter(core, 0, true, 0, 0, 0, '머리\n말');
  assert.equal(JSON.parse(furniture.getHeaderFooterParaInfo(core, 0, true, 0, 0)).paraCount, 1);

  for (const format of ['hwp5', 'hwpx']) {
    const reopened = open(t, doc.serializeAs(format, false)).core;
    assert.equal(text.getTextRange(reopened, 0, 0, 0, 100, true), 'ab\ncd\nef', format);
    assert.equal(text.getTextInCell(reopened, 0, table.paraIdx, table.controlIdx, 0, 0, 0, 100, true), '셀\n둘째 줄', format);
    assert.equal(JSON.parse(furniture.getHeaderFooter(reopened, 0, true, 0)).text, '머리\n말', format);
  }
});

// 바깥 프로그램에 붙여 넣는 평문에는 고른 표의 셀 글자가 표 자리에 들어간다(옛 Studio 와 같은 꼴).
test('글자와 표를 함께 복사한 평문은 표 자리에 셀 글자를 칸은 탭, 줄은 줄바꿈으로 담는다', t => {
  const { core } = open(t);
  text.insertText(core, 0, 0, 0, '앞 글', true);
  const table = createTableEx(core, { sectionIdx: 0, paraIdx: 0, charOffset: 3, rowCount: 2, colCount: 2 });
  text.insertTextInCell(core, 0, table.paraIdx, table.controlIdx, 0, 0, 0, '가', true);
  text.insertTextInCell(core, 0, table.paraIdx, table.controlIdx, 3, 0, 0, '라', true);
  const last = text.getParagraphCount(core, 0) - 1;
  text.insertText(core, 0, last, 0, '뒤', true);
  clipboard.copySelection(core, 0, 0, 0, last, 1);
  const lines = clipboard.getClipboardText(core).split('\n');
  assert.equal(lines[0], '앞 글');
  assert.deepEqual(lines.slice(1, 3), ['가\t', '\t라']);
  assert.equal(lines.at(-1), '뒤');
});
