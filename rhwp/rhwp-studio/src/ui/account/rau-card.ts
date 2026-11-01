// 요금제 카드 · Rau 의 배경 무늬. login-neurons.txt 와 같은 글자로 그린 자모 신경망이다.
// 격자는 어떤 카드보다 높고 카드가 커져도 그대로라, 구독 관리를 열면 무늬가 더 드러날 뿐이다.
// 상태는 글과 막대가 말하고 무늬는 끝 모양만 바꾼다. 글자는 이 파일의 상수에서만 온다.
import './rau-card.css';
import type { PlanCardKind } from './account-format.ts';

export type RauCardEnd = 'open' | 'close' | 'cut' | 'break';

export interface RauCardLook {
  surface: 'tint' | 'raised' | 'plain' | 'out';
  end: RauCardEnd;
  seed: number;
  density: number;
  reach: number;
  dust: boolean;
  live: boolean;
}

interface ArtCell { ch: string; w: number; kind: 't' | 'b'; d: number }
type Row = Array<ArtCell | undefined>;
interface Axon { soma: number; y0: number; at(x: number): number }
interface Neurons { grid: Row[]; axons: Axon[] }

const HALF = ['/', '<', '>', '-', 'v'];
const WIDE = ['ㅊ', 'ㅎ'];
const ART_ROWS = 34;
const AXON_GAP = 11;
const isWide = (ch: string): boolean => ch === 'ㅊ' || ch === 'ㅎ';

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function growNeurons({ cols, seed, density, reach }: { cols: number; seed: number; density: number; reach: number }): Neurons {
  const rows = ART_ROWS;
  const r = random(seed);
  const grid: Row[] = Array.from({ length: rows }, () => new Array<ArtCell | undefined>(cols));
  const axons: Axon[] = [];
  for (let base = 5; base < rows; base += AXON_GAP) {
    const p1 = r() * 6, p2 = r() * 6;
    axons.push({
      soma: Math.floor(cols * (0.3 + r() * 0.5)),
      y0: base,
      at: (x: number) => Math.round(base + Math.sin(x / 19 + p1) * 1.1 + Math.sin(x / 7.3 + p2) * 0.45),
    });
  }

  const put = (x: number, y: number, ch: string, kind: 't' | 'b', axon: Axon): boolean => {
    x = Math.floor(x);
    if (y < 0 || y >= rows || x < 0 || x >= cols) return false;
    const w = isWide(ch) ? 2 : 1;
    if (w === 2 && x + 1 >= cols) return false;
    if (grid[y]![x] || (w === 2 && grid[y]![x + 1])) return false;
    if (x > 0 && grid[y]![x - 1]?.w === 2) return false;
    grid[y]![x] = { ch, w, kind, d: Math.abs(x - axon.soma) + Math.abs(y - axon.y0) };
    return true;
  };
  const pick = (jamo: number): string => (r() < jamo ? WIDE[r() < 0.78 ? 0 : 1]! : HALF[Math.floor(r() * HALF.length)]!);

  for (const axon of axons) {
    // Cell body: a dense knot on the axon.
    const y0 = axon.at(axon.soma);
    [[-2, 3, 5], [-1, 1, 8], [0, 0, 10], [1, 1, 8], [2, 4, 3]].forEach(([dy, from, len]) => {
      for (let i = from; i < from + len; i++) put(axon.soma - 5 + i, y0 + dy, pick(0.42), 't', axon);
    });
    // Axon: runs the full width and off both edges.
    for (let x = 0; x < cols;) {
      const ch = pick(0.34);
      x += put(x, axon.at(x), ch, 't', axon) && isWide(ch) ? 2 : 1;
    }
    // Dendrites: connected strokes that fork, ending in a jamo.
    const twig = (x: number, y: number, dir: number, side: number, len: number, depth: number): void => {
      const climb = depth === 0 ? 0.62 : 0.4;
      for (let i = 0; i < len; i++) {
        const tip = i === len - 1;
        const ch = tip ? (r() < 0.6 ? 'ㅎ' : 'ㅊ') : pick(depth === 0 ? 0.3 : 0.2);
        const placed = put(x, y, ch, 'b', axon);
        x += side * (placed && isWide(ch) ? 2 : 1);
        if (r() < climb) {
          y += dir;
          if (y < 0 || y >= rows) break;
        }
        if (depth < 2 && i > 1 && !tip && r() < 0.17) {
          twig(x, y, r() < 0.62 ? -dir : dir, side, Math.ceil((len - i) * 0.75), depth + 1);
        }
      }
    };
    const count = Math.max(2, Math.round(cols / 56 * density));
    for (let n = 0; n < count; n++) {
      const x = Math.floor(cols * (n + r() * 0.7) / count);
      const dir = n % 2 ? 1 : -1;
      twig(x, axon.at(x) + dir, dir, x < axon.soma ? -1 : 1, Math.round((6 + r() * 7) * reach), 0);
    }
  }
  return { grid, axons };
}

/* Finish the right end of the art for states that have an end. */
function shapeEnd({ grid, axons }: Neurons, { cols, end, pad, seed }: { cols: number; end: RauCardEnd; pad: number; seed: number }): void {
  const nearest = (x: number, y: number): number => Math.min(...axons.map((a) => Math.abs(y - a.at(x))));
  const clear = (test: (x: number, y: number) => boolean): void => grid.forEach((row, y) => {
    for (let x = 0; x < cols; x++) if (row[x] && test(x, y)) row[x] = undefined;
  });
  const mark = (x: number, y: number, ch: string): void => { if (grid[y]) grid[y]![x] = { ch, w: isWide(ch) ? 2 : 1, kind: 't', d: x }; };
  if (end === 'close') {
    const stop = cols - pad - 3;
    clear((x, y) => x >= stop - nearest(x, y) * 3);
    axons.forEach((a) => mark(stop - 2, a.at(stop - 2), 'ㅎ'));
  } else if (end === 'cut') {
    const stop = cols - pad - 7;
    clear((x) => x >= stop);
    axons.forEach((a) => mark(stop + 3, a.at(stop), 'x'));
  } else if (end === 'break') {
    const at = Math.round(cols * 0.46);
    clear((x) => x >= at && x < at + 8);
    const r = random(seed ^ 0x51ed);
    grid.forEach((row, y) => {
      const shear = Math.round((r() - 0.5) * 6) + (y % 2 ? 2 : -1);
      const moved = new Array<ArtCell | undefined>(cols);
      for (let x = at + 8; x < cols; x++) {
        const cell = row[x];
        const to = x + shear;
        if (!cell || to < at + 5 || to + cell.w > cols) continue;
        if (r() < 0.2 + 0.55 * (x - at) / (cols - at)) continue;
        moved[to] = cell;
      }
      for (let x = at; x < cols; x++) row[x] = moved[x];
    });
    axons.forEach((a) => mark(at + 3, a.at(at), 'x'));
  }
}

/* Exhausted: every jamo and stroke crumbles to a dot, and most of them are gone. */
function dissolve({ grid }: Neurons, seed: number): void {
  const r = random(seed ^ 0x2f3a);
  grid.forEach((row) => row.forEach((cell, x) => {
    if (!cell) return;
    row[x] = r() < (cell.kind === 't' ? 0.7 : 0.42) ? { ...cell, ch: '.', w: 1 } : undefined;
  }));
}

/** 상태마다 정해진 무늬. confirming 이면 해지 뒤의 모습을 미리 보인다: 끊기고 신호가 멎는다. */
export function rauCardLook(kind: PlanCardKind, exhausted: boolean, confirming: boolean): RauCardLook {
  const looks: Record<string, Omit<RauCardLook, 'dust'>> = {
    monthly: { surface: 'tint', end: 'open', seed: 11, density: 5, reach: 1, live: true },
    yearly: { surface: 'tint', end: 'open', seed: 29, density: 8, reach: 1.25, live: true },
    lifetime: { surface: 'tint', end: 'open', seed: 29, density: 8, reach: 1.25, live: true },
    cancelled: { surface: 'plain', end: 'cut', seed: 29, density: 8, reach: 1.25, live: false },
    gift: { surface: 'tint', end: 'close', seed: 47, density: 6, reach: 1.1, live: true },
    trial: { surface: 'raised', end: 'close', seed: 53, density: 3, reach: 0.65, live: true },
    failed: { surface: 'plain', end: 'break', seed: 11, density: 5, reach: 1, live: false },
  };
  const base = looks[kind] ?? looks.monthly!;
  const out = exhausted && kind !== 'failed';
  return {
    ...base,
    surface: out ? 'out' : base.surface,
    end: confirming ? 'cut' : base.end,
    dust: out,
    live: base.live && !confirming && !out,
  };
}

function escapeGlyph(ch: string): string {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch;
}

let cellWidth = 0;
function measureCell(host: HTMLElement): number {
  if (cellWidth) return cellWidth;
  host.innerHTML = '<pre><span>----------</span></pre>';
  const width = host.querySelector('span')?.getBoundingClientRect().width ?? 0;
  if (width > 0) cellWidth = width / 10;
  return width / 10;
}

function paint(card: HTMLElement, host: HTMLElement, look: RauCardLook): void {
  const cell = measureCell(host);
  if (!(cell > 0) || !card.clientWidth) return;
  const cols = Math.ceil(card.clientWidth / cell) + 1;
  const visible = Math.min(ART_ROWS, Math.ceil(card.clientHeight / 12));
  const neurons = growNeurons({ cols, seed: look.seed, density: look.density, reach: look.reach });
  shapeEnd(neurons, { cols, end: look.end, pad: Math.ceil(14 / cell), seed: look.seed });
  if (look.dust) dissolve(neurons, look.seed);
  const html = neurons.grid.slice(0, visible).map((row) => {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const glyph = row[x];
      if (!glyph) { line += ' '; continue; }
      if (glyph.w === 2) x += 1;
      line += `<i class="${glyph.kind}" style="--i:${glyph.d}">${escapeGlyph(glyph.ch)}</i>`;
    }
    return line.trimEnd();
  }).join('\n');
  host.innerHTML = `<pre>${html}</pre>`;
  host.style.setProperty('--period', '6s');
  host.style.setProperty('--step', `${2600 / cols}ms`);
  host.toggleAttribute('data-live', look.live);
}

export interface RauCardArt {
  /** null 이면 무늬를 지운다(Rau 가 아닌 표). */
  update(look: RauCardLook | null): void;
  dispose(): void;
}

export function mountRauCardArt(card: HTMLElement, host: HTMLElement): RauCardArt {
  let current: RauCardLook | null = null;
  let key = '';
  let disposed = false;
  const repaint = (): void => {
    if (disposed || !current) return;
    const next = `${JSON.stringify(current)}:${card.clientWidth}:${card.clientHeight}`;
    if (next === key) return;
    key = next;
    paint(card, host, current);
  };
  const observer = new ResizeObserver(repaint);
  observer.observe(card);
  void document.fonts?.load("12px 'Nanum Gothic Coding'", 'ㅊ-').then(() => { cellWidth = 0; key = ''; repaint(); }, () => {});
  return {
    update(look) {
      current = look;
      if (look) { repaint(); return; }
      key = '';
      host.replaceChildren();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
    },
  };
}
