import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';
import type { NoteShapeSettings } from '../src/core/types.ts';

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
const shapes = await import('../src/core/hm/notes-shape.ts');

function open(t: test.TestContext, bytes = new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)))) {
  const engine = new Engine(), doc = engine.open(bytes);
  t.after(() => { doc.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => doc, hasLoadedDocument: () => true,
    applyReceipt: () => {}, refreshLayout: () => {} } as unknown as HeemangAdapter;
  return { core: new HmCore(adapter), doc };
}

const edited: Record<'footnote' | 'endnote', Partial<NoteShapeSettings>> = {
  footnote: { numberFormat: 'userChar', userChar: '*', prefixChar: '(', suffixChar: '', startNumber: 5, superscript: true,
    separatorLength: -1, separatorLineType: 3, separatorLineWidth: 4, separatorColor: '#ff0000', separatorMarginTop: 2000,
    separatorMarginBottom: 1000, noteSpacing: 500, numbering: 'restartPage', placement: 'mergedColumn', beneathText: true },
  endnote: { numberFormat: 'decagonCircleHanja', prefixChar: '[', suffixChar: ']', startNumber: 3,
    separatorLength: 5669, separatorLineType: 2, separatorLineWidth: 8, separatorColor: '#123456', separatorMarginTop: 80,
    separatorMarginBottom: 100, noteSpacing: 150, numbering: 'restartSection', placement: 'sectionEnd' },
};

for (const kind of ['footnote', 'endnote'] as const) {
  test(`${kind} 모양은 HWPX와 HWP로 저장해 다시 열어도 그대로이고 다른 주석 모양은 건드리지 않는다`, t => {
    const { core, doc } = open(t);
    const other = kind === 'footnote' ? 'endnote' : 'footnote';
    const untouched = shapes.getNoteShape(core, 0, other);
    const settings = { ...shapes.getNoteShape(core, 0, kind), ...edited[kind] };
    assert.deepEqual(shapes.applyNoteShape(core, 0, kind, settings), { ok: true, changed: true });
    for (const format of ['hwpx', 'hwp5']) {
      const reopened = open(t, doc.serializeAs(format, false)).core;
      assert.deepEqual(shapes.getNoteShape(reopened, 0, kind), settings, format);
      assert.deepEqual(shapes.getNoteShape(reopened, 0, other), untouched, format);
    }
  });
}

test('바뀐 것 없는 적용은 편집하지 않고, 구분선을 끄면 길이만 0이 되며 이름 없는 저장값은 남는다', t => {
  const { core } = open(t);
  const footnote = shapes.getFootnoteShape(core, 0);
  assert.equal(footnote.separatorLength, -1, '한컴 기본 각주 구분선 5 cm');
  assert.equal(footnote.suffixChar, ')');
  const epoch = core.query({ kind: 'noteShape', section: 0, noteKind: 'footnote' });
  assert.deepEqual(shapes.applyFootnoteShape(core, 0, footnote), { ok: true, changed: false });
  assert.deepEqual(core.query({ kind: 'noteShape', section: 0, noteKind: 'footnote' }), epoch);

  shapes.applyFootnoteShape(core, 0, { ...footnote, separatorEnabled: false });
  const off = core.query<{ separatorLength: number; lineKind: number; lineWidth: number }>({ kind: 'noteShape', section: 0, noteKind: 'footnote' });
  assert.deepEqual([off.separatorLength, off.lineKind, off.lineWidth], [0, footnote.separatorLineType, footnote.separatorLineWidth]);
  shapes.applyFootnoteShape(core, 0, { ...shapes.getFootnoteShape(core, 0), separatorEnabled: true });
  assert.equal(shapes.getFootnoteShape(core, 0).separatorLength, -1, '다시 켜면 한컴 기본 길이');

  // 대화상자가 모르는 번호 모양(20)·위치(3)·속성 14비트 위는 다른 값을 고쳐도 남는다.
  const raw = core.query<{ attr: number }>({ kind: 'noteShape', section: 0, noteKind: 'endnote' });
  const attr = (raw.attr & ~0x3fff) | 20 | (3 << 8) | (1 << 15);
  core.transact([{ op: 'setNoteShape', section: 0, kind: 'endnote', patch: { attr } }]);
  const endnote = shapes.getEndnoteShape(core, 0);
  assert.deepEqual([endnote.numberFormat, endnote.placement], ['20', '3']);
  shapes.applyEndnoteShape(core, 0, { ...endnote, prefixChar: '<' });
  assert.equal(core.query<{ attr: number }>({ kind: 'noteShape', section: 0, noteKind: 'endnote' }).attr, attr);
});
