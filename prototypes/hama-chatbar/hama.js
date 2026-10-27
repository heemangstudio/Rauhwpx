// Hama chatbar mascot prototype.
// A tiny low-res hippo silhouette (16x7, two tones, no face) in the app-icon
// blue, with props drawn on the same 1px grid.

export const COLORS = {
  o: '#62B3E2', s: '#2F73A0', h: '#B2E2FB',
  L: '#7A828D', B: '#5B636E', G: '#B2E2FB', g: '#E6F5FF',
  P: '#F2F4F7', p: '#9AA3AE', r: '#FF6B6B', W: '#FFFFFF', m: '#C98B5B',
};

// ---------------------------------------------------------------- hippo
// The app icon's yawning pose at half resolution: head up, jaw open.
const LOGO = [
  '.......ooo....',
  '.....s.oo.....',
  '.....oooo.....',
  '.....oooooos..',
  '...oooooooo...',
  '.oooooooo.....',
  '.ooooooo......',
];
// Head lowered and jaw shut, for working, reading and sleeping.
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

function paint(row, col, str) {
  return row.slice(0, col) + str + row.slice(col + str.length);
}

// Rests with the jaw shut; opens into the icon pose to yawn, talk and cheer.
const STAND = [...FORWARD, LEGS];
const STEP = [...FORWARD, LEGS_STEP];
const EAR = [FORWARD[0], paint(FORWARD[1], 5, 's'), ...FORWARD.slice(2), LEGS];
const OPEN = [...LOGO, LEGS];
const OPEN_EAR = [paint(LOGO[0], 5, 's'), ...LOGO.slice(1), LEGS];
// Body sinks a row, legs fold under.
const CROUCH = [BLANK, ...FORWARD];
const SLEEP = [BLANK, ...FORWARD.slice(0, 6), '.ssssssss.....'];
// Front paw reaching forward: up, then tapping down onto the keys.
const PAW_UP = [...FORWARD.slice(0, 5), paint(FORWARD[5], 9, 'oo'), FORWARD[6], LEGS];
const PAW_DOWN = [...FORWARD.slice(0, 6), paint(FORWARD[6], 8, 'ooo'), LEGS];

// Cartoon tuck: curled into a ball for flips and bouncing. Ear and snout
// nubs stay on so the spin reads.
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

export const POSES = {
  ball: BALL, squash: SQUASH,
  stand: STAND, step: STEP, ear: EAR, open: OPEN, cheer: OPEN_EAR, crouch: CROUCH, sleep: SLEEP, pawUp: PAW_UP, pawDown: PAW_DOWN,
};

// Props: [art rows, x, y] in hippo coordinates (row 7 is the ground).
export const PROPS = {
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
  mug: [['m.', 'mm'], 17, 6],
};

const Z_FADE = ['W', 'h', 'o', 's'];

// Scene canvas: hippo column c, row r lands at (c - OX, r + OY).
export const OX = -4;
export const OY = 5;
/** Rows drawn below the ground line (skateboard, splash). */
export const BELOW = 3;
export const SCENE_W = 26;
export const SCENE_H = OY + 8 + BELOW;
/** Hippo body width in scene pixels, for placing it along a bar. */
export const BODY_W = 14;
const PIVOT = { x: 6 - OX, y: 4 + OY };

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// ---------------------------------------------------------------- drawing
export function drawLayers(ctx, layers) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const { art, x = 0, y = 0, map = {}, clip } of layers) {
    art.forEach((row, r) => {
      // Clipped layers vanish below the ground line (diving, swimming).
      if (clip != null && y + r >= clip) return;
      for (let c = 0; c < row.length; c++) {
        const ch = row[c];
        if (ch === '.') continue;
        ctx.fillStyle = map[ch] ?? COLORS[ch];
        ctx.fillRect(x + c - OX, y + r + OY, 1, 1);
      }
    });
  }
}

const dot = (x, y, ch) => ({ art: [ch], x, y });
function sparkle(size) {
  const [x, y] = [9, -2];
  if (size <= 0) return [];
  const out = [dot(x, y, 'W')];
  if (size > 1) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push(dot(x + dx, y + dy, 'h'));
  return out;
}
const prop = (name, dx = 0, dy = 0, map) => {
  const [art, x, y] = PROPS[name];
  return { art, x: x + dx, y: y + dy, map };
};

// ---------------------------------------------------------------- actions
const HOP = [
  { ms: 80, pose: 'crouch' },
  { ms: 70, pose: 'step', y: -1 },
  { ms: 90, pose: 'step', y: -2 },
  { ms: 70, pose: 'step', y: -1 },
  { ms: 80, pose: 'crouch' },
  { ms: 60, pose: 'stand' },
];
const CHEER = [
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
// Stretch up, curl into a ball for the spin, uncurl to land.
const BACKFLIP = [
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
const SHUFFLE = [
  { ms: 150, pose: 'step' }, { ms: 150, pose: 'stand' },
  { ms: 150, pose: 'step', x: 1 }, { ms: 150, pose: 'stand', x: 1 },
  { ms: 150, pose: 'step' }, { ms: 150, pose: 'stand' },
];
const LAND = [{ ms: 90, pose: 'crouch' }, { ms: 60, pose: 'stand' }];
const SHAKE = [
  { ms: 60, pose: 'crouch', x: -1 }, { ms: 60, pose: 'crouch', x: 1 },
  { ms: 60, pose: 'crouch', x: -1 }, { ms: 60, pose: 'crouch', x: 1 },
  { ms: 80, pose: 'crouch' },
];
const JUMP = [
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

const GROUND = 7;
const fade = (k) => ['W', 'h', 'o', 's'][Math.min(3, k)];
const lerp = (a, b, p) => a + (b - a) * Math.max(0, Math.min(1, p));
const arc = (p, h) => -Math.round(Math.sin(Math.PI * Math.max(0, Math.min(1, p))) * h);

/** Droplets thrown up and out from (cx, GROUND), age in ms. */
function droplets(cx, age, spread = 1) {
  const out = [];
  for (const [vx, vy] of [[-1.6, 4.5], [-0.8, 6], [0.8, 6.2], [1.7, 4.6], [-2.4, 3], [2.5, 3.2]]) {
    const s = age / 120;
    const y = Math.round(GROUND - (vy * s - 1.1 * s * s));
    if (y > GROUND) continue;
    out.push(dot(Math.round(cx + vx * s * spread), y, fade(Math.floor(age / 180))));
  }
  return out;
}
function ripples(cx, age) {
  const k = Math.floor(age / 110);
  if (k > 3) return [];
  return [dot(cx - 2 - k * 2, GROUND, fade(k)), dot(cx + 2 + k * 2, GROUND, fade(k))];
}

/** Jump, dive nose-first through the chat box, and pop back up. */
function SPLASH(t) {
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
    // Shake off: alternate a pixel either way, drops flung sideways.
    const side = Math.floor(up / 70) % 2 ? 1 : -1;
    return { pose: 'stand', x: side * (up < 480 ? 1 : 0), layers: droplets(6, up - 220, 1.6).slice(0, 4) };
  }
  return null;
}

/** Leap high, hang, slam down. The host can shake on impact. */
function SMASH(t) {
  if (t < 130) return { pose: 'crouch' };
  if (t < 430) return { pose: 'step', y: Math.round(lerp(0, -11, (t - 130) / 300)) };
  if (t < 560) return { pose: 'cheer', y: -11 };
  if (t < 620) return { pose: 'crouch', y: Math.round(lerp(-11, 0, (t - 560) / 60)) };
  const after = t - 620;
  if (after > 700) return null;
  const k = Math.floor(after / 90);
  const layers = [];
  if (k < 5) {
    for (const side of [-1, 1]) {
      const x = side < 0 ? -1 - k : 14 + k;
      layers.push(dot(x, GROUND - (k < 2 ? 1 : 0), fade(k)), dot(x + side, GROUND, fade(k + 1)));
    }
  }
  if (after < 90) layers.push(dot(-2, 3, 'W'), dot(-1, 4, 'W'), dot(15, 3, 'W'), dot(14, 4, 'W'));
  return { pose: after < 260 ? 'crouch' : 'stand', y: after < 60 ? 1 : 0, impact: true, layers };
}

/** Hop in, paddle out and back with only ears and back above water, climb out. */
function SWIM(t, a, h) {
  const span = 16;
  const dir = a.from - span < h.bounds[0] ? 1 : -1;
  if (t < 200) return { pose: 'step', y: arc(t / 200, 2) };
  if (t < 450) return { pose: 'crouch', hy: Math.round(lerp(0, 3, (t - 200) / 200)), clip: true, layers: ripples(6, t - 200) };
  const swim = t - 450;
  const total = span * 2 * 90;
  if (swim < total) {
    const out = swim < total / 2;
    const p = out ? swim / (total / 2) : 2 - swim / (total / 2);
    const bob = Math.floor(swim / 320) % 2;
    const wakeX = Math.floor(swim / 150) % 2;
    const wake = [dot(-1 - wakeX, GROUND - 0, 'h'), dot(-3 - wakeX, GROUND, 'o'), dot(13, GROUND, 'h'), dot(14, GROUND, 'o')];
    return { pose: 'stand', hy: 3 + bob, clip: true, at: a.from + dir * Math.round(p * span), face: out ? dir : -dir, layers: wake };
  }
  const out = swim - total;
  if (out < 220) return { pose: 'ear', hy: Math.round(lerp(3, 0, out / 200)), clip: true, y: arc(out / 220, 2), layers: ripples(6, out) };
  if (out < 600) {
    const side = Math.floor(out / 70) % 2 ? 1 : -1;
    return { pose: 'stand', x: out < 480 ? side : 0, layers: droplets(6, out - 220, 1.6).slice(0, 4) };
  }
  return null;
}

/**
 * Backflip into a ball, then bounce and roll along the bar, squashing on each
 * landing. Rolls to `a.opts.to` when given, otherwise 22px wherever there is room.
 */
function BALL_BOUNCE(t, a, h) {
  let span = 22;
  let dir = a.from + h.facing * span > h.bounds[1] || a.from + h.facing * span < h.bounds[0] ? -h.facing : h.facing;
  if (a.opts?.to != null) {
    span = Math.abs(a.opts.to - a.from);
    dir = a.opts.to >= a.from ? 1 : -1;
  }
  if (t < 110) return { pose: 'crouch', face: dir };
  if (t < 170) return { pose: 'step', y: -2, face: dir };
  const flip = t - 170;
  if (flip < 300) return { pose: 'ball', y: arc(flip / 300, 7) || -1, turn: -Math.floor(flip / 75) - 1, face: dir };
  const BOUNCES = [[460, 6], [360, 4], [280, 2], [200, 1]];
  let at = flip - 300;
  // Arrive exactly as the last bounce lands.
  const rolled = (ms) => a.from + dir * Math.round(span * Math.min(1, ms / 1300));
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
}

const BOARD = ['.mmmmmmmmmmmm.', '..L.......L...'];
const BOARD_SPIN = ['..L.......L...', '.mmmmmmmmmmmm.'];
const board = (y, art = BOARD, map) => ({ art, x: 0, y, map });

/** Kick a board out, ride to `a.opts.to`, ollie with a kickflip, step off. */
function SKATE(t, a, h) {
  const to = Math.max(h.bounds[0], Math.min(h.bounds[1], Math.round(a.opts?.to ?? (a.from > (h.bounds[0] + h.bounds[1]) / 2 ? h.bounds[0] : h.bounds[1]))));
  const dir = to >= a.from ? 1 : -1;
  const dist = Math.abs(to - a.from);
  const ride = dist * 24;
  if (t < 160) return { pose: 'crouch', face: dir, behind: [board(6)] };
  if (t < 260) return { pose: 'step', face: dir, y: t < 210 ? -3 : -2, behind: [board(8 + (t < 210 ? 1 : 0))] };
  const r = t - 260;
  const spin = { L: Math.floor(t / 60) % 2 ? '#7A828D' : '#B2E2FB' };
  if (r < ride) {
    const lean = Math.floor(r / 400) % 3 === 2 ? 'crouch' : 'stand';
    const wind = Math.floor(r / 90) % 2;
    const layers = [dot(-2 - wind, 3, 'h'), dot(-4 - wind, 5, 's'), dot(-3 + wind, 1, 's')];
    return { pose: lean, face: dir, y: -2, at: a.from + dir * Math.floor(r / 24), behind: [board(8, BOARD, spin)], layers };
  }
  const o = r - ride;
  const OLLIE = [[70, -3, BOARD], [70, -5, BOARD_SPIN], [80, -6, BOARD], [70, -5, BOARD_SPIN], [70, -3, BOARD], [90, -2, BOARD]];
  let acc = 0;
  for (const [ms, y, art] of OLLIE) {
    acc += ms;
    if (o < acc) return { pose: y < -4 ? 'crouch' : 'step', face: dir, y, at: to, behind: [board(8, art)] };
  }
  const off = o - acc;
  if (off < 120) return { pose: 'step', face: dir, y: -1, at: to, behind: [board(7)] };
  if (off < 220) return { pose: 'crouch', face: dir, at: to };
  return null;
}

export const ACTIONS = {
  hop: HOP, cheer: CHEER, backflip: BACKFLIP, shuffle: SHUFFLE, land: LAND, shake: SHAKE,
  jump: JUMP, splash: SPLASH, smash: SMASH, swim: SWIM, skate: SKATE, ballBounce: BALL_BOUNCE,
};
export const TRICKS = ['jump', 'backflip', 'ballBounce', 'splash', 'smash', 'swim', 'skate'];

const TYPING = [[90, 1], [80, 0], [90, 1], [80, 0], [70, 1], [260, 0], [90, 1], [70, 0], [90, 1], [200, 0], [80, 1], [80, 0], [90, 1], [420, 0]];
const TYPING_MS = TYPING.reduce((s, [ms]) => s + ms, 0);
const TALKING = [[140, 'open'], [120, 'stand'], [160, 'open'], [380, 'stand']];
const TALKING_MS = TALKING.reduce((s, [ms]) => s + ms, 0);
const GLOW = ['#B2E2FB', '#E6F5FF', '#62B3E2', '#FFFFFF'];

function cycle(table, total, t) {
  let at = t % total;
  for (let i = 0; i < table.length; i++) {
    if (at < table[i][0]) return [i, table[i]];
    at -= table[i][0];
  }
  return [0, table[0]];
}
const noise = (n) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

// ---------------------------------------------------------------- modes
// Each returns { pose, behind, fx, nod } for elapsed time t.
const MODES = {
  idle: () => ({ pose: 'stand' }),
  think(t) {
    const k = Math.floor(t / 320) % 5;
    const fx = [0, 1, 2].map((i) => dot(6 + i * 2, 0, i < k ? 'W' : 's'));
    return { pose: t % 2600 < 180 ? 'ear' : 'stand', fx };
  },
  work(t) {
    const [i, [, down]] = cycle(TYPING, TYPING_MS, t);
    const step = Math.floor(t / TYPING_MS) * TYPING.length + i;
    const glow = GLOW[Math.floor(noise(Math.floor(t / 450)) * GLOW.length)];
    const fx = [];
    if (down) fx.push(dot(11 + Math.floor(noise(step) * 3), 7, 'W'));
    const p = t % 1400;
    if (p < 560) {
      const age = Math.floor(p / 140);
      fx.push(dot(16, 2 - age, ['W', 'h', 'o', 's'][age]));
    }
    return { pose: down ? 'pawDown' : 'pawUp', behind: [prop('laptop', 0, 0, { G: glow })], fx, nod: !down && i === 5 };
  },
  read(t) {
    const shift = Math.floor(t / 520) % 2;
    const art = PROPS.paper[0].map((row, r) => (r % 2 ? (shift ? 'pPp' : 'ppP') : row));
    return { pose: 'pawUp', fx: [{ art, x: 12, y: 3 }] };
  },
  search(t) {
    const path = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const [dx, dy] = path[Math.floor(t / 280) % path.length];
    return { pose: 'pawUp', fx: [prop('magnifier', dx, dy)] };
  },
  talk(t) {
    const [, [, pose]] = cycle(TALKING, TALKING_MS, t);
    return { pose };
  },
  sleep(t) {
    const fx = [];
    for (let n = 0; n < 2; n++) {
      const age = (t + n * 1500) % 3000;
      const k = Math.floor(age / 750);
      fx.push(dot(12 + k, 2 - k * 2, Z_FADE[k]));
    }
    return { pose: 'sleep', fx };
  },
  error(t) {
    const fx = [];
    if (t % 900 < 600) fx.push(prop('bang'));
    fx.push(prop('drop', 0, Math.min(2, Math.floor(t / 400) % 4)));
    return { pose: 'crouch', fx };
  },
  done(t) {
    return { pose: 'cheer', fx: sparkle([1, 2, 2, 1, 0][Math.floor(t / 120) % 8] ?? 0) };
  },
};
export const MODE_NAMES = Object.keys(MODES);

// ---------------------------------------------------------------- engine
export class Hama {
  /** @param {{scale?: number, mode?: string, interactive?: boolean, autoSleepMs?: number}} opts */
  constructor(opts = {}) {
    this.scale = opts.scale ?? 3;
    this.autoSleepMs = opts.autoSleepMs ?? 0;
    this.el = document.createElement('div');
    this.el.className = 'hama';
    this.el.style.marginLeft = `${OX * this.scale}px`;
    this.el.style.marginBottom = `${-BELOW * this.scale}px`;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCENE_W;
    this.canvas.height = SCENE_H;
    this.canvas.style.width = `${SCENE_W * this.scale}px`;
    this.canvas.style.height = `${SCENE_H * this.scale}px`;
    this.canvas.style.transformOrigin = `${PIVOT.x * this.scale}px ${PIVOT.y * this.scale}px`;
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.x = 0;
    this.target = null;
    this.facing = 1;
    this.bounds = [0, 0];
    this.mode = opts.mode ?? 'idle';
    this.modeAt = performance.now();
    this.action = null;
    this.walkAt = 0;
    this.lastInput = performance.now();
    this.micro = null;
    this.nextIdle = performance.now() + 2500;
    this.lastKey = '';
    this.drag = null;

    if (opts.interactive !== false) this.bindPointer();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setBounds(min, max) {
    this.bounds = [min, max];
    this.x = Math.max(min, Math.min(max, this.x));
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeAt = performance.now();
    this.lastInput = this.modeAt;
    if (mode !== 'idle') this.target = null;
    if (mode === 'done') this.play('cheer');
    if (mode === 'error') this.play('shake');
    this.el.dataset.mode = mode;
  }

  play(name, opts, done) {
    if (prefersReducedMotion()) return;
    this.target = null;
    this.returnTo = null;
    this.action = { def: ACTIONS[name], name, at: performance.now(), from: this.x, opts, done };
  }

  /** Go to a spot on the bar: walk if near, skate if far. */
  goTo(x) {
    if (!['idle', 'think', 'talk', 'sleep'].includes(this.mode)) return;
    // A click beats whatever idle fidget is playing.
    this.action = null;
    this.wake();
    const to = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], x)));
    const dist = Math.abs(to - this.x);
    if (dist > 36 && this.mode === 'idle') this.play('skate', { to });
    // Close spots sometimes get a backflip and a rolling bounce instead of a walk.
    else if (dist >= 8 && this.mode === 'idle' && Math.random() < 0.4) this.play('ballBounce', { to });
    else this.walkTo(to);
  }

  /** A stroll walks out and comes back to where it started. */
  walkTo(x, stroll = false) {
    if (!['idle', 'think', 'talk'].includes(this.mode)) return;
    this.returnTo = stroll ? this.x : null;
    if (this.mode === 'idle') this.wake();
    this.target = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], x)));
  }

  wake() {
    this.lastInput = performance.now();
    if (this.mode === 'sleep') {
      this.setMode('idle');
      this.play('hop');
    }
  }

  bindPointer() {
    const c = this.canvas;
    let clicks = [];
    c.addEventListener('pointerenter', () => {
      if (!this.action && this.mode === 'idle') this.micro = { pose: 'ear', until: performance.now() + 220 };
    });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.drag = { startX: e.clientX, fromX: this.x, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = (e.clientX - this.drag.startX) / this.scale;
      if (Math.abs(dx) > 2) this.drag.moved = true;
      if (this.drag.moved) {
        this.target = null;
        this.returnTo = null;
        const nx = Math.round(Math.max(this.bounds[0], Math.min(this.bounds[1], this.drag.fromX + dx)));
        if (nx !== this.x) this.facing = nx > this.x ? 1 : -1;
        this.x = nx;
      }
    });
    c.addEventListener('pointerup', () => {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      if (drag.moved) {
        this.play('land');
        return;
      }
      const now = performance.now();
      this.wake();
      clicks = [...clicks.filter((at) => now - at < 2500), now];
      if (clicks.length >= 3) {
        clicks = [];
        this.play(TRICKS[Math.floor(Math.random() * TRICKS.length)]);
      } else {
        this.play('hop');
      }
    });
  }

  frame(now) {
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

    // Idle life: ear flick, shuffle, hop, stroll, fall asleep.
    if (this.mode === 'idle' && !this.action && !walking && !this.drag && !prefersReducedMotion()) {
      if (this.autoSleepMs && now - this.lastInput > this.autoSleepMs) this.setMode('sleep');
      else if (now > this.nextIdle) {
        const roll = Math.random();
        if (roll < 0.25) this.micro = { pose: 'ear', until: now + 200 };
        else if (roll < 0.4) this.micro = { pose: 'open', until: now + 900 };
        else if (roll < 0.7) this.play('shuffle');
        else if (roll < 0.8) this.play('hop');
        else if (roll < 0.9) this.walkTo(this.x - 4 - Math.random() * 8, true);
        else this.play(['jump', 'swim', 'backflip', 'splash'][Math.floor(Math.random() * 4)]);
        this.nextIdle = now + 1800 + Math.random() * 2600;
      }
    }

    // rAF timestamps can trail performance.now() taken in setMode.
    const t = Math.max(0, now - this.modeAt);
    const m = MODES[this.mode](t);
    let { pose } = m;
    let dx = 0, dy = 0, turn = 0, hy = 0, clip;
    let fx = m.fx ?? [];
    let behind = m.behind ?? [];

    if (this.action) {
      const a = this.action;
      const elapsed = Math.max(0, now - a.at);
      let f;
      if (Array.isArray(a.def)) {
        let acc = 0;
        f = a.def.find((fr) => (acc += fr.ms) > elapsed);
      } else {
        f = a.def(elapsed, a, this);
      }
      if (!f) {
        this.action = null;
        a.done?.();
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
      pose = 'step';
      dy = -2;
    } else if (walking && !this.action) {
      pose = Math.floor(now / 120) % 2 ? 'step' : 'stand';
    } else if (!this.action && this.micro && now < this.micro.until && this.mode === 'idle') {
      pose = this.micro.pose;
    }
    if (m.nod && !this.action) dy += 1;
    const layers = [...behind, { art: POSES[pose], y: hy, clip }, ...fx];
    return { layers, dx, dy, turn };
  }

  loop(now) {
    if (this.el.isConnected) {
      const f = this.frame(now);
      const key = JSON.stringify(f) + this.x + this.facing;
      if (key !== this.lastKey) {
        this.lastKey = key;
        drawLayers(this.ctx, f.layers);
        const s = this.scale;
        this.el.style.transform = `translateX(${(this.x + f.dx) * s}px)`;
        this.canvas.style.transform = `translateY(${f.dy * s}px) scaleX(${this.facing}) rotate(${f.turn * 90 * this.facing}deg)`;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}

/** Draws a static pose or prop onto a fresh canvas (for the asset sheet). */
export function staticCanvas(layers, scale = 4) {
  const c = document.createElement('canvas');
  c.width = SCENE_W;
  c.height = SCENE_H;
  c.style.width = `${SCENE_W * scale}px`;
  c.style.height = `${SCENE_H * scale}px`;
  drawLayers(c.getContext('2d'), layers);
  return c;
}

export const ASSET_SHEET = [
  ['stand', [{ art: STAND }]],
  ['step', [{ art: STEP }]],
  ['ears up', [{ art: EAR }]],
  ['crouch', [{ art: CROUCH }]],
  ['yawn', [{ art: OPEN }]],
  ['sleep', [{ art: SLEEP }, dot(13, 0, 'W')]],
  ['type', [prop('laptop'), { art: PAW_DOWN }, dot(12, 7, 'W')]],
  ['read', [{ art: PAW_UP }, prop('paper')]],
  ['search', [{ art: PAW_UP }, prop('magnifier')]],
  ['think', [{ art: STAND }, ...MODES.think(1000).fx]],
  ['error', [{ art: CROUCH }, prop('bang'), prop('drop')]],
  ['done', [{ art: OPEN_EAR }, ...sparkle(2)]],
  ['coffee', [prop('laptop'), { art: PAW_UP }, prop('mug')]],
  ['ball', [{ art: BALL }]],
  ['squash', [{ art: SQUASH }]],
  ['skate', [board(8), { art: STAND, y: -2 }]],
  ['swim', [{ art: STAND, y: 3, clip: GROUND + 1 }, dot(-1, GROUND, 'h'), dot(-3, GROUND, 'o'), dot(13, GROUND, 'h')]],
  ['splash', [...droplets(6, 260), ...ripples(6, 100)]],
  ['smash', [{ art: CROUCH }, ...SMASH(620 + 100).layers]],
];
