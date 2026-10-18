/** 떠 있는 브라우저의 위치·크기 계산. DOM 없이 앱 창 크기와 프레임만 다룬다. */
export interface FloatFrame { left: number; top: number; width: number; height: number }
export interface FloatArea { width: number; height: number }
export interface FloatPoint { x: number; y: number }
export type FloatResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** 창 가장자리에서 프레임이 비워 둘 거리. 제목 막대가 있는 창은 위쪽만 더 비운다. */
export interface FloatInset { top: number; right: number; bottom: number; left: number }

export const FLOAT_EDGE_GAP = 12;
export const FLOAT_INSET: FloatInset = { top: FLOAT_EDGE_GAP, right: FLOAT_EDGE_GAP, bottom: FLOAT_EDGE_GAP, left: FLOAT_EDGE_GAP };
export const FLOAT_MIN_SIZE: FloatArea = { width: 320, height: 240 };
const FLOAT_DEFAULT_SIZE: FloatArea = { width: 480, height: 340 };
const RUBBER_BAND = 0.35;
const MAGNET = 24;
// UIScrollView 감속률의 빠른 쪽. 던진 거리를 짧게 유지한다.
const DECELERATION = 0.995;

const clampNumber = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
// 좁은 창에서는 최소 크기보다 창 안에 머무는 쪽이 이긴다.
const fitSize = (value: number, min: number, max: number) => Math.round(Math.max(1, Math.min(Math.max(value, min), max)));

/** 저장된 프레임을 현재 창 안에 맞춘다. 결과를 저장하지 않으므로 잠시 작아진 창이 사용자의 크기를 지우지 않는다. */
export function fitFloatFrame(frame: FloatFrame | null, area: FloatArea, inset: FloatInset = FLOAT_INSET): FloatFrame {
  const width = fitSize(frame?.width ?? FLOAT_DEFAULT_SIZE.width, FLOAT_MIN_SIZE.width, area.width - inset.left - inset.right);
  const height = fitSize(frame?.height ?? FLOAT_DEFAULT_SIZE.height, FLOAT_MIN_SIZE.height, area.height - inset.top - inset.bottom);
  const position = frame ?? { left: inset.left, top: area.height - inset.bottom - height };
  return { ...clampFloatPosition({ x: position.left, y: position.top }, { width, height }, area, inset), width, height };
}

export function clampFloatPosition(point: FloatPoint, size: FloatArea, area: FloatArea, inset: FloatInset = FLOAT_INSET): { left: number; top: number } {
  return {
    left: Math.round(clampNumber(point.x, inset.left, area.width - size.width - inset.right)),
    top: Math.round(clampNumber(point.y, inset.top, area.height - size.height - inset.bottom)),
  };
}

/** 가장자리를 넘긴 만큼 점점 무거워지고 여백 안에서 멈춘다. 프레임은 창 밖으로 나가지 않는다. */
function resist(value: number, min: number, max: number): number {
  const band = (overshoot: number) => FLOAT_EDGE_GAP * (1 - Math.exp(-overshoot * RUBBER_BAND / FLOAT_EDGE_GAP));
  if (max < min) return min;
  if (value < min) return min - band(min - value);
  if (value > max) return max + band(value - max);
  return value;
}

export function rubberBandFloatPosition(point: FloatPoint, size: FloatArea, area: FloatArea, inset: FloatInset = FLOAT_INSET): FloatPoint {
  return {
    x: resist(point.x, inset.left, area.width - size.width - inset.right),
    y: resist(point.y, inset.top, area.height - size.height - inset.bottom),
  };
}

/** 놓을 때의 속도(px/s)로 멈출 자리를 투영하고, 가장자리 가까이면 붙인다. */
export function projectFloatRelease(point: FloatPoint, velocity: FloatPoint, size: FloatArea, area: FloatArea, inset: FloatInset = FLOAT_INSET): { left: number; top: number } {
  const distance = (speed: number) => speed / 1000 * DECELERATION / (1 - DECELERATION);
  const target = clampFloatPosition({ x: point.x + distance(velocity.x), y: point.y + distance(velocity.y) }, size, area, inset);
  const right = area.width - size.width - inset.right; const bottom = area.height - size.height - inset.bottom;
  const snap = (value: number, min: number, max: number) => max > min && value - min <= MAGNET ? min : max > min && max - value <= MAGNET ? max : value;
  return { left: Math.round(snap(target.left, inset.left, right)), top: Math.round(snap(target.top, inset.top, bottom)) };
}

/** 잡은 가장자리만 움직이고 반대편은 고정한다. 커지는 쪽은 창 여백에서 멈춘다. */
export function resizeFloatFrame(start: FloatFrame, edge: FloatResizeEdge, delta: FloatPoint, area: FloatArea, inset: FloatInset = FLOAT_INSET): FloatFrame {
  const north = edge.includes('n'); const south = edge.includes('s'); const west = edge.includes('w'); const east = edge.includes('e');
  const right = start.left + start.width; const bottom = start.top + start.height;
  const maxWidth = west ? right - inset.left : area.width - inset.right - start.left;
  const maxHeight = north ? bottom - inset.top : area.height - inset.bottom - start.top;
  const width = east || west ? fitSize(start.width + (east ? delta.x : -delta.x), FLOAT_MIN_SIZE.width, maxWidth) : start.width;
  const height = north || south ? fitSize(start.height + (south ? delta.y : -delta.y), FLOAT_MIN_SIZE.height, maxHeight) : start.height;
  return { left: west ? right - width : start.left, top: north ? bottom - height : start.top, width, height };
}

export interface FloatSpring { position: FloatPoint; velocity: FloatPoint }
// 살짝 덜 감쇠된 스프링. 한 번 작게 넘었다가 자리에 선다.
const STIFFNESS = 420;
const DAMPING = 2 * 0.78 * Math.sqrt(STIFFNESS);

/** dt(초)만큼 스프링을 진행한다. 고정 간격으로 나눠 프레임 지연에도 안정적이다. 멈추면 true. */
export function stepFloatSpring(spring: FloatSpring, target: FloatPoint, dt: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.min(dt, 0.064) / (1 / 240)));
  const h = Math.min(dt, 0.064) / steps;
  for (let i = 0; i < steps; i++) for (const axis of ['x', 'y'] as const) {
    spring.velocity[axis] += (-STIFFNESS * (spring.position[axis] - target[axis]) - DAMPING * spring.velocity[axis]) * h;
    spring.position[axis] += spring.velocity[axis] * h;
  }
  const settled = (['x', 'y'] as const).every(axis => Math.abs(spring.position[axis] - target[axis]) < 0.5 && Math.abs(spring.velocity[axis]) < 12);
  if (settled) { spring.position = { ...target }; spring.velocity = { x: 0, y: 0 }; }
  return settled;
}
