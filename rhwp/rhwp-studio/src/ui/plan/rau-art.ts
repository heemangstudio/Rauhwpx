// Rau 칸의 한글 자모 그림. 칸에 보이는 글자만 골라 캔버스에 그리고, 대각선으로 지나가는 물결 안의 글자가 깜빡인다.
// 글자 모양은 한 번만 그려 두고 복사하며(1초에 12번), 칸이 안 보이거나 창이 숨겨지면 멈춘다. 동작 줄이기면 한 장만 그린다.
import art from '../account/login-neurons.txt?raw';

const FONT_SIZE = 6;
const FONT_FAMILY = "'Nanum Gothic Coding', monospace";
const FRAME_MS = 1000 / 12;
const TILT = (-12 * Math.PI) / 180;
/** 그림의 오른쪽 위 모서리를 칸 기준으로 놓는 자리(CSS 픽셀). */
const OFFSET_RIGHT = 262;
const OFFSET_TOP = -56;
const REST_ALPHA = 0.1;
const PEAK_ALPHA = 0.62;
const WAVE_LENGTH = 34;
const WAVE_SECONDS = 1.1;

export interface RauArt {
  element: HTMLCanvasElement;
  dispose(): void;
}

interface Glyph {
  sx: number;
  sw: number;
  x: number;
  y: number;
  fade: number;
  along: number;
  seed: number;
}

/** 그림 위아래를 흐리게 하는 값(0~1). 22~48% 는 그대로 보인다. */
function fadeAt(share: number): number {
  if (share <= 0.22) return Math.max(0, share / 0.22);
  if (share <= 0.48) return 1;
  return Math.max(0, 1 - (share - 0.48) / 0.28);
}

/** 글자·시각 조각마다 정해지는 0~1 값. Math.random 보다 빠르고 같은 시각에는 같은 값이 나온다. */
function flicker(seed: number, step: number): number {
  let value = Math.imul(seed ^ step, 0x5bd1e995);
  value ^= value >>> 15;
  return (Math.imul(value, 0x2f7f3a21) >>> 24) / 255;
}

/** Rau 오른쪽의 자모 신경망이 낮은 프레임으로 뻗고, 제자리에서 흩어져 사라진다. */
export function stretchRauArt(host: HTMLElement, origin: HTMLElement): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) return () => {};
  const width = host.clientWidth;
  const height = host.clientHeight;
  const canvas = document.createElement('canvas');
  canvas.className = 'ag-pricing-stretch';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  if (!context || !width || !height) return () => {};
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  // 갤러리처럼 조상이 확대·축소되어도 뿌리가 Rau 칸의 가장자리에 붙는다.
  const hostBox = host.getBoundingClientRect();
  const originBox = origin.getBoundingClientRect();
  const scaleX = host.offsetWidth / hostBox.width;
  const scaleY = host.offsetHeight / hostBox.height;
  const blockLeft = (originBox.left - hostBox.left) * scaleX - host.clientLeft;
  const blockTop = (originBox.top - hostBox.top) * scaleY - host.clientTop;
  const blockWidth = originBox.width * scaleX;
  const blockHeight = originBox.height * scaleY;
  const centerX = blockLeft + blockWidth * 0.82;
  const centerY = blockTop + blockHeight * 0.5;

  const size = 6;
  const cell = size * 2 * scale;
  const chars = [...new Set(art.replace(/\s/g, ''))];
  const styles = getComputedStyle(origin);
  const sheet = (fill: string): HTMLCanvasElement => {
    const atlas = document.createElement('canvas');
    atlas.width = chars.length * cell;
    atlas.height = cell;
    const paint = atlas.getContext('2d')!;
    paint.font = `${size * scale}px ${FONT_FAMILY}`;
    paint.textBaseline = 'top';
    paint.fillStyle = fill;
    chars.forEach((char, index) => paint.fillText(char, index * cell, 0));
    return atlas;
  };
  const dim = sheet(styles.getPropertyValue('--plan-rau').trim());
  const hot = sheet(styles.getPropertyValue('--plan-rau-hot').trim());

  // 끝점까지 휘어진 줄기. 곁가지는 줄기의 중간에서 같은 방향으로 갈라진다.
  const vines: Array<{ x: number; y: number; dx: number; dy: number; bend: number; lag: number; parent?: number; fork?: number }> = [];
  const point = (vine: typeof vines[number], t: number): [number, number] => {
    const length = Math.hypot(vine.dx, vine.dy);
    const curl = Math.sin(t * Math.PI) * vine.bend
      + Math.sin(t * Math.PI * 2) * vine.bend * 0.28;
    return [vine.x + vine.dx * t - vine.dy / length * curl,
      vine.y + vine.dy * t + vine.dx / length * curl];
  };
  for (let index = 0; index < 9; index++) {
    const angle = index / 9 * Math.PI * 2;
    const reach = 0.72 + flicker(index + 1, 11) * 0.28;
    const vine = {
      x: centerX + Math.sin(index * 7) * 8,
      y: centerY + Math.cos(index * 5) * 10,
      dx: Math.cos(angle) * blockWidth * (Math.cos(angle) < 0 ? 1.15 : 0.68) * reach,
      dy: Math.sin(angle) * blockHeight * 0.64 * reach,
      bend: (index % 2 ? -1 : 1) * (12 + flicker(index + 1, 3) * 18),
      lag: (index % 4) * 40,
    };
    const parent = vines.length;
    vines.push(vine);
    for (const fork of [0.38, 0.65]) {
      const [x, y] = point(vine, fork);
      const reach = (1 - fork) * 0.8;
      const side = (fork < 0.5 ? -1 : 1) * 0.35;
      const branch = { x, y, dx: vine.dx * reach - vine.dy * side,
        dy: vine.dy * reach + vine.dx * side, bend: -vine.bend * 0.7,
        lag: vine.lag + fork * 360, parent, fork };
      const branchIndex = vines.length;
      vines.push(branch);
      const [tx, ty] = point(branch, 0.55);
      vines.push({ x: tx, y: ty, dx: branch.dx * 0.35 + branch.dy * 0.25,
        dy: branch.dy * 0.35 - branch.dx * 0.25, bend: vine.bend * 0.25,
        lag: branch.lag + 110, parent: branchIndex, fork: 0.55 });
    }
  }

  host.append(canvas);
  const started = performance.now();
  let frame = 0;
  let lastDraw = -Infinity;
  const stop = (): void => {
    cancelAnimationFrame(frame);
    canvas.remove();
    reduced.removeEventListener('change', stop);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
  };
  reduced.addEventListener('change', stop);
  document.addEventListener('visibilitychange', onVisibility);
  const draw = (now: number): void => {
    const elapsed = now - started;
    if (elapsed >= 1600 || !host.isConnected || !origin.isConnected) {
      stop();
      return;
    }
    frame = requestAnimationFrame(draw);
    if (now - lastDraw < 100) return;
    lastDraw = now;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.roundRect(blockLeft, blockTop, blockWidth, blockHeight,
      Number.parseFloat(styles.borderTopLeftRadius) || 0);
    context.clip();
    const fade = Math.min(1, elapsed / 100) * Math.min(1, (1600 - elapsed) / 550);
    const growths: number[] = [];
    vines.forEach((vine, index) => {
      const age = Math.max(0, elapsed - vine.lag);
      // 길이는 거두지 않는다. 10단계씩 끊어 뻗고 글자만 사라진다.
      let growth = Math.min(1, Math.floor((1 - Math.exp(-age / 180)) * 11) / 10);
      if (vine.parent !== undefined) {
        growth = Math.min(growth, Math.max(0, (growths[vine.parent]! - vine.fork!) / (1 - vine.fork!)));
      }
      growths.push(growth);
      const length = Math.hypot(vine.dx, vine.dy) + Math.abs(vine.bend);
      const count = Math.ceil(length / 5);
      for (let step = 0; step < count; step++) {
        const t = step / count;
        if (t >= growth) break;
        const [x, y] = point(vine, t);
        const edgeFade = Math.max(0, Math.min(1, (x - blockLeft + blockWidth * 0.35) / (blockWidth * 0.3)));
        if (!edgeFade) continue;
        const tip = Math.max(0, 1 - (growth - t) / 0.15);
        const seed = Math.imul(index * 137 + step + 1, 0x9e3779b1);
        if (elapsed > 1050 + flicker(seed, 19) * 550) continue;
        const breadth = vine.parent !== undefined ? 0 : (1 - t) * 4;
        for (let strand = -1; strand <= 1; strand++) {
          if (strand && (vine.parent !== undefined || t > 0.78)) continue;
          context.globalAlpha = fade * edgeFade * (strand ? 0.12 : 0.32 + tip * 0.24)
            * (0.75 + 0.25 * flicker(seed, Math.floor(now / 90)));
          const slot = (seed >>> 0) % chars.length;
          const kink = Math.sin(step * 1.7 + index) * 1.8;
          context.drawImage(tip > 0.4 ? hot : dim, slot * cell, 0, cell, cell,
            x - size / 2, y - size / 2 + strand * breadth + kink, size * 2, size * 2);
        }
      }
    });
    context.restore();
  };
  frame = requestAnimationFrame(draw);
  return stop;
}

export function createRauArt(): RauArt {
  const canvas = document.createElement('canvas');
  canvas.className = 'ag-pricing-art';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let atlas: HTMLCanvasElement | null = null;
  let glyphs: Glyph[] = [];
  let scale = 1;
  let onScreen = false;
  let frame = 0;
  let lastDraw = 0;
  let disposed = false;

  function build(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!context || !width || !height) return;
    scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const font = `${FONT_SIZE * scale}px ${FONT_FAMILY}`;
    context.font = font;
    const measured = new Map<string, number>();
    const widthOf = (char: string): number => {
      let value = measured.get(char);
      if (value === undefined) measured.set(char, value = context.measureText(char).width / scale);
      return value;
    };
    const lines = art.split('\n');
    const artWidth = Math.max(...lines.map((line) => [...line].reduce((sum, char) => sum + widthOf(char), 0)));
    const artHeight = lines.length * FONT_SIZE;
    const centerX = width + OFFSET_RIGHT - artWidth / 2;
    const centerY = OFFSET_TOP + artHeight / 2;
    const cos = Math.cos(TILT);
    const sin = Math.sin(TILT);

    // 칸 안에 들어오는 글자만 남긴다. 위치는 기울인 뒤의 자리다.
    const cell = FONT_SIZE * 2 * scale;
    const slots = new Map<string, number>();
    glyphs = [];
    lines.forEach((line, row) => {
      const fade = fadeAt(row / lines.length);
      let left = 0;
      for (const char of line) {
        const advance = widthOf(char);
        if (char.trim() && fade > 0) {
          const dx = left - artWidth / 2;
          const dy = row * FONT_SIZE - artHeight / 2;
          const x = centerX + dx * cos - dy * sin;
          const y = centerY + dx * sin + dy * cos;
          if (x > -FONT_SIZE && x < width + FONT_SIZE && y > -FONT_SIZE && y < height + FONT_SIZE) {
            if (!slots.has(char)) slots.set(char, slots.size);
            glyphs.push({
              sx: slots.get(char)! * cell,
              sw: cell,
              x,
              y,
              fade,
              along: (x + y) * Math.SQRT1_2,
              seed: Math.imul(glyphs.length + 1, 0x9e3779b1),
            });
          }
        }
        left += advance;
      }
    });

    atlas = document.createElement('canvas');
    atlas.width = Math.max(1, slots.size * cell);
    atlas.height = cell;
    const sheet = atlas.getContext('2d');
    if (sheet) {
      sheet.font = font;
      sheet.textBaseline = 'top';
      sheet.fillStyle = getComputedStyle(canvas).color;
      for (const [char, slot] of slots) sheet.fillText(char, slot * cell, 0);
    }
    paint(reduced.matches ? 0 : performance.now());
  }

  function paint(now: number): void {
    if (!context || !atlas) return;
    const seconds = now / 1000;
    const step = Math.floor(now / FRAME_MS);
    const still = reduced.matches;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const size = FONT_SIZE * 2;
    for (const glyph of glyphs) {
      let level = 0.42;
      if (!still) {
        // 물결 둘이 겹쳐 지나간다. 마루가 좁아야 한 줄기씩 보인다.
        const near = 0.5 + 0.5 * Math.sin(glyph.along / WAVE_LENGTH - seconds / WAVE_SECONDS);
        const far = 0.5 + 0.5 * Math.sin(glyph.along / (WAVE_LENGTH * 2.3) + seconds / (WAVE_SECONDS * 2.7));
        const crest = Math.max(near * near * near * near, far * far * far * far * far * far * 0.7);
        level = crest * (0.3 + 0.7 * flicker(glyph.seed, step));
      }
      const alpha = (REST_ALPHA + level * (PEAK_ALPHA - REST_ALPHA)) * glyph.fade;
      if (alpha < 0.02) continue;
      context.globalAlpha = alpha;
      context.drawImage(atlas, glyph.sx, 0, glyph.sw, glyph.sw, glyph.x, glyph.y, size, size);
    }
    context.globalAlpha = 1;
  }

  function tick(now: number): void {
    frame = 0;
    if (!running()) return;
    if (now - lastDraw >= FRAME_MS) {
      lastDraw = now;
      paint(now);
    }
    frame = requestAnimationFrame(tick);
  }

  function running(): boolean {
    return !disposed && onScreen && !reduced.matches && document.visibilityState === 'visible';
  }

  function sync(): void {
    if (running()) {
      if (!frame) frame = requestAnimationFrame(tick);
    } else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  function onMotionChange(): void {
    paint(performance.now());
    sync();
  }

  const resize = new ResizeObserver(build);
  resize.observe(canvas);
  const visible = new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? false;
    sync();
  });
  visible.observe(canvas);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', onMotionChange);
  // 글꼴이 늦게 오면 글자 폭과 모양이 달라지므로 다시 고른다.
  void document.fonts?.load(`${FONT_SIZE}px 'Nanum Gothic Coding'`, 'ㅊ').then(() => {
    if (!disposed) build();
  }).catch(() => {});

  return {
    element: canvas,
    dispose(): void {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resize.disconnect();
      visible.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', onMotionChange);
    },
  };
}
