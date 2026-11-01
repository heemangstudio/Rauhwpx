/**
 * 입력기 위에 올라앉은 작은 픽셀 하마. 앱 아이콘의 파란색으로 그린 16x7 실루엣(두 톤, 얼굴 없음)에
 * 소품을 같은 1px 격자로 얹었다. 에이전트가 생각하고, 도구를 쓰고, 답하고, 끝내는 동안 그 상태를
 * 몸짓으로 보이고, 한가할 때는 귀를 털고 서성이다 잠든다. 누르면 뛰고, 세 번 누르면 재주를 부리고,
 * 끌면 입력기 위를 옮겨 다닌다.
 *
 * - 하마 픽셀만 누를 수 있다. 캔버스는 포인터를 받지 않고, 채팅 화면의 pointerdown 을 가로채
 *   불투명한 하마 픽셀이고 그 아래가 버튼·링크·입력이 아닐 때만 잡는다. 글 선택과 입력을 막지 않는다.
 * - 꺼졌거나(view.showHama) 보이지 않으면(사이드바 닫힘·다른 화면·창 숨김) rAF 와 타이머를 모두 멈춘다.
 * - 시스템의 동작 줄이기와 상관없이 움직인다. 끄려면 설정에서 하마를 끈다.
 */
import type { TurnOutcome } from '../../agent/turn-outcome.ts';
import { baseToolName, presentToolCall } from './tool-presentation.ts';
import './chat-hama.css';

const COLORS: Record<string, string> = {
  o: '#62b3e2', s: '#2f73a0', h: '#b2e2fb',
  L: '#7a828d', B: '#5b636e', G: '#b2e2fb', g: '#e6f5ff',
  P: '#f2f4f7', p: '#9aa3ae', r: '#ff6b6b', W: '#ffffff', m: '#c98b5b',
};
/** 밝은 테마에서는 흰 반짝임과 z 가 배경에 묻히므로 진한 파랑으로 바꾼다. */
const LIGHT_COLORS: Record<string, string> = { W: '#2f73a0', g: '#62b3e2', P: '#e1e6ec' };

// ---------------------------------------------------------------- 하마
// 앱 아이콘의 하품하는 자세를 반 해상도로: 머리를 들고 턱을 벌렸다.
const LOGO = [
  '.......ooo....',
  '.....s.oo.....',
  '.....oooo.....',
  '.....oooooos..',
  '...oooooooo...',
  '.oooooooo.....',
  '.ooooooo......',
];
// 머리를 숙이고 입을 다문 모습 — 일하고, 읽고, 잘 때.
const FORWARD = [
  '..............',
  '..............',
  '.....s........',
  '.....oooooooo.',
  '...ooooooooos.',
  '.oooooooo.....',
  '.ooooooo......',
];
const LEGS = '.os..os.......';
const LEGS_STEP = '..os..os......';
const BLANK = '.'.repeat(14);

function paint(row: string, col: number, str: string): string {
  return row.slice(0, col) + str + row.slice(col + str.length);
}

// 쉴 때는 입을 다물고, 하품·말하기·환호할 때 아이콘 자세로 입을 연다.
const STAND = [...FORWARD, LEGS];
const STEP = [...FORWARD, LEGS_STEP];
const EAR = [FORWARD[0]!, paint(FORWARD[1]!, 5, 's'), ...FORWARD.slice(2), LEGS];
const OPEN = [...LOGO, LEGS];
const OPEN_EAR = [paint(LOGO[0]!, 5, 's'), ...LOGO.slice(1), LEGS];
// 몸이 한 줄 내려앉고 다리를 접는다.
const CROUCH = [BLANK, ...FORWARD];
const SLEEP = [BLANK, ...FORWARD.slice(0, 6), '.ssssssss.....'];
// 앞발을 내밀었다가 자판을 두드린다.
const PAW_UP = [...FORWARD.slice(0, 5), paint(FORWARD[5]!, 9, 'oo'), FORWARD[6]!, LEGS];
const PAW_DOWN = [...FORWARD.slice(0, 6), paint(FORWARD[6]!, 8, 'ooo'), LEGS];

// 공처럼 몸을 만 모습 — 공중제비와 튀기. 귀와 주둥이 돌기를 남겨 도는 방향이 보인다.
const BALL = [
  '....s.........',
  '...ooooo......',
  '..ooooooo.....',
  '.oooooooos....',
  '.oooooooo.....',
  '.oooooooo.....',
  '..oooooos.....',
  '...ssss.......',
  BLANK,
];
const SQUASH = [
  BLANK, BLANK, BLANK,
  '....s.........',
  '..ooooooo.....',
  '.ooooooooos...',
  'oooooooooo....',
  '.ssssssss.....',
  BLANK,
];

const POSES = {
  ball: BALL, squash: SQUASH,
  stand: STAND, step: STEP, ear: EAR, open: OPEN, cheer: OPEN_EAR, crouch: CROUCH, sleep: SLEEP, pawUp: PAW_UP, pawDown: PAW_DOWN,
};
type PoseName = keyof typeof POSES;

interface Layer {
  art: readonly string[];
  x?: number;
  y?: number;
  map?: Record<string, string>;
  /** 이 행부터 아래는 그리지 않는다(물속으로 들어갈 때). */
  clip?: number;
}

// 소품: [그림, x, y] — 하마 좌표(7행이 땅).
const PROPS: Record<string, [readonly string[], number, number]> = {
  laptop: [[
    '.....g',
    '....Gg',
    '....G.',
    '...GL.',
    'BBBBL.',
  ], 11, 3],
  paper: [['PPP', 'ppP', 'PPP', 'ppP'], 12, 3],
  magnifier: [['.L.', 'LhL', '.L.', 'L..'], 12, 1],
  bang: [['r', 'r', '.', 'r'], 10, -5],
  drop: [['h'], 4, 0],
};

const Z_FADE = ['W', 'h', 'o', 's'];

// 장면 캔버스: 하마의 c 열, r 행은 (c - OX, r + OY) 에 놓인다.
const OX = -4;
const OY = 5;
/** 땅 아래로 그리는 행(스케이트보드, 물보라). */
const BELOW = 3;
const SCENE_W = 26;
const SCENE_H = OY + 8 + BELOW;
const PIVOT = { x: 6 - OX, y: 4 + OY };
const GROUND = 7;
const SCALE = 3;
/** 오래 손대지 않으면 잠든다. */
const AUTO_SLEEP_MS = 45_000;
/** 입력이 멈춘 뒤 오른쪽 구석으로 돌아가기까지. */
const HOME_DELAY_MS = 3000;
/** 두 번 눌러 하마를 부르는 입력기 가장자리 폭(CSS 픽셀). */
const EDGE_PX = 12;
/** 입력기 위로 함께 받는 빈자리 높이(CSS 픽셀). */
const ABOVE_PX = 16;

// ---------------------------------------------------------------- 그리기
function drawLayers(ctx: CanvasRenderingContext2D, layers: readonly Layer[], palette: Record<string, string>): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const { art, x = 0, y = 0, map = {}, clip } of layers) {
    art.forEach((row, r) => {
      // 잘린 층은 땅 아래로 사라진다(잠수, 헤엄).
      if (clip != null && y + r >= clip) return;
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]!;
        if (ch === '.') continue;
        ctx.fillStyle = map[ch] ?? palette[ch] ?? COLORS[ch]!;
        ctx.fillRect(x + c - OX, y + r + OY, 1, 1);
      }
    });
  }
}

/** 로그인 카드에서 노트북을 두드리는 하마. */
export function createTypingHama(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'acct-signin-mark';
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  canvas.setAttribute('aria-hidden', 'true');
  const [art, x, y] = PROPS.laptop!;
  drawLayers(canvas.getContext('2d')!, [
    { art, x, y },
    { art: PAW_DOWN },
  ], COLORS);
  return canvas;
}

/** 설정을 마친 카드의 파티 하마. 사이드바와 같은 픽셀·팔레트로 그린다. */
export function createPartyHama(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'rhwp-setup-party-hama';
  canvas.width = SCENE_W;
  canvas.height = 20;
  canvas.setAttribute('aria-hidden', 'true');
  const hat = ['...W...', '...r...', '..rPr..', '..rrr..', '.rPrrr.', '.rrrrr.', 'PPPPPPP'];
  drawLayers(canvas.getContext('2d')!, [
    { art: STAND, y: 3 },
    { art: hat, x: 3, y: -1 },
    { art: ['h'], x: 1, y: -1 },
    { art: ['r'], x: 17, y: 2 },
    { art: ['P'], x: 19, y: -2 },
  ], COLORS);
  return canvas;
}

/**
 * 릴리스 노트 카드의 하마. 초록 리본을 묶은 빨간 크리스마스 선물 상자 위에 입을 다물고 앉아 있고,
 * 둘레에 눈이 내린다. light 면 흰 눈을 진한 파랑, 옅은 눈을 하마 색으로 바꾼다.
 */
export function createReleaseHama(light: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'rn-hama';
  canvas.width = 30;
  canvas.height = 18;
  canvas.setAttribute('aria-hidden', 'true');
  const lid = [
    'EEEEEEEVVEEEEEEE',
    'RRRRRRRVVRRRRRQQ',
    'QQQQQQQvvQQQQQQQ',
  ];
  const bow = [
    'V......V',
    'VVVkkVVV',
    'V..vv..V',
  ];
  const box = [
    'RRRRRRVVRRRRQQ',
    'RRRRRRVVRRRRQQ',
    'RRRRRRVVRRRRQQ',
    'RRRRRRVVRRRRQQ',
    'QQQQQQvvQQQQQQ',
  ];
  const palette = {
    ...COLORS,
    R: '#d8343f', Q: '#a8242f', E: '#ec5a63', V: '#2f9e5b', v: '#22784a', k: '#6fd39a',
    ...(light ? { ...LIGHT_COLORS, h: '#62b3e2' } : {}),
  };
  drawLayers(canvas.getContext('2d')!, [
    { art: EAR, x: 5, y: -3 },
    { art: lid, x: 3, y: 5 },
    { art: box, x: 4, y: 8 },
    { art: bow, x: 7, y: 5 },
    ...sparkleAt(21, 0, 2),
    dot(-2, -3, 'h'),
    dot(-3, 2, 'W'),
    dot(17, -4, 'W'),
    dot(24, 5, 'h'),
  ], palette);
  return canvas;
}

/**
 * 문서 홈 구석에서 릴리스 노트 클립보드의 막대를 문 하마. 36x26 칸(update-hippo.ts)에 채팅 하마
 * 한 칸을 두 칸으로 키워 왼쪽을 보게 그린다. 주둥이가 막대에 닿고 다리가 아래 끝에 닿는다.
 */
export function drawCornerHama(ctx: CanvasRenderingContext2D, pose: 'stand' | 'ear', stick: boolean): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (stick) {
    ctx.fillStyle = '#a3683c';
    ctx.fillRect(1, 0, 2, 18);
  }
  POSES[pose].forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!;
      if (ch === '.') continue;
      ctx.fillStyle = COLORS[ch]!;
      ctx.fillRect(3 + (12 - c) * 2, 12 + (r - 1) * 2, 2, 2);
    }
  });
}

function sparkleAt(x: number, y: number, size: number): Layer[] {
  const out = [dot(x, y, 'W')];
  if (size > 1) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) out.push(dot(x + dx, y + dy, 'h'));
  return out;
}

const dot = (x: number, y: number, ch: string): Layer => ({ art: [ch], x, y });
function sparkle(size: number): Layer[] {
  const [x, y] = [9, -2];
  if (size <= 0) return [];
  const out = [dot(x, y, 'W')];
  if (size > 1) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) out.push(dot(x + dx, y + dy, 'h'));
  return out;
}
const prop = (name: string, dx = 0, dy = 0, map?: Record<string, string>): Layer => {
  const [art, x, y] = PROPS[name]!;
  return { art, x: x + dx, y: y + dy, map };
};

// ---------------------------------------------------------------- 동작
type Facing = 1 | -1;

interface ActionFrame {
  pose: PoseName;
  x?: number;
  y?: number;
  turn?: number;
  hy?: number;
  clip?: boolean;
  /** 반짝임 크기. */
  fx?: number;
  layers?: Layer[];
  behind?: Layer[];
  /** 막대 위의 새 자리. */
  at?: number;
  face?: Facing;
  /** 착지 충격 — 입력기를 살짝 흔든다. */
  impact?: boolean;
}
type TimedFrame = ActionFrame & { ms: number };

interface ActionState {
  def: ActionDef;
  name: ActionName;
  at: number;
  from: number;
  opts?: { to?: number; lift?: number };
  impacted?: boolean;
}
interface ActionHost {
  bounds: [number, number];
  facing: Facing;
}
type ActionFn = (t: number, a: ActionState, h: ActionHost) => ActionFrame | null;
type ActionDef = readonly TimedFrame[] | ActionFn;

const HOP: TimedFrame[] = [
  { ms: 80, pose: 'crouch' },
  { ms: 70, pose: 'step', y: -1 },
  { ms: 90, pose: 'step', y: -2 },
  { ms: 70, pose: 'step', y: -1 },
  { ms: 80, pose: 'crouch' },
  { ms: 60, pose: 'stand' },
];
const CHEER: TimedFrame[] = [
  { ms: 80, pose: 'crouch' },
  { ms: 70, pose: 'cheer', y: -1, fx: 1 },
  { ms: 100, pose: 'cheer', y: -3, fx: 2 },
  { ms: 70, pose: 'cheer', y: -1, fx: 2 },
  { ms: 80, pose: 'crouch', fx: 1 },
  { ms: 70, pose: 'cheer', y: -1, fx: 2 },
  { ms: 90, pose: 'cheer', y: -2, fx: 1 },
  { ms: 70, pose: 'crouch' },
  { ms: 600, pose: 'cheer' },
];
// 몸을 펴고, 공처럼 말아 돌고, 펴며 내려선다.
const BACKFLIP: TimedFrame[] = [
  { ms: 110, pose: 'crouch' },
  { ms: 60, pose: 'step', y: -2 },
  { ms: 50, pose: 'ball', y: -4 },
  { ms: 60, pose: 'ball', y: -6, turn: -1 },
  { ms: 70, pose: 'ball', y: -7, turn: -2 },
  { ms: 60, pose: 'ball', y: -6, turn: -3 },
  { ms: 50, pose: 'ball', y: -4, turn: -4 },
  { ms: 60, pose: 'step', y: -2 },
  { ms: 100, pose: 'crouch' },
  { ms: 60, pose: 'stand' },
];
const SHUFFLE: TimedFrame[] = [
  { ms: 150, pose: 'step' }, { ms: 150, pose: 'stand' },
  { ms: 150, pose: 'step', x: 1 }, { ms: 150, pose: 'stand', x: 1 },
  { ms: 150, pose: 'step' }, { ms: 150, pose: 'stand' },
];
const LAND: TimedFrame[] = [{ ms: 90, pose: 'crouch' }, { ms: 60, pose: 'stand' }];
const SHAKE: TimedFrame[] = [
  { ms: 60, pose: 'crouch', x: -1 }, { ms: 60, pose: 'crouch', x: 1 },
  { ms: 60, pose: 'crouch', x: -1 }, { ms: 60, pose: 'crouch', x: 1 },
  { ms: 80, pose: 'crouch' },
];
const JUMP: TimedFrame[] = [
  { ms: 110, pose: 'crouch' },
  { ms: 50, pose: 'step', y: -3 },
  { ms: 50, pose: 'step', y: -6 },
  { ms: 60, pose: 'step', y: -8 },
  { ms: 80, pose: 'crouch', y: -9 },
  { ms: 80, pose: 'crouch', y: -9 },
  { ms: 60, pose: 'step', y: -8 },
  { ms: 50, pose: 'step', y: -6 },
  { ms: 50, pose: 'step', y: -3 },
  { ms: 110, pose: 'crouch' },
  { ms: 60, pose: 'stand' },
];

const fade = (k: number): string => Z_FADE[Math.min(3, k)]!;
const lerp = (a: number, b: number, p: number): number => a + (b - a) * Math.max(0, Math.min(1, p));
const arc = (p: number, h: number): number => -Math.round(Math.sin(Math.PI * Math.max(0, Math.min(1, p))) * h);

/** (cx, 땅)에서 위로 튀어 오르는 물방울. age 는 ms. */
function droplets(cx: number, age: number, spread = 1): Layer[] {
  const out: Layer[] = [];
  for (const [vx, vy] of [[-1.6, 4.5], [-0.8, 6], [0.8, 6.2], [1.7, 4.6], [-2.4, 3], [2.5, 3.2]] as const) {
    const s = age / 120;
    const y = Math.round(GROUND - (vy * s - 1.1 * s * s));
    if (y > GROUND) continue;
    out.push(dot(Math.round(cx + vx * s * spread), y, fade(Math.floor(age / 180))));
  }
  return out;
}
function ripples(cx: number, age: number): Layer[] {
  const k = Math.floor(age / 110);
  if (k > 3) return [];
  return [dot(cx - 2 - k * 2, GROUND, fade(k)), dot(cx + 2 + k * 2, GROUND, fade(k))];
}

/** 뛰어올라 입력기 속으로 코부터 잠수했다가 다시 솟는다. */
const SPLASH: ActionFn = (t) => {
  if (t < 110) return { pose: 'crouch' };
  if (t < 470) return { pose: 'step', y: arc((t - 110) / 720, 8) };
  if (t < 600) return { pose: 'crouch', y: arc((t - 110) / 720, 8), hy: 0, clip: true };
  const under = t - 600;
  if (under < 180) {
    return { pose: 'crouch', hy: Math.round(lerp(0, 9, under / 120)), clip: true, layers: [...droplets(6, under), ...ripples(6, under)] };
  }
  if (under < 900) return { pose: 'crouch', hy: 9, clip: true, layers: [...droplets(6, under), ...ripples(6, under)] };
  const up = under - 900;
  if (up < 220) return { pose: 'ear', hy: Math.round(lerp(9, 0, up / 200)), clip: true, layers: ripples(6, up) };
  if (up < 620) {
    // 몸을 털며 한 픽셀씩 좌우로, 물방울은 옆으로 튄다.
    const side = Math.floor(up / 70) % 2 ? 1 : -1;
    return { pose: 'stand', x: side * (up < 480 ? 1 : 0), layers: droplets(6, up - 220, 1.6).slice(0, 4) };
  }
  return null;
};

/** 높이 뛰어 잠깐 멈췄다가 내리꽂는다. 착지에 입력기가 흔들린다. */
const SMASH: ActionFn = (t) => {
  if (t < 130) return { pose: 'crouch' };
  if (t < 430) return { pose: 'step', y: Math.round(lerp(0, -11, (t - 130) / 300)) };
  if (t < 560) return { pose: 'cheer', y: -11 };
  if (t < 620) return { pose: 'crouch', y: Math.round(lerp(-11, 0, (t - 560) / 60)) };
  const after = t - 620;
  if (after > 700) return null;
  const k = Math.floor(after / 90);
  const layers: Layer[] = [];
  if (k < 5) {
    for (const side of [-1, 1]) {
      const x = side < 0 ? -1 - k : 14 + k;
      layers.push(dot(x, GROUND - (k < 2 ? 1 : 0), fade(k)), dot(x + side, GROUND, fade(k + 1)));
    }
  }
  if (after < 90) layers.push(dot(-2, 3, 'W'), dot(-1, 4, 'W'), dot(15, 3, 'W'), dot(14, 4, 'W'));
  return { pose: after < 260 ? 'crouch' : 'stand', y: after < 60 ? 1 : 0, impact: true, layers };
};

/**
 * 물에 들어가 귀와 등만 내놓고 헤엄쳐 갔다 오고, 올라와 몸을 턴다.
 * a.opts.to 가 있으면 그곳까지 헤엄쳐 가서 올라온다.
 */
const SWIM: ActionFn = (t, a, h) => {
  const to = a.opts?.to;
  const span = to != null ? Math.abs(to - a.from) : 16;
  const dir: Facing = to != null ? (to >= a.from ? 1 : -1) : a.from - span < h.bounds[0] ? 1 : -1;
  if (t < 200) return { pose: 'step', y: arc(t / 200, 2) };
  if (t < 450) return { pose: 'crouch', hy: Math.round(lerp(0, 3, (t - 200) / 200)), clip: true, layers: ripples(6, t - 200) };
  const swim = t - 450;
  const total = span * (to != null ? 1 : 2) * 90;
  if (swim < total) {
    const out = to != null || swim < total / 2;
    const p = to != null ? swim / total : out ? swim / (total / 2) : 2 - swim / (total / 2);
    const bob = Math.floor(swim / 320) % 2;
    const wakeX = Math.floor(swim / 150) % 2;
    const wake = [dot(-1 - wakeX, GROUND, 'h'), dot(-3 - wakeX, GROUND, 'o'), dot(13, GROUND, 'h'), dot(14, GROUND, 'o')];
    return { pose: 'stand', hy: 3 + bob, clip: true, at: a.from + dir * Math.round(p * span), face: out ? dir : (-dir as Facing), layers: wake };
  }
  const out = swim - total;
  if (out < 220) return { pose: 'ear', hy: Math.round(lerp(3, 0, out / 200)), clip: true, y: arc(out / 220, 2), layers: ripples(6, out) };
  if (out < 600) {
    const side = Math.floor(out / 70) % 2 ? 1 : -1;
    return { pose: 'stand', x: out < 480 ? side : 0, layers: droplets(6, out - 220, 1.6).slice(0, 4) };
  }
  return null;
};

/**
 * 공중제비로 공이 되어 막대를 따라 튀며 구르고, 내려설 때마다 납작해진다.
 * a.opts.to 가 있으면 그곳까지, 없으면 자리가 있는 쪽으로 22px 구른다.
 */
const BALL_BOUNCE: ActionFn = (t, a, h) => {
  let span = 22;
  let dir: Facing = a.from + h.facing * span > h.bounds[1] || a.from + h.facing * span < h.bounds[0] ? (-h.facing as Facing) : h.facing;
  if (a.opts?.to != null) {
    span = Math.abs(a.opts.to - a.from);
    dir = a.opts.to >= a.from ? 1 : -1;
  }
  if (t < 110) return { pose: 'crouch', face: dir };
  if (t < 170) return { pose: 'step', y: -2, face: dir };
  const flip = t - 170;
  if (flip < 300) return { pose: 'ball', y: arc(flip / 300, 7) || -1, turn: -Math.floor(flip / 75) - 1, face: dir };
  const BOUNCES = [[460, 6], [360, 4], [280, 2], [200, 1]] as const;
  let at = flip - 300;
  // 마지막 튀기가 내려서는 순간 도착한다.
  const rolled = (ms: number): number => a.from + dir * Math.round(span * Math.min(1, ms / 1300));
  for (const [ms, height] of BOUNCES) {
    if (at < ms) {
      const roll = flip - 300;
      if (at < 60) return { pose: 'squash', at: rolled(roll), face: dir };
      return { pose: 'ball', y: arc((at - 60) / (ms - 60), height), turn: Math.floor(roll / 70), at: rolled(roll), face: dir };
    }
    at -= ms;
  }
  const end = rolled(flip - 300);
  if (at < 90) return { pose: 'squash', at: end, face: dir };
  if (at < 170) return { pose: 'step', y: -2, at: end, face: dir };
  if (at < 260) return { pose: 'crouch', at: end, face: dir };
  if (at < 760) return { pose: 'cheer', at: end, face: dir, fx: 1 };
  return null;
};

/**
 * 들어 올렸다 놓으면 떨어지며 공처럼 말리고, 땅에 닿아 납작해진 뒤 구르다 일어선다.
 * a.opts.lift 는 놓은 높이(장면 픽셀), 높을수록 오래 떨어지고 멀리 구른다.
 */
const DROP: ActionFn = (t, a, h) => {
  const lift = a.opts?.lift ?? 0;
  const fall = 90 + Math.sqrt(lift) * 70;
  if (t < fall) {
    const p = t / fall;
    const y = -Math.round(lift * (1 - p * p));
    if (p < 0.35) return { pose: 'step', y };
    return { pose: 'ball', y, turn: -Math.floor((t - fall * 0.35) / 70) - 1 };
  }
  let span = Math.round(6 + Math.min(34, lift * 1.2));
  let dir: Facing = h.facing;
  if (a.from + dir * span > h.bounds[1] || a.from + dir * span < h.bounds[0]) dir = -dir as Facing;
  span = Math.min(span, dir > 0 ? h.bounds[1] - a.from : a.from - h.bounds[0]);
  const at = t - fall;
  if (at < 70) return { pose: 'squash', face: dir, impact: lift >= 8 };
  const BOUNCES = [[Math.min(340, 160 + lift * 6), Math.max(1, Math.min(8, Math.round(lift / 4)))], [200, Math.min(3, Math.round(lift / 16)) || 1]] as const;
  const total = BOUNCES[0][0] + BOUNCES[1][0];
  const roll = at - 70;
  const rolled = a.from + dir * Math.round(span * Math.min(1, roll / total));
  if (roll < total) {
    const [ms, height] = roll < BOUNCES[0][0] ? BOUNCES[0] : BOUNCES[1];
    const local = roll < BOUNCES[0][0] ? roll : roll - BOUNCES[0][0];
    return { pose: 'ball', y: arc(local / ms, height), turn: Math.floor(roll / 70), at: rolled, face: dir };
  }
  const end = roll - total;
  if (end < 80) return { pose: 'squash', at: rolled, face: dir };
  if (end < 170) return { pose: 'crouch', at: rolled, face: dir };
  if (end < 230) return { pose: 'stand', at: rolled, face: dir };
  if (end < 470) return { pose: 'ear', at: rolled, face: dir, x: Math.floor(end / 60) % 2 ? 1 : 0 };
  return null;
};

const BOARD = ['.mmmmmmmmmmmm.', '..L.......L...'];
const BOARD_SPIN = ['..L.......L...', '.mmmmmmmmmmmm.'];
const board = (y: number, art: readonly string[] = BOARD, map?: Record<string, string>): Layer => ({ art, x: 0, y, map });

/** 보드를 차 내어 a.opts.to 까지 타고 가서 킥플립으로 올리고 내려선다. */
const SKATE: ActionFn = (t, a, h) => {
  const fallback = a.from > (h.bounds[0] + h.bounds[1]) / 2 ? h.bounds[0] : h.bounds[1];
  const to = Math.max(h.bounds[0], Math.min(h.bounds[1], Math.round(a.opts?.to ?? fallback)));
  const dir: Facing = to >= a.from ? 1 : -1;
  const dist = Math.abs(to - a.from);
  const ride = dist * 24;
  if (t < 160) return { pose: 'crouch', face: dir, behind: [board(6)] };
  if (t < 260) return { pose: 'step', face: dir, y: t < 210 ? -3 : -2, behind: [board(8 + (t < 210 ? 1 : 0))] };
  const r = t - 260;
  const spin = { L: Math.floor(t / 60) % 2 ? '#7a828d' : '#b2e2fb' };
  if (r < ride) {
    const lean = Math.floor(r / 400) % 3 === 2 ? 'crouch' : 'stand';
    const wind = Math.floor(r / 90) % 2;
    const layers = [dot(-2 - wind, 3, 'h'), dot(-4 - wind, 5, 's'), dot(-3 + wind, 1, 's')];
    return { pose: lean, face: dir, y: -2, at: a.from + dir * Math.floor(r / 24), behind: [board(8, BOARD, spin)], layers };
  }
  const o = r - ride;
  const OLLIE = [[70, -3, BOARD], [70, -5, BOARD_SPIN], [80, -6, BOARD], [70, -5, BOARD_SPIN], [70, -3, BOARD], [90, -2, BOARD]] as const;
  let acc = 0;
  for (const [ms, y, art] of OLLIE) {
    acc += ms;
    if (o < acc) return { pose: y < -4 ? 'crouch' : 'step', face: dir, y, at: to, behind: [board(8, art)] };
  }
  const off = o - acc;
  if (off < 120) return { pose: 'step', face: dir, y: -1, at: to, behind: [board(7)] };
  if (off < 220) return { pose: 'crouch', face: dir, at: to };
  return null;
};

const ACTIONS = {
  hop: HOP, cheer: CHEER, backflip: BACKFLIP, shuffle: SHUFFLE, land: LAND, shake: SHAKE,
  jump: JUMP, splash: SPLASH, smash: SMASH, swim: SWIM, skate: SKATE, ballBounce: BALL_BOUNCE, drop: DROP,
} satisfies Record<string, ActionDef>;
type ActionName = keyof typeof ACTIONS;
const TRICKS: readonly ActionName[] = ['jump', 'backflip', 'ballBounce', 'splash', 'smash', 'swim', 'skate'];

const TYPING = [[90, 1], [80, 0], [90, 1], [80, 0], [70, 1], [260, 0], [90, 1], [70, 0], [90, 1], [200, 0], [80, 1], [80, 0], [90, 1], [420, 0]] as const;
const TYPING_MS = TYPING.reduce((s, [ms]) => s + ms, 0);
const TALKING = [[140, 'open'], [120, 'stand'], [160, 'open'], [380, 'stand']] as const;
const TALKING_MS = TALKING.reduce((s, [ms]) => s + ms, 0);
const GLOW = ['#b2e2fb', '#e6f5ff', '#62b3e2', '#ffffff'];

function cycle<T extends readonly [number, unknown]>(table: readonly T[], total: number, t: number): [number, T] {
  let at = t % total;
  for (let i = 0; i < table.length; i++) {
    if (at < table[i]![0]) return [i, table[i]!];
    at -= table[i]![0];
  }
  return [0, table[0]!];
}
const noise = (n: number): number => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

// ---------------------------------------------------------------- 상태
interface ModeFrame {
  pose: PoseName;
  behind?: Layer[];
  fx?: Layer[];
  /** 자판을 두드리다 고개를 끄덕인다. */
  nod?: boolean;
}

export type ChatHamaMode = 'idle' | 'think' | 'work' | 'read' | 'search' | 'talk' | 'sleep' | 'error' | 'done';

const MODES: Record<ChatHamaMode, (t: number) => ModeFrame> = {
  idle: () => ({ pose: 'stand' }),
  think(t: number): ModeFrame {
    const k = Math.floor(t / 320) % 5;
    const fx = [0, 1, 2].map((i) => dot(6 + i * 2, 0, i < k ? 'W' : 's'));
    return { pose: t % 2600 < 180 ? 'ear' : 'stand', fx };
  },
  work(t: number): ModeFrame {
    const [i, [, down]] = cycle(TYPING, TYPING_MS, t);
    const step = Math.floor(t / TYPING_MS) * TYPING.length + i;
    const glow = GLOW[Math.floor(noise(Math.floor(t / 450)) * GLOW.length)]!;
    const fx: Layer[] = [];
    if (down) fx.push(dot(11 + Math.floor(noise(step) * 3), 7, 'W'));
    const p = t % 1400;
    if (p < 560) {
      const age = Math.floor(p / 140);
      fx.push(dot(16, 2 - age, Z_FADE[age]!));
    }
    return { pose: down ? 'pawDown' : 'pawUp', behind: [prop('laptop', 0, 0, { G: glow })], fx, nod: !down && i === 5 };
  },
  read(t: number): ModeFrame {
    const shift = Math.floor(t / 520) % 2;
    const art = PROPS.paper![0].map((row, r) => (r % 2 ? (shift ? 'pPp' : 'ppP') : row));
    return { pose: 'pawUp', fx: [{ art, x: 12, y: 3 }] };
  },
  search(t: number): ModeFrame {
    const path = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    const [dx, dy] = path[Math.floor(t / 280) % path.length]!;
    return { pose: 'pawUp', fx: [prop('magnifier', dx, dy)] };
  },
  talk(t: number): ModeFrame {
    const [, [, pose]] = cycle(TALKING, TALKING_MS, t);
    return { pose };
  },
  sleep(t: number): ModeFrame {
    const fx: Layer[] = [];
    for (let n = 0; n < 2; n++) {
      const age = (t + n * 1500) % 3000;
      const k = Math.floor(age / 750);
      fx.push(dot(12 + k, 2 - k * 2, Z_FADE[k]!));
    }
    return { pose: 'sleep', fx };
  },
  error(t: number): ModeFrame {
    const fx: Layer[] = [];
    if (t % 900 < 600) fx.push(prop('bang'));
    fx.push(prop('drop', 0, Math.min(2, Math.floor(t / 400) % 4)));
    return { pose: 'crouch', fx };
  },
  done(t: number): ModeFrame {
    return { pose: 'cheer', fx: sparkle([1, 2, 2, 1, 0][Math.floor(t / 120) % 8] ?? 0) };
  },
};

// ---------------------------------------------------------------- 엔진
interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  fromX: number;
  /** 입력기 위로 들어 올린 높이(장면 픽셀). */
  lift: number;
  moved: boolean;
}

export class Hama implements ActionHost {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  x = 0;
  facing: Facing = 1;
  bounds: [number, number] = [0, 0];
  mode: ChatHamaMode = 'idle';
  idleActions: readonly ActionName[] | null = null;
  private idleActionIndex = 0;
  /** 부딪혀 내려설 때(스매시) — 입력기를 흔든다. */
  onImpact: (() => void) | null = null;
  /** 들어 올릴 수 있는 높이(장면 픽셀) — 채팅 화면의 절반까지. */
  maxLift: () => number = () => 12;
  private target: number | null = null;
  private returnTo: number | null = null;
  private modeAt = performance.now();
  private action: ActionState | null = null;
  private walkAt = 0;
  private lastInput = performance.now();
  private micro: { pose: PoseName; until: number } | null = null;
  private nextIdle = performance.now() + 2500;
  private lastKey = '';
  private drag: Drag | null = null;
  private clicks: number[] = [];
  private raf = 0;
  private active = false;
  private lastTurn = 0;
  private readonly fixedFacing?: Facing;

  constructor(fixedFacing?: Facing) {
    this.fixedFacing = fixedFacing;
    this.el = document.createElement('div');
    this.el.className = 'ag-hama-hippo';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.marginLeft = `${OX * SCALE}px`;
    this.el.style.marginBottom = `${-BELOW * SCALE}px`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCENE_W;
    this.canvas.height = SCENE_H;
    this.canvas.style.width = `${SCENE_W * SCALE}px`;
    this.canvas.style.height = `${SCENE_H * SCALE}px`;
    this.canvas.style.transformOrigin = `${PIVOT.x * SCALE}px ${PIVOT.y * SCALE}px`;
    this.el.append(this.canvas);
    // 누른 자리가 하마 픽셀인지 자주 읽는다.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.el.dataset.mode = this.mode;
    this.loop = this.loop.bind(this);
  }

  /** 보이는 동안만 rAF 를 돌린다. */
  setActive(active: boolean, animate = true): void {
    this.active = active && animate;
    this.syncLoop();
    if (active) this.render(performance.now());
  }

  private syncLoop(): void {
    const run = this.active;
    if (run && !this.raf) this.raf = requestAnimationFrame(this.loop);
    if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  setBounds(min: number, max: number): void {
    this.bounds = [min, Math.max(min, max)];
    this.x = Math.max(this.bounds[0], Math.min(this.bounds[1], this.x));
  }

  setMode(mode: ChatHamaMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeAt = performance.now();
    this.lastInput = this.modeAt;
    if (mode !== 'idle') this.target = null;
    // 하던 몸짓(턴 시작의 깡충, 한가할 때의 재주)은 새 상태에 자리를 내준다 — 이어 가면 그 동안
    // 노트북·종이·돋보기가 가려진다. 도구가 빨리 바뀌는 턴에서는 소품이 아예 보이지 않는다.
    if (mode !== 'idle' && mode !== 'sleep') this.action = null;
    if (mode === 'done') this.play('cheer');
    if (mode === 'error') this.play('shake');
    this.el.dataset.mode = mode;
  }

  play(name: ActionName, opts?: ActionState['opts']): void {
    this.target = null;
    this.returnTo = null;
    this.micro = null;
    this.action = { def: ACTIONS[name], name, at: performance.now(), from: this.x, opts };
  }

  /** 산책은 나갔다가 출발한 자리로 돌아온다. */
  walkTo(x: number, stroll = false): void {
    if (!['idle', 'think', 'talk'].includes(this.mode)) return;
    this.returnTo = stroll ? this.x : null;
    if (this.mode === 'idle') this.wake();
    this.target = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], x)));
  }

  /** 막대 위 x 로 보드를 타거나, 구르거나, 헤엄쳐 간다. */
  travel(x: number): void {
    const to = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], x)));
    if (this.drag || Math.abs(to - this.x) < 3) return;
    this.wake();
    this.play((['skate', 'ballBounce', 'swim'] as const)[Math.floor(Math.random() * 3)]!, { to });
  }

  wake(): void {
    this.lastInput = performance.now();
    if (this.mode === 'sleep') {
      this.setMode('idle');
      this.play('hop');
    }
  }

  /** 마우스가 하마에 닿으면 귀를 턴다. */
  hover(): void {
    if (!this.action && this.mode === 'idle') this.micro = { pose: 'ear', until: performance.now() + 220 };
  }

  /** 화면 좌표가 그려진 하마 픽셀(한 칸 여유)에 닿는가. 도는 중에는 잡지 않는다. */
  hits(clientX: number, clientY: number): boolean {
    if (this.lastTurn !== 0 || !this.el.isConnected) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
    let px = Math.floor((clientX - rect.left) / SCALE);
    const py = Math.floor((clientY - rect.top) / SCALE);
    // scaleX(-1) 로 뒤집혀 있으면 캔버스 열도 뒤집힌다.
    if ((this.fixedFacing ?? this.facing) < 0) px = SCENE_W - 1 - px;
    const x0 = Math.max(0, px - 1);
    const y0 = Math.max(0, py - 1);
    const w = Math.min(SCENE_W, px + 2) - x0;
    const h = Math.min(SCENE_H, py + 2) - y0;
    if (w <= 0 || h <= 0) return false;
    const data = this.ctx.getImageData(x0, y0, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
    return false;
  }

  /**
   * 하마를 눌렀다. 끌면 옮기고, 위로 들어 올렸다 놓으면 떨어져 구르고, 그냥 떼면 뛰고,
   * 세 번이면 재주를 부린다.
   */
  grab(event: PointerEvent): void {
    const maxLift = this.maxLift();
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, fromX: this.x, lift: 0, moved: false };
    const move = (e: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = (e.clientX - drag.startX) / SCALE;
      const dy = (drag.startY - e.clientY) / SCALE;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      if (!drag.moved) return;
      this.action = null;
      this.target = null;
      this.returnTo = null;
      const nx = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], drag.fromX + dx)));
      if (nx !== this.x) this.facing = nx > this.x ? 1 : -1;
      this.x = nx;
      drag.lift = Math.round(Math.max(0, Math.min(maxLift, dy)));
    };
    const up = (e: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.drag = null;
      if (e.type === 'pointercancel') return;
      if (drag.moved) {
        this.wake();
        if (drag.lift >= 3) this.play('drop', { lift: drag.lift + 2 });
        else this.play('land');
        return;
      }
      const now = performance.now();
      this.wake();
      this.clicks = [...this.clicks.filter((at) => now - at < 2500), now];
      if (this.clicks.length >= 3) {
        this.clicks = [];
        this.play(TRICKS[Math.floor(Math.random() * TRICKS.length)]!);
      } else {
        this.play('hop');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private frame(now: number): { layers: Layer[]; dx: number; dy: number; turn: number } {
    const free = !this.action && !this.drag && ['idle', 'think', 'talk'].includes(this.mode);
    let walking = false;
    if (free && this.target != null && this.target !== this.x) {
      walking = true;
      if (now - this.walkAt > (Math.abs(this.target - this.x) > 20 ? 35 : 60)) {
        this.walkAt = now;
        this.facing = this.target > this.x ? 1 : -1;
        this.x += this.facing;
      }
    } else if (this.target === this.x) {
      this.target = this.returnTo ?? null;
      this.returnTo = null;
    }

    // 한가할 때: 귀 털기, 발 구르기, 뛰기, 산책, 잠들기.
    if (this.mode === 'idle' && !this.action && !walking && !this.drag) {
      if (now - this.lastInput > AUTO_SLEEP_MS) this.setMode('sleep');
      else if (now > this.nextIdle) {
        if (this.idleActions?.length) {
          this.play(this.idleActions[this.idleActionIndex++ % this.idleActions.length]!);
        } else {
          const roll = Math.random();
          if (roll < 0.25) this.micro = { pose: 'ear', until: now + 200 };
          else if (roll < 0.4) this.micro = { pose: 'open', until: now + 900 };
          else if (roll < 0.7) this.play('shuffle');
          else if (roll < 0.8) this.play('hop');
          else if (roll < 0.9) this.walkTo(this.x - 4 - Math.random() * 8, true);
          else this.play((['jump', 'swim', 'backflip', 'splash'] as const)[Math.floor(Math.random() * 4)]!);
        }
        this.nextIdle = now + 1800 + Math.random() * 2600;
      }
    }

    // rAF 시각은 setMode 의 performance.now() 보다 늦을 수 있다.
    const t = Math.max(0, now - this.modeAt);
    const m = MODES[this.mode](t);
    let pose = m.pose;
    let dx = 0, dy = 0, turn = 0, hy = 0;
    let clip: number | undefined;
    let fx = m.fx ?? [];
    let behind = m.behind ?? [];

    if (this.action) {
      const a = this.action;
      const elapsed = Math.max(0, now - a.at);
      let f: ActionFrame | null | undefined;
      if (Array.isArray(a.def)) {
        let acc = 0;
        f = (a.def as readonly TimedFrame[]).find((fr) => (acc += fr.ms) > elapsed);
      } else {
        f = (a.def as ActionFn)(elapsed, a, this);
      }
      if (!f) {
        this.action = null;
        this.nextIdle = now + 1800 + Math.random() * 2600;
      } else {
        pose = f.pose;
        dx = f.x ?? 0;
        dy = f.y ?? 0;
        turn = f.turn ?? 0;
        hy = f.hy ?? 0;
        clip = f.clip ? GROUND + 1 : undefined;
        fx = f.fx ? sparkle(f.fx) : f.layers ?? [];
        behind = f.behind ?? [];
        if (f.at != null) this.x = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], f.at)));
        if (f.face) this.facing = f.face;
        if (f.impact && !a.impacted) {
          a.impacted = true;
          this.onImpact?.();
        }
      }
    }
    if (this.drag?.moved) {
      // 들려 있으면 발을 버둥거린다.
      pose = this.drag.lift > 0 && Math.floor(now / 140) % 2 ? 'stand' : 'step';
      dy = -2 - this.drag.lift;
      dx = 0;
      turn = 0;
    } else if (walking && !this.action) {
      pose = Math.floor(now / 120) % 2 ? 'step' : 'stand';
    } else if (!this.action && this.micro && now < this.micro.until && this.mode === 'idle') {
      pose = this.micro.pose;
    }
    if (m.nod && !this.action) dy += 1;
    const layers = [...behind, { art: POSES[pose], y: hy, clip }, ...fx];
    return { layers, dx, dy, turn };
  }

  private render(now: number): void {
    if (!this.el.isConnected) return;
    const f = this.frame(now);
    const light = document.documentElement.dataset.themeEffective === 'light';
    const facing = this.fixedFacing ?? this.facing;
    const key = JSON.stringify(f) + this.x + facing + light;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastTurn = f.turn;
    drawLayers(this.ctx, f.layers, light ? LIGHT_COLORS : COLORS);
    this.el.style.transform = `translateX(${(this.x + f.dx) * SCALE}px)`;
    this.canvas.style.transform = `translateY(${f.dy * SCALE}px) scaleX(${facing}) rotate(${f.turn * 90 * facing}deg)`;
  }

  private loop(now: number): void {
    this.raf = 0;
    if (!this.active) return;
    this.render(now);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.active = false;
    this.syncLoop();
    this.el.remove();
  }
}

// ---------------------------------------------------------------- 사이드바 연결
/** 하마가 누를 수 있는 것 위에 서 있으면 그 클릭을 가로채지 않는다. */
const INTERACTIVE = [
  'button', 'a[href]', 'input', 'textarea', 'select', 'label', 'summary',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="switch"]', '[role="tab"]', '[role="checkbox"]',
  '[contenteditable=""]', '[contenteditable="true"]',
].join(', ');

/** 도구 이름으로 몸짓을 고른다 — 찾기·확인은 돋보기, 읽기는 종이, 나머지(편집·명령)는 노트북. */
export function hamaModeForTool(tool: string, argsJson = '{}'): ChatHamaMode {
  const name = baseToolName(tool);
  if (/search|find|grep|glob|query|fetch|browse/i.test(name)) return 'search';
  const { category } = presentToolCall(tool, argsJson);
  if (category === 'check') return 'search';
  if (category === 'read' || /^(read|view|get|list|ls)(_|$)/i.test(name)) return 'read';
  return 'work';
}

export interface ChatHamaOptions {
  /** 하마가 올라앉는 입력기. */
  composer: HTMLElement;
  /** 입력하는 동안 캐럿을 따라 걷는다. */
  input: HTMLTextAreaElement;
  /** 하마를 누르는 포인터를 받는 범위(채팅 화면). 이 면이 숨으면 하마도 멈춘다. */
  hitRoot: HTMLElement;
  /** 설정 view.showHama. */
  enabled(): boolean;
  /** 사이드바가 열렸거나 집중 화면인가. */
  shown(): boolean;
}

export interface ChatHama {
  /** 설정·열림·화면이 바뀌었다 — 하마를 붙이거나 떼고, 루프를 켜거나 멈춘다. 사이드바 뿌리의 클래스가 바뀔 때마다 부른다. */
  sync(): void;
  /** 턴이 돌기 시작했거나 멈췄다. */
  setRunning(running: boolean): void;
  /** 도구를 부른다. */
  tool(tool: string, argsJson?: string): void;
  /** 답을 쓰는 중이다. */
  talking(): void;
  /** 턴이 끝났다 — 완료면 환호, 실패면 움츠림, 중단이면 그냥 선다. */
  turnEnded(outcome: TurnOutcome): void;
  /** 턴 밖의 일(문체 학습)을 보인다 — 턴이 도는 동안은 턴이 하마를 쓴다. null 이면 한가함으로. */
  background(mode: ChatHamaMode | null): void;
  /** 지금 상태(시험용). */
  readonly mode: ChatHamaMode;
  dispose(): void;
}

const RUNNING_MODES: ReadonlySet<ChatHamaMode> = new Set(['think', 'work', 'read', 'search', 'talk']);
/** 끝 상태를 보인 뒤 한가함으로 돌아가기까지. */
const SETTLE_MS: Partial<Record<ChatHamaMode, number>> = { done: 2000, error: 5000 };

export function createChatHama(opts: ChatHamaOptions): ChatHama {
  const { composer, input, hitRoot } = opts;
  let mode: ChatHamaMode = 'idle';
  let running = false;
  /** 턴 밖의 일(문체 학습)이 바라는 모습. 턴이 끝나거나 끝 상태가 거둬지면 이리로 돌아간다. */
  let backgroundMode: ChatHamaMode | null = null;
  let settleAt = 0;
  let settleTimer = 0;
  let homeTimer = 0;
  let intersecting = false;
  let mounted: {
    hama: Hama;
    perch: HTMLDivElement;
    resize: ResizeObserver | null;
    io: IntersectionObserver | null;
  } | null = null;
  let disposed = false;
  let measure: CanvasRenderingContext2D | null = null;

  const home = (perch: HTMLElement): number => Math.floor(perch.clientWidth / SCALE - 15);

  function setMode(next: ChatHamaMode): void {
    mode = next;
    window.clearTimeout(settleTimer);
    settleTimer = 0;
    settleAt = SETTLE_MS[next] ? performance.now() + SETTLE_MS[next]! : 0;
    mounted?.hama.setMode(next);
    armSettle();
  }

  /** 채팅 화면이 설정·목록 같은 다른 면 뒤로 숨었는가(visibility: hidden). */
  function pageHidden(): boolean {
    return typeof composer.checkVisibility === 'function' && !composer.checkVisibility({ visibilityProperty: true });
  }

  function isActive(): boolean {
    return Boolean(mounted) && intersecting && document.visibilityState !== 'hidden' && opts.shown() && !pageHidden();
  }

  /** 끝 상태를 거두는 타이머 — 보이는 동안만 건다. 숨어 있던 사이에 지났으면 바로 거둔다. */
  function armSettle(): void {
    window.clearTimeout(settleTimer);
    settleTimer = 0;
    if (!settleAt || !isActive()) return;
    const wait = settleAt - performance.now();
    if (wait <= 0) {
      if (!running) setMode(backgroundMode ?? 'idle');
      return;
    }
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (!running && settleAt) setMode(backgroundMode ?? 'idle');
    }, wait);
  }

  function updateActive(): void {
    if (!mounted) return;
    const active = isActive();
    mounted.hama.setActive(active);
    if (!active) {
      window.clearTimeout(homeTimer);
      homeTimer = 0;
    }
    armSettle();
  }

  function onVisibility(): void {
    updateActive();
  }

  /** 다른 면으로 넘어갈 때 채팅 화면은 전환이 끝난 뒤에야 숨는다 — 그때 다시 잰다. */
  function onPageTransition(event: TransitionEvent): void {
    if (event.target === hitRoot && event.propertyName === 'visibility') updateActive();
  }

  /** 캐럿이 있는 줄의 앞 글자 폭으로 캐럿의 가로 위치를 어림한다. */
  function caretX(perch: HTMLElement): number {
    measure ??= document.createElement('canvas').getContext('2d');
    const style = getComputedStyle(input);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const inner = input.clientWidth - padLeft - (parseFloat(style.paddingRight) || 0);
    const before = input.value.slice(0, input.selectionStart ?? input.value.length).split('\n').pop() ?? '';
    let width = 0;
    if (measure) {
      measure.font = style.font || `${style.fontSize} ${style.fontFamily}`;
      width = measure.measureText(before).width;
    }
    if (inner > 0) width %= inner;
    return input.getBoundingClientRect().left - perch.getBoundingClientRect().left + padLeft + width;
  }

  function onInput(event: Event): void {
    if (!mounted || !isActive() || !event.isTrusted) return;
    const { hama, perch } = mounted;
    hama.wake();
    hama.walkTo(Math.min(caretX(perch), perch.clientWidth) / SCALE - 11);
    window.clearTimeout(homeTimer);
    homeTimer = window.setTimeout(() => {
      homeTimer = 0;
      if (mounted && isActive()) mounted.hama.walkTo(home(mounted.perch));
    }, HOME_DELAY_MS);
  }

  function onFocus(): void {
    mounted?.hama.wake();
  }

  function onPointerDown(event: PointerEvent): void {
    if (!mounted || event.button !== 0 || !event.isPrimary || !isActive()) return;
    if (!mounted.hama.hits(event.clientX, event.clientY)) return;
    // 캔버스는 포인터를 받지 않으므로 이 자리의 맨 위 요소가 실제 화면이다.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under?.closest(INTERACTIVE)) return;
    event.preventDefault();
    event.stopPropagation();
    mounted.hama.grab(event);
  }

  /** 입력기 가장자리나 바로 위 빈자리를 두 번 누르면 하마가 그 자리로 간다. */
  function onDoubleClick(event: MouseEvent): void {
    if (!mounted || !isActive()) return;
    const target = event.target as Element | null;
    if (target !== input && target?.closest(INTERACTIVE)) return;
    const rect = composer.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < rect.left || x > rect.right || y < rect.top - ABOVE_PX || y > rect.bottom) return;
    if (y >= rect.top && Math.min(x - rect.left, rect.right - x, y - rect.top, rect.bottom - y) > EDGE_PX) return;
    const { hama, perch } = mounted;
    window.clearTimeout(homeTimer);
    homeTimer = 0;
    hama.travel((x - perch.getBoundingClientRect().left) / SCALE - 6);
  }

  let hovering = false;
  function onPointerMove(event: PointerEvent): void {
    if (!mounted || event.buttons !== 0 || !isActive()) return;
    const hit = mounted.hama.hits(event.clientX, event.clientY);
    if (hit && !hovering) mounted.hama.hover();
    hovering = hit;
  }

  function mount(): void {
    const perch = document.createElement('div');
    perch.className = 'ag-hama-perch';
    const hama = new Hama();
    hama.setMode(mode);
    hama.onImpact = () => {
      composer.animate?.([{ translate: '0 0' }, { translate: '0 1px' }, { translate: '0 0' }], { duration: 110 });
    };
    hama.maxLift = () => Math.max(12, Math.floor((perch.getBoundingClientRect().bottom - hitRoot.getBoundingClientRect().top) / 2 / SCALE));
    perch.append(hama.el);
    composer.append(perch);
    // 집은 오른쪽 구석 — 발이 둥근 모서리 바로 안쪽에 선다.
    const fit = (): void => {
      const atHome = hama.x >= hama.bounds[1];
      hama.setBounds(0, home(perch));
      if (atHome) hama.x = hama.bounds[1];
    };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    resize?.observe(perch);
    hama.setBounds(0, home(perch));
    hama.x = hama.bounds[1];
    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting);
        updateActive();
      })
      : null;
    intersecting = io === null;
    io?.observe(composer);
    mounted = { hama, perch, resize, io };
    document.addEventListener('visibilitychange', onVisibility);
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    hitRoot.addEventListener('pointerdown', onPointerDown, true);
    hitRoot.addEventListener('pointermove', onPointerMove, { passive: true });
    hitRoot.addEventListener('dblclick', onDoubleClick);
    hitRoot.addEventListener('transitionend', onPageTransition);
    hitRoot.addEventListener('transitioncancel', onPageTransition);
    updateActive();
  }

  function unmount(): void {
    if (!mounted) return;
    const { hama, perch, resize, io } = mounted;
    mounted = null;
    intersecting = false;
    hovering = false;
    window.clearTimeout(homeTimer);
    window.clearTimeout(settleTimer);
    homeTimer = 0;
    settleTimer = 0;
    resize?.disconnect();
    io?.disconnect();
    hama.dispose();
    perch.remove();
    document.removeEventListener('visibilitychange', onVisibility);
    input.removeEventListener('input', onInput);
    input.removeEventListener('focus', onFocus);
    hitRoot.removeEventListener('pointerdown', onPointerDown, true);
    hitRoot.removeEventListener('pointermove', onPointerMove);
    hitRoot.removeEventListener('dblclick', onDoubleClick);
    hitRoot.removeEventListener('transitionend', onPageTransition);
    hitRoot.removeEventListener('transitioncancel', onPageTransition);
  }

  function sync(): void {
    if (disposed) return;
    const want = opts.enabled();
    if (want && !mounted) mount();
    else if (!want && mounted) unmount();
    else updateActive();
  }

  return {
    sync,
    setRunning(next: boolean): void {
      if (next === running) return;
      running = next;
      if (next) {
        // 문체 학습의 모습(read·work·think)도 RUNNING_MODES 다 — 그때도 턴이 하마를 넘겨받는다.
        if (!RUNNING_MODES.has(mode) || (backgroundMode !== null && mode === backgroundMode)) {
          setMode('think');
          mounted?.hama.play('hop');
        }
      } else if (RUNNING_MODES.has(mode)) {
        setMode(backgroundMode ?? 'idle');
      }
    },
    tool(tool: string, argsJson = '{}'): void {
      if (running) setMode(hamaModeForTool(tool, argsJson));
    },
    talking(): void {
      if (running && mode !== 'talk') setMode('talk');
    },
    turnEnded(outcome: TurnOutcome): void {
      running = false;
      setMode(outcome === 'completed' ? 'done' : outcome === 'failed' ? 'error' : backgroundMode ?? 'idle');
    },
    background(next: ChatHamaMode | null): void {
      const prevBg = backgroundMode;
      // 끝 모습(done·error)은 한 번 보이고 거두는 것이라 돌아갈 모습으로 남기지 않는다.
      const oneShot = next !== null && SETTLE_MS[next] !== undefined;
      backgroundMode = oneShot ? null : next;
      if (running) return;
      if (oneShot) {
        if (next !== mode) setMode(next);
        return;
      }
      // 턴의 끝 상태(환호·움츠림)는 다 보인 뒤 armSettle 이 배경 모습으로 넘긴다 — 여기서 자르지 않는다.
      if (settleAt && (mode === 'done' || mode === 'error')) return;
      if (next === null) {
        // 배경이 맡았던 모습만 거둔다.
        if (prevBg !== null && mode === prevBg) setMode('idle');
        return;
      }
      if (next !== mode) setMode(next);
    },
    get mode() {
      return mode;
    },
    dispose(): void {
      unmount();
      disposed = true;
    },
  };
}
