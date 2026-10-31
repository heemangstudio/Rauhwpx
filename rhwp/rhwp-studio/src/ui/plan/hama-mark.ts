// 앱 하마 픽셀 마크(7×7). 색은 currentColor 라 놓인 자리의 Hama 파랑을 따른다.
const NS = 'http://www.w3.org/2000/svg';
export const HAMA_MARK = 'M4 0h2v1H4zM2 1h1v1H2zM4 1h2v1H4zM2 2h3v1H2zM2 3h5v1H2zM0 4h6v1H0zM0 5h6v1H0zM0 6h2v1H0zM3 6h2v1H3z';

export function createHamaMark(className: string): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 7 7');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', HAMA_MARK);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}
