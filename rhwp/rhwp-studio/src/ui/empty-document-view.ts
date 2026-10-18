/**
 * 문서가 없을 때 용지 자리 — 점선 종이 하나와 새 문서·파일 열기 두 단추. 문서 없는 채팅 옆에서는 이
 * 두 단추가 그 채팅에 문서를 잇는다(편집기가 정한다). 문서가 열리면 바로 내려간다.
 * 종이 테두리는 손으로 그은 듯 고르지 않은 점선이다. 종이를 눌러도 파일 열기와 같다. 종이 안에는 하마가 엎드려 잔다 — 스프라이트(hama-sprites.png)의
 * 깜빡임 자세 머리와 같은 색으로 그린 픽셀 그림이다. 모양은 styles/empty-document-view.css.
 */
export interface EmptyDocumentView {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 하마 스프라이트의 다섯 색 — A 윗빛, D 몸, B 그늘, E 깊은 그늘, C 입·눈. */
const PALETTE: Record<string, string> = {
  A: 'rgb(178, 226, 251)',
  D: 'rgb(98, 179, 226)',
  B: 'rgb(47, 115, 160)',
  E: 'rgb(29, 71, 102)',
  C: 'rgb(12, 37, 54)',
};
/** 엎드려 자는 하마 30×12. 머리는 스프라이트의 눈 감은 자세 그대로, 다리는 배 밑에 접었다. */
const SLEEPING_HAMA = [
  '..AAAAAA......................',
  '.ADDDDDDAA....................',
  'ADDDDDDDDDA...................',
  'DDDDDDDDDDDD..................',
  'DDDDDDDDDDDD.A....AA..........',
  'DDDDDDDDDDDDABA..ADDA.........',
  'DDDDDDDDDDDDDAAAADEEDAAAAA....',
  'DDDDDDDDDDDBDDDDDDDDDDDDDDDAA.',
  'DDDDDDDDDDDBDDDDDDDDDDDDDDDDDB',
  'DDDDDDDDDDDDBDDDDDDDDDDDDDDDDB',
  'BDDDBDDDDDDDDBDDDDDCCCCCCCCBBB',
  '.BBEEBBBBBBBBBEEEDDDBBBBBBBB..',
];
/** 숨을 들이쉴 때 등이 한 칸 솟는다 — 바뀌는 픽셀만. */
const INHALE = [
  '...AAAA',
  '...DDDD',
];
const Z_SMALL = ['####', '..#.', '.#..', '####'];
const Z_LARGE = ['#####', '...#.', '..#..', '.#...', '#####'];
/** 그림 칸: 위 16줄은 z 자리, 아래 12줄이 하마. */
const VIEW_W = 30;
const VIEW_H = 28;
const HAMA_TOP = 16;

/** 종이 크기(css 와 같다). 테두리는 이 좌표로 손으로 그은 듯 그린다. */
const PAPER_W = 118;
const PAPER_H = 156;
/**
 * 네 변을 따로 긋는다. 변마다 살짝 휘고, 끝이 모서리를 조금 지나치거나 못 미쳐 모서리가 고르지 않다.
 * 점선 간격도 변마다 시작점을 달리해 같은 무늬가 되풀이되지 않는다.
 */
const PAPER_EDGES = [
  'M -0.6 1.7 C 30 0.5, 74 2.5, 117.4 0.9',
  'M 116.5 -0.7 C 117.9 42, 116.0 104, 117.0 155.4',
  'M 118.3 154.5 C 82 155.9, 38 153.8, 1.2 155.3',
  'M 1.5 156.6 C 0.2 112, 2.3 48, 0.8 1.1',
];
const EDGE_DASH_OFFSETS = [0, 11, 5, 17];

/** 종이 테두리 — 고르지 않은 점선 한 겹 위에 옅은 덧선 한 겹. 색은 currentColor 를 따른다. */
function createPaperOutline(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'empty-document-paper-outline');
  svg.setAttribute('viewBox', `0 0 ${PAPER_W} ${PAPER_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const stroke = (d: string, className: string, offset: number): SVGPathElement => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    path.setAttribute('stroke-dashoffset', String(offset));
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    return path;
  };
  PAPER_EDGES.forEach((d, index) => {
    svg.append(stroke(d, 'empty-document-paper-stroke', EDGE_DASH_OFFSETS[index]!));
  });
  // 덧선은 같은 변을 반 픽셀 비켜 한 번 더 지나간 자국이다. 앞의 두 변에만 남긴다.
  const retrace = document.createElementNS(SVG_NS, 'g');
  retrace.setAttribute('class', 'empty-document-paper-retrace');
  retrace.setAttribute('transform', 'translate(0.7 0.6)');
  PAPER_EDGES.slice(0, 2).forEach((d, index) => {
    retrace.append(stroke(d, 'empty-document-paper-stroke', EDGE_DASH_OFFSETS[index]! + 7));
  });
  svg.append(retrace);
  return svg;
}

/** 글자 격자를 가로로 이어진 칸마다 rect 하나로 그린다. '.' 은 비운다. */
function pixelGroup(rows: readonly string[], x0: number, y0: number, color: (cell: string) => string): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const cell = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === cell) end++;
      if (cell !== '.') {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x0 + x));
        rect.setAttribute('y', String(y0 + y));
        rect.setAttribute('width', String(end - x));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', color(cell));
        group.append(rect);
      }
      x = end;
    }
  });
  return group;
}

function createSleepingHama(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'empty-document-hama');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const byPalette = (cell: string): string => PALETTE[cell] ?? PALETTE.D!;
  const inhale = pixelGroup(INHALE, 0, HAMA_TOP - 1, byPalette);
  inhale.setAttribute('class', 'empty-document-hama-inhale');
  svg.append(pixelGroup(SLEEPING_HAMA, 0, HAMA_TOP, byPalette), inhale);
  // z 셋이 눈 위에 계단처럼 선다. 아래 것부터 차례로 떠올라 사라진다.
  ([[Z_SMALL, 18, 13], [Z_SMALL, 21, 7], [Z_LARGE, 25, 0]] as const).forEach(([glyph, x, y], index) => {
    const z = pixelGroup(glyph, x, y, () => 'currentColor');
    z.setAttribute('class', `empty-document-z empty-document-z-${index + 1}`);
    svg.append(z);
  });
  return svg;
}

export function createEmptyDocumentView(actions: { create(): void; open(): void }): EmptyDocumentView {
  const element = document.createElement('div');
  element.className = 'empty-document-view';
  element.hidden = true;
  // 종이는 파일 열기를 마우스로 크게 누르는 자리다. 초점을 받지 않고, 키보드·낭독은 단추로 간다.
  const paper = document.createElement('div');
  paper.className = 'empty-document-paper';
  paper.setAttribute('aria-hidden', 'true');
  paper.append(createPaperOutline(), createSleepingHama());
  paper.addEventListener('click', () => actions.open());
  const row = document.createElement('div');
  row.className = 'empty-document-actions';
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'empty-document-action empty-document-create';
  create.textContent = '새 문서';
  create.addEventListener('click', () => actions.create());
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'empty-document-action empty-document-open';
  open.textContent = '파일 열기';
  open.addEventListener('click', () => actions.open());
  row.append(create, open);
  element.append(paper, row);
  return {
    element,
    setVisible(visible) {
      element.hidden = !visible;
    },
  };
}
