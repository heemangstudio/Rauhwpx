/**
 * 문서 칩 — 문서 없이 시작해 문서를 이은 채팅의 머리에 그 문서를 보인다. 모양은 document-chip.css.
 *
 * 이을 때 채팅이 보이면 하마가 픽셀로 문서를 지어 칩을 세운다: 하마가 픽셀로 나타나 입을 벌리고,
 * 입에서 튄 픽셀이 포물선을 그리며 10×12 문서 그림을 아래부터 쌓는다. 하마는 폴짝 뛰고 흩어진 뒤
 * 칩 이름이 한 글자씩 찍힌다. 하마는 public/images/boot/hama-sprites.png 의 26×20 칸 여섯
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
const CANVAS_W = 112;
const CANVAS_H = 44;
/** 하마 픽셀 파랑과 같은 색 — 문서의 줄과 날아가는 픽셀. */
const HAMA_BLUE = 'rgb(98, 179, 226)';
/** 10×12 문서. # 는 테두리(글자색), l 은 줄(파랑). 접힌 귀퉁이가 오른쪽 위에 있다. */
const DOCUMENT_GLYPH = [
  '#######...',
  '#.....##..',
  '#.....#.#.',
  '#.....####',
  '#........#',
  '#.lllll..#',
  '#........#',
  '#.llllll.#',
  '#........#',
  '#.llll...#',
  '#........#',
  '##########',
];
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
    root.classList.remove('ag-doc-chip-building');
  }

  function settle(name: string): void {
    clearCanvas();
    setName(name);
    chip.hidden = false;
    root.hidden = false;
  }

  /** 하마가 문서를 짓는다. 다른 짓기나 숨기기가 끼어들면 Cancelled. */
  async function playBuild(poses: SpritePixel[][], token: number): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    const fx = document.createElement('canvas');
    fx.className = 'ag-doc-chip-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.width = CANVAS_W * dpr;
    fx.height = CANVAS_H * dpr;
    fx.style.width = `${CANVAS_W}px`;
    fx.style.height = `${CANVAS_H}px`;
    const context = fx.getContext('2d');
    if (!context) return;
    canvas = fx;
    root.classList.add('ag-doc-chip-building');
    root.append(fx);
    context.scale(dpr, dpr);
    const ink = getComputedStyle(root).color || 'rgb(23, 27, 34)';
    const P = SCALE;
    const hamaX = 0;
    const hamaY = 2;
    const glyphX = 80;
    const glyphY = 10;
    const mouth = { x: hamaX + 23 * P, y: hamaY + 8 * P };
    const targets: Array<{ x: number; y: number; color: string }> = [];
    DOCUMENT_GLYPH.forEach((row, y) => [...row].forEach((cell, x) => {
      if (cell !== '.') targets.push({ x, y, color: cell === '#' ? ink : HAMA_BLUE });
    }));
    // 아래 줄부터 쌓는다.
    targets.sort((a, b) => b.y - a.y || a.x - b.x);
    const EMERGE = 8;
    const PER_TICK = 3;
    const FLIGHT = 5;
    const particles = targets.map((target, index) => ({ target, start: EMERGE + Math.floor(index / PER_TICK) }));
    const landed = EMERGE + Math.ceil(targets.length / PER_TICK) + FLIGHT;
    const end = landed + HOP.length + 6;
    for (let tick = 0; tick <= end; tick++) {
      if (token !== generation) throw new Cancelled();
      let pose = 0;
      let offsetY = 0;
      let shown = 1;
      if (tick < 6) shown = (tick + 1) / 6;
      else if (tick < EMERGE) pose = 1;
      else if (tick < landed) pose = (tick - EMERGE) % 4 < 3 ? 2 : 1;
      else if (tick < landed + HOP.length) [pose, offsetY] = HOP[tick - landed]!;
      else shown = 1 - (tick - landed - HOP.length + 1) / 6;
      context.clearRect(0, 0, CANVAS_W, CANVAS_H);
      for (const pixel of poses[pose] ?? []) {
        if (pixel.rank >= shown) continue;
        context.fillStyle = pixel.color;
        context.fillRect(hamaX + pixel.x * P, hamaY + (pixel.y + offsetY) * P, P, P);
      }
      for (const { target, start } of particles) {
        const progress = (tick - start) / FLIGHT;
        const tx = glyphX + target.x * P;
        const ty = glyphY + target.y * P;
        if (progress >= 1) {
          context.fillStyle = target.color;
          context.fillRect(tx, ty, P, P);
        } else if (progress >= 0) {
          const x = mouth.x + (tx - mouth.x) * progress;
          const y = mouth.y + (ty - mouth.y) * progress - Math.sin(Math.PI * progress) * 12;
          context.fillStyle = HAMA_BLUE;
          context.fillRect(Math.round(x / P) * P, Math.round(y / P) * P, P, P);
        }
      }
      await wait(FRAME_MS, token);
    }
    fx.classList.add('ag-doc-chip-fx-out');
    await wait(160, token);
    clearCanvas();
  }

  async function typeName(name: string, token: number): Promise<void> {
    chip.hidden = false;
    // 긴 이름도 반 초 남짓에 다 찍힌다.
    const step = Math.max(1, Math.ceil(name.length / 20));
    for (let length = step; length < name.length; length += step) {
      label.textContent = name.slice(0, length);
      await wait(28, token);
    }
    setName(name);
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
      clearCanvas();
      chip.hidden = true;
      root.hidden = false;
      try {
        const poses = await loadPoses();
        if (token !== generation) return;
        if (poses) await playBuild(poses, token);
        await typeName(name, token);
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
