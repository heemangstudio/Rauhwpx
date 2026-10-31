/** 전체 화면 빈 채팅 위의 픽셀 무대.
 *
 *  인사 문장 대신 120×40 칸 캔버스에 짧은 장면을 그린다. 주인공은 입력기 위의 하마
 *  (hama-art.ts)와 같은 실루엣·팔레트·1px 격자다. 빈 채팅이 열리면 장면 하나를 한 번
 *  보여 준 뒤 마지막 모습으로 멈춘다. 가리키면 같은 장면을 다시, 누르면 다음 장면을
 *  보여 준다. 장면 사이와 끝은 4×4 디더 순서로 칸을 바꿔 넘어간다.
 *
 *  모든 움직임은 15fps 로 끊는다. 캔버스는 CSS 에서 입력기 하마와 같은 3배로 키우고
 *  pixelated 로 그린다. 동작 줄이기 설정이면 처음부터 마지막 모습만 그린다. */

import {
  COLORS, LIGHT_COLORS, POSES, PROPS, sparkle, dot, fade, lerp, arc, droplets, ripples,
  type Layer, type PoseName,
} from './hama-art.ts';

const W = 120;
const H = 40;
/** 땅(물) 윗면의 행. 하마의 7행이 바로 위에 선다. */
const FLOOR = 34;
const STEP = 1000 / 15;
const SWAP_MS = 320;
const HIDDEN_POLL_MS = 500;
/** 물보라 장면에서 하마가 내려앉아 떠 있는 자리(0열). */
const FLOAT_X = 53;
const POND = [26, 94] as const;
/** 물에 뜬 하마가 잠기는 깊이(행). 귀·머리·등만 물 위에 남는다. */
const FLOAT_Y = 2;

type Hex = string;

interface Tone {
  /** 땅 선과 먼 물결. */
  dim: Hex;
  star: Hex;
  /** 산의 밝은 면과 그늘. */
  hillL: Hex;
  hillR: Hex;
  /** 생각 구름 속. */
  cloud: Hex;
}

const TONES: Record<'dark' | 'light', Tone> = {
  dark: { dim: '#2A2E35', star: '#3A404A', hillL: '#2C3A50', hillR: '#222D3E', cloud: '#1C222C' },
  light: { dim: '#D9DCE1', star: '#CDD2D9', hillL: '#D3DDE9', hillR: '#BFCCDC', cloud: '#F1F4F8' },
};
// 무대는 입력기보다 어두운 화면 바탕 위에 서므로, 밝은 테마의 종이·잔과 옅은 하늘색을 한 단계 진하게 쓴다.
const LIGHT_PAL: Record<string, Hex> = { ...COLORS, ...LIGHT_COLORS, P: '#ccd3dc', h: '#62b3e2' };

const STARS: ReadonlyArray<readonly [number, number]> = [
  [8, 6], [22, 15], [37, 3], [84, 9], [101, 17], [113, 5], [66, 2],
];
/** 4×4 Bayer 순서. 장면을 바꿀 때 이 순서대로 칸이 넘어간다. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 잔. 하마 팔레트의 종이색 몸, 갈색 커피, 회색 손잡이. */
const MUG = [
  'PmmmPp.',
  'PPPPP.p',
  'PPPPPp.',
  '.PPP...',
];
const PAGE_W = 9;
const PAGE_H = 11;

type Draw = (t: number) => void;

export interface PixelScene {
  readonly id: string;
  /** 장면이 그리는 응원 한 줄. 화면에는 쓰지 않고 접근성 이름으로만 쓴다. */
  readonly label: string;
  readonly duration: number;
}

export const PIXEL_SCENES: readonly PixelScene[] = [
  { id: 'lines', label: '한 줄씩 차근차근', duration: 4000 },
  { id: 'mountain', label: '오늘도 한 걸음 더', duration: 5000 },
  { id: 'coffee', label: '커피 한 잔', duration: 3600 },
  { id: 'thought', label: '생각을 문서로', duration: 3800 },
  { id: 'splash', label: '오늘도 화이팅', duration: 3300 },
];

/** 직전 장면과 겹치지 않게 하나를 고른다. */
export function pickScene(previous: number | null, random: () => number = Math.random): number {
  const pool = PIXEL_SCENES.map((_, i) => i).filter((i) => i !== previous);
  return pool[Math.floor(random() * pool.length)] ?? 0;
}

export interface PixelGreeting {
  readonly canvas: HTMLCanvasElement;
  /** 새 장면을 골라 보여 주고 프레임을 돌린다. */
  start(): void;
  /** 칸이 디더 순서로 빠져 비고, 그 뒤 프레임을 멈춘다. */
  dissolve(durationMs: number): void;
  /** 즉시 비우고 멈춘다. */
  stop(): void;
}

export function createPixelGreeting(opts: { reducedMotion: () => boolean }): PixelGreeting {
  const canvas = document.createElement('canvas');
  canvas.className = 'ag-focus-greeting-art';
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute('role', 'img');
  const ctx = canvas.getContext('2d');
  const image = ctx?.createImageData(W, H) ?? null;
  const out32 = image ? new Uint32Array(image.data.buffer) : null;
  const bufA = new Uint32Array(W * H);
  const bufB = new Uint32Array(W * H);
  let buf = bufA;
  let tone = TONES.light;
  let pal = LIGHT_PAL;
  const colors = new Map<Hex, number>();

  function rgba(hex: Hex): number {
    let v = colors.get(hex);
    if (v === undefined) {
      const n = parseInt(hex.slice(1), 16);
      v = ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
      colors.set(hex, v);
    }
    return v;
  }
  function px(x: number, y: number, hex: Hex): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    buf[y * W + x] = rgba(hex);
  }
  function rect(x: number, y: number, w: number, h: number, hex: Hex): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, hex);
  }
  const q = (t: number): number => Math.floor(t / STEP) * STEP;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  /** 하마 좌표(hama-art 의 층, 7행이 땅 바로 위)를 무대에 그린다. x 는 하마 0열이 놓일
      열, ground 는 발밑 땅의 행, y 는 위아래 이동(위가 음수)이다. flip 이면 14열 폭을
      기준으로 뒤집어 왼쪽을 본다. clip 이면 땅(물) 아래 행을 그리지 않는다. */
  function layers(list: readonly Layer[], x: number, o: { y?: number; ground?: number; flip?: boolean; clip?: boolean } = {}): void {
    const ground = o.ground ?? FLOOR;
    const base = ground - 8 + (o.y ?? 0);
    for (const { art, x: lx = 0, y: ly = 0, map } of list) {
      art.forEach((row, r) => {
        const sy = base + ly + r;
        if (o.clip && sy >= FLOOR) return;
        for (let c = 0; c < row.length; c++) {
          const ch = row[c]!;
          if (ch === '.') continue;
          const hex = map?.[ch] ?? pal[ch];
          if (!hex) continue;
          const cx = lx + c;
          px(o.flip ? x + 13 - cx : x + cx, sy, hex);
        }
      });
    }
  }
  const pet = (pose: PoseName, x: number, o: { y?: number; ground?: number; flip?: boolean; clip?: boolean } = {}): void => {
    layers([{ art: POSES[pose] }], x, o);
  };
  const walk = (t: number): PoseName => (Math.floor(t / 120) % 2 ? 'step' : 'stand');
  /** 입을 벌린 하마 위의 반짝임. 머리에 닿지 않게 띄운다. */
  const twinkle = (size: number): Layer[] => sparkle(size).map((l) => ({ ...l, x: l.x! + 2, y: l.y! - 1 }));

  function sky(t: number): void {
    STARS.forEach(([x, y], i) => {
      if (Math.sin(t / 700 + i * 1.7) > -0.3) px(x, y, tone.star);
    });
  }
  /** 땅 선. 양 끝은 비워 무대 가장자리가 보이지 않게 한다. */
  function floor(from = 14, to = W - 14): void {
    for (let x = from; x < to; x++) px(x, FLOOR, tone.dim);
  }
  function water(t: number, from: number = POND[0], to: number = POND[1]): void {
    const shift = Math.floor(t / 260);
    for (let x = from; x < to; x++) {
      const edge = Math.min(x - from, to - 1 - x) < 6;
      if ((x + shift) % 9 < 4) px(x, FLOOR, edge ? tone.dim : pal.s!);
      if (!edge && (x - shift + 4) % 13 < 3) px(x, FLOOR + 2, tone.dim);
    }
  }
  /** 땅에 선 종이. 줄은 왼쪽부터 n 칸까지 채운다. */
  function page(x: number, lines: readonly number[]): void {
    const top = FLOOR - PAGE_H;
    rect(x, top, PAGE_W, PAGE_H, pal.P!);
    lines.forEach((n, i) => {
      if (n > 0) rect(x + 2, top + 3 + i * 2, n, 1, pal.p!);
    });
  }
  /** 일정한 속도로 줄을 하나씩 채운다. */
  function typed(widths: readonly number[], elapsed: number, msPerCell: number, gap = 0): number[] {
    let left = elapsed;
    return widths.map((len) => {
      const n = Math.max(0, Math.min(len, Math.floor(left / msPerCell)));
      left -= len * msPerCell + gap;
      return n;
    });
  }

  /** 물에 뜬 하마 — 머리와 등만 내놓는다. 까딱일 때마다 물결이 양옆으로 번진다. */
  function float(t: number, x: number): void {
    const bob = Math.floor(t / 900) % 2;
    pet('stand', x, { y: FLOAT_Y + bob, clip: true });
    const k = Math.floor((t % 900) / 180);
    if (k < 3) {
      px(x - 1 - k, FLOOR - 1, pal[fade(k + 1)]!);
      px(x + 13 + k, FLOOR - 1, pal[fade(k + 1)]!);
    }
  }

  const empty: Draw = () => {};

  const scenes: Record<string, Draw> = {
    // 걸어 들어와 노트북을 두드리면 옆에 선 종이에 줄이 하나씩 써진다.
    lines(t) {
      t = q(t); sky(t); floor();
      const home = 44;
      const arrive = 1100;
      const x = Math.round(lerp(20, home, t / arrive));
      const typing = t >= arrive && t < 3500;
      const beat = Math.floor(t / 90);
      const down = typing && beat % 2 === 1 && beat % 10 < 7;
      const glow = typing ? [pal.h!, pal.g!, pal.o!, pal.W!][beat % 4]! : pal.B!;
      layers([{ ...prop('laptop'), map: { G: glow, g: glow } }], home);
      page(home + 20, typed([5, 4, 5, 3], t - arrive - 200, 80, 160));
      if (t < arrive) pet(walk(t), x);
      else if (typing) pet(down ? 'pawDown' : 'pawUp', home);
      else layers([{ art: POSES.cheer }, ...twinkle(t < 3700 ? 1 : 2)], home);
    },
    // 산을 걸어 올라 꼭대기에 깃발을 꽂는다.
    mountain(t) {
      t = q(t); sky(t);
      const [left, peakX, right, peakY] = [28, 66, 100, 13];
      const ridge = (x: number): number => {
        if (x <= left || x >= right) return FLOOR;
        if (x <= peakX) return Math.round(FLOOR - ((x - left) / (peakX - left)) * (FLOOR - peakY));
        return Math.round(FLOOR - ((right - x) / (right - peakX)) * (FLOOR - peakY));
      };
      floor(10, left);
      floor(right, W - 10);
      for (let x = left; x < right; x++) {
        for (let y = ridge(x); y < FLOOR + 1; y++) px(x, y, x <= peakX ? tone.hillL : tone.hillR);
      }
      // 네 발 가운데 땅을 디딘다.
      const feet = (x: number): number => ridge(x + 4);
      const climb = 3000;
      const top = peakX - 6;
      const x = Math.round(lerp(8, top, t / climb));
      const ground = feet(x);
      const flagX = top + 13;
      const plant = t - climb - 250;
      if (plant > 0) {
        const pole = Math.min(9, Math.floor(plant / 45));
        const base = ridge(flagX);
        for (let y = 1; y <= pole; y++) px(flagX, base - y, pal.L!);
        if (pole === 9) {
          const wave = Math.floor(t / 220) % 2;
          rect(flagX + 1, base - 9, 4, 3, pal.r!);
          px(flagX + 5, base - 9 + wave + 1, pal.r!);
        }
      }
      if (t < climb) pet(walk(t), x, { ground });
      else if (plant < 500) pet(plant > 0 ? 'pawUp' : 'stand', top, { ground });
      // 멈추는 모습에서는 반짝임을 가장 크게 남긴다.
      else layers([{ art: POSES.cheer }, ...twinkle(plant < 1700 ? Math.floor(plant / 140) % 3 : 2)], top, { ground });
    },
    // 잔이 떨어져 놓이고, 김이 오르면 주둥이를 담가 마신 뒤 고개를 들고 숨을 내쉰다.
    coffee(t) {
      t = q(t); sky(t); floor();
      const x = 44;
      const mugX = x + 13;
      const fall = clamp01((t - 200) / 260);
      const mugY = FLOOR - MUG.length - Math.round((1 - fall * fall) * 18) - (t > 460 && t < 540 ? 1 : 0);
      if (t > 200) for (let r = 0; r < MUG.length; r++) {
        const row = MUG[r]!;
        for (let c = 0; c < row.length; c++) if (row[c] !== '.') px(mugX + c, mugY + r, pal[row[c]!]!);
      }
      // 김: 세 가닥이 번갈아 오르며 옅어진다.
      if (t > 700) {
        for (let i = 0; i < 3; i++) {
          const age = (t - 700 + i * 380) % 1140;
          const k = Math.floor(age / 285);
          const sway = Math.round(Math.sin((age / 1140) * Math.PI * 2 + i));
          px(mugX + 1 + i + sway, FLOOR - MUG.length - 2 - k * 2, pal[fade(k)]!);
        }
      }
      const sip = t > 1300 && t < 2700 && Math.floor((t - 1300) / 350) % 2 === 0;
      // 마실 때는 몸을 숙여 앞으로 내밀어 주둥이를 잔에 담근다.
      if (t < 1300) pet(t % 900 < 120 ? 'ear' : 'stand', x);
      else if (t < 2700) pet(sip ? 'crouch' : 'stand', sip ? x + 2 : x);
      else pet(t < 3200 ? 'open' : 'cheer', x);
    },
    // 머리 위로 생각 점이 차오르고, 구름 속 종이가 저절로 써지면 폴짝 뛰고 구름을 올려다본다.
    thought(t) {
      t = q(t); sky(t); floor();
      const x = 34;
      if (t < 900) {
        const k = Math.floor(t / 220) % 4;
        layers([0, 1, 2].map((i) => dot(6 + i * 2, 0, i < k ? 'W' : 's')), x);
      }
      const head = FLOOR - 8;
      for (const [dx, dy, n, at] of [[13, -2, 1, 900], [16, -5, 2, 1050]] as const) {
        if (t >= at) rect(x + dx, head + dy, n, n, pal.h!);
      }
      const c = t - 1200;
      if (c >= 0) {
        const grow = c < 70 ? 0.45 : c < 140 ? 0.8 : c < 210 ? 1.08 : 1;
        const [cx, cy] = [x + 30, 11];
        const lobes = [[-9, 2, 5], [-4, -3, 5], [3, -3, 5], [8, 1, 4], [0, 3, 6]] as const;
        const inside = (px_: number, py: number): boolean => lobes.some(([lx, ly, r]) => {
          const dx = px_ - (cx + lx * grow), dy = py - (cy + ly * grow), rr = r * grow;
          return dx * dx + dy * dy <= rr * rr;
        });
        for (let y = 0; y < 22; y++) for (let xx = cx - 16; xx < cx + 16; xx++) {
          if (!inside(xx, y)) continue;
          const rim = !inside(xx - 1, y) || !inside(xx + 1, y) || !inside(xx, y - 1) || !inside(xx, y + 1);
          px(xx, y, rim ? pal.h! : tone.cloud);
        }
        if (c > 300) {
          const [pxl, pyl] = [cx - 4, cy - 4];
          const shown = Math.min(9, Math.floor((c - 300) / 30) + 1);
          rect(pxl, pyl, 8, shown, pal.P!);
          typed([5, 4, 5], c - 650, 60, 140).forEach((n, i) => {
            if (n && 2 + i * 2 < shown) rect(pxl + 2, pyl + 2 + i * 2, n, 1, pal.p!);
          });
        }
      }
      const done = t > 2700;
      if (!done) pet(t > 1200 && t % 1400 < 120 ? 'ear' : 'stand', x);
      else {
        const hop = t - 2900;
        pet(hop > 0 && hop < 360 ? 'step' : hop <= 0 ? 'crouch' : 'cheer', x, {
          y: hop > 0 && hop < 360 ? arc(hop / 360, 3) : 0,
        });
      }
    },
    // 둑에서 웅크렸다 공처럼 말아 연못으로 뛰어들고, 떠올라 까딱이다 입을 크게 벌린다.
    splash(t) {
      t = q(t); sky(t);
      const bank = 34;
      floor(10, bank);
      water(t, bank, POND[1]);
      const from = 14;
      const leap = 600, land = 1350;
      if (t < 400) { pet(t > 250 && t < 330 ? 'ear' : 'stand', from); return; }
      if (t < leap) { pet('crouch', from); return; }
      if (t < land) {
        const p = (t - leap) / (land - leap);
        const x = Math.round(lerp(from, FLOAT_X, p));
        const y = arc(p, 14);
        pet(p < 0.25 ? 'step' : 'ball', x, { y: p < 0.25 ? y : y - 1, clip: p > 0.8 });
        return;
      }
      const under = t - land;
      const splashes = [...droplets(6, under, 1.2), ...ripples(6, under)];
      if (under < 700) {
        const sink = Math.round(lerp(0, 9, under / 150));
        pet('ball', FLOAT_X, { y: sink - 1, clip: true });
        layers(splashes, FLOAT_X);
        return;
      }
      // 솟아올라 쉬는 모습과 같은 자리에 뜬다.
      const up = under - 700;
      if (up < 260) {
        pet('ear', FLOAT_X, { y: Math.round(lerp(9, FLOAT_Y, up / 260)), clip: true });
        layers(ripples(6, up), FLOAT_X);
      } else if (t < 2900) float(t, FLOAT_X);
      else layers([{ art: POSES.cheer }, ...twinkle(t < 3100 ? 1 : 2)], FLOAT_X, { y: FLOAT_Y, clip: true });
    },
  };

  /** PROPS 의 소품을 하마 좌표 층으로. */
  function prop(name: string): Layer {
    const [art, x, y] = PROPS[name]!;
    return { art, x, y };
  }

  interface Shown { draw: Draw; start: number }
  let current: Shown = { draw: empty, start: 0 };
  let swap: { from: Shown; to: Shown; start: number; duration: number } | null = null;
  let sceneIndex: number | null = null;
  let sceneUntil: number | null = null;
  /** 지금 장면의 마지막 모습. 장면이 끝나면 여기서 멈춘다. */
  let still: Draw = empty;
  let timer: number | null = null;

  function paint(now: number): void {
    if (!ctx || !image || !out32) return;
    const dark = document.documentElement.dataset.themeEffective === 'dark';
    tone = dark ? TONES.dark : TONES.light;
    pal = dark ? COLORS : LIGHT_PAL;
    if (swap && now - swap.start >= swap.duration) {
      current = swap.to;
      swap = null;
    }
    if (swap) {
      buf = bufA; bufA.fill(0); swap.from.draw(now - swap.from.start);
      buf = bufB; bufB.fill(0); swap.to.draw(now - swap.to.start);
      const level = Math.floor(((now - swap.start) / swap.duration) * 17);
      for (let i = 0; i < W * H; i++) {
        out32[i] = BAYER[((i / W) & 3) * 4 + ((i % W) & 3)]! < level ? bufB[i]! : bufA[i]!;
      }
    } else {
      buf = bufA; bufA.fill(0); current.draw(now - current.start);
      out32.set(bufA);
    }
    ctx.putImageData(image, 0, 0);
  }

  function tick(): void {
    timer = null;
    const now = performance.now();
    if (sceneUntil !== null && now > sceneUntil) {
      sceneUntil = null;
      show(still, 0);
    }
    // 창이 숨었거나 설정 같은 다른 면 뒤에 있으면 그리지 않고 드문드문 살피기만 한다.
    const hidden = document.visibilityState === 'hidden'
      || (typeof canvas.checkVisibility === 'function' && !canvas.checkVisibility({ visibilityProperty: true }));
    if (!hidden) paint(now);
    // 멈춘 모습을 그렸으면 프레임을 끝낸다. 숨어 있었다면 보일 때 한 번 그리려고 계속 살핀다.
    const moving = sceneUntil !== null || swap !== null;
    if (moving || (hidden && current.draw !== empty)) timer = window.setTimeout(tick, hidden ? HIDDEN_POLL_MS : STEP);
  }

  function run(): void {
    if (timer === null) tick();
  }

  function show(draw: Draw, duration: number): void {
    const now = performance.now();
    const to = { draw, start: now };
    if (duration <= 0) {
      current = to;
      swap = null;
      return;
    }
    swap = { from: swap ? swap.to : current, to, start: now, duration };
  }

  function play(index: number): void {
    sceneIndex = index;
    const scene = PIXEL_SCENES[index]!;
    const draw = scenes[scene.id]!;
    still = () => draw(scene.duration);
    canvas.setAttribute('aria-label', scene.label);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-effective'] });
    if (opts.reducedMotion()) {
      sceneUntil = null;
      show(still, 0);
      paint(performance.now());
      return;
    }
    show(draw, current.draw === empty ? 0 : SWAP_MS);
    sceneUntil = performance.now() + scene.duration;
    run();
  }

  // 멈춘 동안에는 프레임이 돌지 않으므로 테마가 바뀔 때 다시 그린다.
  const themeWatch = new MutationObserver(() => {
    if (timer === null) paint(performance.now());
  });

  canvas.addEventListener('pointerenter', () => {
    if (sceneIndex !== null && sceneUntil === null && !swap && !opts.reducedMotion()) play(sceneIndex);
  });
  canvas.addEventListener('click', () => {
    if (sceneIndex !== null) play((sceneIndex + 1) % PIXEL_SCENES.length);
  });

  function stop(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    sceneUntil = null;
    themeWatch.disconnect();
    show(empty, 0);
    paint(performance.now());
  }

  return {
    canvas,
    start() {
      play(pickScene(sceneIndex));
    },
    dissolve(durationMs) {
      sceneUntil = null;
      if (durationMs < 20) { stop(); return; }
      show(empty, durationMs);
      run();
    },
    stop,
  };
}
