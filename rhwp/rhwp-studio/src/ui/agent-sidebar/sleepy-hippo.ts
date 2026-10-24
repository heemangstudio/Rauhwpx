/**
 * 고를 것이 아직 없을 때 빈 자리에 엎드려 조는 하마. 설정 하마(scripts/generate-boot-logo.py)의
 * 옆모습 머리를 눈을 감고(BLINK) 바닥에 턱을 댄 채 납작한 몸통 앞에 붙였다. 색도 같고, z 는 글자색을 따른다.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SCALE = 3;

const COLORS: Record<string, string> = {
  o: '#62b3e2',
  s: '#2f73a0',
  h: '#b2e2fb',
  d: '#1d4766',
  k: '#0c2536',
  z: 'currentColor',
};

/** 작은 z 와 큰 Z 는 따로 깜빡이도록 다른 글자로 둔다. */
const SLEEPY_HIPPO = [
  '..............................ZZZZZ',
  '.................................Z.',
  '................................Z..',
  '.........................zzzz..Z...',
  '...........................z..ZZZZZ',
  '..........................z........',
  '......hhhhhhh............zzzz......',
  '....hhoooooooh.....................',
  '...hooooooooooohh....hh............',
  '..hooooooooooooosh..hooh...........',
  '.hooooooooooooooohhhoddohhhhh......',
  '.ooooooooooooooooooooooooooooohh...',
  '.ooooooooooooooooooooooooooooooos..',
  'soooooooooooooooooooookkkkkkkksss..',
  '.ssssssssssssssoooooooossssssss....',
  '..ddd.........ddd..................',
];

export function createSleepyHippo(className = ''): SVGSVGElement {
  const width = Math.max(...SLEEPY_HIPPO.map((row) => row.length));
  const height = SLEEPY_HIPPO.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width * SCALE));
  svg.setAttribute('height', String(height * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const paths = new Map<string, string>();
  SLEEPY_HIPPO.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x]!;
      let end = x + 1;
      while (row[end] === ch) end += 1;
      if (ch !== '.') paths.set(ch, `${paths.get(ch) ?? ''}M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  for (const [ch, d] of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (ch === 'z' || ch === 'Z') {
      path.setAttribute('fill', COLORS.z!);
      path.setAttribute('class', ch === 'z' ? 'ag-sleepy-z-small' : 'ag-sleepy-z-large');
    } else {
      path.setAttribute('fill', COLORS[ch] ?? COLORS.o!);
    }
    svg.appendChild(path);
  }
  return svg;
}
