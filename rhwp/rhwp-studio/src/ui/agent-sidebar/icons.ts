/* 사이드바 아이콘 — 유니코드 글리프(✓ ✕ ⇄ …) 대신 직접 그린 SVG.
   chevron.ts 와 같은 규약: 12 그리드, currentColor, 1.25 스트로크,
   둥근 캡. 굵기를 한 벌로 맞춰야 글리프마다 폰트 렌더가 달라지는
   문제가 사라진다. */

const NS = 'http://www.w3.org/2000/svg';

/** 스트로크로만 그리는 아이콘의 패스 정의. */
const STROKE_PATHS = {
  check: 'M2.5 6.4 5 8.9l4.5-5.4',
  close: 'M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6',
  send: 'M6 9.5v-7M2.9 5.6 6 2.5l3.1 3.1',
  insert: 'M6 2.6v6.8M2.6 6h6.8',
  delete: 'M2.6 6h6.8',
  replace: 'M2.5 4.3h6.2L6.9 2.6M9.5 7.7H3.3l1.8 1.7',
  format: 'M2.8 9.2 3.2 7.5l4.4-4.4 1.3 1.3-4.4 4.4zM2.8 9.2h2.4',
  field: 'M3.4 9.4V2.6h5.2L7.3 4.6l1.3 2H3.4',
  /* 네 귀퉁이가 바깥을 향한다 — 콘솔 펼치기 */
  expand: 'M2.6 4.8V2.6h2.2M7.2 2.6h2.2v2.2M9.4 7.2v2.2H7.2M4.8 9.4H2.6V7.2',
  /* 같은 형태를 안쪽으로 뒤집는다 — 사이드바로 되돌리기 */
  contract: 'M4.8 2.6v2.2H2.6M9.4 4.8H7.2V2.6M7.2 9.4V7.2h2.2M2.6 7.2h2.2v2.2',
  environment: 'M2.4 3.2h1.1M5.1 3.2h4.5M2.4 8.8h4.5M8.5 8.8h1.1M4.3 2.2v2M7.7 7.8v2',
  document: 'M3 2.2h3.8L9 4.4v5.4H3zM6.8 2.2v2.2H9',
  /* 문서 열기 — 문서 오른쪽 아래 귀퉁이에 더하기가 붙는다. */
  documentAdd: 'M5.9 9.8H3V2.2h3.8L9 4.4v1.4M6.8 2.2v2.2H9M8.6 7.2v3M7.1 8.7h3',
  /* 새 채팅 — 열린 상자 위의 연필. */
  compose: 'M6 2.4H3.4a1 1 0 0 0-1 1v5.2a1 1 0 0 0 1 1h5.2a1 1 0 0 0 1-1V6M8.4 1.9a.9.9 0 0 1 1.3 1.3L6.1 6.8l-1.7.4.4-1.7z',
  /* 상자를 빠져나가는 화살표 — 다른 문서로 이동 */
  external: 'M9.4 6.6v2.8H2.6V2.6h2.8M6.6 5.4 9.4 2.6M7.2 2.6h2.2v2.2',
  /* 변경 위치로 이동 — 틀 없는 대각 화살표. */
  jump: 'M3.5 8.5 8.5 3.5M4.6 3.5h3.9v3.9',
  /* 되돌리기 — 왼쪽으로 꺾여 돌아오는 화살표. */
  undo: 'M4.3 2.8 2.3 4.8l2 2M2.5 4.8h4.4a2.6 2.6 0 0 1 0 5.2H5.2',
  plan: 'M3 2.2h6v7.6H3zM4.2 4.3l.7.7 1.2-1.4M6.8 4.4h1M4.2 7.1l.7.7 1.2-1.4M6.8 7.2h1',
  minimize: 'M3 7.8h6',
  image: 'M2.4 2.7h7.2v6.6H2.4zM3.5 7.8l1.7-1.7 1.2 1.2 1-1 1.1 1.5M7.8 4.5h.1',
  changes: 'M3 2.2h6v7.6H3zM4.6 5.1h2.8M6 3.7v2.8M4.6 8h2.8',
  /* 톱니 여덟 개를 두른 축 — 설정 */
  gear: 'M6 4.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6M6 1.5v1.3M6 9.2v1.3M2.8 6H1.5M10.5 6H9.2M3.72 3.72l-.92-.92M9.2 9.2l-.92-.92M8.28 3.72l.92-.92M2.8 9.2l.92-.92',
  /* 겹친 두 장 — 복사 */
  copy: 'M4.3 4.3h5.2v5.2H4.3zM2.5 7.7V2.5h5.2',
  /* 아래로 내려가는 화살 — 최신 대화로 */
  arrowDown: 'M6 2.5v7M2.9 6.4 6 9.5l3.1-3.1',
  /* 시계 방향으로 도는 화살 — 다시 확인 */
  refresh: 'M9.3 6a3.3 3.3 0 1 1-1.05-2.4M9.5 2.1v1.9H7.6',
  paperclip: 'M4.1 6.2 7.3 3a1.7 1.7 0 0 1 2.4 2.4L5.8 9.3A2.5 2.5 0 0 1 2.3 5.8l4-4M4.7 7.5 8 4.2',
  references: 'M3 2.2h4.1L9 4.1v5.7H3zM7.1 2.2v1.9H9M4.4 6h3.2M4.4 7.7h2.3',
  search: 'M5.3 2.5a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6M7.3 7.3l2.2 2.2',
  /* 여섯 점으로 만든 작은 그립 — 목록 순서 이동 */
  grip: 'M4 2.5h.1M8 2.5h.1M4 6h.1M8 6h.1M4 9.5h.1M8 9.5h.1',
  /* 가로 세 점 — 더 보기 메뉴 */
  /* 문서에 직접 쓰는 skill — 짧고 삐딱한 연필 한 자루. */
  skillEdit: 'M2.1 9.9l.7-2.5 5-5 1.9 1.9-5 5zM7.1 3.1 9 5M2.8 7.4l1.9 1.9',
  /* 내부 작업 skill — 안테나·입 없이 사각 몸체와 두 눈만 둔다. */
  skillBot: 'M2.1 3h7.8v6H2.1zM4 6h.6M7.4 6H8',
  /* 기타 skill — 가는 방사선 대신 몸통과 넓은 톱니가 이어진 묵직한 gear. */
  skillSystem: 'M5.05 1h1.9l.34 1.3c.36.1.7.24 1.02.42l1.16-.68 1.49 1.49-.68 1.16c.18.32.32.66.42 1.02L11 5.05v1.9l-1.3.34c-.1.36-.24.7-.42 1.02l.68 1.16-1.49 1.49-1.16-.68c-.32.18-.66.32-1.02.42L6.95 11h-1.9l-.34-1.3c-.36-.1-.7-.24-1.02-.42l-1.16.68-1.49-1.49.68-1.16c-.18-.32-.32-.66-.42-1.02L1 6.95v-1.9l1.3-.34c.1-.36.24-.7.42-1.02l-.68-1.16 1.49-1.49 1.16.68c.32-.18.66-.32 1.02-.42zM6 4.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4',
  pencil: 'M2.1 9.9l.7-2.5 5-5 1.9 1.9-5 5zM7.1 3.1 9 5M2.8 7.4l1.9 1.9',
  bot: 'M2.1 3h7.8v6H2.1zM4 6h.6M7.4 6H8',
  system: 'M5.05 1h1.9l.34 1.3c.36.1.7.24 1.02.42l1.16-.68 1.49 1.49-.68 1.16c.18.32.32.66.42 1.02L11 5.05v1.9l-1.3.34c-.1.36-.24.7-.42 1.02l.68 1.16-1.49 1.49-1.16-.68c-.32.18-.66.32-1.02.42L6.95 11h-1.9l-.34-1.3c-.36-.1-.7-.24-1.02-.42l-1.16.68-1.49-1.49.68-1.16c-.18-.32-.32-.66-.42-1.02L1 6.95v-1.9l1.3-.34c-.1-.36-.24-.7-.42-1.02l-.68-1.16 1.49-1.49 1.16.68c.32.18.66.32 1.02.42zM6 4.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4',
  /* Lucide 아이콘의 작은 제품 스킬용 subset (ISC). */
  sparkles: 'M6 1.5 7.1 4.9 10.5 6 7.1 7.1 6 10.5 4.9 7.1 1.5 6 4.9 4.9zM10 1.5v2M9 2.5h2M2 9v2M1 10h2',
  book: 'M1.8 2.2h3.1A2.1 2.1 0 0 1 7 4.3v5.5A1.8 1.8 0 0 0 5.2 8H1.8zM10.2 2.2H7A2.1 2.1 0 0 0 5 4.3v5.5A1.8 1.8 0 0 1 6.8 8h3.4z',
  target: 'M6 10.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 1v2M6 9v2M1 6h2M9 6h2',
  chart: 'M2 10V2M2 10h8M4.5 8V6M7 8V4M9.5 8V2.5',
  lightbulb: 'M4.2 7.5a3 3 0 1 1 3.6 0c-.5.5-.8 1-.8 1.7H5c0-.7-.3-1.2-.8-1.7zM5 10h2M5.3 11h1.4',
  calendar: 'M2 3h8v7H2zM4 1.5v3M8 1.5v3M2 5h8',
  code: 'M4.2 3.5 1.8 6l2.4 2.5M7.8 3.5 10.2 6 7.8 8.5M6.8 2.5 5.2 9.5',
  terminal: 'M2 3.2 4.5 6 2 8.8M5.8 8.8H10',
  heart: 'M6 10S1.8 7.5 1.8 4.6a2.3 2.3 0 0 1 4.2-1.3 2.3 2.3 0 0 1 4.2 1.3C10.2 7.5 6 10 6 10z',
  bolt: 'M7 1.5 3 6.3h2.8L5 10.5l4-5H6.2z',
  shield: 'M6 1.5 10 3v3.2c0 2.2-1.5 3.9-4 4.8-2.5-.9-4-2.6-4-4.8V3zM4.3 6l1.1 1.1L7.8 4.7',
  /* 가로 점 셋 — 더 많은 동작. 작은 고리에 스트로크를 둘러 꽉 찬 점으로 읽힌다. */
  more: 'M2.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M5.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M8.4 6a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0',
  /* 말풍선 — 채팅 모드. */
  message: 'M2.2 2.6h7.6v5.3H5.4L3.2 9.8V7.9h-1z',
  /* 위아래 갈매기 — 팝업 버튼의 선택 표시. */
  updown: 'M4.2 4.6 6 2.8l1.8 1.8M4.2 7.4 6 9.2l1.8-1.8',
  /* 속이 빈 점 — 아직 시작하지 않은 단계. */
  pending: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
} as const;

/** 사각 프레임(개체)만 채우기 없이 rect 로 그린다. */
const RECT_ICONS = { object: true } as const;

export type SidebarIconName = keyof typeof STROKE_PATHS | keyof typeof RECT_ICONS;

/**
 * 12×12 인라인 SVG 아이콘을 만든다.
 * 색은 currentColor 를 따르므로 부모에서 color 로 제어한다.
 */
export function createIcon(name: SidebarIconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-icon ${className}` : 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  if (name in RECT_ICONS) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '2.9');
    rect.setAttribute('y', '2.9');
    rect.setAttribute('width', '6.2');
    rect.setAttribute('height', '6.2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.25');
    svg.appendChild(rect);
    return svg;
  }

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', STROKE_PATHS[name as keyof typeof STROKE_PATHS]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', name === 'skillSystem' ? '1.35' : '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** 실행 중지 버튼용 채워진 사각형. 스트로크 아이콘과 달리 면으로 읽혀야 한다. */
export function createStopIcon(className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-icon ${className}` : 'ag-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '3.6');
  rect.setAttribute('y', '3.6');
  rect.setAttribute('width', '4.8');
  rect.setAttribute('height', '4.8');
  rect.setAttribute('rx', '1');
  rect.setAttribute('fill', 'currentColor');
  svg.appendChild(rect);
  return svg;
}

/** 응답 대기·편집 상태에 쓰는 잉크 고리. 가운데 점은 회전하지 않는다. */
export function createInkRing(className = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', className ? `ag-ink-ring ${className}` : 'ag-ink-ring');
  svg.setAttribute('viewBox', '-10 -10 120 120');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const trails = document.createElementNS(NS, 'g');
  trails.setAttribute('class', 'ag-ink-ring-trails');
  const pathData = 'M50 13 C90 7 104 65 69 81 C33 108 2 61 24 31 C43 0 85 31 73 61 C60 91 16 75 23 44 C29 18 67 11 78 41 C89 71 50 98 29 73 C1 44 30 10 50 13Z';
  for (const transform of [
    '',
    'rotate(20 50 50) scale(.9) translate(5.5 5.5)',
    'rotate(40 50 50)',
    'rotate(60 50 50) scale(.85) translate(9 9)',
  ]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathData);
    if (transform) path.setAttribute('transform', transform);
    trails.appendChild(path);
  }

  const center = document.createElementNS(NS, 'circle');
  center.setAttribute('class', 'ag-ink-ring-center');
  center.setAttribute('cx', '50');
  center.setAttribute('cy', '50');
  center.setAttribute('r', '5');
  svg.append(trails, center);
  return svg;
}

/** 편집 종류 → 아이콘 이름. opGlyph 의 유니코드 대응을 대체한다. */
export const OP_ICON: Record<string, SidebarIconName> = {
  insert: 'insert',
  delete: 'delete',
  replace: 'replace',
  format: 'format',
  field: 'field',
  object: 'object',
};
