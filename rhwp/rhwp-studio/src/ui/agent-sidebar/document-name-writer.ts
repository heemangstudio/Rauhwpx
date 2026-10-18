/**
 * 문서 이름 쓰기 — 문서 없이 시작한 채팅에 문서를 이으면 하마가 머리의 '/ 문서 이름' 을 뱉어 쓴다. 모양은
 * document-name-writer.css.
 *
 * 이름 오른쪽에 하마가 픽셀로 나타나 왼쪽을 보고 입을 벌리면, 입에서 튄 픽셀이 포물선을 그리며 이름의 글자에
 * 하나씩 앉아 그 글자를 드러낸다. 다 쓰면 하마는 폴짝 뛰고 흩어지고, 이름 칸은 보통 글자로 돌아간다.
 * 하마는 public/images/boot/hama-sprites.png 의 26×20 칸 여섯 (closed·talk·open·blink·step·crouch)을
 * 정수배(2)로, 50ms 씩 끊어 그린다. 동작 줄이기면 쓰지 않는다 — 이름은 그대로 보인다.
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
    if (separator) separator.style.visibility = '';
    target.textContent = text;
  }

  /**
   * 하마가 이름 오른쪽에 서서 왼쪽을 보고, 입에서 튄 픽셀이 포물선을 그리며 이름의 글자에 앉는다 —
   * 앉은 자리의 글자가 파랗게 찍혔다가 글자색이 된다. 글자는 처음부터 제자리를 차지하고 숨어 있어서
   * 끝나도 자리가 움직이지 않는다. 다른 쓰기나 거두기가 끼어들면 Cancelled.
   */
  async function play(
    letters: HTMLElement[],
    poses: SpritePixel[][],
    token: number,
    place: { host: HTMLElement; separator?: HTMLElement },
  ): Promise<void> {
    const target = current!.target;
    const dpr = window.devicePixelRatio || 1;
    const P = SCALE;
    const hostBox = place.host.getBoundingClientRect();
    const nameBox = target.getBoundingClientRect();
    const last = letters[letters.length - 1]?.getBoundingClientRect();
    const textRight = Math.min(last ? last.right : nameBox.left, nameBox.right) - hostBox.left;
    const hamaX = Math.ceil(textRight) + HAMA_GAP;
    const hamaY = Math.round((CANVAS_H - CELL_H * P) / 2);
    const width = hamaX + CELL_W * P;
    const top = Math.round(nameBox.top + nameBox.height / 2 - hostBox.top - CANVAS_H / 2);
    const fx = document.createElement('canvas');
    fx.className = 'ag-doc-name-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.width = width * dpr;
    fx.height = CANVAS_H * dpr;
    fx.style.width = `${width}px`;
    fx.style.height = `${CANVAS_H}px`;
    fx.style.top = `${top}px`;
    const context = fx.getContext('2d');
    if (!context) return;
    current!.canvas = fx;
    place.host.append(fx);
    context.scale(dpr, dpr);
    // 하마는 왼쪽을 본다 — 스프라이트를 좌우로 뒤집어 그린다. 입은 뒤집은 그림의 왼쪽 위다.
    const mouth = { x: hamaX + (CELL_W - 1 - 23) * P, y: hamaY + 8 * P };
    const canvasBox = fx.getBoundingClientRect();
    const spot = (span: HTMLElement): { x: number; y: number } => {
      const box = span.getBoundingClientRect();
      // 말줄임으로 가려진 글자는 보이는 끝으로 날아간다.
      const x = Math.min(box.left + box.width / 2, nameBox.right - P) - canvasBox.left;
      return { x: Math.round(x / P) * P, y: Math.round((box.top + box.height / 2 - canvasBox.top) / P) * P };
    };
    // 빈칸은 뱉지 않는다. 긴 이름은 한 번에 여러 글자를 뱉어 발사 횟수를 묶는다.
    const visible = letters.filter((span) => span.textContent!.trim() !== '');
    const perShot = Math.max(1, Math.ceil(visible.length / MAX_SHOTS));
    const EMERGE = 6;
    const shots: Array<{ start: number; spans: HTMLElement[]; to: { x: number; y: number } }> = [];
    for (let index = 0; index < visible.length; index += perShot) {
      const spans = visible.slice(index, index + perShot);
      shots.push({ start: EMERGE + shots.length, spans, to: spot(spans[spans.length - 1]!) });
    }
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
      context.clearRect(0, 0, width, CANVAS_H);
      for (const pixel of poses[pose] ?? []) {
        if (pixel.rank >= shown) continue;
        context.fillStyle = pixel.color;
        context.fillRect(hamaX + (CELL_W - 1 - pixel.x) * P, hamaY + (pixel.y + offsetY) * P, P, P);
      }
      // '/' 는 하마가 처음 비치는 장면과 함께 선다.
      if (tick === 0 && place.separator) place.separator.style.visibility = '';
      context.fillStyle = HAMA_BLUE;
      for (const shot of shots) {
        const progress = (tick - shot.start) / FLIGHT;
        if (progress >= 1) {
          for (const span of shot.spans) reveal(span);
        } else if (progress >= 0) {
          // 높이 떴다가 글자 위로 떨어진다. 짧게 나는 앞 글자일수록 낮게 뜬다.
          const lift = 6 + Math.min(10, Math.abs(mouth.x - shot.to.x) / 12);
          const x = mouth.x + (shot.to.x - mouth.x) * progress;
          const y = mouth.y + (shot.to.y - mouth.y) * progress - Math.sin(Math.PI * progress) * lift;
          context.fillRect(Math.round(x / P) * P, Math.round(y / P) * P, P, P);
        }
      }
      // 빈칸은 앞 글자와 함께 드러난다.
      letters.forEach((span, index) => {
        if (!revealed.has(span) && span.textContent!.trim() === '' && (index === 0 || revealed.has(letters[index - 1]!))) reveal(span);
      });
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
      const graphemes = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
        : Array.from(text);
      const letters = graphemes.map((letter) => {
        const span = document.createElement('span');
        span.className = 'ag-doc-name-letter';
        span.textContent = letter;
        return span;
      });
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
    cancel() {
      generation++;
      settle();
    },
  };
}
