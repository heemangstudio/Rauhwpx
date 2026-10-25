/** 전체 화면 빈 채팅 위의 픽셀 무대.
 *
 *  인사 문장 대신 128×40 칸 캔버스에 짧은 장면을 그린다. 물 위에 떠 있는 하마가
 *  주인공이고, 빈 채팅이 열리면 장면 하나를 한 번 보여 준 뒤 쉬는 하마로 돌아간다.
 *  가리키면 같은 장면을 다시, 누르면 다음 장면을 보여 준다. 장면 사이와 끝은 4×4
 *  디더 순서로 칸을 바꿔 넘어간다.
 *
 *  모든 움직임은 15fps 로 끊는다. 캔버스는 CSS 에서 4배로 키우고 pixelated 로
 *  그린다. 동작 줄이기 설정이면 장면의 마지막 모습만 멈춰 그린다. */

const W = 128;
const H = 40;
const WATER = 34;
const STEP = 1000 / 15;
const SCENE_TAIL_MS = 700;
const SWAP_MS = 320;
const SETTLE_MS = 420;

type Hex = string;

// 하마 색은 부팅 로고(scripts/generate-boot-logo.py)의 HIPPO 팔레트다.
const HIPPO_PAL: Record<string, Hex> = {
  o: '#62B3E2', s: '#2F73A0', h: '#B2E2FB', d: '#1D4766', k: '#0C2536', w: '#E6F5FF',
};

interface Tone {
  ink: Hex; rim: Hex; dim: Hex; star: Hex; paper: Hex; line: Hex; edge: Hex; far: Hex;
  slateL: Hex; slateR: Hex; snow: Hex; mug: Hex; mugShade: Hex; coffee: Hex; steam: Hex;
}

const TONES: Record<'dark' | 'light', Tone> = {
  dark: {
    ink: '#F5F5F7', rim: '#B2E2FB', dim: '#2A2E35', star: '#5A6270', paper: '#F5F5F7', line: '#9AA3B0',
    edge: '#0F0F0F', far: '#1C222C', slateL: '#4A5D78', slateR: '#2C3A50', snow: '#D8DDE6',
    mug: '#EDE6DA', mugShade: '#C9BFAE', coffee: '#6B4A32', steam: '#6E7682',
  },
  light: {
    ink: '#1D1D1F', rim: '#62B3E2', dim: '#D9DCE1', star: '#B8BEC8', paper: '#FFFFFF', line: '#9AA3B0',
    edge: '#C4C9D1', far: '#E3E7EC', slateL: '#8FA3BD', slateR: '#6A7F9C', snow: '#FFFFFF',
    mug: '#EDE6DA', mugShade: '#C9BFAE', coffee: '#6B4A32', steam: '#B8BEC8',
  },
};

// 앱 아이콘 하마를 옆에서 본 모습으로 단순하게 다듬었다. 왼쪽을 본다. 눈은 위에 따로
// 그려서 두리번거리고 깜빡이고 웃게 한다.
const HEAD = [
  '..........ooo...................',
  '..oo.....ooooo..oo..............',
  '.odoooooooooooooooooo...........',
  'ooooooooooooooooooooooo.........',
  'ooooooooooooooooooooooooo.......',
  'ooooooooooooooooooooooooooo.....',
  'ooooooooooooooooooooooooooooo...',
  '.oooooooooooooooooooooooooooooo.',
  '..........oooooooooooooooooooooo',
  '..........oooooooooooooooooooooo',
  '..........oooooooooooooooooooooo',
];
const EAR_DOWN = [HEAD[0], '..oo.....ooooo..................', ...HEAD.slice(2)];
/** 눈은 이 열의 1×2 막대다. */
const EYE = 11;
/** 산을 오르는 작은 하마. 오른쪽을 본다. */
const MINI_A = [
  '......o..oo...',
  '..ooooooooko..',
  '.ooooooooooooo',
  '.oooooooookkko',
  '.oooooooooooo.',
  '.oo.oo...oo.o.',
];
const MINI_B = [...MINI_A.slice(0, 5), '..oo.oo...oo..'];
const MUG = [
  'mmmmmmmmm...',
  'mcccccccm...',
  'mmmmmmmmmmm.',
  'mmmmmmmmn..m',
  'mmmmmmmmn..m',
  'mmmmmmmmmmm.',
  'mmmmmmmmn...',
  '.mmmmmmn....',
];
const HX = 48;
/** 물결이 깔리는 열 범위. 양 끝 8칸은 옅게 그린다. */
const POND = [20, 108] as const;
const STARS: ReadonlyArray<readonly [number, number]> = [
  [10, 6], [27, 14], [40, 4], [88, 8], [104, 16], [118, 5], [72, 3],
];
/** 4×4 Bayer 순서. 장면을 바꿀 때 이 순서대로 칸이 넘어간다. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

type Eyes = 'open' | 'blink' | 'happy';
type Draw = (t: number) => void;

export interface PixelScene {
  readonly id: string;
  /** 장면이 그리는 응원 한 줄. 화면에는 쓰지 않고 접근성 이름으로만 쓴다. */
  readonly label: string;
  readonly duration: number;
}

export const PIXEL_SCENES: readonly PixelScene[] = [
  { id: 'lines', label: '한 줄씩 차근차근', duration: 3800 },
  { id: 'mountain', label: '오늘도 한 걸음 더', duration: 4600 },
  { id: 'coffee', label: '커피 한 잔', duration: 3800 },
  { id: 'thought', label: '생각을 문서로', duration: 4000 },
  { id: 'jump', label: '오늘도 화이팅', duration: 3000 },
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
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    buf[y * W + x] = rgba(hex);
  }
  function rect(x: number, y: number, w: number, h: number, hex: Hex): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, hex);
  }
  function sprite(rows: readonly string[], x: number, y: number, pal: Record<string, Hex>, clipY = H): void {
    for (let r = 0; r < rows.length && y + r < clipY; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const hex = pal[row[c]];
        if (hex) px(x + c, y + r, hex);
      }
    }
  }
  const q = (t: number): number => Math.floor(t / STEP) * STEP;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  function sky(t: number): void {
    STARS.forEach(([x, y], i) => {
      if (Math.sin(t / 700 + i * 1.7) > -0.3) px(x, y, tone.star);
    });
  }
  function water(t: number): void {
    const shift = Math.floor(t / 260);
    for (let x = POND[0]; x < POND[1]; x++) {
      const edge = Math.min(x - POND[0], POND[1] - 1 - x) < 8;
      if ((x + shift) % 9 < 4) px(x, WATER, edge ? tone.dim : HIPPO_PAL.s);
      if (!edge && (x - shift + 4) % 13 < 3) px(x, WATER + 2, tone.dim);
    }
  }
  function hippo(t: number, o: { lift?: number; eyes?: Eyes; look?: readonly [number, number] } = {}): void {
    const { lift = 0, look = [0, 0] } = o;
    const y = WATER - 8 + (Math.floor(t / 900) % 2) - lift;
    sprite(t % 5300 > 5150 ? EAR_DOWN : HEAD, HX, y, HIPPO_PAL, WATER);
    const eyes = o.eyes ?? (t % 3400 < 140 ? 'blink' : 'open');
    const x = HX + EYE + look[0];
    const top = y + 1 + look[1];
    const eye = (dx: number, dy: number): void => {
      if (top + dy < WATER) px(x + dx, top + dy, HIPPO_PAL.k);
    };
    if (eyes === 'blink') { eye(-1, 1); eye(0, 1); }
    else if (eyes === 'happy') { eye(-1, 1); eye(0, 0); eye(1, 1); }
    else { eye(0, 0); eye(0, 1); }
    // 까딱일 때마다 물결이 양옆으로 번진다.
    const k = Math.floor((t % 900) / 180);
    if (k < 4) {
      px(HX - 2 - k, WATER - 1, HIPPO_PAL.h);
      px(HX + 32 + k, WATER - 1, HIPPO_PAL.h);
    }
  }

  const idle: Draw = (t) => { t = q(t); sky(t); hippo(t); water(t); };
  const empty: Draw = () => {};

  const scenes: Record<string, Draw> = {
    // 물 위로 종이가 떠오르고 줄이 하나씩 써진다.
    lines(t) {
      t = q(t); sky(t);
      const x = 18, w = 24, h = 27;
      const top = Math.round(WATER - h * clamp01(t / 450));
      for (let j = 0; j < h && top + j < WATER; j++) {
        for (let i = 0; i < w; i++) {
          if (i >= w - 4 && j < 4 && i - (w - 4) > j - 1) continue;
          const edge = i === 0 || j === 0 || i === w - 1 || (i >= w - 4 && i - (w - 4) === j);
          px(x + i, top + j, edge ? tone.edge : tone.paper);
        }
      }
      let left = t - 550;
      let caret: [number, number] | null = null;
      const widths = [17, 15, 18, 12, 16, 8];
      widths.forEach((len, i) => {
        if (left <= 0) return;
        const n = Math.min(len, Math.floor(left / 38));
        const ly = top + 5 + i * 3;
        if (ly < WATER) rect(x + 3, ly, n, 1, tone.line);
        if (!caret && (n < len || i === widths.length - 1)) caret = [x + 3 + n, ly];
        left -= len * 38 + 160;
      });
      const at = caret as [number, number] | null;
      if (at && Math.floor(t / 300) % 2 === 0) rect(at[0], at[1] - 1, 1, 3, HIPPO_PAL.o);
      hippo(t, { look: [-1, Math.min(1, Math.floor(Math.max(0, t - 550) / 900) % 2)] });
      water(t);
    },
    // 작은 하마가 산을 올라 꼭대기에 깃발을 꽂는다.
    mountain(t) {
      t = q(t); sky(t);
      const peak = 7, cx = 64;
      const mount = (pcx: number, py: number, slope: number, left: Hex, right: Hex): void => {
        for (let y = py; y < H; y++) {
          const hw = Math.floor((y - py) * slope);
          for (let x = pcx - hw; x <= pcx + hw; x++) px(x, y, x <= pcx ? left : right);
        }
      };
      mount(20, 22, 1.4, tone.far, tone.far);
      mount(108, 20, 1.4, tone.far, tone.far);
      mount(cx, peak, 1.6, tone.slateL, tone.slateR);
      for (let y = peak; y < peak + 8; y++) {
        const hw = Math.floor((y - peak) * 1.6);
        for (let x = cx - hw; x <= cx + hw; x++) {
          const jag = (x * 7 + 3) % 4;
          if (y < peak + 5 + jag - (x > cx ? 1 : 0)) px(x, y, x > cx + 1 ? tone.slateL : tone.snow);
        }
      }
      const p = clamp01((t - 300) / 3000);
      const feet = Math.round(24 + p * 31);
      const walking = p > 0 && p < 1;
      sprite(walking && Math.floor(t / 130) % 2 ? MINI_B : MINI_A, feet - 8,
        Math.round(peak + (cx - feet + 5) / 1.6) - 6, HIPPO_PAL);
      const f = t - 3400;
      if (f > 0) {
        const pole = Math.min(6, Math.floor(f / 50));
        for (let y = 0; y < pole; y++) px(cx, peak - 1 - y, tone.ink);
        if (pole === 6) {
          rect(cx + 1, peak - 7, 6, 3, HIPPO_PAL.o);
          px(cx + 3 + (Math.floor(t / 200) % 2) * 2, peak - 6, HIPPO_PAL.s);
        }
      }
    },
    // 김이 오르는 잔이 떠오르고 하마가 웃는다.
    coffee(t) {
      t = q(t); sky(t);
      const mugY = Math.round(WATER - 6 * clamp01(t / 500));
      sprite(MUG, 26, mugY, { m: tone.mug, n: tone.mugShade, c: tone.coffee }, WATER + 1);
      if (t > 600) {
        for (let i = 0; i < 3; i++) {
          const life = ((t - 600) / 90 + i * 5) % 14;
          for (let k = 0; k < 3; k++) {
            const yy = mugY - 2 - Math.floor(life) + k;
            const wob = Math.round(Math.sin((yy + i * 3) / 2));
            if (yy < mugY - 1 && yy > mugY - 15) px(28 + i * 2 + wob, yy, tone.steam);
          }
        }
      }
      hippo(t, { eyes: t > 1200 && t < 2600 ? 'happy' : undefined, look: [t < 1200 ? -1 : 0, 0] });
      water(t);
    },
    // 머리 위로 생각 방울이 오르고, 구름 속에 종이가 들어가 저절로 써진다.
    thought(t) {
      t = q(t); sky(t);
      for (const [x, y, n, at] of [[HX + 8, 23, 1, 0], [HX + 4, 20, 2, 220], [HX - 2, 17, 3, 440]]) {
        if (t >= at) rect(x, y, n, n, tone.rim);
      }
      const c = t - 680;
      if (c >= 0) {
        // 조금 크게 튀어나왔다가 제자리에 앉는다.
        const grow = c < 70 ? 0.45 : c < 140 ? 0.8 : c < 210 ? 1.08 : 1;
        const lobes = [[19, 11, 5], [26, 7, 5], [33, 7, 5], [38, 11, 4], [27, 12, 6]];
        const inside = (x: number, y: number): boolean => lobes.some(([lx, ly, r]) => {
          const rr = r * grow, dx = x - (28 + (lx - 28) * grow), dy = y - (9 + (ly - 9) * grow);
          return dx * dx + dy * dy <= rr * rr;
        });
        for (let y = 0; y < 21; y++) for (let x = 8; x < 48; x++) {
          if (!inside(x, y)) continue;
          const rim = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
          px(x, y, rim ? tone.rim : tone.far);
        }
      }
      const d = t - 1050;
      if (d >= 0) {
        const x = 23, y = 5, w = 10, h = 11;
        const shown = Math.min(h, Math.floor(d / 30) + 1);
        for (let j = 0; j < shown; j++) for (let i = 0; i < w; i++) {
          if (i >= w - 3 && j < 3 && i - (w - 3) > j) continue;
          const edge = i === 0 || i === w - 1 || j === 0 || j === h - 1 || (i >= w - 3 && i - (w - 3) === j);
          px(x + i, y + j, edge ? tone.edge : tone.paper);
        }
        [6, 5, 6, 3].forEach((len, i) => {
          const n = Math.min(len, Math.max(0, Math.floor((d - 450 - i * 260) / 40)));
          if (n) rect(x + 2, y + 3 + i * 2, n, 1, tone.line);
        });
      }
      const looking = t > 740 && t <= 2200;
      hippo(t, {
        eyes: t > 600 && t < 740 ? 'blink' : t > 2200 ? 'happy' : undefined,
        look: looking ? [-1, -1] : [0, 0],
      });
      water(t);
    },
    // 웅크렸다 뛰어오르고 반짝이다가 물보라를 튀기며 내려앉는다.
    jump(t) {
      t = q(t); sky(t);
      let lift = 0;
      let eyes: Eyes | undefined = t < 2200 ? 'happy' : undefined;
      if (t < 260) { lift = -1; eyes = 'blink'; }
      else if (t < 1300) lift = Math.round(Math.sin(((t - 260) / 1040) * Math.PI) * 3);
      hippo(t, { lift, eyes });
      if (t > 500 && t < 1200) {
        [[HX - 4, WATER - 10], [HX + 33, WATER - 9], [HX + 14, WATER - 15]].forEach(([x, y], i) => {
          if ((Math.floor(t / 120) + i) % 3 === 0) return;
          px(x, y, HIPPO_PAL.w);
          px(x - 1, y, HIPPO_PAL.o); px(x + 1, y, HIPPO_PAL.o);
          px(x, y - 1, HIPPO_PAL.o); px(x, y + 1, HIPPO_PAL.o);
        });
      }
      const s = t - 1300;
      if (s > 0 && s < 600) {
        const p = s / 600;
        for (let i = 0; i < 4; i++) {
          const dx = Math.round((3 + i * 2) * p), dy = Math.round((6 - i) * Math.sin(p * Math.PI));
          px(HX - 2 - dx, WATER - 1 - dy, HIPPO_PAL.h);
          px(HX + 31 + dx, WATER - 1 - dy, HIPPO_PAL.h);
        }
      }
      water(t);
    },
  };

  interface Layer { draw: Draw; start: number }
  let current: Layer = { draw: empty, start: 0 };
  let swap: { from: Layer; to: Layer; start: number; duration: number; then?: () => void } | null = null;
  let sceneIndex: number | null = null;
  let sceneUntil: number | null = null;
  let timer: number | null = null;

  function paint(now: number): void {
    if (!ctx || !image || !out32) return;
    tone = document.documentElement.dataset.themeEffective === 'dark' ? TONES.dark : TONES.light;
    if (swap && now - swap.start >= swap.duration) {
      const done = swap.then;
      current = swap.to;
      swap = null;
      done?.();
    }
    if (swap) {
      buf = bufA; bufA.fill(0); swap.from.draw(now - swap.from.start);
      buf = bufB; bufB.fill(0); swap.to.draw(now - swap.to.start);
      const level = Math.floor(((now - swap.start) / swap.duration) * 17);
      for (let i = 0; i < W * H; i++) {
        out32[i] = BAYER[((i / W) & 3) * 4 + ((i % W) & 3)] < level ? bufB[i] : bufA[i];
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
      show(idle, SETTLE_MS);
    }
    paint(now);
    if (current.draw !== empty || swap) timer = window.setTimeout(tick, STEP);
  }

  function run(): void {
    if (timer === null) tick();
  }

  function show(draw: Draw, duration: number, then?: () => void): void {
    const now = performance.now();
    const to = { draw, start: now };
    if (duration <= 0) {
      current = to;
      swap = null;
      then?.();
      return;
    }
    swap = { from: swap ? swap.to : current, to, start: now, duration, then };
  }

  function play(index: number): void {
    sceneIndex = index;
    const scene = PIXEL_SCENES[index];
    const draw = scenes[scene.id];
    canvas.setAttribute('aria-label', scene.label);
    if (opts.reducedMotion()) {
      sceneUntil = null;
      show(() => draw(scene.duration), 0);
      paint(performance.now());
      return;
    }
    show(draw, current.draw === empty ? 0 : SWAP_MS);
    sceneUntil = performance.now() + scene.duration + SCENE_TAIL_MS;
    run();
  }

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
