import type { Doc, Engine, PictureSource } from '../../vendor/hm-wasm/hm_wasm';

type GlyphRun = { face: number; size: number; ratio: number; color: number; flags: number; baseline: number; glyphs: number[][] };
type Op =
  | ({ op: 'glyphs' } & GlyphRun)
  | ({ op: 'outline'; width: number; dash: number[] } & GlyphRun)
  | { op: 'rect' | 'clip'; x: number; y: number; w: number; h: number; color?: number }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: number; dash: number }
  | { op: 'path'; fill: number; width: number; stroke: number; dash: number; roundCap: boolean; alpha: number; els: number[][] }
  | { op: 'patch'; item: number; x: number; y: number; w: number; h: number }
  | { op: 'unclip' };
export interface PacketLine { list: { section: number; steps: { para: number; control: number; index: number }[] }; para: number; line: number; y: number; height: number; baseline: number; stops: number[][] }
export interface PagePacket { version: number; page: number; contentEpoch: number; layoutEpoch: number; fontGeneration: number; width: number; height: number; ops: Op[]; lines: PacketLine[]; glyphs: Uint32Array }
type Outline = { em: number; cmds: Float32Array };
// Reference player for hm-wasm page packets: decodes a packet (see
// crates/hm-wasm/src/packet.rs) and paints it on a Canvas 2D context with
// glyph outlines as Path2D. Coordinates are page HU (7200 per inch).

const MAGIC = 0x4b504d48; // "HMPK"
export const PACKET_VERSION = 1;

class Reader {
  v: DataView;
  at: number;
  end: number;
  constructor(bytes: Uint8Array, offset = 0, end = bytes.byteLength) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = offset;
    this.end = end;
  }
  need(n: number) {
    if (this.at + n > this.end) throw new Error(`packet truncated at ${this.at}`);
  }
  u8() { this.need(1); return this.v.getUint8(this.at++); }
  u16() { this.need(2); const x = this.v.getUint16(this.at, true); this.at += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.at, true); this.at += 4; return x; }
  i32() { this.need(4); const x = this.v.getInt32(this.at, true); this.at += 4; return x; }
  f32() { this.need(4); const x = this.v.getFloat32(this.at, true); this.at += 4; return x; }
  count(size: number) {
    const n = this.u32();
    if (n * size > this.end - this.at) throw new Error(`count ${n} overruns the block`);
    return n;
  }
}

const tagName = (v: DataView, at: number) =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

function glyphs(r: Reader): GlyphRun {
  const run: GlyphRun = {
    face: r.u32(), size: r.i32(), ratio: r.i32(), color: r.u32(), flags: r.u8(), baseline: r.i32(), glyphs: [],
  };
  const n = r.count(6);
  run.glyphs = new Array(n);
  for (let k = 0; k < n; k++) run.glyphs[k] = [r.u16(), r.i32()];
  return run;
}

function paint(r: Reader): Op[] {
  const n = r.count(1);
  const ops = new Array<Op>(n);
  for (let k = 0; k < n; k++) {
    const tag = r.u8();
    switch (tag) {
      case 1: ops[k] = { op: 'glyphs', ...glyphs(r) }; break;
      case 2: ops[k] = { op: 'rect', x: r.i32(), y: r.i32(), w: r.i32(), h: r.i32(), color: r.u32() }; break;
      case 3: ops[k] = { op: 'line', x1: r.i32(), y1: r.i32(), x2: r.i32(), y2: r.i32(), width: r.i32(), color: r.u32(), dash: r.u8() }; break;
      case 4: {
        const p: Extract<Op, { op: 'path' }> = { op: 'path', fill: r.u32(), width: r.i32(), stroke: r.u32(), dash: r.u8(), roundCap: r.u8() === 1, alpha: r.u8(), els: [] };
        const m = r.count(1);
        const els = [];
        for (let j = 0; j < m; j++) {
          const verb = r.u8();
          const len = [2, 2, 6, 0][verb];
          if (len === undefined) throw new Error(`unknown path verb ${verb}`);
          const el = [verb];
          for (let q = 0; q < len; q++) el.push(r.i32());
          els.push(el);
        }
        p.els = els;
        ops[k] = p;
        break;
      }
      case 5: ops[k] = { op: 'patch', item: r.u32(), x: r.i32(), y: r.i32(), w: r.i32(), h: r.i32() }; break;
      case 6: {
        const run = glyphs(r);
        const width = r.i32();
        const m = r.count(4);
        const dash = [];
        for (let j = 0; j < m; j++) dash.push(r.i32());
        ops[k] = { op: 'outline', ...run, width, dash };
        break;
      }
      case 7: ops[k] = { op: 'clip', x: r.i32(), y: r.i32(), w: r.i32(), h: r.i32() }; break;
      case 8: ops[k] = { op: 'unclip' }; break;
      default: throw new Error(`unknown paint op ${tag} at ${r.at - 1}`);
    }
  }
  return ops;
}

function lines(r: Reader): PacketLine[] {
  const lists: PacketLine['list'][] = [];
  for (let n = r.count(8), k = 0; k < n; k++) {
    const section = r.u32();
    const steps = [];
    for (let m = r.count(12), j = 0; j < m; j++) steps.push({ para: r.u32(), control: r.u32(), index: r.u32() });
    lists.push({ section, steps });
  }
  const out: PacketLine[] = [];
  for (let n = r.count(28), k = 0; k < n; k++) {
    const list = r.u32();
    if (list >= lists.length) throw new Error(`line names list ${list}`);
    const line: PacketLine = { list: lists[list], para: r.u32(), line: r.u32(), y: r.i32(), height: r.i32(), baseline: r.i32(), stops: [] };
    const stops = [];
    for (let m = r.count(8), j = 0; j < m; j++) stops.push([r.u32(), r.i32()]);
    line.stops = stops;
    out.push(line);
  }
  return out;
}

function glyphList(r: Reader) {
  const n = r.count(8);
  const out = new Uint32Array(n * 2);
  for (let k = 0; k < n * 2; k++) out[k] = r.u32();
  return out;
}

/** Decodes and validates a page packet. Unknown blocks are kept raw. */
export function decodePacket(bytes: Uint8Array): PagePacket {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error('not a page packet');
  const version = r.u16();
  if (version !== PACKET_VERSION) throw new Error(`packet version ${version}, player reads ${PACKET_VERSION}`);
  r.u16();
  const header = {
    version, page: r.u32(), contentEpoch: r.u32(), layoutEpoch: r.u32(), fontGeneration: r.u32(),
    width: r.i32(), height: r.i32(),
  };
  const blocks: Record<string, { offset: number; length: number }> = {};
  for (let n = r.count(12), k = 0; k < n; k++) {
    const tag = tagName(r.v, r.at);
    r.at += 4;
    const offset = r.u32();
    const length = r.u32();
    if (blocks[tag]) throw new Error(`duplicate block ${tag}`);
    if (offset + length > bytes.byteLength) throw new Error(`block ${tag} overruns the packet`);
    blocks[tag] = { offset, length };
  }
  let end = r.at;
  for (const [tag, block] of Object.entries(blocks).sort((a, b) => a[1].offset - b[1].offset)) {
    if (block.offset < end) throw new Error(`block ${tag} overlaps the header or another block`);
    end = block.offset + block.length;
  }
  if (header.width <= 0 || header.height <= 0) throw new Error('invalid page dimensions');
  const read = <T>(tag: string, f: (r: Reader) => T): T | undefined => {
    const b = blocks[tag];
    if (!b) return undefined;
    const br = new Reader(bytes, b.offset, b.offset + b.length);
    const v = f(br);
    if (br.at !== br.end) throw new Error(`block ${tag} has ${br.end - br.at} bytes left over`);
    return v;
  };
  return {
    ...header,
    ops: read('PANT', paint) ?? [],
    lines: read('LINE', lines) ?? [],
    glyphs: read('GLYF', glyphList) ?? new Uint32Array(0),
  };
}

/** Decodes `Engine.glyphOutlines` output into `Map("face:glyph" -> {em, cmds})`. */
export function decodeOutlines(bytes: Uint8Array, into = new Map<string, Outline>()) {
  const r = new Reader(bytes);
  for (let n = r.count(16), k = 0; k < n; k++) {
    const face = r.u32();
    const glyph = r.u32();
    const em = r.f32();
    const m = r.count(4);
    const cmds = new Float32Array(m);
    for (let j = 0; j < m; j++) cmds[j] = r.f32();
    into.set(`${face}:${glyph}`, { em, cmds });
  }
  return into;
}

const DASHES = [null, [8, 4], [1, 2], [8, 3, 1, 3], [8, 3, 1, 3, 1, 3], [16, 6], [0, 2.5]];
const KEPT_RUN_PATHS = 256;
const KEPT_RUN_GLYPHS = 4096;

/** Integer device-pixel box. */
export type Box = { x: number; y: number; w: number; h: number };
/** What a patch op showed: where it lands and the picture or pixels drawn, compared value by value. */
export type PatchState = { boxes: Box[]; key: unknown[] };
/**
 * What a page canvas last received from `Player.paint`, kept to repaint only
 * what changed: patch states by op index and, once computed, each op's box.
 */
export type PaintRecord = { packet: PagePacket; s: number; patches: Map<number, PatchState>; boxes?: (Box | null)[] };
// Antialiasing reaches past exact geometry; strokes use the Canvas 2D default miter limit.
const AA_GUARD = 2;
const MITER_LIMIT = 10;
// Repainting most of the page costs about as much as repainting all of it.
const MAX_REPAINT_SHARE = 0.5;

function deviceBox(x0: number, y0: number, x1: number, y1: number, margin: number): Box | null {
  if (!(x0 <= x1 && y0 <= y1)) return null;
  const x = Math.floor(x0 - margin - AA_GUARD), y = Math.floor(y0 - margin - AA_GUARD);
  return { x, y, w: Math.ceil(x1 + margin + AA_GUARD) - x, h: Math.ceil(y1 + margin + AA_GUARD) - y };
}

function sameOp(a: Op, b: Op): boolean {
  if (a === b) return true;
  if (a.op !== b.op) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  if (Object.keys(x).length !== Object.keys(y).length) return false;
  for (const key in x) {
    const u = x[key], v = y[key];
    if (u === v) continue;
    if (!Array.isArray(u) || !Array.isArray(v) || u.length !== v.length) return false;
    for (let k = 0; k < u.length; k++) {
      const p = u[k], q = v[k];
      if (p === q) continue;
      if (!Array.isArray(p) || !Array.isArray(q) || p.length !== q.length || p.some((n, i) => n !== q[i])) return false;
    }
  }
  return true;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}

function sameKey(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((u, k) => {
    const v = b[k];
    if (u === v) return true;
    return u instanceof Uint8Array && v instanceof Uint8Array && u.length === v.length && u.every((n, i) => n === v[i]);
  });
}

/** Unions touching boxes until none touch, so each can be repainted under one rectangular clip. */
function mergeBoxes(boxes: Box[]): Box[] {
  const out = boxes.slice();
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = out.length - 1; j > i; j--) {
        const a = out[i], b = out[j];
        if (a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        out.splice(j, 1);
        merged = true;
      }
    }
  }
  return out;
}

function clipStack(ops: Op[], end: number): Op[] {
  const stack: Op[] = [];
  for (let k = 0; k < end; k++) {
    if (ops[k].op === 'clip') stack.push(ops[k]);
    else if (ops[k].op === 'unclip') stack.pop();
  }
  return stack;
}

export const css = (colorref: number) =>
  `rgb(${colorref & 255},${(colorref >> 8) & 255},${(colorref >> 16) & 255})`;

export type Picture = { source: PictureSource; bitmap: ImageBitmap | null };
type PictureEntry = { bitmap: ImageBitmap | null; failed: boolean; promise: Promise<void>; finish: () => void; timer?: ReturnType<typeof setTimeout> };

/** Browser-decoded pictures shared by a document's pages. Clear before switching documents. */
export class Pictures {
  private entries = new Map<string, PictureEntry>();
  private generation = 0;
  private ready: () => void;
  constructor(ready: () => void) { this.ready = ready; }

  get(doc: Pick<Doc, 'pictureSource' | 'pictureBytes'>, page: number, item: number): Picture | null {
    let source: PictureSource | null;
    try {
      source = JSON.parse(doc.pictureSource(page, item));
    } catch {
      return null;
    }
    if (!source) return null;
    let entry = this.entries.get(source.key);
    if (!entry) {
      let finish!: () => void;
      const promise = new Promise<void>(resolve => { finish = resolve; });
      const pending: PictureEntry = { bitmap: null, failed: false, promise, finish };
      entry = pending;
      this.entries.set(source.key, pending);
      // Defer byte extraction and decoding until after the first paint.
      pending.timer = setTimeout(async () => {
        pending.timer = undefined;
        try {
          // Font registration may have moved a different picture into this item.
          const current = JSON.parse(doc.pictureSource(page, item)) as PictureSource | null;
          if (current?.key !== source.key) {
            this.entries.delete(source.key);
            this.ready();
            return;
          }
          const bytes = doc.pictureBytes(page, item);
          const bitmap = source.mime === 'image/x-rgba'
            ? await createImageBitmap(new ImageData(new Uint8ClampedArray(bytes), source.width, source.height))
            : await createImageBitmap(new Blob([bytes.slice()], { type: source.mime }), { imageOrientation: 'none' });
          if (this.entries.get(source.key) !== pending) {
            bitmap.close();
            return;
          }
          pending.bitmap = bitmap;
        } catch {
          if (this.entries.get(source.key) !== pending) return;
          pending.failed = true;
        } finally {
          pending.finish();
        }
        this.ready();
      }, 0);
    }
    return entry.failed ? null : { source, bitmap: entry.bitmap };
  }

  async prepare(doc: Pick<Doc, 'pictureSource' | 'pictureBytes'>, page: number, items: number[]): Promise<void> {
    const generation = this.generation;
    while (generation === this.generation) {
      const pending: Promise<void>[] = [];
      for (const item of items) {
        const picture = this.get(doc, page, item);
        if (picture && !picture.bitmap) pending.push(this.entries.get(picture.source.key)!.promise);
      }
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  clear() {
    this.generation++;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.finish();
      entry.bitmap?.close();
    }
    this.entries.clear();
  }
}

/**
 * Paints decoded packets. `engine` supplies glyph outlines; `patch(page,
 * item, dpi)` returns pixel patches (`Doc.patch`).
 */
export class Player {
  engine: Engine;
  outlines: Map<string, Outline>;
  paths: Map<string, { em: number; path: Path2D }>;
  generation: number;
  private readonly runPaths = new Map<string, { path: Path2D; glyphs: number }>();
  // Glyph boxes [em, x0, y0, x1, y1] in font units; null when the outline draws nothing.
  private readonly glyphBoxes = new Map<string, number[] | null>();
  private retainedRunGlyphs = 0;
  constructor(engine: Engine) {
    this.engine = engine;
    this.outlines = new Map();
    this.paths = new Map();
    this.generation = -1;
  }

  /** Fetches the outlines a packet needs that are not cached yet. */
  load(packet: PagePacket) {
    if (packet.fontGeneration !== this.generation || this.outlines.size > 8192) {
      this.outlines.clear();
      this.paths.clear();
      this.runPaths.clear();
      this.glyphBoxes.clear();
      this.retainedRunGlyphs = 0;
      this.generation = packet.fontGeneration;
    }
    const g = packet.glyphs;
    const missing = [];
    for (let k = 0; k < g.length; k += 2) {
      if (!this.outlines.has(`${g[k]}:${g[k + 1]}`)) missing.push(g[k], g[k + 1]);
    }
    if (missing.length) decodeOutlines(this.engine.glyphOutlines(new Uint32Array(missing)).slice(), this.outlines);
  }

  glyphPath(face: number, glyph: number) {
    const key = `${face}:${glyph}`;
    let p = this.paths.get(key);
    if (p) return p;
    const o = this.outlines.get(key);
    p = { em: o?.em ?? 0, path: new Path2D() };
    const c = o?.cmds ?? [];
    for (let k = 0; k < c.length;) {
      switch (c[k++]) {
        case 0: p.path.moveTo(c[k], c[k + 1]); k += 2; break;
        case 1: p.path.lineTo(c[k], c[k + 1]); k += 2; break;
        case 2: p.path.quadraticCurveTo(c[k], c[k + 1], c[k + 2], c[k + 3]); k += 4; break;
        case 3: p.path.bezierCurveTo(c[k], c[k + 1], c[k + 2], c[k + 3], c[k + 4], c[k + 5]); k += 6; break;
        default: p.path.closePath();
      }
    }
    this.paths.set(key, p);
    return p;
  }

  /** The device path of a glyph run at `s` pixels per HU. */
  runPath(run: GlyphRun, s: number) {
    const key = run.glyphs.length <= KEPT_RUN_GLYPHS
      ? JSON.stringify([s, run.face, run.size, run.ratio, run.flags & 2, run.baseline, run.glyphs]) : null;
    const cached = key !== null && this.runPaths.get(key);
    if (key !== null && cached) {
      this.runPaths.delete(key);
      this.runPaths.set(key, cached);
      return cached.path;
    }
    const out = this.buildRunPath(run, s);
    if (key !== null) {
      this.runPaths.set(key, { path: out, glyphs: run.glyphs.length });
      this.retainedRunGlyphs += run.glyphs.length;
      // Composite paths copy glyph geometry, so bound both runs and glyphs retained.
      while (this.runPaths.size > KEPT_RUN_PATHS || this.retainedRunGlyphs > KEPT_RUN_GLYPHS) {
        const oldest = this.runPaths.keys().next().value!;
        this.retainedRunGlyphs -= this.runPaths.get(oldest)!.glyphs;
        this.runPaths.delete(oldest);
      }
    }
    return out;
  }

  private buildRunPath(run: GlyphRun, s: number): Path2D {
    const out = new Path2D();
    const skew = run.flags & 2 ? 0.2 : 0;
    for (const [glyph, x] of run.glyphs) {
      const { em, path } = this.glyphPath(run.face, glyph);
      if (!em) continue;
      const k = (run.size * s) / em;
      const m = new DOMMatrix([(k * run.ratio) / 100, 0, k * skew, -k, x * s, run.baseline * s]);
      out.addPath(path, m);
    }
    return out;
  }

  /** Control-point box of a glyph outline, null when it draws nothing, undefined when not loaded. */
  private glyphBox(face: number, glyph: number): number[] | null | undefined {
    const key = `${face}:${glyph}`;
    let b = this.glyphBoxes.get(key);
    if (b !== undefined) return b;
    const o = this.outlines.get(key), c = o?.cmds;
    if (!o) return undefined;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; c && k < c.length;) {
      const command = c[k++];
      const points = command === 0 || command === 1 ? 1 : command === 2 ? 2 : command === 3 ? 3 : 0;
      for (let n = 0; n < points; n++, k += 2) {
        x0 = Math.min(x0, c[k]); x1 = Math.max(x1, c[k]);
        y0 = Math.min(y0, c[k + 1]); y1 = Math.max(y1, c[k + 1]);
      }
    }
    b = o?.em && x0 <= x1 ? [o.em, x0, y0, x1, y1] : null;
    this.glyphBoxes.set(key, b);
    return b;
  }

  /** Device pixels `paint` may touch for a run, from the same transform `buildRunPath` uses. */
  private runBox(run: GlyphRun, s: number, margin: number): Box | null | undefined {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const skew = run.flags & 2 ? 0.2 : 0;
    for (const [glyph, x] of run.glyphs) {
      const b = this.glyphBox(run.face, glyph);
      if (b === undefined) return undefined;
      if (!b) continue;
      const k = (run.size * s) / b[0], a = (k * run.ratio) / 100, c = k * skew;
      // Extremes of a linear map over the box come from its corners, one axis at a time.
      x0 = Math.min(x0, x * s + Math.min(a * b[1], a * b[3]) + Math.min(c * b[2], c * b[4]));
      x1 = Math.max(x1, x * s + Math.max(a * b[1], a * b[3]) + Math.max(c * b[2], c * b[4]));
      y0 = Math.min(y0, run.baseline * s + Math.min(-k * b[2], -k * b[4]));
      y1 = Math.max(y1, run.baseline * s + Math.max(-k * b[2], -k * b[4]));
    }
    return deviceBox(x0, y0, x1, y1, margin);
  }

  /**
   * Device pixels `paint` may touch for `op` at `s` pixels per HU, null when it
   * draws nothing and undefined when a glyph outline is not loaded. Patches
   * report their packet box.
   */
  opBox(op: Op, s: number): Box | null | undefined {
    const px = (v: number) => v * s;
    switch (op.op) {
      case 'glyphs':
        return this.runBox(op, s, op.flags & 1 ? ((op.size * s) / (op.flags & 4 ? 1000 : 40) / 2) * MITER_LIMIT : 0);
      case 'outline':
        return this.runBox(op, s, Math.max(px(op.width), 0.5) / 2);
      case 'rect':
        return deviceBox(px(op.x), px(op.y), px(op.x) + Math.max(px(op.w), 0.5), px(op.y) + Math.max(px(op.h), 0.5), 0);
      case 'line':
        return deviceBox(Math.min(px(op.x1), px(op.x2)), Math.min(px(op.y1), px(op.y2)),
          Math.max(px(op.x1), px(op.x2)), Math.max(px(op.y1), px(op.y2)), Math.max(px(op.width), 0.5));
      case 'path': {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const e of op.els) {
          for (let k = 1; k + 1 < e.length; k += 2) {
            x0 = Math.min(x0, px(e[k])); x1 = Math.max(x1, px(e[k]));
            y0 = Math.min(y0, px(e[k + 1])); y1 = Math.max(y1, px(e[k + 1]));
          }
        }
        return deviceBox(x0, y0, x1, y1, op.width >= 0 ? (Math.max(px(op.width), 0.5) / 2) * MITER_LIMIT : 0);
      }
      case 'patch':
        return deviceBox(Math.min(px(op.x), px(op.x + op.w)), Math.min(px(op.y), px(op.y + op.h)),
          Math.max(px(op.x), px(op.x + op.w)), Math.max(px(op.y), px(op.y + op.h)), 0);
      default:
        return null;
    }
  }

  /** Where a patch op lands: its packet box and, for a browser-decoded picture, the placed image. */
  patchBoxes(op: Op & { op: 'patch' }, s: number, picture: Picture | null): Box[] {
    const out: Box[] = [];
    const own = this.opBox(op, s);
    if (own) out.push(own);
    const m = picture?.source.matrix;
    if (!m) return out;
    const [a, b, c, d, e, f] = m;
    const xs = [c, a + c, b + c, a + b + c].map(v => v * s), ys = [f, d + f, e + f, d + e + f].map(v => v * s);
    const box = deviceBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 0);
    if (box) out.push(box);
    return out;
  }

  /** The device box of op `k` in `record`, a patch from its state. */
  private recordBox(record: PaintRecord, k: number): Box | null | undefined {
    const state = record.patches.get(k);
    return state ? unionBox(state.boxes) : this.opBox(record.packet.ops[k], record.s);
  }

  /** Each op's device box for `record`; undefined when an outline is not loaded. */
  private recordBoxes(record: PaintRecord): (Box | null)[] | undefined {
    if (record.boxes) return record.boxes;
    const out: (Box | null)[] = [];
    for (let k = 0; k < record.packet.ops.length; k++) {
      const box = this.recordBox(record, k);
      if (box === undefined) return undefined;
      out.push(box);
    }
    return (record.boxes = out);
  }

  /**
   * Disjoint boxes outside which painting `next` leaves exactly the pixels
   * `prev` left, or null when the whole page must be painted again. Both records
   * must share scale, canvas size and font generation. Ops align by their common
   * prefix and suffix; changed ops and patches whose pixels changed repaint, and
   * the clip stack entering the common suffix must match. Repaint each box under
   * its own rectangular clip. Skia rasterizes a fill that crosses a clip edge
   * differently from one inside it, and a clip joining several rectangles is a
   * coverage mask, so boxes grow until every op they touch lies wholly inside.
   */
  repaintRegion(prev: PaintRecord, next: PaintRecord, width: number, height: number): Box[] | null {
    if (prev.s !== next.s || prev.packet.fontGeneration !== next.packet.fontGeneration) return null;
    this.load(next.packet);
    const a = prev.packet.ops, b = next.packet.ops;
    let head = 0;
    while (head < a.length && head < b.length && sameOp(a[head], b[head])) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && sameOp(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
    const before = clipStack(a, a.length - tail), after = clipStack(b, b.length - tail);
    if (before.length !== after.length || before.some((op, k) => !sameOp(op, after[k]))) return null;
    const old = this.recordBoxes(prev);
    if (!old) return null;
    // Ops shared with the last paint keep their boxes; patches take their current state.
    const drawn: (Box | null)[] = new Array(b.length);
    for (let k = 0; k < b.length; k++) {
      const shared = k < head ? k : k >= b.length - tail ? k - b.length + a.length : -1;
      const box = shared >= 0 && b[k].op !== 'patch' ? old[shared] : this.recordBox(next, k);
      if (box === undefined) return null;
      drawn[k] = box;
    }
    next.boxes = drawn;
    const boxes: Box[] = [];
    const patch = (i: number, j: number) => {
      const p = prev.patches.get(i), n = next.patches.get(j);
      if (p && n && sameKey(p.key, n.key)) return;
      boxes.push(...p?.boxes ?? [], ...n?.boxes ?? []);
    };
    for (let k = 0; k < head; k++) if (b[k].op === 'patch') patch(k, k);
    for (let t = 1; t <= tail; t++) if (b[b.length - t].op === 'patch') patch(a.length - t, b.length - t);
    for (let k = head; k < a.length - tail; k++) if (old[k]) boxes.push(old[k]!);
    for (let k = head; k < b.length - tail; k++) if (drawn[k]) boxes.push(drawn[k]!);
    let region = mergeBoxes(boxes);
    for (let grown = true; grown;) {
      grown = false;
      region = mergeBoxes(region.map(box => {
        for (const d of drawn) {
          if (!d || !overlaps(d, box) || (d.x >= box.x && d.y >= box.y && d.x + d.w <= box.x + box.w && d.y + d.h <= box.y + box.h)) continue;
          box = unionBox([box, d])!;
          grown = true;
        }
        return box;
      }));
    }
    const visible = region.map(box => {
      const x = Math.max(0, box.x), y = Math.max(0, box.y);
      return { x, y, w: Math.min(width, box.x + box.w) - x, h: Math.min(height, box.y + box.h) - y };
    }).filter(box => box.w > 0 && box.h > 0);
    const area = visible.reduce((sum, box) => sum + box.w * box.h, 0);
    return area > width * height * MAX_REPAINT_SHARE ? null : visible;
  }

  /**
   * Paints a packet on `ctx` at `dpi`, the canvas already sized and
   * cleared. `patch(item, dpi)` returns a patch image or null;
   * `picture(item)` optionally supplies a browser-decoded picture. `only`
   * skips ops whose box (from `repaintRegion`) misses the box being repainted.
   */
  paint(ctx: CanvasRenderingContext2D, packet: PagePacket, dpi: number, patch: (item: number, dpi: number) => CanvasImageSource | null, picture?: (item: number) => Picture | null,
    only?: { box: Box; boxes: (Box | null)[] }) {
    this.load(packet);
    const s = dpi / 7200;
    const px = (v: number) => v * s;
    const stroke = (width: number, color: number, dash: number, round = false) => {
      const w = Math.max(px(width), 0.5);
      ctx.lineWidth = w;
      ctx.strokeStyle = css(color);
      const d = DASHES[dash];
      ctx.setLineDash(d ? d.map(v => Math.max(v * w, 0.01)) : []);
      ctx.lineCap = dash === 6 || round ? 'round' : 'butt';
    };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let depth = 0;
    for (let k = 0; k < packet.ops.length; k++) {
      const op = packet.ops[k];
      // Ops wholly outside the box being repainted cannot change its pixels.
      if (only && op.op !== 'clip' && op.op !== 'unclip' && !(only.boxes[k] && overlaps(only.boxes[k]!, only.box))) continue;
      switch (op.op) {
        case 'glyphs': {
          const path = this.runPath(op, s);
          ctx.fillStyle = css(op.color);
          ctx.fill(path, 'nonzero');
          if (op.flags & 1) {
            ctx.lineWidth = (op.size * s) / (op.flags & 4 ? 1000 : 40);
            ctx.strokeStyle = ctx.fillStyle;
            ctx.setLineDash([]);
            ctx.lineJoin = 'miter';
            ctx.lineCap = 'butt';
            ctx.stroke(path);
          }
          break;
        }
        case 'outline': {
          const path = this.runPath(op, s);
          ctx.lineWidth = Math.max(px(op.width), 0.5);
          ctx.strokeStyle = css(op.color);
          ctx.setLineDash(op.dash.map(v => Math.max(px(v), 0.01)));
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(path);
          break;
        }
        case 'rect':
          ctx.fillStyle = css(op.color!);
          ctx.fillRect(px(op.x), px(op.y), Math.max(px(op.w), 0.5), Math.max(px(op.h), 0.5));
          break;
        case 'line':
          ctx.beginPath();
          ctx.moveTo(px(op.x1), px(op.y1));
          ctx.lineTo(px(op.x2), px(op.y2));
          stroke(op.width, op.color, op.dash, false);
          ctx.stroke();
          break;
        case 'path': {
          const p = new Path2D();
          for (const e of op.els) {
            if (e[0] === 0) p.moveTo(px(e[1]), px(e[2]));
            else if (e[0] === 1) p.lineTo(px(e[1]), px(e[2]));
            else if (e[0] === 2) p.bezierCurveTo(px(e[1]), px(e[2]), px(e[3]), px(e[4]), px(e[5]), px(e[6]));
            else p.closePath();
          }
          if (op.fill !== 0xff000000) {
            ctx.globalAlpha = (255 - op.alpha) / 255;
            ctx.fillStyle = css(op.fill);
            ctx.fill(p, 'evenodd');
            ctx.globalAlpha = 1;
          }
          if (op.width >= 0) {
            stroke(op.width, op.stroke, op.dash, op.roundCap);
            ctx.lineJoin = 'miter';
            ctx.stroke(p);
          }
          break;
        }
        case 'patch': {
          const pic = picture?.(op.item);
          if (pic) {
            if (!pic.bitmap) break;
            const [a, b, c, d, e, f] = pic.source.matrix;
            ctx.save();
            if (pic.source.clip) {
              ctx.beginPath();
              pic.source.clip.forEach(([x, y], k) => k ? ctx.lineTo(px(x), px(y)) : ctx.moveTo(px(x), px(y)));
              ctx.closePath();
              ctx.clip();
            }
            ctx.imageSmoothingQuality = 'high';
            ctx.setTransform(s * a, s * d, s * b, s * e, s * c, s * f);
            ctx.drawImage(pic.bitmap, 0, 0, 1, 1);
            ctx.restore();
            break;
          }
          const img = patch && patch(op.item, dpi);
          if (img) ctx.drawImage(img, px(op.x), px(op.y), px(op.w), px(op.h));
          break;
        }
        case 'clip':
          ctx.save();
          depth++;
          ctx.beginPath();
          ctx.rect(px(op.x), px(op.y), px(op.w), px(op.h));
          ctx.clip();
          break;
        case 'unclip':
          if (depth > 0) {
            ctx.restore();
            depth--;
          }
          break;
      }
    }
    while (depth-- > 0) ctx.restore();
    ctx.restore();
  }
}

/** A canvas image from `Doc.patch` bytes, or null when empty. */
export function patchImage(bytes: Uint8Array, makeCanvas: (w: number, h: number) => OffscreenCanvas): OffscreenCanvas | null {
  if (!bytes || bytes.byteLength < 8) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = v.getUint32(0, true);
  const h = v.getUint32(4, true);
  if (!w || !h) return null;
  if (!Number.isSafeInteger(w * h * 4) || bytes.byteLength !== 8 + w * h * 4) throw new Error('invalid patch dimensions');
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.slice(8).buffer), w, h), 0, 0);
  return canvas;
}
