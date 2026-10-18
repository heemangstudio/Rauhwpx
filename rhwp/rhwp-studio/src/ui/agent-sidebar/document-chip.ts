/**
 * 문서 칩 — 문서 없이 시작해 문서를 이은 채팅의 머리에 그 문서를 보인다. 모양은 document-chip.css.
 *
 * 이을 때 채팅이 보이면 하마가 칩 이름을 뱉어 쓴다: 칩 오른쪽에 하마가 픽셀로 나타나 왼쪽을 보고 입을 벌리면,
 * 입에서 튄 픽셀이 포물선을 그리며 이름의 글자에 하나씩 앉아 그 글자를 드러낸다. 다 쓰면 하마는 폴짝 뛰고
 * 흩어진다. 하마는 public/images/boot/hama-sprites.png 의 26×20 칸 여섯
 * (closed·talk·open·blink·step·crouch)을 정수배(2)로, 50ms 씩 끊어 그린다. 동작 줄이기면 칩만 바로 선다.
 */
import { createIcon } from './icons.ts';
import './document-chip.css';

export interface DocumentChip {
  /** 머리 줄에 넣는 자리. 칩과, 짓는 동안의 캔버스가 이 안에 선다. */
  readonly root: HTMLElement;
  /** 지금 보이는 (또는 짓고 있는) 문서 이름. 숨었으면 null. */
  readonly name: string | null;
  /** 칩을 보인다. build 면 하마가 짓는다 — 끝나면 풀린다. 같은 이름이면 다시 짓지 않는다. */
  show(name: string, options?: { build?: boolean }): Promise<void>;
  hide(): void;
}

export interface DocumentChipOptions {
  /** 누르면 부른다. 없으면 칩은 누를 수 없는 표시다. */
  onActivate?: () => void;
  /** 누를 수 있는 칩의 설명 (aria-label 앞부분). */
  actionLabel?: string;
}

const CELL_W = 26;
const CELL_H = 20;
const POSE_COUNT = 6;
const SCALE = 2;
const FRAME_MS = 50;
const CANVAS_H = 44;
/** 하마와 칩 사이 틈. */
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

/** 스프라이트를 한 번 읽어 자세별 픽셀로 나눈다. 읽지 못하면 null — 칩은 짓지 않고 바로 선다. */
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

export function createDocumentChip(options: DocumentChipOptions = {}): DocumentChip {
  const root = document.createElement('span');
  root.className = 'ag-doc-chip-slot';
  root.hidden = true;
  const chip = document.createElement(options.onActivate ? 'button' : 'span');
  chip.className = 'ag-doc-chip';
  if (chip instanceof HTMLButtonElement) {
    chip.type = 'button';
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onActivate?.();
    });
  }
  const label = document.createElement('span');
  label.className = 'ag-doc-chip-name';
  chip.append(createIcon('document'), label);
  root.append(chip);

  let shownName: string | null = null;
  /** 앞선 짓기를 거두는 표. 늘 때마다 돌던 짓기는 다음 장면에서 멈춘다. */
  let generation = 0;
  let canvas: HTMLCanvasElement | null = null;

  const wait = (ms: number, token: number): Promise<void> => new Promise((resolve, reject) => {
    window.setTimeout(() => (token === generation ? resolve() : reject(new Cancelled())), ms);
  });

  function setName(name: string): void {
    label.textContent = name;
    chip.title = name;
    if (options.onActivate) chip.setAttribute('aria-label', `${options.actionLabel ?? '문서'} · ${name}`);
  }

  function clearCanvas(): void {
    canvas?.remove();
    canvas = null;
  }

  function settle(name: string): void {
    clearCanvas();
    setName(name);
    chip.hidden = false;
    root.hidden = false;
  }

  /**
   * 하마가 칩 오른쪽에 서서 왼쪽을 보고, 입에서 튄 픽셀이 포물선을 그리며 칩 이름의 글자에 앉는다 —
   * 앉은 자리의 글자가 파랗게 찍혔다가 글자색이 된다. 칩은 처음부터 제 폭으로 서고 글자만 숨어 있어서
   * 끝나도 자리가 움직이지 않는다. 다른 짓기나 숨기기가 끼어들면 Cancelled.
   */
  async function playBuild(name: string, poses: SpritePixel[][], token: number): Promise<void> {
    const graphemes = typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].map((part) => part.segment)
      : Array.from(name);
    const letters = graphemes.map((text) => {
      const span = document.createElement('span');
      span.className = 'ag-doc-chip-letter';
      span.textContent = text;
      return span;
    });
    label.replaceChildren(...letters);
    chip.hidden = false;
    const dpr = window.devicePixelRatio || 1;
    const chipBox = chip.getBoundingClientRect();
    const P = SCALE;
    const hamaX = Math.ceil(chipBox.width) + HAMA_GAP;
    const hamaY = Math.round((CANVAS_H - CELL_H * P) / 2);
    const width = hamaX + CELL_W * P;
    const fx = document.createElement('canvas');
    fx.className = 'ag-doc-chip-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.width = width * dpr;
    fx.height = CANVAS_H * dpr;
    fx.style.width = `${width}px`;
    fx.style.height = `${CANVAS_H}px`;
    const context = fx.getContext('2d');
    if (!context) return;
    canvas = fx;
    root.append(fx);
    context.scale(dpr, dpr);
    // 하마는 왼쪽을 본다 — 스프라이트를 좌우로 뒤집어 그린다. 입은 뒤집은 그림의 왼쪽 위다.
    const mouth = { x: hamaX + (CELL_W - 1 - 23) * P, y: hamaY + 8 * P };
    const canvasBox = fx.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const target = (span: HTMLElement): { x: number; y: number } => {
      const box = span.getBoundingClientRect();
      // 말줄임으로 가려진 글자는 보이는 끝으로 날아간다.
      const x = Math.min(box.left + box.width / 2, labelBox.right - P) - canvasBox.left;
      return { x: Math.round(x / P) * P, y: Math.round((box.top + box.height / 2 - canvasBox.top) / P) * P };
    };
    // 빈칸은 뱉지 않는다. 긴 이름은 한 번에 여러 글자를 뱉어 발사 횟수를 묶는다.
    const visible = letters.filter((span) => span.textContent!.trim() !== '');
    const perShot = Math.max(1, Math.ceil(visible.length / MAX_SHOTS));
    const EMERGE = 6;
    const shots: Array<{ start: number; spans: HTMLElement[]; to: { x: number; y: number } }> = [];
    for (let index = 0; index < visible.length; index += perShot) {
      const spans = visible.slice(index, index + perShot);
      shots.push({ start: EMERGE + shots.length, spans, to: target(spans[spans.length - 1]!) });
    }
    const revealed = new Set<HTMLElement>();
    const reveal = (span: HTMLElement): void => {
      if (revealed.has(span)) return;
      revealed.add(span);
      span.classList.add('ag-doc-chip-letter-in');
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
    clearCanvas();
  }

  return {
    root,
    get name() { return shownName; },
    async show(name, showOptions = {}) {
      if (shownName === name) return;
      const token = ++generation;
      shownName = name;
      const animate = showOptions.build === true && !reducedMotion();
      if (!animate) {
        settle(name);
        return;
      }
      // 칩은 하마가 서는 장면과 같은 프레임에 선다 — 스프라이트를 읽는 동안에는 칩도 이름도 보이지 않는다.
      clearCanvas();
      chip.hidden = true;
      root.hidden = false;
      try {
        const poses = await loadPoses();
        if (token !== generation) return;
        if (poses) await playBuild(name, poses, token);
        if (token === generation) settle(name);
      } catch (error) {
        if (!(error instanceof Cancelled)) {
          if (token === generation) settle(name);
          throw error;
        }
      }
    },
    hide() {
      generation++;
      shownName = null;
      clearCanvas();
      root.hidden = true;
    },
  };
}
