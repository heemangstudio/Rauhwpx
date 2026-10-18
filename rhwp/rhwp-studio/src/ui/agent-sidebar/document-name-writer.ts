/**
 * 문서 이름 쓰기 — 문서 없이 시작한 채팅에 문서를 이으면 하마가 머리의 '/ 문서 이름' 을 뱉어 쓴다. 모양은
 * document-name-writer.css.
 *
 * 이름 오른쪽에 하마가 픽셀로 나타나 왼쪽을 보고 입을 벌리면, 입에서 튄 픽셀이 포물선을 그리며 이름의 글자에
 * 하나씩 앉아 그 글자를 드러낸다. 다 쓰면 하마는 폴짝 뛰고 흩어지고, 이름 칸은 보통 글자로 돌아간다.
 * 하마는 public/images/boot/hama-sprites.png 의 26×20 칸 여섯 (closed·talk·open·blink·step·crouch)을
 * 정수배(2)로, 50ms 씩 끊어 그린다. 동작 줄이기면 쓰지 않는다 — 이름은 그대로 보인다.
 *
 * 채팅을 문서에서 떼면 하마가 이름을 먹는다(inhale). 이름 오른쪽 끝에 입을 대고 나타나, 입을 벌렸다 다물며
 * 글자를 물고 왼쪽으로 걸어가 마지막에 '/' 까지 먹은 뒤 꿀꺽하고 폴짝 뛰어 흩어진다.
 * 하마는 늘 머리 줄(host) 안에 선다 — 그 오른쪽은 머리의 단추 자리다.
 */
import './document-name-writer.css';

export interface DocumentNameWriter {
  /** 지금 하마가 쓰고 있는 이름 칸. 쓰지 않으면 null. */
  readonly target: HTMLElement | null;
  /**
   * target 에 지금 적힌 글자를 하마가 쓴다. host 는 하마 캔버스가 서는 머리 줄(위치 기준), separator 는
   * 하마가 서기 전까지 함께 숨길 '/'. 끝나거나 거두면 target 은 처음의 보통 글자로 돌아간다.
   */
  write(target: HTMLElement, place: { host: HTMLElement; separator?: HTMLElement }): Promise<void>;
  /**
   * target 에 지금 적힌 글자를 하마가 오른쪽부터 먹는다. 끝까지 가면 target 은 비고 separator 는 숨긴 채로 둔다 —
   * 부른 쪽이 곧 이 채팅을 떠난다. 거두면(cancel·다른 write/inhale) 처음 글자와 separator 로 돌아간다.
   * 끝까지 갔으면 true, 거뒀으면 false. 동작 줄이기면 바로 비우고 true.
   */
  inhale(target: HTMLElement, place: { host: HTMLElement; separator?: HTMLElement }): Promise<boolean>;
  /** 쓰던 것을 바로 거둔다. */
  cancel(): void;
}

const CELL_W = 26;
const CELL_H = 20;
const POSE_COUNT = 6;
const SCALE = 2;
const FRAME_MS = 50;
const CANVAS_H = 44;
/** 이름 끝과 하마 사이 틈. */
const HAMA_GAP = 6;
/** 하마 픽셀 파랑과 같은 색 — 날아가는 픽셀과 막 찍힌 글자. */
const HAMA_BLUE = 'rgb(98, 179, 226)';
/** 입에서 글자까지 날아가는 틱 수와, 한 번에 뱉는 글자 수의 상한을 정하는 발사 횟수. */
const FLIGHT = 4;
const MAX_SHOTS = 18;
/** 먹을 때 한 입의 상한 — 이름은 많아야 여섯 입('/' 는 따로 한 입). 긴 이름은 한 입에 여러 글자를 문다. */
const BITES = 6;
/** 입이 물 글자의 오른쪽 끝 안으로 걸치는 폭(px). */
const BITE_REACH = 2;
/**
 * 문 자리에서 튀는 부스러기: [가로, 세로] 첫 속도(스프라이트 픽셀/틱). 틱마다 한 칸씩 떨어지고 세 틱 만에 옅어진다.
 * 입마다 앞에서부터 셋이나 넷을 돌려 쓴다.
 */
const CRUMBS: ReadonlyArray<readonly [number, number]> = [[-1, -3], [-3, -2], [1, -3], [-2, -1], [0, -4]];
const CRUMB_ALPHA = [1, 0.6, 0.3];
/** 폴짝: [자세, 세로 이동(스프라이트 픽셀)] — crouch, step 으로 떴다가 내려앉는다. */
const HOP: ReadonlyArray<readonly [number, number]> = [[5, 0], [4, -2], [4, -3], [4, -2], [5, 0], [0, 0]];

interface SpritePixel { x: number; y: number; color: string; rank: number }

let posesPromise: Promise<SpritePixel[][] | null> | null = null;

/** 흩어지고 모이는 순서 — 픽셀마다 고정된 0..1 값. */
function pixelRank(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function spriteUrl(): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}images/boot/hama-sprites.png`;
}

/** 스프라이트를 한 번 읽어 자세별 픽셀로 나눈다. 읽지 못하면 null — 이름은 쓰지 않고 바로 보인다. */
function loadPoses(): Promise<SpritePixel[][] | null> {
  posesPromise ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = CELL_W * POSE_COUNT;
        canvas.height = CELL_H;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const poses: SpritePixel[][] = [];
        for (let pose = 0; pose < POSE_COUNT; pose++) {
          const pixels: SpritePixel[] = [];
          for (let y = 0; y < CELL_H; y++) {
            for (let x = 0; x < CELL_W; x++) {
              const at = (y * canvas.width + pose * CELL_W + x) * 4;
              if (!data[at + 3]) continue;
              pixels.push({ x, y, color: `rgb(${data[at]}, ${data[at + 1]}, ${data[at + 2]})`, rank: pixelRank(x, y) });
            }
          }
          poses.push(pixels);
        }
        resolve(poses);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = spriteUrl();
  });
  return posesPromise;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class Cancelled extends Error {}

type Point = { x: number; y: number };
type Place = { host: HTMLElement; separator?: HTMLElement };

/** 이름을 글자(자소 묶음) 단위로 자른다. */
function graphemes(text: string): string[] {
  return typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
    : Array.from(text);
}

function letterSpans(text: string, className: string): HTMLElement[] {
  return graphemes(text).map((letter) => {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.textContent = letter;
    return span;
  });
}

/** 입과 글자 사이 포물선 위의 한 점. 높이 떴다가 내려앉는다 — 멀리 갈수록 높게 뜬다. */
function arc(from: Point, to: Point, progress: number, lift: number): Point {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress - Math.sin(Math.PI * progress) * lift,
  };
}

function liftBetween(mouth: Point, letter: Point): number {
  return 6 + Math.min(10, Math.abs(mouth.x - letter.x) / 12);
}

/** 하마 무대 — 머리 줄(host) 위에 겹친 캔버스와, 그 위의 하마·입·글자 자리. 하마 x 는 하마 그림의 왼쪽 끝이다. */
interface Stage {
  readonly canvas: HTMLCanvasElement;
  /**
   * 화면 x(right)에서 HAMA_GAP 만큼 오른쪽에 설 자리. 머리 줄 오른쪽 끝을 넘지 않게 당긴다 — 그 오른쪽은
   * 머리의 단추 자리다. 이름이 줄을 다 채우면 하마는 마지막 글자들 위에 선다.
   */
  standAt(right: number, gap?: number): number;
  /** 하마를 rank < shown 인 픽셀만 그린다(흩어지고 모이기). 캔버스를 먼저 비운다. */
  hama(poses: SpritePixel[][], x: number, pose: number, offsetY: number, shown: number): void;
  /** 스프라이트 격자에 맞춘 픽셀 하나. alpha 는 옅어지는 부스러기. */
  dot(at: Point, color: string, alpha?: number): void;
  mouth(x: number): Point;
  /** 글자 가운데 — 말줄임으로 가려진 글자는 보이는 끝. */
  spot(element: HTMLElement): Point;
  /** 글자의 화면 오른쪽 끝 — 말줄임으로 가려진 글자는 보이는 끝. */
  right(element: HTMLElement): number;
}

/** 머리 줄에 하마 캔버스를 세운다. 하마는 왼쪽을 본다. */
function createStage(target: HTMLElement, place: Place): Stage | null {
  const dpr = window.devicePixelRatio || 1;
  const P = SCALE;
  const hostBox = place.host.getBoundingClientRect();
  const nameBox = target.getBoundingClientRect();
  const hamaW = CELL_W * P;
  const hamaY = Math.round((CANVAS_H - CELL_H * P) / 2);
  const width = Math.max(Math.floor(hostBox.width), hamaW);
  const top = Math.round(nameBox.top + nameBox.height / 2 - hostBox.top - CANVAS_H / 2);
  const canvas = document.createElement('canvas');
  canvas.className = 'ag-doc-name-fx';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = width * dpr;
  canvas.height = CANVAS_H * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${CANVAS_H}px`;
  canvas.style.top = `${top}px`;
  const context = canvas.getContext('2d');
  if (!context) return null;
  place.host.append(canvas);
  context.scale(dpr, dpr);
  const canvasBox = canvas.getBoundingClientRect();
  return {
    canvas,
    standAt(right, gap = HAMA_GAP) {
      return Math.max(0, Math.min(Math.ceil(right - hostBox.left) + gap, width - hamaW));
    },
    // 하마는 왼쪽을 본다 — 스프라이트를 좌우로 뒤집어 그린다. 입은 뒤집은 그림의 왼쪽 위다.
    mouth(x) {
      return { x: x + (CELL_W - 1 - 23) * P, y: hamaY + 8 * P };
    },
    hama(poses, x, pose, offsetY, shown) {
      context.clearRect(0, 0, width, CANVAS_H);
      for (const pixel of poses[pose] ?? []) {
        if (pixel.rank >= shown) continue;
        context.fillStyle = pixel.color;
        context.fillRect(x + (CELL_W - 1 - pixel.x) * P, hamaY + (pixel.y + offsetY) * P, P, P);
      }
    },
    dot(at, color, alpha = 1) {
      context.globalAlpha = alpha;
      context.fillStyle = color;
      context.fillRect(Math.round(at.x / P) * P, Math.round(at.y / P) * P, P, P);
      context.globalAlpha = 1;
    },
    spot(element) {
      const box = element.getBoundingClientRect();
      // 말줄임으로 가려진 글자는 보이는 끝으로 날아간다.
      const x = Math.min(box.left + box.width / 2, nameBox.right - P) - canvasBox.left;
      return { x: Math.round(x / P) * P, y: Math.round((box.top + box.height / 2 - canvasBox.top) / P) * P };
    },
    right(element) {
      return Math.min(element.getBoundingClientRect().right, nameBox.right);
    },
  };
}

/** 빈칸은 쏘지 않는다. 긴 이름은 한 번에 여러 글자를 묶어 발사 횟수를 cap 안에 둔다. */
function groupShots(letters: HTMLElement[], cap: number): HTMLElement[][] {
  const visible = letters.filter((span) => span.textContent!.trim() !== '');
  const perShot = Math.max(1, Math.ceil(visible.length / cap));
  const groups: HTMLElement[][] = [];
  for (let index = 0; index < visible.length; index += perShot) groups.push(visible.slice(index, index + perShot));
  return groups;
}

export function createDocumentNameWriter(): DocumentNameWriter {
  /** 앞선 쓰기를 거두는 표. 늘 때마다 돌던 쓰기는 다음 장면에서 멈춘다. */
  let generation = 0;
  let current: { target: HTMLElement; text: string; separator?: HTMLElement; canvas?: HTMLCanvasElement } | null = null;

  const wait = (ms: number, token: number): Promise<void> => new Promise((resolve, reject) => {
    window.setTimeout(() => (token === generation ? resolve() : reject(new Cancelled())), ms);
  });

  /** 캔버스를 걷고 이름 칸을 보통 글자로 되돌린다. */
  function settle(): void {
    if (!current) return;
    const { target, text, separator, canvas } = current;
    current = null;
    canvas?.remove();
    target.classList.remove('ag-doc-name-inhaling');
    if (separator) {
      separator.style.visibility = '';
      separator.classList.remove('ag-doc-name-letter-out');
    }
    target.textContent = text;
  }

  /** 먹기를 끝낸다 — 이름 칸은 비우고 '/' 는 숨긴 채로 둔다. */
  function empty(target: HTMLElement, separator?: HTMLElement): void {
    current?.canvas?.remove();
    current = null;
    target.classList.remove('ag-doc-name-inhaling');
    target.textContent = '';
    if (separator) {
      separator.style.visibility = 'hidden';
      separator.classList.remove('ag-doc-name-letter-out');
    }
  }

  function openStage(place: Place): Stage | null {
    const stage = createStage(current!.target, place);
    if (stage) current!.canvas = stage.canvas;
    return stage;
  }

  /**
   * 하마가 이름 오른쪽에 서서 왼쪽을 보고, 입에서 튄 픽셀이 포물선을 그리며 이름의 글자에 앉는다 —
   * 앉은 자리의 글자가 파랗게 찍혔다가 글자색이 된다. 글자는 처음부터 제자리를 차지하고 숨어 있어서
   * 끝나도 자리가 움직이지 않는다. 이름이 머리 줄을 다 채우면 하마는 마지막 글자들 위에 서고, 그 글자는
   * 하마가 흩어질 때 드러난다. 다른 쓰기나 거두기가 끼어들면 Cancelled.
   */
  async function play(letters: HTMLElement[], poses: SpritePixel[][], token: number, place: Place): Promise<void> {
    const stage = openStage(place);
    if (!stage) return;
    const hamaX = stage.standAt(stage.right(letters[letters.length - 1]!));
    const mouth = stage.mouth(hamaX);
    const EMERGE = 6;
    const shots = groupShots(letters, MAX_SHOTS)
      .map((spans, index) => ({ start: EMERGE + index, spans, to: stage.spot(spans[spans.length - 1]!) }));
    const revealed = new Set<HTMLElement>();
    const reveal = (span: HTMLElement): void => {
      if (revealed.has(span)) return;
      revealed.add(span);
      span.classList.add('ag-doc-name-letter-in');
    };
    const landed = EMERGE + shots.length + FLIGHT;
    const end = landed + HOP.length + 5;
    for (let tick = 0; tick <= end; tick++) {
      if (token !== generation) throw new Cancelled();
      let pose = 0;
      let offsetY = 0;
      let shown = 1;
      if (tick < EMERGE - 1) shown = (tick + 1) / (EMERGE - 1);
      else if (tick < EMERGE) pose = 1;
      else if (tick < landed - FLIGHT) pose = (tick - EMERGE) % 3 < 2 ? 2 : 1;
      else if (tick < landed) pose = 0;
      else if (tick < landed + HOP.length) [pose, offsetY] = HOP[tick - landed]!;
      else shown = 1 - (tick - landed - HOP.length + 1) / 5;
      stage.hama(poses, hamaX, pose, offsetY, shown);
      // '/' 는 하마가 처음 비치는 장면과 함께 선다.
      if (tick === 0 && place.separator) place.separator.style.visibility = '';
      for (const shot of shots) {
        const progress = (tick - shot.start) / FLIGHT;
        if (progress >= 1) {
          for (const span of shot.spans) reveal(span);
        } else if (progress >= 0) {
          // 높이 떴다가 글자 위로 떨어진다. 짧게 나는 앞 글자일수록 낮게 뜬다.
          stage.dot(arc(mouth, shot.to, progress, liftBetween(mouth, shot.to)), HAMA_BLUE);
        }
      }
      // 빈칸은 앞 글자와 함께 드러난다.
      letters.forEach((span, index) => {
        if (!revealed.has(span) && span.textContent!.trim() === '' && (index === 0 || revealed.has(letters[index - 1]!))) reveal(span);
      });
      await wait(FRAME_MS, token);
    }
  }

  /**
   * 먹기 — 쓰기의 반대. 하마가 이름 오른쪽 끝에 입을 대고 나타나(머리 줄 안으로 당긴다), 입을 벌렸다 다물 때마다
   * 입 앞의 글자를 문다. 문 글자는 벌린 틱에 파랗게 물들고 다문 틱에 사라지며, 그 자리에서 파란 부스러기
   * 몇 개가 튀어 떨어진다. 물고 나면 두 틱에 걸쳐 남은 이름의 끝까지 왼쪽으로 걷는다 — 벌리고, 물고, 걷고.
   * 이름 다음엔 '/' 를 마지막으로 물고, 입을 다문 채 꿀꺽한 뒤 그 자리에서 폴짝 뛰고 흩어진다.
   * 다른 쓰기나 거두기가 끼어들면 Cancelled.
   */
  async function swallow(letters: HTMLElement[], poses: SpritePixel[][], token: number, place: Place): Promise<void> {
    const stage = openStage(place);
    if (!stage) return;
    /** 나타나는 틱, 한 입의 틱(벌림·물기·걸음). */
    const EMERGE = 3;
    const CHOMP = 3;
    // 입마다 설 자리 — 입이 그 입에 물 글자들의 오른쪽 끝에 닿는다.
    const standFor = (span: HTMLElement): number => stage.standAt(stage.right(span), -BITE_REACH - (CELL_W - 1 - 23) * SCALE);
    // 이름이 줄을 다 채우면 하마는 머리 줄 끝으로 당겨져 마지막 글자들 위에 선다. 그 글자들과 말줄임 뒤에 숨은
    // 글자들은 서는 자리가 같다 — 첫 입에 함께 문다.
    const visible = letters.filter((span) => span.textContent!.trim() !== '').reverse();
    const first = visible.length ? standFor(visible[0]!) : 0;
    let covered = 0;
    while (covered < visible.length - 1 && standFor(visible[covered + 1]!) >= first) covered++;
    const bites = covered ? [visible.slice(0, covered + 1)] : [];
    bites.push(...groupShots(visible.slice(bites.length ? covered + 1 : 0).reverse(), BITES - bites.length)
      .reverse().map((spans) => [...spans].reverse()));
    if (place.separator) bites.push([place.separator]);
    if (!bites.length) return;
    const stands = bites.map((spans) => standFor(spans[0]!));
    const crumbs: Array<{ born: number; from: Point; velocity: readonly [number, number] }> = [];
    const gulp = EMERGE + CHOMP * bites.length - 1;
    const hop = gulp + 1;
    const end = hop + HOP.length + 3;
    let hamaX = stands[0]!;
    for (let tick = 0; tick <= end; tick++) {
      if (token !== generation) throw new Cancelled();
      let pose = 0;
      let offsetY = 0;
      let shown = 1;
      if (tick < EMERGE) {
        shown = (tick + 1) / EMERGE;
      } else if (tick < gulp) {
        const bite = Math.floor((tick - EMERGE) / CHOMP);
        const phase = (tick - EMERGE) % CHOMP;
        const spans = bites[bite]!;
        if (phase === 0) {
          // 벌린다 — 앞 입에서 반쯤 걸어온 나머지를 마저 걷고, 물 글자가 파랗게 물든다.
          pose = 2;
          hamaX = stands[bite]!;
          for (const span of spans) span.classList.add('ag-doc-name-letter-out');
        } else if (phase === 1) {
          // 문다 — 글자가 사라지고 입 앞에서 부스러기가 튄다.
          pose = 0;
          for (const span of spans) span.style.visibility = 'hidden';
          // 첫 입에 말줄임 뒤 글자까지 사라지면 '…' 도 걷는다.
          if (bite === 0) current!.target.classList.add('ag-doc-name-inhaling');
          // 부스러기는 주둥이 끝 바로 앞에서 튄다 — 몸과 같은 파랑이라 몸 위에서는 보이지 않는다.
          const from = { x: hamaX - SCALE, y: stage.mouth(hamaX).y };
          const count = 3 + (bite % 2);
          for (let k = 0; k < count; k++) crumbs.push({ born: tick, from, velocity: CRUMBS[(bite + k) % CRUMBS.length]! });
        } else {
          // 걷는다 — 다음 입 자리까지 반.
          pose = 4;
          const next = stands[bite + 1] ?? hamaX;
          hamaX = Math.round((hamaX + next) / 2);
        }
      } else if (tick < hop) {
        pose = 3; // 다문 입으로 꿀꺽.
      } else if (tick < hop + HOP.length) {
        [pose, offsetY] = HOP[tick - hop]!;
      } else {
        shown = 1 - (tick - hop - HOP.length + 1) / 3;
      }
      stage.hama(poses, hamaX, pose, offsetY, shown);
      for (const crumb of crumbs) {
        const age = tick - crumb.born;
        if (age >= CRUMB_ALPHA.length) continue;
        // 무는 틱에 벌써 한 걸음 튀어 있다. 틱마다 한 칸씩 더 떨어진다.
        const [vx, vy] = crumb.velocity;
        const t = age + 1;
        const at = { x: crumb.from.x + vx * t * SCALE, y: crumb.from.y + (vy * t + (t * (t - 1)) / 2) * SCALE };
        stage.dot(at, HAMA_BLUE, CRUMB_ALPHA[age]);
      }
      await wait(FRAME_MS, token);
    }
  }

  return {
    get target() { return current?.target ?? null; },
    async write(target, place) {
      const token = ++generation;
      settle();
      const text = target.textContent ?? '';
      if (!text || reducedMotion()) return;
      // 글자를 숨긴 채 제자리에 세운다 — 스프라이트를 읽는 동안에도 이름과 '/' 는 비치지 않는다.
      const letters = letterSpans(text, 'ag-doc-name-letter');
      current = { target, text, ...(place.separator ? { separator: place.separator } : {}) };
      target.replaceChildren(...letters);
      if (place.separator) place.separator.style.visibility = 'hidden';
      try {
        const poses = await loadPoses();
        if (token !== generation) return;
        if (poses) await play(letters, poses, token, place);
      } catch (error) {
        if (!(error instanceof Cancelled)) {
          if (token === generation) settle();
          throw error;
        }
        return;
      }
      if (token === generation) settle();
    },
    async inhale(target, place) {
      const token = ++generation;
      settle();
      const text = target.textContent ?? '';
      if (!text || reducedMotion()) {
        empty(target, place.separator);
        return true;
      }
      // 글자는 그대로 보이게 나눠 둔다 — 하마가 하나씩 숨긴다.
      const letters = letterSpans(text, '');
      current = { target, text, ...(place.separator ? { separator: place.separator } : {}) };
      target.replaceChildren(...letters);
      try {
        const poses = await loadPoses();
        if (token !== generation) return false;
        if (poses) await swallow(letters, poses, token, place);
      } catch (error) {
        if (!(error instanceof Cancelled)) {
          if (token === generation) settle();
          throw error;
        }
        return false;
      }
      if (token !== generation) return false;
      empty(target, place.separator);
      return true;
    },
    cancel() {
      generation++;
      settle();
    },
  };
}
