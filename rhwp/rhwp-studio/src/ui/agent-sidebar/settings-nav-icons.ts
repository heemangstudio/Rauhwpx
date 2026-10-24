/* 설정 왼쪽 목록과 설정 검색 결과의 아이콘 — icons.ts 와 같은 규약(12 그리드, currentColor,
   1.25 스트로크, 둥근 캡)으로 목적지마다 따로 그린다. 라벨 글자 대신 고정 id 로 찾는다. */
import './settings-nav-icons.css';

const NS = 'http://www.w3.org/2000/svg';

const NAV_PATHS = {
  /* 밑줄 위에 비스듬히 선 연필 — 편집 */
  editing: 'M2.6 9.4l.5-2 5-5a1 1 0 0 1 1.4 1.4l-5 5zM6.9 3.6l1.5 1.5M6.6 9.4h2.8',
  /* 초승달 — 테마 */
  theme: 'M9.6 7.1A3.9 3.9 0 1 1 4.9 2.4a3.1 3.1 0 0 0 4.7 4.7z',
  /* 큰 반짝임과 작은 반짝임 — AI */
  ai: 'M5.4 1.9c.38 2.1 1.4 3.12 3.5 3.5-2.1.38-3.12 1.4-3.5 3.5-.38-2.1-1.4-3.12-3.5-3.5 2.1-.38 3.12-1.4 3.5-3.5zM9.4 8.4v2M8.4 9.4h2',
  /* 플러그 — AI › 연결 */
  connection: 'M4.6 1.9v2M7.4 1.9v2M3.3 3.9h5.4v1.7a2.7 2.7 0 0 1-5.4 0zM6 8.3v1.8',
  /* 바늘이 선 계기판 — AI › 사용량 */
  usage: 'M3.3 9.1a3.8 3.8 0 1 1 5.4 0M6 6.4l1.7-1.7M6 6.4h.01',
  /* 손잡이가 엇갈린 두 슬라이더 — AI › 사용자화 */
  customize: 'M2.2 3.8h3.6M8.2 3.8h1.6M2.2 8.2h1.6M6.2 8.2h3.6M7 2.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4M5 7a1.2 1.2 0 1 0 0 2.4A1.2 1.2 0 0 0 5 7',
  /* 나침반 — 브라우저 */
  browser: 'M6 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8M7.6 4.4 6.6 6.6 4.4 7.6l1-2.2z',
  /* 번개 — 스킬 */
  skills: 'M6.6 1.9 3 6.7h3l-.6 3.4 3.6-4.8H6z',
  /* 손잡이 달린 서류 가방 — 프로젝트 */
  project: 'M2 4.2h8v5.4H2zM4.4 4.2V3a.6.6 0 0 1 .6-.6h2a.6.6 0 0 1 .6.6v1.2M2 6.6h8',
  /* 화살이 들어가는 상자 — 보관함 */
  archive: 'M2.2 4.8v4.8h7.6V4.8M1.8 3h8.4v1.8H1.8zM6 5.9v2.4M4.9 7.3 6 8.4l1.1-1.1',
  /* 메달과 리본 — 라이선스 */
  license: 'M6 1.9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2M4.5 6.6 4 10.1l2-1 2 1-.5-3.5',
} as const;

export type SettingsNavIconId = keyof typeof NAV_PATHS;

export function createSettingsNavIcon(id: SettingsNavIconId): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ag-settings-nav-icon');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.navIcon = id;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', NAV_PATHS[id]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/** 라벨 글자 앞에 아이콘을 붙인다. textContent 는 그대로라 검색·테스트가 라벨을 그대로 읽는다. */
export function withNavIcon<T extends HTMLElement>(element: T, id: SettingsNavIconId): T {
  element.classList.add('ag-has-nav-icon');
  element.prepend(createSettingsNavIcon(id));
  return element;
}
