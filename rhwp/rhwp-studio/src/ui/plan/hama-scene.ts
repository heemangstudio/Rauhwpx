// Hama 업그레이드 그림: 물에 들어선 픽셀 하마와 반짝이. 하마 마크(7×7)와 같은 픽셀 하나를 단위로 쓰는 16×9 판이다.
// 색은 currentColor(Hama 파랑)를 따르고, 반짝임은 CSS 가 맡는다(움직임을 줄이면 멈춘다).
import { HAMA_MARK } from './hama-mark.ts';

const NS = 'http://www.w3.org/2000/svg';

/** [모양, CSS 이름]. 좌표는 판의 픽셀 칸이다. 하마는 (5,1) 에 서서 물 위에 발을 딛는다. */
const SPARKS: ReadonlyArray<readonly [string, string]> = [
  // 큰 반짝이: 가운데와 네 팔. 팔만 따로 깜빡인다.
  ['M14 2h1v1h-1z', 'hama-scene-spark'],
  ['M14 1h1v1h-1zM13 2h1v1h-1zM15 2h1v1h-1zM14 3h1v1h-1z', 'hama-scene-spark-arms'],
  // 작은 반짝이 둘.
  ['M2 1h1v1H2z', 'hama-scene-spark hama-scene-spark-b'],
  ['M1 4h1v1H1z', 'hama-scene-spark hama-scene-spark-c'],
];

/** 물: 하마가 선 수면 한 줄과 그 위로 튀는 물결, 수면의 반짝임. */
const WATER: ReadonlyArray<readonly [string, string]> = [
  ['M0 8h16v1H0zM2 7h1v1H2zM11 7h1v1h-1zM14 7h1v1h-1z', 'hama-scene-water'],
  ['M1 8h1v1H1zM7 8h1v1H7zM12 8h2v1h-2z', 'hama-scene-water-light'],
];

function path(d: string, className: string): SVGPathElement {
  const node = document.createElementNS(NS, 'path');
  node.setAttribute('d', d);
  node.setAttribute('class', className);
  return node;
}

export function createHamaScene(className: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `hama-scene ${className}`);
  svg.setAttribute('viewBox', '0 0 16 9');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(NS, 'g');
  body.setAttribute('transform', 'translate(5 1)');
  body.append(path(HAMA_MARK, 'hama-scene-hama'));
  svg.append(
    ...SPARKS.map(([d, name]) => path(d, name)),
    body,
    ...WATER.map(([d, name]) => path(d, name)),
  );
  return svg;
}
