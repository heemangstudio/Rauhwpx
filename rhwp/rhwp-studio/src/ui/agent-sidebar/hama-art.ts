/**
 * 하마 그림의 원본. 채팅 하마(chat-hama.ts)와 그 하마를 쓰는 화면(빈 채팅 무대, 업데이트 하마, 설정,
 * 로그인)이 같은 실루엣·팔레트·소품·1px 격자를 쓰도록 여기에 모았다. 앱 아이콘의 파란색으로 그린
 * 14열 두 톤 실루엣이고 얼굴은 없다. 7행이 땅이다.
 */
export const COLORS: Record<string, string> = {
  o: '#62b3e2', s: '#2f73a0', h: '#b2e2fb',
  L: '#7a828d', B: '#5b636e', G: '#b2e2fb', g: '#e6f5ff',
  P: '#f2f4f7', p: '#9aa3ae', r: '#ff6b6b', W: '#ffffff', m: '#c98b5b',
  // 물방울·비눗방울(d), 빗자루 솔(y), 종이(w).
  d: '#b2e2fb', y: '#e0b45c', w: '#f2f4f7',
};
/** 밝은 테마에서는 흰 반짝임과 z 가 배경에 묻히므로 진한 파랑으로 바꾼다. */
export const LIGHT_COLORS: Record<string, string> = { W: '#2f73a0', g: '#62b3e2', P: '#e1e6ec', d: '#62b3e2', y: '#c99a3e', w: '#b9c1cb' };

// ---------------------------------------------------------------- 하마
// 앱 아이콘의 하품하는 자세를 반 해상도로: 머리를 들고 턱을 벌렸다.
export const LOGO = [
  '.......ooo....',
  '.....s.oo.....',
  '.....oooo.....',
  '.....oooooos..',
  '...oooooooo...',
  '.oooooooo.....',
  '.ooooooo......',
];
// 머리를 숙이고 입을 다문 모습 — 일하고, 읽고, 잘 때.
export const FORWARD = [
  '..............',
  '..............',
  '.....s........',
  '.....oooooooo.',
  '...ooooooooos.',
  '.oooooooo.....',
  '.ooooooo......',
];
export const LEGS = '.os..os.......';
export const LEGS_STEP = '..os..os......';
export const BLANK = '.'.repeat(14);

export function paint(row: string, col: number, str: string): string {
  return row.slice(0, col) + str + row.slice(col + str.length);
}

// 쉴 때는 입을 다물고, 하품·말하기·환호할 때 아이콘 자세로 입을 연다.
export const STAND = [...FORWARD, LEGS];
export const STEP = [...FORWARD, LEGS_STEP];
export const EAR = [FORWARD[0]!, paint(FORWARD[1]!, 5, 's'), ...FORWARD.slice(2), LEGS];
export const OPEN = [...LOGO, LEGS];
export const OPEN_EAR = [paint(LOGO[0]!, 5, 's'), ...LOGO.slice(1), LEGS];
// 몸이 한 줄 내려앉고 다리를 접는다.
export const CROUCH = [BLANK, ...FORWARD];
export const SLEEP = [BLANK, ...FORWARD.slice(0, 6), '.ssssssss.....'];
// 앞발을 내밀었다가 자판을 두드린다.
export const PAW_UP = [...FORWARD.slice(0, 5), paint(FORWARD[5]!, 9, 'oo'), FORWARD[6]!, LEGS];
export const PAW_DOWN = [...FORWARD.slice(0, 6), paint(FORWARD[6]!, 8, 'ooo'), LEGS];

// 공처럼 몸을 만 모습 — 공중제비와 튀기. 귀와 주둥이 돌기를 남겨 도는 방향이 보인다.
export const BALL = [
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
export const SQUASH = [
  BLANK, BLANK, BLANK,
  '....s.........',
  '..ooooooo.....',
  '.ooooooooos...',
  'oooooooooo....',
  '.ssssssss.....',
  BLANK,
];

export const POSES = {
  ball: BALL, squash: SQUASH,
  stand: STAND, step: STEP, ear: EAR, open: OPEN, cheer: OPEN_EAR, crouch: CROUCH, sleep: SLEEP, pawUp: PAW_UP, pawDown: PAW_DOWN,
};
export type PoseName = keyof typeof POSES;

export interface Layer {
  art: readonly string[];
  x?: number;
  y?: number;
  map?: Record<string, string>;
  /** 이 행부터 아래는 그리지 않는다(물속으로 들어갈 때). */
  clip?: number;
}

// 소품: [그림, x, y] — 하마 좌표(7행이 땅).
export const PROPS: Record<string, [readonly string[], number, number]> = {
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

export const Z_FADE = ['W', 'h', 'o', 's'];

// 장면 캔버스: 하마의 c 열, r 행은 (c - OX, r + OY) 에 놓인다.
export const OX = -4;
export const OY = 5;
/** 땅 아래로 그리는 행(스케이트보드, 물보라). */
export const BELOW = 3;
export const SCENE_W = 26;
export const SCENE_H = OY + 8 + BELOW;
export const PIVOT = { x: 6 - OX, y: 4 + OY };
export const GROUND = 7;
export const SCALE = 3;


// ---------------------------------------------------------------- 그리기
export function drawLayers(ctx: CanvasRenderingContext2D, layers: readonly Layer[], palette: Record<string, string>): void {
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

export const dot = (x: number, y: number, ch: string): Layer => ({ art: [ch], x, y });
export function sparkle(size: number): Layer[] {
  const [x, y] = [9, -2];
  if (size <= 0) return [];
  const out = [dot(x, y, 'W')];
  if (size > 1) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) out.push(dot(x + dx, y + dy, 'h'));
  return out;
}
export const prop = (name: string, dx = 0, dy = 0, map?: Record<string, string>): Layer => {
  const [art, x, y] = PROPS[name]!;
  return { art, x: x + dx, y: y + dy, map };
};

export const fade = (k: number): string => Z_FADE[Math.min(3, k)]!;
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * Math.max(0, Math.min(1, p));
export const arc = (p: number, h: number): number => -Math.round(Math.sin(Math.PI * Math.max(0, Math.min(1, p))) * h);

/** (cx, 땅)에서 위로 튀어 오르는 물방울. age 는 ms. */
export function droplets(cx: number, age: number, spread = 1): Layer[] {
  const out: Layer[] = [];
  for (const [vx, vy] of [[-1.6, 4.5], [-0.8, 6], [0.8, 6.2], [1.7, 4.6], [-2.4, 3], [2.5, 3.2]] as const) {
    const s = age / 120;
    const y = Math.round(GROUND - (vy * s - 1.1 * s * s));
    if (y > GROUND) continue;
    out.push(dot(Math.round(cx + vx * s * spread), y, fade(Math.floor(age / 180))));
  }
  return out;
}
export function ripples(cx: number, age: number): Layer[] {
  const k = Math.floor(age / 110);
  if (k > 3) return [];
  return [dot(cx - 2 - k * 2, GROUND, fade(k)), dot(cx + 2 + k * 2, GROUND, fade(k))];
}

// ---------------------------------------------------------------- 앱 순간과 재주의 소품
// 하마 좌표(7행이 땅), 하마는 오른쪽을 본다. 몸은 그대로 두고 소품만 같은 격자와 몇 안 되는 색으로 더한다.
/** 도장: 손잡이를 입에 물고, 나무 몸통 아래 빨간 인면. */
export const STAMP = ['.m.', '.m.', 'mmm', 'rrr'];
/** 땅에 깐 종이 한 장, 도장을 찍은 뒤. */
export const SHEET = ['wwwwww'];
export const SHEET_STAMPED = ['wwrrrw'];
/** 종이를 접어 비행기로: 한 장, 반 접기, 비행기, 멀어진 비행기. */
export const PAGE = ['www', 'www', 'www'];
export const PAGE_FOLD = ['ww.', 'www', 'ww.'];
export const PLANE = ['w...', 'wwww', '.pw.'];
export const PLANE_FAR = ['ww', '.w'];
/** 부메랑 — 90도씩 돌린 네 모습. */
export const BOOMERANG = [
  ['mmm', 'm..', 'm..'],
  ['mmm', '..m', '..m'],
  ['..m', '..m', 'mmm'],
  ['m..', 'm..', 'mmm'],
];
/** 낙하산에 매단 상자, 열린 상자. */
export const PARACHUTE = ['.rrrrr.', 'rrrrrrr', 'p.....p', '.p...p.'];
export const BOX = ['mmm', 'mmm', 'mmm'];
export const BOX_OPEN = ['m...m', '.m.m.', '.mmm.', '.mmm.'];
/** 빗자루: 주둥이에 문 자루와 솔. */
export const BROOM = ['m....', '.m...', '..yy.', '.yyyy'];
/** 풍선: 부푸는 두 모습과 다 부푼 모습. */
export const BALLOON = ['.rr.', 'rrrr', 'rrrr', 'rrrr', '.rr.'];
export const BALLOON_HALF = ['rr', 'rr'];
/** 비눗방울. */
export const BUBBLE = ['.d.', 'd.d', '.d.'];
export const BUBBLE_BIG = ['.dd.', 'd..d', 'd..d', '.dd.'];
/** 비구름과 우산(닫힘, 반쯤, 펼침). */
export const CLOUD = ['.pp.ppp.', 'pppppppp', '.LLLLLL.'];
export const UMBRELLA = ['.rrrrr.', 'rrrrrrr'];
export const UMBRELLA_HALF = ['.rrr.', 'rrrrr'];
export const UMBRELLA_SHUT = ['r', 'r'];
/** 코끝에 올리는 두 색 공 — 도는 두 모습. */
export const BEACH_BALL = [['rw', 'wr'], ['wr', 'rw']];
