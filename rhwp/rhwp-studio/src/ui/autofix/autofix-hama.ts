/**
 * 자동 수정이 도는 동안 시트에 띄우는 작은 픽셀 하마. 채팅 하마(chat-hama.ts)와 같은 두 톤 파랑 실루엣이
 * 판자에 박힌 못을 망치로 두드린다: 천천히 들어 올렸다가 빠르게 내리치면 불똥이 튀고 못이 한 칸 들어간다.
 * 세 번에 못이 다 들어가면 판자가 반짝이고 새 못이 솟는다. 진행률이 아니라 도는 동안의 반복이다.
 *
 * - 장면은 28x11 논리 픽셀이다. 캔버스를 그 크기로 그리고 CSS 로 키운다(pixelated).
 * - autofixHamaRows(t) 는 t ms 째 장면을 글자 격자로 돌려준다(그리기와 테스트가 같이 쓴다).
 * - 동작 줄이기를 켰으면 망치를 든 한 장면만 그린다. dispose 하면 rAF 를 멈춘다.
 */

/* token-ok: 하마 팔레트는 채팅 하마·부트 로고와 같은 고정 색이다. */
const COLORS: Record<string, string> = {
  o: '#62b3e2', s: '#2f73a0', h: '#b2e2fb', W: '#ffffff',
  B: '#5b636e', N: '#5b636e', n: '#9aa3ae', m: '#c98b5b', w: '#b07a4f', v: '#7d5236',
};
/** 밝은 테마에서는 흰 불똥이 배경에 묻히므로 진한 파랑으로 바꾼다(채팅 하마와 같다). */
const LIGHT_COLORS: Record<string, string> = { W: '#2f73a0' };

export const AUTOFIX_HAMA_WIDTH = 28;
export const AUTOFIX_HAMA_HEIGHT = 11;

// ---------------------------------------------------------------- 그림
// 채팅 하마의 머리 숙인 모습(오른쪽을 본다). 7행이 다리.
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

function paint(row: string, col: number, str: string): string {
  return row.slice(0, col) + str + row.slice(col + str.length);
}

const POSES = {
  /** 앞발을 들어 망치를 쥐었다. */
  pawUp: [...FORWARD.slice(0, 5), paint(FORWARD[5]!, 9, 'oo'), FORWARD[6]!, LEGS],
  /** 내리친 앞발 */
  pawDown: [...FORWARD.slice(0, 6), paint(FORWARD[6]!, 8, 'ooo'), LEGS],
  /** 못이 다 들어가면 귀를 턴다. */
  ear: [FORWARD[0]!, paint(FORWARD[1]!, 5, 's'), ...FORWARD.slice(2, 5), paint(FORWARD[5]!, 9, 'oo'), FORWARD[6]!, LEGS],
  stand: [...FORWARD, LEGS],
};
type Pose = keyof typeof POSES;

/** 하마 그림의 (0,0) 이 놓이는 장면 좌표. 10행이 땅이다. */
const HAMA_X = 1;
const HAMA_Y = 3;
/** 망치 자루를 쥔 앞발 끝: 든 앞발, 내리친 앞발. 내려앉아도 자루는 앞발 끝 위에서 나간다. */
const PAW_UP = { x: 11, y: 8 };
const PAW_DOWN = { x: 11, y: 9 };
/** 판자: 땅 위 두 줄 */
const PLANK = { x: 16, y: 9, width: 9 };
const NAIL_X = 20;
const NAIL_HEIGHT = 3;
/** 들어 올린 망치 머리(왼쪽 위 칸) */
const HEAD_UP = { x: 11, y: 1 };

// ---------------------------------------------------------------- 시간표
const RAISE_MS = 300;
const SWING_MS = 90;
const IMPACT_MS = 140;
const RECOVER_MS = 260;
const HIT_MS = RAISE_MS + SWING_MS + IMPACT_MS + RECOVER_MS;
const GLINT_MS = 560;
const POP_MS = 180;
/** 못이 박히는 열과 판자 윗줄(테스트가 장면을 읽는다) */
export const AUTOFIX_HAMA_NAIL = { x: NAIL_X, plankY: PLANK.y };
export const AUTOFIX_HAMA_CYCLE_MS = NAIL_HEIGHT * HIT_MS + GLINT_MS + POP_MS;
const SPARK_MS = 340;
/** 불똥 네 개의 속도(칸 / 60ms). 위로 튀었다가 떨어진다. */
const SPARKS = [[-1.4, -1.3], [1.5, -1.1], [-0.6, -2], [0.8, -1.8]] as const;

/** 내리친 순간: 몇 번째 못질(0부터)의 몇 ms 째인지 */
export function autofixHamaImpactTime(hit: number): number {
  return hit * HIT_MS + RAISE_MS + SWING_MS;
}

interface Scene {
  pose: Pose;
  dip: number;
  /** 0 이면 들어 올림, 1 이면 못을 친 자리 */
  swing: number;
  /** 지금 판자 위로 나온 못 길이 */
  nail: number;
  /** 이번 못질이 겨누는 못 길이(내리친 뒤에는 한 칸 들어가 있다) */
  target: number;
  sparkAge: number | null;
  glint: number | null;
}

const easeIn = (x: number) => x * x;
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);

function sceneAt(t: number): Scene {
  const c = ((t % AUTOFIX_HAMA_CYCLE_MS) + AUTOFIX_HAMA_CYCLE_MS) % AUTOFIX_HAMA_CYCLE_MS;
  const hitting = NAIL_HEIGHT * HIT_MS;
  if (c < hitting) {
    const hit = Math.floor(c / HIT_MS);
    const within = c - hit * HIT_MS;
    const before = NAIL_HEIGHT - hit;
    const struck = within >= RAISE_MS + SWING_MS;
    const base = { nail: struck ? before - 1 : before, target: before, glint: null };
    if (within < RAISE_MS) return { ...base, pose: 'pawUp', dip: 0, swing: 0, sparkAge: null };
    if (within < RAISE_MS + SWING_MS) {
      const swing = easeIn((within - RAISE_MS) / SWING_MS);
      return { ...base, pose: swing > 0.5 ? 'pawDown' : 'pawUp', dip: 0, swing, sparkAge: null };
    }
    const sparkAge = within - RAISE_MS - SWING_MS;
    if (within < RAISE_MS + SWING_MS + IMPACT_MS) return { ...base, pose: 'pawDown', dip: 1, swing: 1, sparkAge };
    const back = easeOut((within - RAISE_MS - SWING_MS - IMPACT_MS) / RECOVER_MS);
    return { ...base, pose: back > 0.5 ? 'pawUp' : 'pawDown', dip: 0, swing: 1 - back, sparkAge };
  }
  if (c < hitting + GLINT_MS) {
    const age = c - hitting;
    return { pose: age % 280 < 140 ? 'ear' : 'pawUp', dip: 0, swing: 0, nail: 0, target: 0, sparkAge: null, glint: age };
  }
  const grow = (c - hitting - GLINT_MS) / POP_MS;
  return { pose: 'pawUp', dip: 0, swing: 0, nail: Math.min(NAIL_HEIGHT, Math.ceil(grow * NAIL_HEIGHT)), target: NAIL_HEIGHT, sparkAge: null, glint: null };
}

// ---------------------------------------------------------------- 그리기
function blankRows(): string[][] {
  return Array.from({ length: AUTOFIX_HAMA_HEIGHT }, () => Array.from({ length: AUTOFIX_HAMA_WIDTH }, () => '.'));
}

function put(grid: string[][], x: number, y: number, ch: string): void {
  if (y >= 0 && y < grid.length && x >= 0 && x < grid[0]!.length) grid[y]![x] = ch;
}

function line(grid: string[][], x0: number, y0: number, x1: number, y1: number, ch: string): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    put(grid, x0, y0, ch);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** 망치 머리(왼쪽 위 칸). 들어 올린 자리와 못을 친 자리 사이를 앞발을 축으로 돈다. */
function hammerHead(swing: number, target: number): { x: number; y: number } {
  const strike = { x: NAIL_X - 1, y: PLANK.y - target - 2 };
  const up = { x: HEAD_UP.x - PAW_UP.x, y: HEAD_UP.y - PAW_UP.y };
  const down = { x: strike.x - PAW_UP.x, y: strike.y - PAW_UP.y };
  const a0 = Math.atan2(up.y, up.x);
  const a1 = Math.atan2(down.y, down.x);
  const angle = a0 + (a1 - a0) * swing;
  const length = Math.hypot(up.x, up.y) + (Math.hypot(down.x, down.y) - Math.hypot(up.x, up.y)) * swing;
  if (swing >= 1) return strike;
  return { x: Math.round(PAW_UP.x + Math.cos(angle) * length), y: Math.round(PAW_UP.y + Math.sin(angle) * length) };
}

/** t ms 째 장면. 글자는 팔레트 이름이고 '.' 은 빈칸이다. */
export function autofixHamaRows(t: number): string[] {
  const scene = sceneAt(t);
  const grid = blankRows();
  // 판자와 못
  for (let x = PLANK.x; x < PLANK.x + PLANK.width; x += 1) {
    put(grid, x, PLANK.y, 'w');
    put(grid, x, PLANK.y + 1, 'v');
  }
  for (let k = 1; k <= scene.nail; k += 1) put(grid, NAIL_X, PLANK.y - k, k === scene.nail ? 'N' : 'n');
  if (scene.nail === 0) put(grid, NAIL_X, PLANK.y, 'n');
  // 불똥: 친 자리(못 머리)에서 튀어 오르다 떨어지고, 흰색 → 하늘색 → 사라진다. 망치 머리가 그 위에 온다.
  if (scene.sparkAge !== null && scene.sparkAge < SPARK_MS) {
    const step = scene.sparkAge / 60;
    const ch = scene.sparkAge < 150 ? 'W' : 'h';
    for (const [vx, vy] of SPARKS) {
      put(grid, Math.round(NAIL_X + vx * step), Math.round(PLANK.y - scene.target + vy * step + 0.35 * step * step), ch);
    }
  }
  // 망치: 자루 뒤에 하마가 온다(들어 올리면 자루가 머리 뒤로 지나간다).
  const head = hammerHead(scene.swing, scene.target);
  const paw = scene.pose === 'pawDown' ? PAW_DOWN : PAW_UP;
  line(grid, paw.x, paw.y, head.x, head.y + 1, 'm');
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) put(grid, head.x + dx, head.y + dy, 'B');
  // 하마. 내리치면 몸이 한 줄 내려앉고 다리를 접는다(채팅 하마의 웅크림처럼).
  const art = scene.dip ? ['.'.repeat(14), ...POSES[scene.pose].slice(0, 7)] : POSES[scene.pose];
  art.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== '.') put(grid, HAMA_X + c, HAMA_Y + r, row[c]!);
    }
  });
  // 다 박은 못 자리의 반짝임
  if (scene.glint !== null) {
    const [x, y] = [NAIL_X, PLANK.y - 2];
    put(grid, x, y, 'W');
    if (scene.glint % 280 < 180) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) put(grid, x + dx, y + dy, 'h');
  }
  return grid.map((row) => row.join(''));
}

/** 동작 줄이기에서 보이는 한 장면: 망치를 들고 못이 반쯤 들어갔다. */
export const AUTOFIX_HAMA_STILL_MS = HIT_MS + RAISE_MS / 2;

// ---------------------------------------------------------------- 캔버스
export interface AutofixHama {
  element: HTMLCanvasElement;
  dispose(): void;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createAutofixHama(className = 'afm-hama'): AutofixHama {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  canvas.width = AUTOFIX_HAMA_WIDTH;
  canvas.height = AUTOFIX_HAMA_HEIGHT;
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  let frame = 0;
  let last = '';
  const started = performance.now();
  const draw = (t: number): void => {
    if (!ctx) return;
    const rows = autofixHamaRows(t);
    const light = document.documentElement.dataset.themeEffective === 'light';
    const key = `${light}${rows.join('')}`;
    if (key === last) return;
    last = key;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const ch = row[x]!;
        if (ch === '.') continue;
        ctx.fillStyle = (light ? LIGHT_COLORS[ch] : undefined) ?? COLORS[ch]!;
        ctx.fillRect(x, y, 1, 1);
      }
    });
  };
  if (reducedMotion()) {
    draw(AUTOFIX_HAMA_STILL_MS);
  } else {
    const loop = (now: number): void => {
      draw(now - started);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
  }
  return {
    element: canvas,
    dispose() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
