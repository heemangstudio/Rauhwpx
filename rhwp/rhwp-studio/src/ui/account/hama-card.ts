// 요금제 카드 · Hama 의 픽셀 그림. 채팅 하마를 2배(6px 칸)로 수면 위에 세운다.
// 달은 월간, 해는 연간. 해지하면 잿빛 노을에 귀와 등만 남기고 잠기고, 결제가 실패하면 물이 빠진 진흙에 웅크린다.
// 문자열은 이 파일의 상수로만 만든다.
import './hama-card.css';
import { CROUCH, EAR, OPEN_EAR, STAND, STEP, Z_FADE } from '../agent-sidebar/chat-hama.ts';
import type { PlanCardKind } from './account-format.ts';

const CELL = 6;
type Cell = [x: number, y: number, ch: string];

const BANG = ['r', 'r', '.', 'r'];
const DROP = ['h'];
const MOON = [
  '..mmmm.',
  '.mmmm..',
  'mmmm...',
  'mmmm...',
  'mmmm..m',
  '.mmmmmm',
  '..mmmm.',
];
const SUN = [
  '.........',
  '.........',
  '...SSS...',
  '..SSSST..',
  '..SSSST..',
  '..SSSST..',
  '...STT...',
  '.........',
  '.........',
];
const RAYS: Array<[number, number]> = [[4, 0], [0, 4], [8, 4], [4, 8]];
const RAYS_DIAG: Array<[number, number]> = [[1, 1], [7, 1], [1, 7], [7, 7]];
const REFLECT = ['..SSSSS..', '.........', '...TTT...'];
const GIFT = [
  '...VV.VV...',
  '....VkV....',
  'EEEEEVEEEEE',
  'RRRRRVRRRRQ',
  '.QQQQVQQQQ.',
  '.RRRRVRRRQ.',
  '.RRRRVRRRQ.',
  '.RRRRVRRRQ.',
  '.QQQQVQQQQ.',
];
const SPARK = ['.h.', 'hWh', '.h.'];
/** 하마 무대. 글 쪽을 보게 뒤집는다. 좌표는 chat-hama 의 하마 좌표(7행이 땅)다. */
const STAGE = { w: 26, h: 18, ox: 9, oy: 10 };

function peaks(): string[] {
  const list: Array<[number, number, string]> = [[3, 3, 'N'], [8, 5, 'F'], [13, 7, 'N'], [18, 5, 'F'], [23, 3, 'N']];
  const width = 27;
  const height = 7;
  const rows = Array.from({ length: height }, () => Array<string>(width).fill('.'));
  for (const [center, tall, tone] of list) {
    for (let x = 0; x < width; x++) {
      const top = tall - Math.abs(x - center);
      for (let y = 0; y < top; y++) {
        rows[height - 1 - y]![x] = (tall === 7 && y >= 5) || (tall === 5 && y >= 4) ? 'U' : tone;
      }
    }
  }
  return rows.map((row) => row.join(''));
}

function cellsOf(art: readonly string[], ox = 0, oy = 0): Cell[] {
  const out: Cell[] = [];
  art.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') out.push([x + ox, y + oy, ch]); }));
  return out;
}

function pathFor(cells: readonly Cell[]): string {
  const byLetter = new Map<string, string>();
  for (const [x, y, ch] of cells) byLetter.set(ch, `${byLetter.get(ch) ?? ''}M${x} ${y}h1v1h-1z`);
  return [...byLetter].map(([ch, d]) => `<path class="p-${ch}" d="${d}"/>`).join('');
}

function svg(w: number, h: number, inner: string, { cls = '', style = '' } = {}): string {
  return `<svg class="hc-pix ${cls}" style="${style}" viewBox="0 0 ${w} ${h}" width="${w * CELL}" height="${h * CELL}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${inner}</svg>`;
}

function pix(art: readonly string[], opts: { cls?: string; style?: string } = {}): string {
  return svg(Math.max(...art.map((row) => row.length)), art.length, pathFor(cellsOf(art)), opts);
}

const at = (right: number, bottom: number): string => `right:${right * CELL}px;bottom:${bottom * CELL}px;`;
const twinkle = (right: number, bottom: number, tone: string): string => pix(['y'], { cls: `hc-twinkle ${tone}`, style: at(right, bottom) });

function stageCells(art: readonly string[], x = 0, y = 0): Cell[] {
  return cellsOf(art).map(([col, row, ch]): Cell => [13 - (col + x) + STAGE.ox, row + y + STAGE.oy, ch]);
}

function hippoStage(kind: PlanCardKind): string {
  let body: string;
  if (kind === 'failed') {
    body = `${pathFor(stageCells(CROUCH))}<g class="fx-bang">${pathFor(stageCells(BANG, 10, -5))}</g><g class="fx-drop">${pathFor(stageCells(DROP, 4, 0))}</g>`;
  } else if (kind === 'lifetime') {
    const small = stageCells(['W'], 9, -2);
    const big = [...small, ...stageCells(['h'], 10, -2), ...stageCells(['h'], 8, -2), ...stageCells(['h'], 9, -1), ...stageCells(['h'], 9, -3)];
    body = `${pathFor(stageCells(OPEN_EAR))}<g class="spark-small">${pathFor(small)}</g><g class="spark-big">${pathFor(big)}</g>`;
  } else if (kind === 'cancelled') {
    const z = [0, 1, 2, 3].map((k) => `<g class="zz k${k}">${pathFor(stageCells([Z_FADE[k]!], 12 + k, 2 - k * 2))}</g>`).join('');
    body = `${pathFor(stageCells(STAND))}${z}`;
  } else {
    body = `<g class="f-a">${pathFor(stageCells(STAND))}</g><g class="f-b">${pathFor(stageCells(EAR))}</g><g class="f-c">${pathFor(stageCells(STEP))}</g>`;
  }
  return `<div class="hc-hippo" style="--oy:${STAGE.oy}">${svg(STAGE.w, STAGE.h, body)}</div>`;
}

function rays(): string {
  const cells = (list: Array<[number, number]>, ch: string): Cell[] => list.map(([x, y]): Cell => [x, y, ch]);
  return `<g class="rays">${pathFor(cells(RAYS, 'S'))}<g class="rays-pulse">${pathFor(cells(RAYS_DIAG, 'T'))}</g></g>`;
}

function skyProps(kind: PlanCardKind): string {
  if (kind === 'yearly' || kind === 'cancelled') {
    return svg(9, 9, pathFor(cellsOf(SUN)) + rays(), { cls: 'hc-sun', style: `right:${20 * CELL}px;` });
  }
  if (kind === 'gift') {
    return pix(GIFT, { style: at(18, 0) }) + pix(SPARK, { cls: 'hc-twinkle t2', style: at(16, 10) });
  }
  if (kind === 'lifetime') {
    return pix(peaks(), { style: at(14, 0) })
      + svg(9, 9, pathFor(cellsOf(SUN)) + rays(), { style: at(14, 6) })
      + pix(MOON, { style: at(31, 7) })
      + twinkle(42, 11, 't3 hc-wideonly') + twinkle(56, 8, 't1 hc-wideonly') + twinkle(68, 12, 't2 hc-wideonly');
  }
  if (kind === 'failed') return '';
  return pix(MOON, { cls: 'hc-moon', style: `right:${20 * CELL}px;` })
    + twinkle(29, 11, 't1') + twinkle(17, 12, 't2') + twinkle(11, 9, 't3')
    + twinkle(46, 7, 't2 hc-wideonly') + twinkle(58, 11, 't1 hc-wideonly') + twinkle(72, 8, 't3 hc-wideonly');
}

function waterArt(kind: PlanCardKind): string {
  const reflect = kind === 'cancelled' ? pix(REFLECT, { style: `right:${20 * CELL}px;top:6px;` }) : '';
  // 헤엄치는 하마의 물결 점.
  const wake = kind === 'cancelled'
    ? svg(STAGE.w, 1, pathFor(([[-1, 'h'], [-3, 'o'], [13, 'h'], [14, 'o']] as Array<[number, string]>).map(([x, ch]): Cell => [13 - x + STAGE.ox, 0, ch])), { style: 'right:0;top:0;' })
    : '';
  return `${reflect}<span class="hc-ripple r1"></span><span class="hc-ripple r2"></span><span class="hc-line"></span>${wake}<span class="hc-dither"></span>`;
}

export interface HamaCardLook {
  sky: 'day' | 'night';
  live: boolean;
  skyArt: string;
  waterArt: string;
}

export function hamaCardLook(kind: PlanCardKind): HamaCardLook {
  return {
    sky: kind === 'yearly' || kind === 'gift' || kind === 'failed' ? 'day' : 'night',
    live: kind !== 'cancelled' && kind !== 'failed',
    skyArt: skyProps(kind) + hippoStage(kind),
    waterArt: waterArt(kind),
  };
}
