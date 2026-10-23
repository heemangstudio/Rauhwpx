import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { inflateRawSync } from 'node:zlib';
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

function zipXml(bytes: Uint8Array, name: string): string {
  const zip = Buffer.from(bytes);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const length = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    if (zip.subarray(at + 46, at + 46 + length).toString() === name) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(start, start + zip.readUInt32LE(at + 20));
      return (zip.readUInt16LE(at + 10) === 0 ? compressed : inflateRawSync(compressed)).toString();
    }
    at += 46 + length + extra + comment;
  }
  throw new Error(`Missing ${name}`);
}

function assertRestored(a: InstanceType<typeof HeemangAdapter>, before: ReturnType<InstanceType<typeof HeemangAdapter>['state']>) {
  const after = a.state();
  assert.deepEqual({ ...after, contentEpoch: before.contentEpoch, layoutEpoch: before.layoutEpoch }, before);
  assert.ok(after.contentEpoch > before.contentEpoch); // native restore는 revision을 올린다.
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
  assertRestored(a, before);
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

test('character formatting preserves the directed selection without a receipt caret and survives save/reopen', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'A😀\tB');
  const range: TextSelection = { from: { ...body, offset: 12 }, to: { ...body, offset: 1 }, fromAffinity: 'upstream' };
  const result = a.formatCharacters(range, { bold: true, italic: true, underline: true, size: 1500, color: 0x332211 })!;
  assert.equal(result.receipt.undo, 2);
  assert.equal(result.receipt.caret, undefined);
  assert.deepEqual(result.anchor!.position, range.from);
  assert.equal(result.anchor!.affinity, 'upstream');
  assert.deepEqual(result.caret.position, range.to);
  const styled = a.copyText(range);
  assert.equal(styled.text, '😀\tB');
  for (const css of ['font-weight:bold', 'font-style:italic', 'text-decoration:underline', 'font-size:15pt', 'color:#112233']) {
    assert.ok(styled.html.includes(css), css);
  }
  assert.ok(!a.copyText({ from: body, to: range.to }).html.includes('font-weight:bold'));
  reopened(a.serialize(false), doc => {
    assert.deepEqual(JSON.parse(doc.copy(JSON.stringify({ from: range.to, to: range.from }))), styled);
  });
  const undo = a.undoEdit()!;
  assert.deepEqual(undo.anchor!.position, range.from);
  assert.deepEqual(undo.caret.position, range.to);
  assert.ok(!a.copyText(range).html.includes('font-weight:bold'));
  a.redoEdit();
  assert.deepEqual(a.copyText(range), styled);
  a.undoEdit();
  const before = a.state();
  assert.equal(a.formatCharacters(range, {}), null);
  assert.throws(() => a.formatCharacters(selection(body), { bold: true }), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.formatCharacters(range, { bold: true, fontFamily: 'Arial' } as any), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.formatCharacters(range, { size: NaN }), { code: 'BAD_REQUEST' });
  assert.throws(() => a.formatCharacters(range, { bold: null } as any), { code: 'BAD_REQUEST' });
  assert.deepEqual(a.state(), before);
});

test('paragraph formatting applies every patch field to endpoint paragraphs and accepts a collapsed caret', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'first\nlast');
  const range = { from: { ...body, para: 2, offset: 2 }, to: { ...body, offset: 2 } };
  const patch = { align: 'center', left: 200, indent: -100, spaceBefore: 300, spaceAfter: 400, lineSpacing: 180 } as const;
  const formatted = a.formatParagraphs(range, patch)!;
  assert.equal(formatted.receipt.undo, 2);
  assert.equal(formatted.receipt.caret, undefined);
  assert.deepEqual(formatted.anchor!.position, range.from);
  assert.deepEqual(formatted.caret.position, range.to);
  const bytes = a.serialize(false);
  const ids = [...zipXml(bytes, 'Contents/section0.xml').matchAll(/<hp:p\b[^>]*paraPrIDRef="(\d+)"/g)].slice(-2).map(m => m[1]);
  const header = zipXml(bytes, 'Contents/header.xml');
  for (const id of ids) {
    const shape = header.match(new RegExp(`<hh:paraPr\\b[^>]*id="${id}"[^>]*>[\\s\\S]*?</hh:paraPr>`))![0];
    for (const property of ['horizontal="CENTER"', '<hc:left value="200"', '<hc:intent value="-100"', '<hc:prev value="300"', '<hc:next value="400"', 'type="PERCENT" value="180"']) {
      assert.ok(shape.includes(property), property);
    }
  }
  const centered = a.locate({ kind: 'caret', position: range.to })!;
  reopened(bytes, doc => assert.deepEqual(JSON.parse(doc.locate(JSON.stringify({ kind: 'caret', position: range.to }))), centered));
  a.undoEdit();
  const plain = a.locate({ kind: 'caret', position: range.to }) as any;
  assert.ok((centered as any).x > plain.x);
  a.redoEdit();
  assert.equal(a.formatParagraphs(selection(body), { align: 'left' })!.anchor, null);
  const before = a.state();
  assert.equal(a.formatParagraphs(range, {}), null);
  assert.throws(() => a.formatParagraphs(range, { right: 100 } as any), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.formatParagraphs(range, { lineSpacing: 0 }), { code: 'BAD_REQUEST' });
  assert.throws(() => a.formatParagraphs(range, { align: 'invalid' } as any), { code: 'BAD_REQUEST' });
  assert.throws(() => a.formatParagraphs(selection({ ...body, offset: 999 }), patch), { code: 'BAD_ADDRESS' });
  assert.deepEqual(a.state(), before);
});

test('copy/cut and selected plain paste use native wire offsets and one undo group', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'A😀\tB\nCDE');
  const range = { from: { ...body, para: 2, offset: 2 }, to: { ...body, offset: 1 } };
  const before = a.state();
  assert.equal(a.copyText(range).text, '😀\tB\nCD');
  assert.deepEqual(a.state(), before);
  const cut = a.cutText(range);
  assert.equal(cut.clipboard.text, '😀\tB\nCD');
  assert.equal(cut.edit!.receipt.undo, 2);
  assert.equal(a.getParagraphText(0, 1), 'AE');
  const undo = a.undoEdit()!;
  assert.deepEqual(undo.anchor!.position, range.from);
  assert.deepEqual(undo.caret.position, range.to);
  const pasted = a.pasteText(range, '한\r\n글')!;
  assert.equal(pasted.receipt.undo, 2);
  assert.equal(a.getParagraphText(0, 1), 'A한');
  assert.equal(a.getParagraphText(0, 2), '글E');
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 1), 'A😀\tB');
  assert.equal(a.getParagraphText(0, 2), 'CDE');
  assert.equal(a.canRedo(), true);
  const noop = a.state();
  assert.deepEqual(a.copyText(selection(body)), { text: '', html: '' });
  assert.deepEqual(a.cutText(selection(body)), { clipboard: { text: '', html: '' }, edit: null });
  assert.deepEqual(a.state(), noop);
});

test('internal text paste retains styles, plain paste stays plain, and internal replacement rejects before mutation', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'bold plain');
  const bold = { from: body, to: { ...body, offset: 4 } };
  a.formatCharacters(bold, { bold: true });
  assert.equal(a.copyText(bold).text, 'bold');
  assert.equal(a.hasInternalClipboard(), true);
  const plainEnd = selection({ ...body, offset: 10 });
  const plain = a.pasteText(plainEnd, 'bold')!;
  assert.ok(!a.copyText({ from: plainEnd.to, to: plain.caret.position }).html.includes('font-weight:bold'));
  // 위 copy로 바뀐 native fragment를 원래 서식으로 다시 채운다.
  a.copyText(bold);
  const internal = a.pasteText(selection(plain.caret.position), 'bold', true)!;
  assert.equal(internal.receipt.undo, 4);
  assert.ok(a.copyText({ from: plain.caret.position, to: internal.caret.position }).html.includes('font-weight:bold'));
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 1), 'bold plainbold');
  const before = a.state();
  assert.throws(() => a.pasteText(bold, 'bold', true), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.pasteText(plainEnd, 'different', true), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.deepEqual(a.state(), before);
  a.redoEdit();
  assert.equal(a.getParagraphText(0, 1), 'bold plainboldbold');
});

test('search returns actual UTF-16/tab/nested-list matches and replacement rejects stale epochs', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'A😀\tAb aB');
  const table = a.paragraphs(0)[0].controls.find(c => c.kind === 'table')!;
  const at = { section: 0, steps: [{ para: 0, control: table.index, index: 0 }], para: 0, offset: 0 };
  a.replaceText(selection(at), 'Ab😀');
  const found = a.search('ab');
  assert.deepEqual(found.matches, [
    { from: { ...body, offset: 11 }, to: { ...body, offset: 13 } },
    { from: { ...body, offset: 14 }, to: { ...body, offset: 16 } },
    { from: at, to: { ...at, offset: 2 } },
  ]);
  assert.equal(a.search('Ab', true).matches.length, 2);
  assert.deepEqual(a.search('😀\t', true).matches, [{ from: { ...body, offset: 1 }, to: { ...body, offset: 11 } }]);
  const replaced = a.replaceMatch(found.matches[2], '한\t', found.contentEpoch)!;
  assert.deepEqual(replaced.caret.position, { ...at, offset: 9 });
  assert.equal(a.getParagraphText(0, 0, at.steps).startsWith('한\t😀'), true);
  const before = a.state();
  assert.throws(() => a.replaceMatch(found.matches[0], 'x', found.contentEpoch), { code: 'STALE_EPOCH' });
  assert.deepEqual(a.state(), before);
  a.undoEdit();
  assert.ok(a.getParagraphText(0, 0, at.steps).startsWith('Ab😀'));
});

test('replaceAll crosses body/cell lists in one group, restores selection and does not truncate at 1000', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'qZ '.repeat(1005));
  const table = a.paragraphs(0)[0].controls.find(c => c.kind === 'table')!;
  const at = { section: 0, steps: [{ para: 0, control: table.index, index: 0 }], para: 0, offset: 0 };
  a.replaceText(selection(at), 'qZ qZ');
  const before = a.state();
  const range = { from: { ...body, offset: 3 }, to: body };
  assert.equal(a.search('qZ', true).matches.length, 1007);
  const result = a.replaceAll('qZ', '😀\t', true, range);
  assert.equal(result.count, 1007);
  assert.equal(result.edit!.receipt.undo, before.undo + 1);
  assert.equal(a.getParagraphText(0, 1), '😀\t '.repeat(1005));
  assert.ok(a.getParagraphText(0, 0, at.steps).startsWith('😀\t 😀\t'));
  assert.equal(a.search('qZ', true).matches.length, 0);
  const undo = a.undoEdit()!;
  assert.deepEqual(undo.anchor!.position, range.from);
  assert.deepEqual(undo.caret.position, range.to);
  assert.equal(a.getParagraphText(0, 1), 'qZ '.repeat(1005));
  a.redoEdit();
  assert.equal(a.getParagraphText(0, 1), '😀\t '.repeat(1005));
  const noop = a.state();
  assert.deepEqual(a.replaceAll('absent', 'x'), { count: 0, edit: null });
  assert.deepEqual(a.replaceAll('', 'x'), { count: 0, edit: null });
  assert.deepEqual(a.state(), noop);
});

test('all mutations including undo/redo roll back native history and content when post-mutation caret lookup fails', async t => {
  for (const action of ['replace', 'characters', 'paragraphs', 'cut', 'plain-paste', 'internal-paste', 'replace-match', 'replace-all', 'undo', 'redo']) {
    const a = await open(t);
    a.replaceText(selection(body), 'seed');
    a.replaceText(selection(body), 'redo');
    a.undoEdit();
    const range = { from: body, to: { ...body, offset: 4 } };
    a.copyText(range);
    const before = a.state();
    const bytes = a.serialize(false);
    const doc = (a as any).doc;
    const locate = doc.locate.bind(doc);
    doc.locate = () => 'null';
    const run = () => {
      switch (action) {
        case 'replace': return a.replaceText(range, 'changed');
        case 'characters': return a.formatCharacters(range, { bold: true });
        case 'paragraphs': return a.formatParagraphs(range, { align: 'center' });
        case 'cut': return a.cutText(range);
        case 'plain-paste': return a.pasteText(range, 'changed');
        case 'internal-paste': return a.pasteText(selection(body), 'seed', true);
        case 'replace-match': return a.replaceMatch(range, 'changed', before.contentEpoch);
        case 'replace-all': return a.replaceAll('seed', 'changed');
        case 'undo': return a.undoEdit();
        case 'redo': return a.redoEdit();
      }
    };
    assert.throws(run, { code: 'ENGINE_NOT_SUPPORTED' }, action);
    doc.locate = locate;
    assertRestored(a, before);
    assert.equal(a.getParagraphText(0, 1), 'seed', action);
    assert.deepEqual(a.serialize(false), bytes, action);
    assert.equal(a.canUndo(), true, action);
    assert.equal(a.canRedo(), true, action);
    a.redoEdit();
    assert.equal(a.getParagraphText(0, 1), 'redoseed', action);
    a.undoEdit();
    a.undoEdit();
    assert.equal(a.state().dirty, false, action);
  }
});

test('a failed edit keeps an already serialized save candidate valid after checkpoint restore', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'save me');
  const bytes = a.serialize(false);
  const doc = (a as any).doc;
  const locate = doc.locate.bind(doc);
  doc.locate = () => 'null';
  assert.throws(() => a.replaceText(selection(body), 'bad'), { code: 'ENGINE_NOT_SUPPORTED' });
  doc.locate = locate;
  assert.equal(a.markSaved(), true);
  assert.equal(a.state().dirty, false);
  assert.equal(a.documentDigest, `blake3:${blake3Hex(bytes)}`);
  assert.deepEqual(a.serialize(false), bytes);
});

test('native internal clipboard inserts styled multiline text across document instances in one group', async t => {
  const source = await open(t);
  source.replaceText(selection(body), 'abc\n한글');
  const range = { from: body, to: { ...body, para: 2, offset: 2 } };
  source.formatCharacters(range, { italic: true, size: 1200 });
  const copied = source.copyText(range);
  const target = await open(t);
  target.replaceText(selection(body), 'target');
  const result = target.pasteText(selection(body), copied.text, true)!;
  assert.equal(result.receipt.undo, 2);
  assert.equal(target.getParagraphText(0, 1), 'abc');
  assert.equal(target.getParagraphText(0, 2), '한글target');
  const pasted = target.copyText({ from: body, to: result.caret.position });
  assert.equal(pasted.text, copied.text);
  assert.ok(pasted.html.includes('font-style:italic'));
  assert.ok(pasted.html.includes('font-size:12pt'));
  target.undoEdit();
  assert.equal(target.getParagraphText(0, 1), 'target');
  assert.equal(target.getParagraphCount(0), 2);
  target.redoEdit();
  assert.equal(target.getParagraphText(0, 2), '한글target');
});

test('native transaction failures restore derived format tables as well as text and history', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'format me');
  const range = { from: body, to: { ...body, offset: 9 } };
  const before = a.state();
  const bytes = a.serialize(false);
  const doc = (a as any).doc;
  const transact = doc.transact.bind(doc);
  doc.transact = (request: string) => {
    const req = JSON.parse(request);
    req.ops.push({ op: 'insertText', at: { ...body, para: 999999 }, text: 'bad' });
    return transact(JSON.stringify(req));
  };
  assert.throws(() => a.formatCharacters(range, { size: 2345, bold: true }), { code: 'BAD_ADDRESS' });
  assertRestored(a, before);
  assert.deepEqual(a.serialize(false), bytes);
  assert.throws(() => a.formatParagraphs(range, { align: 'center', left: 1234 }), { code: 'BAD_ADDRESS' });
  assertRestored(a, before);
  assert.deepEqual(a.serialize(false), bytes);
  assert.throws(() => a.replaceAll('m', 'changed'), { code: 'BAD_ADDRESS' });
  assertRestored(a, before);
  assert.deepEqual(a.serialize(false), bytes);
  doc.transact = transact;
  assert.equal(a.undoEdit()!.receipt.undo, 0);
  assert.equal(a.getParagraphText(0, 1), '');
});

test('an edit receipt missing its caret rolls back instead of recording a hidden action', async t => {
  const a = await open(t);
  const before = a.state();
  const doc = (a as any).doc;
  const transact = doc.transact.bind(doc);
  doc.transact = (request: string) => {
    const receipt = JSON.parse(transact(request));
    delete receipt.caret;
    return JSON.stringify(receipt);
  };
  assert.throws(() => a.pasteText(selection(body), 'hidden'), { code: 'ENGINE_NOT_SUPPORTED' });
  assertRestored(a, before);
  assert.equal(a.getParagraphText(0, 1), '');
  assert.equal(a.canUndo(), false);
  doc.transact = transact;
});

test('multiline replaceAll protects empty-paragraph limits and remains a single undo action', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'x qZqZ y');
  const before = a.state();
  assert.throws(() => a.replaceAll('qZ', '\n', true), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.deepEqual(a.state(), before);
  assert.equal(a.getParagraphText(0, 1), 'x qZqZ y');
  const replaced = a.replaceAll('qZ', '한\n글', true);
  assert.equal(replaced.count, 2);
  assert.equal(replaced.edit!.receipt.undo, before.undo + 1);
  assert.deepEqual(a.paragraphs(0, [], 1).map(p => p.text), ['x 한', '글한', '글 y']);
  a.undoEdit();
  assert.equal(a.getParagraphText(0, 1), 'x qZqZ y');
});

test('HWP5 formatting and replacement serialize with styles and reopen in the native engine', async t => {
  const a = await open(t, hwp());
  a.replaceText(selection(body), 'qZ😀\t');
  const range = { from: body, to: { ...body, offset: 12 } };
  a.formatCharacters(range, { bold: true, underline: true, color: 0x112233 });
  a.formatParagraphs(selection(body), { align: 'right' });
  assert.equal(a.replaceAll('qZ', '한글', true).count, 1);
  const copied = a.copyText(range);
  assert.equal(copied.text, '한글😀\t');
  assert.ok(copied.html.includes('font-weight:bold'));
  assert.ok(copied.html.includes('text-decoration:underline'));
  reopened(a.serialize(false), doc => {
    assert.deepEqual(JSON.parse(doc.copy(JSON.stringify(range))), copied);
  });
});


test('copy/cut reject object selections before discarding content or the existing clipboard fragment', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'keep clipboard');
  a.copyText({ from: body, to: { ...body, offset: 14 } });
  const before = a.state();
  const bytes = a.serialize(false);
  const table = { from: { section: 0, para: 0, offset: 16 }, to: { section: 0, para: 0, offset: 24 } };
  assert.throws(() => a.copyText(table), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.cutText(table), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.deepEqual(a.state(), before);
  assert.deepEqual(a.serialize(false), bytes);
  a.pasteText(selection(body), 'keep clipboard', true);
  assert.equal(a.getParagraphText(0, 1), 'keep clipboardkeep clipboard');
});


test('clipboard rejects soft breaks and special spaces before a lossy cut', async t => {
  const a = await open(t, readFileSync(new URL('./fixtures/heemang-clipboard.hwpx', import.meta.url)));
  const p = a.paragraphs(0, [], 1, 1)[0];
  assert.match(p.text, /A\nB/);
  const range = { from: body, to: { ...body, offset: p.caret[1] } };
  const before = a.state();
  const bytes = a.serialize(false);
  assert.throws(() => a.copyText(range), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.throws(() => a.cutText(range), { code: 'ENGINE_NOT_SUPPORTED' });
  assert.deepEqual(a.state(), before);
  assert.deepEqual(a.serialize(false), bytes);
});


test('find next and previous use native wire positions and wrap from the current selection', async t => {
  const a = await open(t);
  a.replaceText(selection(body), 'qZ 😀 qZ');
  const all = a.search('qZ', true).matches;
  assert.equal(all.length, 2);
  assert.deepEqual(a.search('qZ', true, all[0].to).matches, [all[1]]);
  assert.deepEqual(a.search('qZ', true, all[1].from, true).matches, [all[0]]);
  assert.deepEqual(a.search('qZ', true, all[1].to).matches, [all[0]]);
  assert.deepEqual(a.search('qZ', true, all[0].from, true).matches, [all[1]]);
});
