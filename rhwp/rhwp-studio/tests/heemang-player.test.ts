import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, decodeOutlines, Pictures, Player } from '../src/view/heemang-player.ts';
import { EngineNotSupportedError } from '../src/core/engine-support.ts';

function packet() {
  // HMPK/1: 한 사각형과 빈 LINE/GLYF 블록.
  const bytes = new Uint8Array(109);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0x4b504d48, true);
  v.setUint16(4, 1, true);
  v.setInt32(24, 59528, true); v.setInt32(28, 84188, true);
  v.setUint32(32, 3, true);
  [['PANT', 72, 25], ['LINE', 97, 8], ['GLYF', 105, 4]].forEach(([tag, offset, length], i) => {
    bytes.set(new TextEncoder().encode(String(tag)), 36 + i * 12);
    v.setUint32(40 + i * 12, Number(offset), true);
    v.setUint32(44 + i * 12, Number(length), true);
  });
  v.setUint32(72, 1, true); bytes[76] = 2;
  [100, 200, 300, 400, 0xff].forEach((n, i) => v.setInt32(77 + i * 4, n, true));
  return bytes;
}

test('Heemang packet preserves HU geometry and COLORREF paint records', () => {
  const p = decodePacket(packet());
  assert.equal(p.width, 59528);
  assert.deepEqual(p.ops, [{ op: 'rect', x: 100, y: 200, w: 300, h: 400, color: 0xff }]);
  assert.deepEqual(p.lines, []);
});

test('Heemang packet rejects incompatible, truncated and overlapping transfers', () => {
  const bytes = packet();
  assert.throws(() => decodePacket(bytes.slice(0, 90)), /overruns/);
  bytes[4] = 2;
  assert.throws(() => decodePacket(bytes), /packet version/);
  bytes[4] = 1;
  new DataView(bytes.buffer).setUint32(40, 12, true);
  assert.throws(() => decodePacket(bytes), /overlaps/);
});

test('Heemang packet rejects unknown paint instructions and oversized counts', () => {
  const bytes = packet();
  bytes[76] = 99;
  assert.throws(() => decodePacket(bytes), /unknown paint op/);
  bytes[76] = 2;
  new DataView(bytes.buffer).setUint32(72, 0xffffffff, true);
  assert.throws(() => decodePacket(bytes), /overruns/);
  assert.throws(() => decodeOutlines(new Uint8Array([1, 0, 0, 0])), /overruns/);
});

test('unavailable engine operations have one machine-readable error', () => {
  const error = new EngineNotSupportedError('exportHwpx');
  assert.equal(error.code, 'ENGINE_NOT_SUPPORTED');
  assert.equal(error.operation, 'exportHwpx');
  assert.ok(error instanceof Error);
});

function pictureSource(overrides = {}) {
  return { key: 'shared', mime: 'image/png', width: 1, height: 1,
    matrix: [10, 20, 30, 40, 50, 60], clip: null, ...overrides };
}

function pictureDoc(source = pictureSource(), bytes = new Uint8Array([1, 2, 3, 4])) {
  return { pictureSource: () => JSON.stringify(source), pictureBytes: () => bytes };
}

function installDecoder(t, decode) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: decode });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

test('picture preparation waits for decoding and shares the bitmap with the first paint', async t => {
  let finish;
  const bitmap = { close() {} };
  installDecoder(t, () => new Promise(resolve => { finish = resolve; }));
  const pictures = new Pictures(() => {});
  const doc = pictureDoc();
  const read = t.mock.method(doc, 'pictureBytes');
  let ready = false;
  const preparing = pictures.prepare(doc, 0, [7,7]).then(() => { ready = true; });
  t.mock.timers.runAll(); await Promise.resolve();
  assert.equal(read.mock.callCount(),1); assert.equal(ready,false);
  finish(bitmap); await preparing;
  assert.equal(pictures.get(doc,0,7).bitmap,bitmap);
  pictures.clear();
});

for (const state of ['queued', 'decoding']) {
  test(`picture preparation cancels ${state} reads without waiting on a replaced document`, async t => {
    let finish;
    installDecoder(t, () => new Promise(resolve => { finish = resolve; }));
    const pictures = new Pictures(() => {}), doc = pictureDoc();
    const read = t.mock.method(doc, 'pictureBytes');
    const preparing = pictures.prepare(doc,0,[7]);
    if (state === 'decoding') { t.mock.timers.runAll(); await Promise.resolve(); }
    pictures.clear(); await preparing;
    t.mock.timers.runAll(); assert.equal(read.mock.callCount(),state === 'queued' ? 0 : 1);
    if (finish) {
      const close = t.mock.fn(); finish({close}); await Promise.resolve();
      assert.equal(close.mock.callCount(),1);
    }
  });
}

for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/bmp']) {
  test(`pictures defer and share ${mime} decoding across pages while retaining placement`, async t => {
    const closed = t.mock.fn();
    const bitmap = { close: closed };
    const decode = t.mock.fn(async () => bitmap);
    installDecoder(t, decode);
    const ready = t.mock.fn();
    const pictures = new Pictures(ready);
    const bytes = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4);
    const doc = pictureDoc(pictureSource({ mime }), bytes);
    const read = t.mock.method(doc, 'pictureBytes');
    assert.equal(pictures.get(doc, 0, 7).bitmap, null);
    doc.pictureSource = () => JSON.stringify(pictureSource({ mime, matrix: [1, 2, 3, 4, 5, 6] }));
    assert.equal(pictures.get(doc, 1, 9).bitmap, null);
    assert.equal(read.mock.callCount(), 0);
    t.mock.timers.runAll();
    await Promise.resolve();
    assert.equal(read.mock.callCount(), 1);
    assert.deepEqual(read.mock.calls[0].arguments, [0, 7]);
    const [blob, options] = decode.mock.calls[0].arguments;
    assert.equal(blob.type, mime);
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual(options, { imageOrientation: 'none' });
    const result = pictures.get(doc, 1, 9);
    assert.equal(result.bitmap, bitmap);
    assert.deepEqual(result.source.matrix, [1, 2, 3, 4, 5, 6]);
    assert.equal(decode.mock.callCount(), 1);
    assert.equal(ready.mock.callCount(), 1);
    pictures.clear();
    pictures.clear();
    assert.equal(closed.mock.callCount(), 1);
  });
}

test('RGBA pictures decode through ImageData with exact pixels and dimensions', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class {
    data; width; height;
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'ImageData', original);
    else delete globalThis.ImageData;
  });
  const decode = t.mock.fn(async () => ({ close() {} }));
  installDecoder(t, decode);
  const pictures = new Pictures(() => {});
  const doc = pictureDoc(pictureSource({ mime: 'image/x-rgba', width: 2 }),
    new Uint8Array([9, 255, 0, 0, 255, 0, 255, 0, 128, 9]).subarray(1, 9));
  pictures.get(doc, 0, 0);
  t.mock.timers.runAll();
  await Promise.resolve();
  const [data] = decode.mock.calls[0].arguments;
  assert.ok(data instanceof ImageData);
  assert.deepEqual([...data.data], [255, 0, 0, 255, 0, 255, 0, 128]);
  assert.equal(data.width, 2);
  assert.equal(data.height, 1);
  pictures.clear();
});

test('clear cancels queued document reads and discards a stale decode with the same key', async t => {
  let resolve;
  const decode = t.mock.fn(() => new Promise(done => { resolve = done; }));
  installDecoder(t, decode);
  const ready = t.mock.fn();
  const pictures = new Pictures(ready);
  const doc = pictureDoc();
  const read = t.mock.method(doc, 'pictureBytes');
  pictures.get(doc, 0, 0);
  pictures.clear();
  t.mock.timers.runAll();
  assert.equal(read.mock.callCount(), 0);
  pictures.get(doc, 0, 0);
  t.mock.timers.runAll();
  pictures.clear();
  pictures.get(pictureDoc(), 0, 0);
  const close = t.mock.fn();
  resolve({ close });
  await Promise.resolve();
  assert.equal(close.mock.callCount(), 1);
  assert.equal(ready.mock.callCount(), 0);
  assert.equal(pictures.get(doc, 0, 0).bitmap, null);
  pictures.clear();
});

for (const failure of ['bytes', 'sync decode', 'async decode']) {
  test(`pictures fall back after ${failure} failure without retrying the decode`, async t => {
    const decode = t.mock.fn(() => {
      if (failure === 'sync decode') throw new Error('decode');
      return Promise.reject(new Error('decode'));
    });
    installDecoder(t, decode);
    const ready = t.mock.fn();
    const pictures = new Pictures(ready);
    const doc = pictureDoc();
    if (failure === 'bytes') doc.pictureBytes = () => { throw new Error('freed'); };
    pictures.get(doc, 0, 0);
    t.mock.timers.runAll();
    await Promise.resolve();
    assert.equal(pictures.get(doc, 0, 0), null);
    assert.equal(ready.mock.callCount(), 1);
    t.mock.timers.runAll();
    assert.equal(decode.mock.callCount(), failure === 'bytes' ? 0 : 1);
    pictures.clear();
  });
}

test('picture source errors and non-picture items use the patch fallback', () => {
  const pictures = new Pictures(() => assert.fail('unexpected decode'));
  for (const source of ['null', '{']) {
    assert.equal(pictures.get({ pictureSource: () => source, pictureBytes: () => assert.fail() }, 0, 0), null);
  }
  assert.equal(pictures.get({ pictureSource() { throw new Error('source'); }, pictureBytes: () => assert.fail() }, 0, 0), null);
});

test('player clips picture placement, skips pending pictures and preserves patch fallback', () => {
  const calls = [];
  const ctx = Object.fromEntries(['save', 'restore', 'setTransform', 'beginPath', 'moveTo', 'lineTo',
    'closePath', 'clip', 'drawImage'].map(name => [name, (...args) => calls.push([name, ...args])]));
  const player = new Player({});
  const p = decodePacket(packet());
  p.ops = [0, 1, 2].map(item => ({ op: 'patch', item, x: 100, y: 200, w: 300, h: 400 }));
  const bitmap = {};
  const fallback = {};
  const patch = (item, dpi) => { calls.push(['patch', item, dpi]); return fallback; };
  player.paint(ctx, p, 144, patch, item => item === 2 ? null : {
    source: pictureSource({ clip: [[100, 200], [300, 200], [300, 400]] }),
    bitmap: item === 0 ? bitmap : null,
  });
  assert.deepEqual(calls, [
    ['save'], ['setTransform', 1, 0, 0, 1, 0, 0], ['save'], ['beginPath'],
    ['moveTo', 2, 4], ['lineTo', 6, 4], ['lineTo', 6, 8], ['closePath'], ['clip'],
    ['setTransform', .2, .8, .4, 1, .6, 1.2], ['drawImage', bitmap, 0, 0, 1, 1], ['restore'],
    ['patch', 2, 144], ['drawImage', fallback, 2, 4, 6, 8], ['restore'],
  ]);
  assert.equal(ctx.imageSmoothingQuality, 'high');
  calls.length = 0;
  p.ops = p.ops.slice(0, 1);
  player.paint(ctx, p, 72, patch);
  assert.deepEqual(calls.filter(c => c[0] === 'patch' || c[0] === 'drawImage'), [
    ['patch', 0, 72], ['drawImage', fallback, 1, 2, 3, 4],
  ]);
});

test('glyph-run reuse preserves geometry across packet replacement, zoom and font refill', t => {
  const previous = new Map(['Path2D','DOMMatrix'].map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  class Path {
    commands = [];
    moveTo(...p) { this.commands.push(['move',...p]); }
    lineTo(...p) { this.commands.push(['line',...p]); }
    quadraticCurveTo(...p) { this.commands.push(['quad',...p]); }
    bezierCurveTo(...p) { this.commands.push(['cubic',...p]); }
    closePath() { this.commands.push(['close']); }
    addPath(path,matrix) { this.commands.push(['add',path.commands,matrix.values]); }
  }
  Object.defineProperty(globalThis,'Path2D',{configurable:true,value:Path});
  Object.defineProperty(globalThis,'DOMMatrix',{configurable:true,value:class { constructor(values) { this.values=values; } }});
  t.after(() => { for (const [name,descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name];
  } });
  const seed = (player,shape=10) => {
    for (const face of [2,3]) for (const glyph of [3,4]) player.outlines.set(`${face}:${glyph}`,{
      em:1000,cmds:new Float32Array([0,face,shape,1,glyph,shape+1,4]),
    });
  };
  const fresh = (shape=10) => { const player=new Player({}); player.load(decodePacket(packet())); seed(player,shape); return player; };
  const run = {face:2,size:1000,ratio:100,color:0,flags:0,baseline:100,glyphs:[[3,0],[4,500]]};
  const player=fresh(),cached=player.runPath(run,1);
  assert.equal(player.runPath(structuredClone(run),1),cached,'unchanged runs survive decoded packet replacement');
  for (const [patch,scale] of [[{face:3},1],[{size:1200},1],[{ratio:80},1],[{flags:2},1],
    [{baseline:130},1],[{glyphs:[[4,10],[3,520]]},1],[{},1.5],[{color:0xff},1]]) {
    const next={...run,...patch};
    assert.deepEqual(player.runPath(next,scale).commands,fresh().runPath(next,scale).commands);
  }
  const missing=fresh(); missing.outlines.delete('2:4');
  const partial=missing.runPath(run,1);
  const refill=decodePacket(packet()); refill.fontGeneration+=1; missing.load(refill); seed(missing);
  assert.notDeepEqual(missing.runPath(run,1).commands,partial.commands,'the newly available glyph is painted');
  assert.deepEqual(missing.runPath(run,1).commands,fresh().runPath(run,1).commands);
  const next=decodePacket(packet()); next.fontGeneration+=1; player.load(next); seed(player,40);
  const refilled=player.runPath(run,1);
  assert.notEqual(refilled,cached,'a font refill replaces retained composite outlines');
  assert.deepEqual(refilled.commands,fresh(40).runPath(run,1).commands);
});


test('page repaint region covers changed ops whole and keeps distant pixels, or asks for a full repaint', () => {
  const player = new Player({});
  const base = decodePacket(packet());
  player.load(base);
  for (const glyph of [3, 4]) player.outlines.set(`2:${glyph}`, { em: 1000, cmds: new Float32Array([0, 0, -200, 1, 600, 800, 4]) });
  const run = (baseline, glyphs) => ({ op: 'glyphs', face: 2, size: 2000, ratio: 100, color: 0, flags: 1, baseline, glyphs });
  const page = ops => ({ ...base, ops });
  const record = (p, patches = new Map()) => ({ packet: p, s: 0.01, patches });
  const box = op => player.opBox(op, 0.01);
  const rule = { op: 'rect', x: 1000, y: 30100, w: 50000, h: 20, color: 0 };
  const far = run(70000, [[3, 1000], [4, 3000]]);
  const before = page([run(30000, [[3, 1000], [4, 3000]]), rule, far]);
  const after = page([run(30000, [[3, 1000], [3, 2000], [4, 4000]]), rule, far]);
  const region = player.repaintRegion(record(before), record(after), 595, 841);
  const overlaps = b => region.some(r => b.x < r.x + r.w && r.x < b.x + b.w && b.y < r.y + r.h && r.y < b.y + b.h);
  const inside = b => region.some(r => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h);
  assert.ok(inside(box(before.ops[0])) && inside(box(after.ops[0])), 'old and new text are repainted');
  assert.ok(inside(box(rule)), 'an op crossing the change is repainted whole, never cut by the clip');
  assert.equal(overlaps(box(far)), false, 'distant unchanged text keeps its pixels');
  const shown = page([...after.ops, { op: 'patch', item: 1, x: 1000, y: 1000, w: 2000, h: 2000 }]);
  const state = (key, boxes) => new Map([[3, { key, boxes }]]);
  const at = [{ x: 10, y: 10, w: 20, h: 20 }], moved = [{ x: 400, y: 600, w: 20, h: 20 }];
  assert.deepEqual(player.repaintRegion(record(shown, state([new Uint8Array([1, 2])], at)),
    record(shown, state([new Uint8Array([1, 2])], at)), 595, 841), [], 'unchanged patch pixels are kept');
  const pixels = new Uint8Array(4103).fill(7);
  for (const k of [0, 2050, 4102]) {
    const changed = pixels.slice();
    changed[k] = 8;
    assert.deepEqual(player.repaintRegion(record(shown, state([pixels], at)), record(shown, state([changed], at)), 595, 841),
      at, `a patch whose byte ${k} changed repaints`);
  }
  assert.deepEqual(player.repaintRegion(record(shown, state([pixels], at)), record(shown, state([pixels.slice(1).subarray(0)], at)), 595, 841),
    at, 'a patch of another size repaints');
  assert.deepEqual(player.repaintRegion(record(shown, state(['decoded', null], at)), record(shown, state(['decoded', {}], moved)), 595, 841),
    [...at, ...moved], 'a picture repaints where it was and where it lands once decoded');
  const clip = { op: 'clip', x: 0, y: 0, w: 30000, h: 30000 };
  const full = [
    [before, { ...after, fontGeneration: after.fontGeneration + 1 }],
    [before, page([run(30000, [[9, 1000]]), rule, far])],
    [page([clip, ...after.ops]), page([{ ...clip, w: 20000 }, ...after.ops])],
    [after, page([...after.ops, { op: 'rect', x: 0, y: 0, w: 59528, h: 84188, color: 0xff }])],
  ];
  for (const [a, b] of full) assert.equal(player.repaintRegion(record(a), record(b), 595, 841), null);
});

test('deferred reads retry after relayout moves a different picture into the item', async t => {
  const bitmap = { close() {} };
  const decode = t.mock.fn(async () => bitmap);
  installDecoder(t, decode);
  const ready = t.mock.fn();
  const pictures = new Pictures(ready);
  let source = pictureSource({ key: 'before-layout' });
  const doc = { pictureSource: () => JSON.stringify(source), pictureBytes: t.mock.fn(() => new Uint8Array([2])) };
  pictures.get(doc, 0, 0);
  source = pictureSource({ key: 'after-layout' });
  t.mock.timers.runAll();
  await Promise.resolve();
  assert.equal(doc.pictureBytes.mock.callCount(), 0);
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(ready.mock.callCount(), 1);
  assert.equal(pictures.get(doc, 0, 0).bitmap, null);
  t.mock.timers.runAll();
  await Promise.resolve();
  assert.equal(doc.pictureBytes.mock.callCount(), 1);
  assert.equal(pictures.get(doc, 0, 0).bitmap, bitmap);
  assert.equal(ready.mock.callCount(), 2);
  pictures.clear();
});
