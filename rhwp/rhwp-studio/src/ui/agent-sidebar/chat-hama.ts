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
import {
  COLORS, LIGHT_COLORS, POSES, PROPS, Z_FADE, OX, BELOW, SCENE_W, SCENE_H, PIVOT, GROUND, SCALE, drawLayers, dot, sparkle, prop, fade, lerp, arc, droplets, ripples,
  STAMP, SHEET, SHEET_STAMPED, PAGE, PAGE_FOLD, PLANE, PLANE_FAR, BOOMERANG, PARACHUTE, BOX, BOX_OPEN, BROOM,
  BALLOON, BALLOON_HALF, BUBBLE, BUBBLE_BIG, CLOUD, UMBRELLA, UMBRELLA_HALF, UMBRELLA_SHUT, BEACH_BALL,
  type PoseName, type Layer,
} from './hama-art.ts';

/** 오래 손대지 않으면 잠든다. */
const AUTO_SLEEP_MS = 45_000;
/** 입력이 멈춘 뒤 오른쪽 구석으로 돌아가기까지. */
const HOME_DELAY_MS = 3000;
/** 두 번 눌러 하마를 부르는 입력기 가장자리 폭(CSS 픽셀). */
const EDGE_PX = 12;
/** 입력기 위로 함께 받는 빈자리 높이(CSS 픽셀). */
const ABOVE_PX = 16;

// ---------------------------------------------------------------- 동작
type Facing = 1 | -1;

interface ActionFrame {
  pose: PoseName;
  x?: number;
  y?: number;
  turn?: number;
  /** 몸만 옮긴다 — 소품은 제자리에 둔다. */
  hx?: number;
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

// ---------------------------------------------------------------- 앱 순간과 새 재주
const place = (art: readonly string[], x: number, y: number, map?: Record<string, string>): Layer => ({ art, x, y, map });
/** (x, y)의 반짝임 — size 1 은 점, 2 는 십자. */
function twinkle(x: number, y: number, size: number): Layer[] {
  if (size <= 0) return [];
  const out = [dot(x, y, 'W')];
  if (size > 1) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) out.push(dot(x + dx, y + dy, 'd'));
  return out;
}

/** 앞에 소품을 펴는 몸짓은 자리가 넓은 쪽을 보고 한다 — 오른쪽 구석의 집에서는 왼쪽을 본다. */
const towardRoom = (fn: ActionFn): ActionFn => (t, a, h) => {
  const f = fn(t, a, h);
  return f && { face: a.from - h.bounds[0] > h.bounds[1] - a.from ? -1 : 1, ...f };
};

/** 저장: 종이가 밀려 들어오고, 문 도장을 쳐들었다가 내리찍고, 찍힌 종이가 밀려 나간다. */
const STAMP_DOWN: ActionFn = (t) => {
  if (t >= 1750) return null;
  const sheetX = t < 260 ? Math.round(lerp(22, 10, t / 260)) : Math.round(lerp(10, 22, (t - 1300) / 400));
  const sheet = place(t < 560 ? SHEET : SHEET_STAMPED, sheetX, 7);
  // 도장 손잡이를 주둥이 끝에 문다 — 서면 인면이 종이 위에 닿고, 고개를 들면 쳐들리고, 엎드리면 종이를 누른다.
  if (t < 260) return { pose: 'stand', layers: [sheet, place(STAMP, 12, 3)] };
  if (t < 440) return { pose: 'open', hy: -2, layers: [sheet, place(STAMP, 11, 0)] };
  if (t < 560) {
    const puff = t < 520 ? [dot(11, 6, 'W'), dot(15, 6, 'W')] : [];
    return { pose: 'crouch', impact: true, layers: [sheet, place(STAMP, 12, 4), ...puff] };
  }
  if (t < 1300) return { pose: 'open', layers: [sheet, place(STAMP, 11, 2)] };
  return { pose: t > 1550 && t < 1650 ? 'ear' : 'stand', layers: [sheet, place(STAMP, 12, 3)] };
};

/** 내보내기: 종이를 접어 비행기를 만들고, 몸을 젖혔다가 던진다. 비행기는 멀어지며 작아진다. */
const PAPER_PLANE: ActionFn = (t) => {
  if (t < 330) return { pose: 'stand', layers: [place(t < 110 ? PAGE : t < 220 ? PAGE_FOLD : PLANE, 13, 2)] };
  if (t < 480) return { pose: 'crouch', hx: -1, layers: [place(PLANE, 12, 3)] };
  if (t < 560) return { pose: 'open', layers: [place(PLANE, 12, 1)] };
  const p = (t - 560) / 1000;
  if (p < 1) {
    const art = p < 0.4 ? PLANE : p < 0.75 ? PLANE_FAR : ['w'];
    return { pose: p < 0.35 ? 'open' : 'stand', layers: [place(art, 12 + Math.round(8 * p), 1 - Math.round(6 * p))] };
  }
  if (t < 1700) return { pose: t > 1580 && t < 1680 ? 'ear' : 'stand' };
  return null;
};

/** 되돌리기: 부메랑을 던지면 앞으로 돌아 나가 머리 위를 지나 다시 입으로 돌아온다. */
const BOOMERANG_THROW: ActionFn = (t) => {
  const held = BOOMERANG[0]!;
  if (t < 160) return { pose: 'crouch', hx: -1, layers: [place(held, 12, 3)] };
  const fly = t - 160;
  const FLIGHT = 1300;
  if (fly < FLIGHT) {
    const th = (fly / FLIGHT) * Math.PI * 2;
    const cx = 13 + Math.round(6 * Math.sin(th));
    const cy = 2 - Math.round(3.2 * (1 - Math.cos(th)));
    // 머리 위로 지나갈 때 몸을 숙인다.
    const overhead = th > Math.PI * 1.2 && th < Math.PI * 1.92;
    return { pose: fly < 120 ? 'open' : overhead ? 'crouch' : 'stand', layers: [place(BOOMERANG[Math.floor(fly / 60) % 4]!, cx - 1, cy - 1)] };
  }
  const back = fly - FLIGHT;
  if (back < 160) return { pose: 'open', layers: [place(held, 12, 1)] };
  if (back < 300) return { pose: 'crouch', layers: [place(held, 12, 3)] };
  if (back < 620) return { pose: 'stand', layers: [place(held, 13, 2)] };
  return null;
};

/** 문서 열기: 낙하산에 매달린 상자가 내려오고, 하마가 다가가 코로 밀자 상자가 열려 반짝인다. */
const PARCEL_DROP: ActionFn = (t) => {
  const DESCENT = 1100;
  if (t < DESCENT) {
    const top = Math.round(lerp(-9, 1, t / DESCENT));
    const sway = t < DESCENT - 200 ? Math.floor(t / 260) % 2 : 0;
    // 내려오는 동안 고개를 들어 올려다본다.
    return { pose: t > 250 && t < 850 ? 'open' : 'stand', layers: [place(PARACHUTE, 13 + sway, top), place(BOX, 15 + sway, top + 4)] };
  }
  const on = t - DESCENT;
  // 낙하산은 상자 둘레로 내려앉는다.
  const chute = on < 100 ? place(['rrrrrrr'], 13, 3) : place(['rrrrrrr'], 13, 7);
  const opened = on >= 620;
  const box = opened ? place(BOX_OPEN, 14, 4) : place(BOX, 15, 5);
  const layers = [chute, box];
  if (on < 200) return { pose: 'stand', layers };
  if (on < 330) return { pose: 'step', hx: 1, layers };
  if (on < 480) return { pose: 'stand', hx: 2, layers };
  if (on < 620) return { pose: 'crouch', hx: 2, layers };
  if (on < 1300) {
    const k = on - 620;
    const shine = k < 90 ? [dot(16, 4, 'W')] : k < 400 ? twinkle(16, 2, 2) : k < 560 ? twinkle(16, 2, 1) : [];
    return { pose: 'cheer', hx: 2, layers: [...layers, ...shine] };
  }
  if (on < 1430) return { pose: 'step', hx: 1, layers };
  if (on < 1600) return { pose: 'stand', layers };
  return null;
};

const CONFETTI_COLORS = ['r', 'd', 'y', 'W', 'm'];
/** 오래 걸린 일을 마쳤다: 웅크렸다가 뛰며 입에서 색종이를 터뜨린다. 색종이는 하늘거리며 내려앉는다. */
const CONFETTI_POP: ActionFn = (t) => {
  if (t < 140) return { pose: 'crouch' };
  const s = t - 140;
  if (s >= 2300) return null;
  const bits: Layer[] = [];
  const RISE = 300;
  for (let i = 0; i < 12; i++) {
    // 부채꼴로 고르게 퍼진다 — 색과 높이는 섞는다.
    const vx = -2.2 + ((i * 5) % 12) * 0.5;
    const up = 3 + ((i * 7) % 4);
    const x0 = 11, y0 = 1;
    let x: number, y: number;
    if (s < RISE) {
      const p = s / RISE;
      x = x0 + (vx * s) / 100;
      y = y0 - up * (1 - (1 - p) * (1 - p));
    } else {
      const fall = s - RISE;
      // 꼭대기에서는 천천히 떨어지며 좌우로 한 칸씩 흔들린다.
      x = x0 + (vx * RISE) / 100 + (vx * fall) / 600 + (Math.floor(fall / 140 + i) % 2);
      y = y0 - up + fall / (100 + noise(i + 3) * 40);
    }
    if (y >= GROUND + 1) continue;
    bits.push(dot(Math.round(x), Math.min(GROUND, Math.round(y)), CONFETTI_COLORS[i % CONFETTI_COLORS.length]!));
  }
  const hop = s < 100 ? -2 : s < 220 ? -1 : s > 900 && s < 1050 ? -1 : 0;
  // 색종이는 몸 뒤로 지나간다.
  return { pose: s < 1700 ? 'cheer' : 'stand', hy: hop, behind: bits, layers: s < 80 ? [dot(10, 0, 'W')] : [] };
};

/** 새 채팅: 빗자루를 물고 앞을 쓸면 먼지가 날아가고, 깨끗해진 자리가 반짝인다. */
const SWEEP: ActionFn = (t) => {
  const STROKE = 200;
  const STROKES = 7;
  const k = Math.floor(t / STROKE);
  const layers: Layer[] = [];
  // 앞으로 쓸 때마다 먼지 두 점이 앞으로 튄다.
  for (let j = 0; j < STROKES; j += 2) {
    const age = t - j * STROKE - 60;
    if (age < 0 || age > 460) continue;
    const s = age / 80;
    layers.push(dot(19 + Math.round(s * 0.6), GROUND + arc(age / 460, 2), 'p'));
    layers.push(dot(19 + Math.round(s * 0.3), GROUND + arc(age / 460, 4), 'L'));
    if (age > 120) layers.push(dot(19 + Math.round(s * 0.5), GROUND + arc((age - 120) / 340, 3), 'p'));
  }
  if (k < STROKES) {
    const out = k % 2 === 0;
    return { pose: out ? 'step' : 'stand', hx: out ? 1 : 0, layers: [place(BROOM, out ? 14 : 13, 4), ...layers] };
  }
  const end = t - STROKES * STROKE;
  if (end >= 700) return null;
  const shine = end < 120 ? twinkle(18, 6, 1) : end < 420 ? twinkle(18, 5, 2) : [];
  return { pose: end > 480 && end < 580 ? 'ear' : 'stand', layers: [place(BROOM, 13, 4), ...layers, ...shine] };
};

/** 등에 묶은 풍선이 부풀어 하마를 들어 올리다 터지고, 하마는 떨어져 어질어질하다. */
const BALLOON_RIDE: ActionFn = (t) => {
  if (t >= 2000) return null;
  const sway = Math.floor(t / 280) % 2;
  // 등에 묶은 실 — 풍선이 흔들리면 윗부분이 따라간다.
  const string = (x: number): Layer[] => [dot(3, 3, 'p'), dot(3, 2, 'p'), dot(x, 1, 'p'), dot(x, 0, 'p')];
  if (t < 150) return { pose: 'stand', layers: [...string(3), dot(3, -1, 'r')] };
  if (t < 300) return { pose: 'stand', layers: [...string(3), place(BALLOON_HALF, 3, -2)] };
  const LIFT = 6;
  if (t < 1260) {
    const p = Math.min(1, (t - 300) / 900);
    const y = -Math.round(LIFT * (1 - (1 - p) * (1 - p)));
    // 들리면 발을 버둥거린다.
    const pose: PoseName = y < 0 && Math.floor(t / 140) % 2 ? 'stand' : 'step';
    return { pose, y, layers: [...string(3 + sway), place(BALLOON, 2 + sway, -5)] };
  }
  if (t < 1340) {
    const burst = [dot(1, -6, 'r'), dot(6, -6, 'r'), dot(0, -3, 'r'), dot(7, -3, 'r'), dot(1, 0, 'r'), dot(6, 0, 'r'), dot(3, -3, 'W'), dot(4, -3, 'W')];
    return { pose: 'cheer', y: -LIFT, layers: [...string(3), ...burst] };
  }
  if (t < 1540) {
    const p = (t - 1340) / 200;
    return { pose: 'step', y: -LIFT + Math.round(LIFT * p * p) };
  }
  if (t < 1640) return { pose: 'crouch', impact: true };
  return { pose: t > 1880 ? 'ear' : 'stand', x: t < 1840 ? (Math.floor(t / 70) % 2 ? 1 : -1) : 0 };
};

/** 비눗방울을 불어 띄운다 — 큰 것 하나, 작은 것 하나. 떠오르다 톡 터진다. */
function blown(age: number, big: boolean): Layer[] {
  if (age < 0) return [];
  if (age < 200) return [dot(13, 3, 'd')];
  if (age < 400 || (big && age < 600)) return [age < 400 ? place(BUBBLE, 13, 2) : place(BUBBLE_BIG, 13, 1)];
  const rel = age - (big ? 600 : 400);
  const art = big ? BUBBLE_BIG : BUBBLE;
  const x = 13 + Math.floor(rel / 300) + (Math.floor(rel / 220) % 2);
  const y = (big ? 1 : 2) - Math.floor(rel / 110);
  const top = big ? -4 : -2;
  if (y > top) return [place(art, x, y)];
  // 터지면 네 귀퉁이로 물방울이 튄다.
  const pop = rel - ((big ? 1 : 2) - top) * 110;
  if (pop > 140) return [];
  const [w, h] = [art[0]!.length, art.length];
  return [dot(x - 1, y - 1, 'W'), dot(x + w, y - 1, 'W'), dot(x - 1, y + h, 'W'), dot(x + w, y + h, 'W')];
}
const BUBBLE_BLOW: ActionFn = (t) => {
  if (t >= 2400) return null;
  const layers = [...blown(t - 150, true), ...blown(t - 1250, false)];
  const pose: PoseName = t < 150 || (t > 1100 && t < 1250) ? 'crouch' : t > 2150 && t < 2250 ? 'ear' : 'stand';
  return { pose, layers };
};

/** 머리 위에 비구름이 와서 비를 뿌리면, 움츠렸다가 우산을 펴고 버틴다. 구름이 가면 몸을 턴다. */
const RAIN_SHOWER: ActionFn = (t) => {
  if (t >= 2700) return null;
  const layers: Layer[] = [];
  const umbrella = t < 1000 || t >= 2460 ? null
    : t < 1080 || t >= 2380 ? place(UMBRELLA_SHUT, 6, 0)
      : t < 1160 || t >= 2300 ? place(UMBRELLA_HALF, 4, -1) : place(UMBRELLA, 3, -1);
  const open = t >= 1160 && t < 2300;
  // 빗방울: 구름 아래에서 떨어져 머리(우산을 펴면 우산 위)에서 사라진다.
  for (let i = 0; i < 26; i++) {
    const born = 350 + i * 70;
    const age = t - born;
    if (age < 0 || born > 2100) continue;
    const col = 3 + Math.floor(noise(i + 11) * 7);
    const y = -2 + Math.floor(age / 45);
    const floor = open ? -2 : col < 5 ? 3 : 2;
    if (y <= floor) layers.push(dot(col, y, 'd'));
  }
  // 우산 끝에서 떨어지는 물.
  if (open && t < 2200) {
    for (const [x, at] of [[3, 1300], [9, 1390], [3, 1660], [9, 1750], [3, 2020]] as const) {
      const age = t - at;
      const y = 1 + Math.floor(age / 50);
      if (age >= 0 && y <= GROUND) layers.push(dot(x, y, 'd'));
    }
  }
  if (t < 2500) {
    const x = t < 400 ? Math.round(lerp(-9, 2, t / 400)) : t < 2100 ? 2 : Math.round(lerp(2, 9, (t - 2100) / 400));
    layers.unshift(place(CLOUD, x, -5, t >= 2100 ? { L: COLORS.p!, p: COLORS.P! } : undefined));
  }
  if (umbrella) layers.push(umbrella, ...(open ? [dot(6, 1, 'L'), dot(6, 2, 'L')] : []));
  if (t < 450) return { pose: 'stand', layers };
  if (t < 600) return { pose: 'ear', layers };
  if (t < 1160) return { pose: 'crouch', layers };
  if (t < 2300) return { pose: t > 1700 && t < 1800 ? 'ear' : 'stand', layers };
  return { pose: 'stand', x: t < 2600 ? (Math.floor(t / 60) % 2 ? 1 : -1) : 0, layers };
};

/** 물개처럼 코끝으로 공을 튀긴다 — 점점 높이 세 번, 잠깐 버티다가 공을 앞으로 굴려 보낸다. */
const NOSE_BALL: ActionFn = (t) => {
  const ball = (x: number, y: number): Layer => place(BEACH_BALL[Math.floor(t / 90) % 2]!, x, y);
  const REST = 1;
  if (t < 300) return { pose: 'stand', layers: [ball(10, Math.round(lerp(-7, REST, (t / 300) ** 2)))] };
  let at = t - 300;
  for (const [ms, height] of [[360, 3], [400, 4], [460, 5]] as const) {
    if (at < ms) return { pose: at < 80 ? 'cheer' : 'stand', layers: [ball(10, REST + arc(at / ms, height))] };
    at -= ms;
  }
  // 코 위에서 버틴다 — 몸이 한 칸씩 흔들려도 공은 코를 따라간다.
  if (at < 420) {
    const sway = [0, -1, 0, 1][Math.floor(at / 105)] ?? 0;
    return { pose: at > 300 ? 'ear' : 'stand', hx: sway, layers: [ball(10 + sway, REST)] };
  }
  at -= 420;
  const ROLL = [[11, 1], [12, 2], [13, 3], [14, 5], [15, 6], [16, 5], [17, 5], [18, 6], [19, 6], [20, 6]] as const;
  const step = Math.floor(at / 70);
  if (step < ROLL.length) {
    const [x, y] = ROLL[step]!;
    return { pose: 'stand', layers: [ball(x, y)] };
  }
  return null;
};

const ACTIONS = {
  hop: HOP, cheer: CHEER, backflip: BACKFLIP, shuffle: SHUFFLE, land: LAND, shake: SHAKE,
  jump: JUMP, splash: SPLASH, smash: SMASH, swim: SWIM, skate: SKATE, ballBounce: BALL_BOUNCE, drop: DROP,
  stamp: towardRoom(STAMP_DOWN), plane: towardRoom(PAPER_PLANE), boomerang: towardRoom(BOOMERANG_THROW),
  parcel: towardRoom(PARCEL_DROP), confetti: towardRoom(CONFETTI_POP), broom: towardRoom(SWEEP),
  balloon: BALLOON_RIDE, bubbles: towardRoom(BUBBLE_BLOW), rain: RAIN_SHOWER, noseBall: towardRoom(NOSE_BALL),
} satisfies Record<string, ActionDef>;
type ActionName = keyof typeof ACTIONS;
export type HamaActionName = ActionName;
const TRICKS: readonly ActionName[] = ['jump', 'backflip', 'ballBounce', 'splash', 'smash', 'swim', 'skate', 'balloon', 'noseBall', 'boomerang'];
/** 한가할 때 가끔 하는 큰 몸짓. */
const IDLE_TRICKS: readonly ActionName[] = ['jump', 'swim', 'backflip', 'splash', 'bubbles', 'rain', 'noseBall'];
/** 앱 순간과 재주로 더한 몸짓 — 미리보기에서 하나씩 본다. */
export const HAMA_SHOWCASE: readonly ActionName[] = ['stamp', 'plane', 'boomerang', 'parcel', 'confetti', 'broom', 'balloon', 'bubbles', 'rain', 'noseBall'];
/** 하던 몸짓을 끊어도 되는 잔동작. */
const AMBIENT: ReadonlySet<ActionName> = new Set(['hop', 'shuffle', 'land']);

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

  /** 끌리지 않고, 상태 몸짓이나 재주를 하지 않는가. 깡충·발 구르기 같은 잔동작은 끊어도 된다. */
  isFree(): boolean {
    return !this.drag && (this.mode === 'idle' || this.mode === 'sleep') && (!this.action || AMBIENT.has(this.action.name));
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
          else this.play(IDLE_TRICKS[Math.floor(Math.random() * IDLE_TRICKS.length)]!);
        }
        this.nextIdle = now + 1800 + Math.random() * 2600;
      }
    }

    // rAF 시각은 setMode 의 performance.now() 보다 늦을 수 있다.
    const t = Math.max(0, now - this.modeAt);
    const m = MODES[this.mode](t);
    let pose = m.pose;
    let dx = 0, dy = 0, turn = 0, hx = 0, hy = 0;
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
        hx = f.hx ?? 0;
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
      hx = 0;
      turn = 0;
    } else if (walking && !this.action) {
      pose = Math.floor(now / 120) % 2 ? 'step' : 'stand';
    } else if (!this.action && this.micro && now < this.micro.until && this.mode === 'idle') {
      pose = this.micro.pose;
    }
    if (m.nod && !this.action) dy += 1;
    const layers = [...behind, { art: POSES[pose], x: hx, y: hy, clip }, ...fx];
    return { layers, dx, dy, turn };
  }

  private render(now: number): void {
    if (!this.el.isConnected) return;
    const f = this.frame(now);
    // 지금 하는 몸짓 이름(미리보기·시험용).
    const action = this.action?.name ?? '';
    if ((this.el.dataset.action ?? '') !== action) {
      if (action) this.el.dataset.action = action;
      else delete this.el.dataset.action;
    }
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
  /** 턴이 끝났다 — 완료면 환호(오래 걸렸으면 색종이), 실패면 움츠림, 중단이면 그냥 선다. */
  turnEnded(outcome: TurnOutcome): void;
  /** 앱에서 일이 생겼다. 보이고 한가할 때만, 잦지 않게 몸짓으로 답한다. */
  react(moment: HamaMoment): void;
  /** 이름으로 몸짓을 바로 한다(미리보기·시험용). 하마가 없으면 false. */
  perform(name: HamaActionName): boolean;
  /** 턴 밖의 일(문체 학습)을 보인다 — 턴이 도는 동안은 턴이 하마를 쓴다. null 이면 한가함으로. */
  background(mode: ChatHamaMode | null): void;
  /** 지금 상태(시험용). */
  readonly mode: ChatHamaMode;
  dispose(): void;
}

/** 하마가 답하는 앱의 순간. */
export type HamaMoment = 'saved' | 'exported' | 'undone' | 'opened' | 'newChat';
/** 순간마다 하는 몸짓과, 같은 순간에 다시 답하기까지 두는 간격. */
const MOMENTS: Record<HamaMoment, { action: ActionName; gapMs: number }> = {
  saved: { action: 'stamp', gapMs: 60_000 },
  exported: { action: 'plane', gapMs: 15_000 },
  undone: { action: 'boomerang', gapMs: 120_000 },
  opened: { action: 'parcel', gapMs: 30_000 },
  newChat: { action: 'broom', gapMs: 30_000 },
};
/** 어떤 순간이든 앞 몸짓과 두는 간격. */
const MOMENT_GAP_MS = 8000;
/** 이보다 오래 돈 턴을 마치면 색종이를 터뜨린다. */
const LONG_RUN_MS = 60_000;

const RUNNING_MODES: ReadonlySet<ChatHamaMode> = new Set(['think', 'work', 'read', 'search', 'talk']);
/** 끝 상태를 보인 뒤 한가함으로 돌아가기까지. */
const SETTLE_MS: Partial<Record<ChatHamaMode, number>> = { done: 2000, error: 5000 };

export function createChatHama(opts: ChatHamaOptions): ChatHama {
  const { composer, input, hitRoot } = opts;
  let mode: ChatHamaMode = 'idle';
  let running = false;
  let runStartedAt = 0;
  let lastMomentAt = -Infinity;
  const momentAt = new Map<HamaMoment, number>();
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
        runStartedAt = performance.now();
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
      const long = runStartedAt > 0 && performance.now() - runStartedAt >= LONG_RUN_MS;
      running = false;
      runStartedAt = 0;
      setMode(outcome === 'completed' ? 'done' : outcome === 'failed' ? 'error' : backgroundMode ?? 'idle');
      if (outcome === 'completed' && long && isActive()) mounted?.hama.play('confetti');
    },
    react(moment: HamaMoment): void {
      if (!mounted || !isActive() || running || (mode !== 'idle' && mode !== 'sleep') || !mounted.hama.isFree()) return;
      const now = performance.now();
      const { action, gapMs } = MOMENTS[moment];
      if (now - lastMomentAt < MOMENT_GAP_MS || now - (momentAt.get(moment) ?? -Infinity) < gapMs) return;
      lastMomentAt = now;
      momentAt.set(moment, now);
      mounted.hama.wake();
      mounted.hama.play(action);
    },
    perform(name: HamaActionName): boolean {
      if (!mounted) return false;
      mounted.hama.wake();
      mounted.hama.play(name);
      return true;
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
