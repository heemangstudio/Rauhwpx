/**
 * 일별 처리 토큰 차트 — 연필로 그린 듯한 선과 빗금. 흔들림은 씨앗으로 정해져 다시 그려도 같은 모양이다.
 * 의존성 없이 SVG 경로만 만든다. 순수 함수는 테스트가 직접 들여온다.
 */
import type { TokenUsageAgent, TokenUsageReport } from '../../agent/types.ts';
import { formatCompact, formatDayLabel, niceTicks } from './token-usage-format.ts';

export type Point = readonly [number, number];

/** mulberry32 — 같은 씨앗이면 같은 수열. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a — 이름에서 씨앗을 만든다. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 단조 3차 보간(Fritsch–Carlson)으로 점 사이를 step px 간격으로 채운다.
 * 구간마다 양 끝 값 사이에 머물러 0 아래로 내려가거나 봉우리를 넘지 않는다.
 */
export function monotoneSamples(points: readonly Point[], step = 4): Point[] {
  const n = points.length;
  if (n < 2) return points.map(([x, y]) => [x, y] as const);
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1]![0] - points[i]![0];
    slopes.push(dx === 0 ? 0 : (points[i + 1]![1] - points[i]![1]) / dx);
  }
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === n - 1) return slopes[n - 2]!;
    const a = slopes[i - 1]!;
    const b = slopes[i]!;
    return a * b <= 0 ? 0 : (a + b) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    const d = slopes[i]!;
    if (d === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i]! / d;
    const beta = tangents[i + 1]! / d;
    const sum = alpha * alpha + beta * beta;
    if (sum > 9) {
      const tau = 3 / Math.sqrt(sum);
      tangents[i] = tau * alpha * d;
      tangents[i + 1] = tau * beta * d;
    }
  }
  const out: Point[] = [[points[0]![0], points[0]![1]]];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = x1 - x0;
    const count = Math.max(1, Math.ceil(Math.abs(h) / step));
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      const t2 = t * t;
      const t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * tangents[i]!
        + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * tangents[i + 1]!;
      out.push([x0 + h * t, y]);
    }
  }
  return out;
}

/** 선을 따라 천천히 바뀌는 법선 방향 흔들림. wavelength px 마다 새 값, 그 사이는 코사인 보간. */
export function wobble(points: readonly Point[], seed: number, amplitude: number, wavelength = 40): Point[] {
  if (points.length < 2 || amplitude === 0) return points.map(([x, y]) => [x, y] as const);
  const random = seededRandom(seed);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  }
  const knots = Array.from({ length: Math.ceil(lengths[lengths.length - 1]! / wavelength) + 2 }, () => random() * 2 - 1);
  return points.map(([x, y], i) => {
    const before = points[Math.max(0, i - 1)]!;
    const after = points[Math.min(points.length - 1, i + 1)]!;
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    const position = lengths[i]! / wavelength;
    const k = Math.floor(position);
    const mix = (1 - Math.cos((position - k) * Math.PI)) / 2;
    const offset = (knots[k]! * (1 - mix) + knots[k + 1]! * mix) * amplitude;
    return [x - (dy / length) * offset, y + (dx / length) * offset] as const;
  });
}

const round = (value: number) => Math.round(value * 10) / 10;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function pathData(points: readonly Point[]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${round(x)} ${round(y)}`).join('');
}

/** 같은 선을 두 번 — 굵은 첫 획과 살짝 어긋난 가는 둘째 획. */
export function roughStrokes(points: readonly Point[], seed: number, amplitude = 1.2): [string, string] {
  return [
    pathData(wobble(points, seed, amplitude, 46)),
    pathData(wobble(points, seed + 7919, amplitude * 1.6, 26)),
  ];
}

/** 손으로 그은 직선: 끝이 조금 넘치거나 모자라고 가운데가 휜다. */
export function roughSegment(from: Point, to: Point, seed: number, amplitude = 0.7): Point[] {
  const random = seededRandom(seed);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const start = (random() - 0.4) * 3;
  const end = (random() - 0.4) * 3;
  const a: Point = [from[0] - ux * start, from[1] - uy * start];
  const b: Point = [to[0] + ux * end, to[1] + uy * end];
  const count = Math.max(2, Math.ceil(length / 8));
  const points: Point[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return wobble(points, seed + 1, amplitude, 60);
}

export const AGENT_NAME: Record<TokenUsageAgent, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
/** 빗금 각도: 겹치는 곳은 엇갈린 빗금이 된다. */
const HATCH: Record<TokenUsageAgent, { angle: number; gap: number }> = {
  claude: { angle: 56, gap: 6.5 },
  codex: { angle: 124, gap: 6.5 },
  pi: { angle: 80, gap: 5 },
};

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

let chartCount = 0;

export function createTokenUsageChart() {
  const id = `ag-token-chart-${++chartCount}`;
  const element = html('figure', 'ag-token-chart');
  const caption = html('figcaption', 'ag-token-chart-title', '일별 처리 토큰');
  const plot = html('div', 'ag-token-chart-plot');
  const readout = html('div', 'ag-token-chart-readout');
  readout.hidden = true;
  element.append(caption, plot);
  let report: TokenUsageReport | null = null;
  let agents: TokenUsageAgent[] = [];
  let width = 0;
  let enter = false;
  let focusIndex: number | null = null;
  let layout: { x: (i: number) => number; y: (v: number) => number; top: number; base: number; left: number; right: number } | null = null;
  let svgRoot: SVGSVGElement | null = null;
  let hoverLayer: SVGGElement | null = null;

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      const next = Math.round(plot.clientWidth);
      if (next && next !== width) draw();
    })
    : null;
  observer?.observe(plot);

  function draw() {
    width = Math.round(plot.clientWidth);
    if (!report || !width) return;
    const days = report.daily;
    const n = days.length;
    const height = width < 420 ? 150 : 184;
    const max = Math.max(0, ...days.flatMap((day) => agents.map((agent) => day[agent])));
    const ticks = niceTicks(max, 3);
    const top = 8;
    const base = height - 26;
    const left = 10 + Math.max(...ticks.map((tick) => formatCompact(tick).length)) * 6.8;
    const right = width - 6;
    const x = (i: number) => (n > 1 ? left + (i / (n - 1)) * (right - left) : (left + right) / 2);
    const y = (v: number) => base - (v / ticks[ticks.length - 1]!) * (base - top);
    layout = { x, y, top, base, left, right };

    const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: enter ? 'ag-token-chart-svg ag-token-chart-enter' : 'ag-token-chart-svg' });
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', `일별 처리 토큰, ${formatDayLabel(days[0]?.date ?? '')}부터 ${formatDayLabel(days[n - 1]?.date ?? '')}까지`);
    enter = false;
    const defs = svg('defs');
    root.append(defs);

    const grid = svg('g', { class: 'ag-token-chart-grid' });
    ticks.forEach((tick, i) => {
      const ty = y(tick);
      const label = svg('text', { x: left - 10, y: ty + 3.5, 'text-anchor': 'end', class: 'ag-token-chart-label' });
      label.textContent = formatCompact(tick);
      grid.append(label);
      const line = roughSegment([left, ty], [right, ty], hashSeed(`grid${i}`), 0.6);
      if (i === 0) {
        const [a, b] = roughStrokes(line, hashSeed('base'), 0.5);
        grid.append(svg('path', { d: a, class: 'ag-token-chart-base' }), svg('path', { d: b, class: 'ag-token-chart-base ag-token-chart-second' }));
      } else {
        grid.append(svg('path', { d: pathData(line), class: 'ag-token-chart-gridline' }));
      }
    });
    const middle = Math.floor((n - 1) / 2);
    const marks = n > 2 ? [[0, 'start'], [middle, 'middle'], [n - 1, 'end']] as const : [[0, 'start'], [n - 1, 'end']] as const;
    for (const [index, anchor] of marks) {
      if (!days[index]) continue;
      const label = svg('text', { x: x(index), y: height - 6, 'text-anchor': anchor, class: 'ag-token-chart-label' });
      label.textContent = formatDayLabel(days[index]!.date);
      grid.append(label);
    }
    root.append(grid);

    const hatches = svg('g', { class: 'ag-token-chart-hatches' });
    const lines = svg('g', { class: 'ag-token-chart-lines' });
    for (const agent of agents) {
      const curve = monotoneSamples(days.map((day, i) => [x(i), y(day[agent])] as const), 4);
      const clip = svg('clipPath', { id: `${id}-${agent}` });
      clip.append(svg('path', { d: `${pathData(curve)}L${round(x(n - 1))} ${round(base)}L${round(x(0))} ${round(base)}Z` }));
      defs.append(clip);
      const hatch = svg('g', { 'clip-path': `url(#${id}-${agent})`, class: 'ag-token-chart-hatch', 'data-agent': agent });
      const { angle, gap } = HATCH[agent];
      const radians = (angle * Math.PI) / 180;
      const run = (base - top) / Math.tan(radians);
      const stepX = gap / Math.sin(radians);
      const from = Math.min(left, left - run);
      const to = Math.max(right, right - run);
      const strokes: string[] = [];
      for (let k = 0, x0 = from; x0 <= to; k++, x0 += stepX) {
        strokes.push(pathData(roughSegment([x0, base + 2], [x0 + run, top - 2], hashSeed(`${agent}h${k}`), 0.9)));
      }
      hatch.append(svg('path', { d: strokes.join('') }));
      hatches.append(hatch);
      const [a, b] = roughStrokes(curve, hashSeed(agent));
      const series = svg('g', { class: 'ag-token-chart-series', 'data-agent': agent });
      series.append(svg('path', { d: a, class: 'ag-token-chart-line', pathLength: 1 }), svg('path', { d: b, class: 'ag-token-chart-line ag-token-chart-second', pathLength: 1 }));
      lines.append(series);
    }
    hoverLayer = svg('g', { class: 'ag-token-chart-hover' });
    const hit = svg('rect', { x: left, y: 0, width: Math.max(0, right - left), height: base, class: 'ag-token-chart-hit' });
    root.append(hatches, lines, hoverLayer, hit);
    root.setAttribute('tabindex', '0');
    root.addEventListener('pointermove', (event) => {
      const box = root.getBoundingClientRect();
      const px = event.clientX - box.left;
      showIndex(n > 1 ? Math.round(((px - left) / (right - left)) * (n - 1)) : 0);
    });
    root.addEventListener('pointerleave', () => showIndex(null));
    root.addEventListener('blur', () => showIndex(null));
    root.addEventListener('keydown', (event) => {
      const last = n - 1;
      const current = focusIndex ?? last;
      const next = event.key === 'ArrowLeft' ? current - 1 : event.key === 'ArrowRight' ? current + 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'Escape' ? null : undefined;
      if (next === undefined) return;
      event.preventDefault();
      showIndex(next === null ? null : Math.max(0, Math.min(last, next)));
    });
    svgRoot?.remove();
    svgRoot = root;
    plot.replaceChildren(root, readout);
    const keep = focusIndex;
    focusIndex = null;
    if (keep !== null) showIndex(keep);
  }

  // 가리킨 날로 옮길 때 안내선·점·읽기 창을 새로 그리지 않고 미끄러지듯 옮긴다.
  let hover: { guide: SVGGElement; dots: Map<TokenUsageAgent, SVGCircleElement> } | null = null;
  const readoutValues = new Map<TokenUsageAgent, HTMLElement>();
  const readoutDate = html('div', 'ag-token-chart-readout-date');

  function showIndex(index: number | null) {
    if (!report || !layout || !hoverLayer) return;
    const days = report.daily;
    if (index === null || !days[index]) {
      focusIndex = null;
      hoverLayer.classList.remove('ag-shown');
      readout.hidden = true;
      return;
    }
    if (index === focusIndex && !readout.hidden) return;
    const { x, y, top, base } = layout;
    const day = days[index]!;
    const gx = round(x(index));
    const fresh = !hover || hover.guide.parentNode !== hoverLayer;
    if (fresh) {
      const guide = svg('g', { class: 'ag-token-chart-guide-group' });
      const [a, b] = roughStrokes(roughSegment([0, top], [0, base], hashSeed('guide'), 0.6), 11, 0.5);
      guide.append(svg('path', { d: a, class: 'ag-token-chart-guide' }), svg('path', { d: b, class: 'ag-token-chart-guide ag-token-chart-second' }));
      const dots = new Map<TokenUsageAgent, SVGCircleElement>();
      for (const agent of agents) dots.set(agent, svg('circle', { cx: 0, cy: 0, r: 3, class: 'ag-token-chart-dot', 'data-agent': agent }) as SVGCircleElement);
      hoverLayer.replaceChildren(guide, ...dots.values());
      hover = { guide, dots };
      readoutValues.clear();
      readout.replaceChildren(readoutDate);
      for (const agent of agents) {
        const row = html('div', 'ag-token-chart-readout-row');
        row.dataset.agent = agent;
        const value = html('span', 'ag-token-chart-readout-value');
        row.append(html('span', 'ag-token-dot'), html('span', 'ag-token-chart-readout-name', AGENT_NAME[agent]), value);
        readout.append(row);
        readoutValues.set(agent, value);
      }
    }
    // 처음 나타날 때는 제자리에 두고, 그다음부터 옮겨 간다.
    const glide = focusIndex !== null && !fresh && !reducedMotion();
    hoverLayer.classList.toggle('ag-glide', glide);
    readout.classList.toggle('ag-glide', glide);
    focusIndex = index;
    hover!.guide.style.transform = `translateX(${gx}px)`;
    for (const [agent, dot] of hover!.dots) dot.style.transform = `translate(${gx}px, ${round(y(day[agent]))}px)`;
    hoverLayer.classList.add('ag-shown');
    readoutDate.textContent = formatDayLabel(day.date);
    for (const [agent, value] of readoutValues) value.textContent = formatCompact(day[agent]);
    readout.hidden = false;
    const flip = gx > (layout.left + layout.right) / 2;
    const left = flip ? gx - 12 - readout.offsetWidth : gx + 12;
    readout.style.transform = `translateX(${round(Math.max(0, Math.min(width - readout.offsetWidth, left)))}px)`;
  }

  return {
    element,
    update(next: TokenUsageReport, visible: TokenUsageAgent[], animate: boolean) {
      enter = animate;
      report = next;
      agents = visible;
      focusIndex = null;
      readout.hidden = true;
      draw();
    },
    dispose() {
      observer?.disconnect();
    },
  };
}
