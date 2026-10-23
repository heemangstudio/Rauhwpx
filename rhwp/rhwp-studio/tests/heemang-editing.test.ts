import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { Address, TextSelection } from '../src/core/heemang-adapter.ts';

// 실제 배포 WASM을 쓴다. Vite의 env와 확장자 해석만 Node에 연결한다.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/vendor/hm-wasm/hm_wasm')) return next(`${specifier}.js`, context);
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (new URL(url).pathname.endsWith('/core/heemang-adapter.ts')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(
        readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({DEV:false})')) };
    }
    return next(url, context);
  },
});
initSync({ module: readFileSync(new URL('../vendor/hm-wasm/hm_wasm_bg.wasm', import.meta.url)) });
const { HeemangAdapter } = await import('../src/core/heemang-adapter.ts');
const { replacementOps } = await import('../src/core/heemang-editing.ts');
const { blake3Hex } = await import('../src/core/content-hash.ts');
const fixture = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
const hwpx = () => fixture('tests/fixtures/editing_parity/mac-hancom-12.30.0/cell-mixed-text/source.hwpx');
const hwp = () => fixture('fuzz/corpus/parse_hwp/english.hwp');
const selection = (at: Address): TextSelection => ({ from: at, to: at });
const body: Address = { section: 0, para: 1, offset: 0 };

async function open(t: test.TestContext, bytes = hwpx()) {
  const adapter = new HeemangAdapter();
  await adapter.initialize();
  adapter.loadDocument(bytes, '편집.hwpx');
  t.after(() => adapter.releaseDocument());
  return adapter;
}

function reopened(bytes: Uint8Array, run: (doc: ReturnType<Engine['open']>) => void) {
  const engine = new Engine();
  const doc = engine.open(bytes);
  try { run(doc); } finally { doc.free(); engine.free(); }
}

test('native untouched HWP5/HWPX serialization preserves exact bytes and epochs', async t => {
  for (const bytes of [hwpx(), hwp()]) {
    reopened(bytes, doc => {
      const before = JSON.parse(doc.state());
      assert.deepEqual(doc.serialize(false), new Uint8Array(bytes));
      assert.deepEqual(JSON.parse(doc.state()), before);
    });
    const adapter = await open(t, bytes);
    const before = adapter.state();
    const digest = adapter.documentDigest;
    assert.equal(adapter.readOnly, false);
    const out = adapter.serialize(false);
    assert.deepEqual(out, new Uint8Array(bytes));
    out[0] = 0; // 호출자가 바꿔도 저장 후보나 다음 serialize에 섞이지 않는다.
    assert.deepEqual(adapter.serialize(true), new Uint8Array(bytes));
    assert.deepEqual(adapter.state(), before);
    assert.equal(adapter.documentDigest, digest);
  }
});

test('emoji, combining marks and tabs use native grapheme boundaries and wire offsets', async t => {
  const a = await open(t);
  const result = a.replaceText(selection(body), '👍🏽é́ᄒᆞᆫ\tZ')!;
  assert.equal(result.receipt.undo, 1);
  assert.equal(result.caret.position.offset, 18);
  assert.equal(a.getParagraphText(0, 1), '👍🏽é́ᄒᆞᆫ\tZ');
  let at = a.deleteBackward(selection(result.caret.position))!.caret.position;
  assert.equal(at.offset, 17);
  at = a.deleteBackward(selection(at))!.caret.position;
  assert.equal(at.offset, 9); // tab 전체 8 wire units
  at = a.deleteBackward(selection(at))!.caret.position;
  assert.equal(at.offset, 6); // 조합 자모 한 grapheme
  at = a.deleteBackward(selection(at))!.caret.position;
  assert.equal(at.offset, 4); // accent 포함
  assert.equal(a.deleteBackward(selection(at))!.caret.position.offset, 0);
  assert.equal(a.getParagraphText(0, 1), '');
});

test('selected replacement is one undo group and restores the directed selection', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'AB😀\tCD');
  const range = { from: { ...body, offset: 12 }, to: { ...body, offset: 1 } };
  const changed = a.replaceText(range, '한글')!;
  assert.equal(a.getParagraphText(0, 1), 'A한글CD');
  assert.equal(changed.receipt.undo, 2);
  assert.equal(changed.caret.position.offset, 3);
  assert.equal(changed.anchor, null);
  assert.equal(a.canUndo(), true);
  const undo = a.undoEdit()!;
  assert.equal(a.getParagraphText(0, 1), 'AB😀\tCD');
  assert.deepEqual(undo.anchor!.position, range.from);
  assert.deepEqual(undo.caret.position, range.to);
  assert.equal(a.canRedo(), true);
  const redo = a.redoEdit()!;
  assert.equal(a.getParagraphText(0, 1), 'A한글CD');
  assert.deepEqual(redo.caret.position, changed.caret.position);
  assert.equal(redo.anchor, null);
  a.undoEdit();
  a.replaceText(selection(body), 'X');
  assert.equal(a.canRedo(), false);
  assert.equal(a.redoEdit(), null);
});

test('selection deletion plus split, backspace join and forward join undo atomically', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'abcd');
  const range = { from: { ...body, offset: 1 }, to: { ...body, offset: 3 } };
  const split = a.split(range)!;
  assert.equal(split.receipt.undo, 2);
  assert.deepEqual(split.caret.position, { ...body, para: 2 });
  assert.equal(a.getParagraphText(0, 1), 'a');
  assert.equal(a.getParagraphText(0, 2), 'd');
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 1), 'abcd');
  a.redoEdit();
  const joined = a.deleteBackward(selection(split.caret.position))!;
  assert.equal(a.getParagraphText(0, 1), 'ad');
  assert.equal(joined.caret.position.offset, 1);
  a.undoEdit();
  a.deleteForward(selection({ ...body, offset: 1 }));
  assert.equal(a.getParagraphText(0, 1), 'ad');
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 2), 'd');
});

test('nested cell edits preserve list addresses, normalized newlines, save and reopen', async t => {
  const a = await open(t);
  const table = a.paragraphs(0)[0].controls.find(c => c.kind === 'table')!;
  const steps = [{ para: 0, control: table.index, index: 0 }];
  const p = a.paragraphs(0, steps)[0];
  const at = { section: 0, steps, para: 0, offset: p.caret[0] };
  const before = p.text;
  const end = a.replaceText(selection(at), '가\t😀\r\n나\r다')!;
  assert.deepEqual(end.caret.position, { ...at, para: 2, offset: 1 });
  assert.equal(a.getParagraphText(0, 0, steps), '가\t😀');
  assert.equal(a.getParagraphText(0, 1, steps), '나');
  assert.equal(a.getParagraphText(0, 2, steps), '다' + before);
  reopened(a.serialize(false), doc => {
    const ps = JSON.parse(doc.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0, steps } })));
    assert.deepEqual(ps.slice(0, 3).map(p => p.text), ['가\t😀', '나', '다' + before]);
  });
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 0, steps), before);
  assert.equal(a.state().dirty, false);
});

test('wire controls stay indivisible and the leading section/column controls survive deletion', async t => {
  const a = await open(t);
  const p = a.paragraphs(0)[0];
  const at = { section: 0, para: 0, offset: p.caret[0] };
  const before = a.state();
  assert.equal(a.deleteBackward(selection(at)), null);
  assert.deepEqual(a.state(), before);
  const removed = a.deleteForward(selection(at))!;
  assert.equal(removed.caret.position.offset, 16);
  assert.deepEqual(a.paragraphs(0)[0].controls.map(c => c.kind), ['section', 'columns']);
  a.undoEdit();
  assert.deepEqual(a.paragraphs(0)[0], p);
});

test('reversed paragraph-spanning replacement and HWP5 edit serialization reopen correctly', async t => {
  const a = await open(t, hwp());
  const initial = a.getParagraphText(0, 1);
  a.replaceText(selection(body), 'alpha\nbeta\ngamma');
  const range = { from: { ...body, para: 3, offset: 2 }, to: { ...body, offset: 2 } };
  const result = a.replaceText(range, '😀\t')!;
  assert.equal(a.getParagraphText(0, 1), 'al😀\tmma' + initial);
  assert.equal(result.caret.position.offset, 12);
  assert.equal(result.receipt.undo, 2);
  const out = a.serialize(false);
  assert.deepEqual([...out.slice(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  reopened(out, doc => {
    const ps = JSON.parse(doc.query(JSON.stringify({ kind: 'paragraphs', list: { section: 0 } })));
    assert.equal(ps[1].text, 'al😀\tmma' + initial);
  });
  const undone = a.undoEdit()!;
  assert.deepEqual(undone.anchor!.position, range.from);
  assert.deepEqual(undone.caret.position, range.to);
  assert.deepEqual(a.paragraphs(0, [], 1, 3).map(p => p.text), ['alpha', 'beta', 'gamma' + initial]);
});

test('boundary and empty no-ops do not enter undo or increase the content epoch', async t => {
  const a = await open(t);
  const before = a.state();
  const end = { ...body, offset: a.paragraphs(0)[1].caret[1] };
  assert.equal(a.deleteForward(selection(end)), null);
  assert.equal(a.replaceText(selection(body), ''), null);
  assert.equal(a.undoEdit(), null);
  assert.equal(a.redoEdit(), null);
  assert.deepEqual(a.state(), before);
});

test('빈 문단을 만드는 Enter는 엔진 조판 수정 전까지 내용과 이력을 바꾸지 않는다', async t => {
  const a = await open(t);
  a.replaceText(selection(body), '한글');
  const before = a.state();
  for (const offset of [0, 2]) {
    assert.throws(() => a.split(selection({ ...body, offset })), { code: 'ENGINE_NOT_SUPPORTED' });
  }
  assert.throws(() => a.replaceText(selection(body), '\n'), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.equal(a.getParagraphText(0, 1), '한글');
  assert.deepEqual(a.state(), before);
});

test('failed native second operation rolls back content and engine history', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'rollback');
  a.undoEdit();
  const before = a.state();
  // 엔진 경계에만 실패를 주입한다. 실제 Doc.transact가 앞선 insert를 되돌려야 한다.
  const doc = (a as any).doc;
  const transact = doc.transact.bind(doc);
  doc.transact = (request: string) => {
    const req = JSON.parse(request);
    req.ops.push({ op: 'insertText', at: { ...body, para: 999999 }, text: 'bad' });
    return transact(JSON.stringify(req));
  };
  assert.throws(() => a.replaceText(selection(body), 'changed'), e => e.code === 'BAD_ADDRESS');
  assert.deepEqual(a.state(), before);
  assert.equal(a.getParagraphText(0, 1), '');
  assert.equal(a.canRedo(), true);
  doc.transact = transact;
  a.redoEdit();
  assert.equal(a.getParagraphText(0, 1), 'rollback');
});

test('unsupported scopes and invalid input fail before mutation', async t => {
  const a = await open(t);
  const before = a.state();
  assert.throws(() => a.replaceText({ from: body, to: { ...body, section: 1 } }, 'x'), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.replaceText(selection({ ...body, offset: 0.5 }), 'x'), { code: 'BAD_ADDRESS' });
  assert.throws(() => a.replaceText(selection(body), '\0'), { code: 'BAD_REQUEST' });
  assert.throws(() => a.replaceText(selection(body), '\ud800'), { code: 'BAD_REQUEST' });
  assert.deepEqual(a.state(), before);
  // 생략한 steps와 빈 배열은 같은 body list다.
  assert.equal(replacementOps({ from: body, to: { ...body, steps: [] } }, '').length, 0);
});

test('save acknowledgement preserves revisions, protects concurrent edits and tracks clean undo', async t => {
  const a = await open(t);
  const original = hwpx();
  const oldDigest = a.documentDigest;
  a.replaceText(selection(body), 'first');
  const first = a.serialize(false);
  assert.equal(a.state().dirty, true);
  assert.equal(a.documentDigest, oldDigest);
  a.replaceText(selection(body), 'later');
  assert.equal(a.markSaved(), false);
  assert.equal(a.state().dirty, true);
  assert.equal(a.documentDigest, oldDigest);
  a.undoEdit();
  assert.equal(a.state().dirty, true);
  const saved = a.serialize(false);
  assert.deepEqual(saved, first);
  const epoch = a.state().contentEpoch;
  assert.equal(a.markSaved(), true);
  assert.equal(a.state().contentEpoch, epoch);
  assert.equal(a.state().dirty, false);
  assert.equal(a.documentDigest, `blake3:${blake3Hex(saved)}`);
  a.undoEdit();
  assert.equal(a.state().dirty, true);
  a.redoEdit();
  assert.equal(a.state().dirty, false);
  assert.deepEqual(a.serialize(false), saved);
  a.loadDocument(original);
  assert.equal(a.markSaved(), false);
  assert.equal(a.canUndo(), false);
  assert.equal(a.canRedo(), false);
  a.releaseDocument();
  assert.equal(a.readOnly, true);
});

test('HWP3 stays read only because native same-format serialization is unavailable', async t => {
  const a = await open(t, fixture('fuzz/corpus/parse_hwp3/hwp3-sample.hwp'));
  assert.equal(a.state().format, 'hwp3');
  assert.equal(a.readOnly, true);
  assert.throws(() => a.replaceText(selection(body), 'x'), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.serialize(false), { code: 'ENGINE_NOT_SUPPORTED' });
});
