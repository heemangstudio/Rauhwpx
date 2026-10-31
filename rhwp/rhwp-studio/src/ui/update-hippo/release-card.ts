/**
 * 업데이트한 뒤 첫 실행에 문서 홈 맨 위(새로 만들기 위)에 뜨는 릴리스 노트 카드.
 * 왼쪽에 상자를 연 픽셀 하마를 두고, 오른쪽에 버전과 노트 전부를 새 기능·고친 문제로 나눠 보인다.
 *
 * 카드가 홈에 처음 보이면 본 것으로 적는다. 그 실행 동안은 닫을 때까지 남고, 다음 실행부터는
 * 뜨지 않는다. 테두리·그림자·글머리표는 하마 그림과 같은 픽셀 칸으로 그린다.
 */
import './release-card.css';
import { createReleaseHama } from '../agent-sidebar/chat-hama.ts';
import {
  markReleaseNotesSeen,
  pendingReleaseNotes,
  RELEASE_NOTES,
  type ReleaseNote,
} from './release-notes.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 닫기 단추의 픽셀 ×. 한 칸은 2px 이다. */
const CLOSE_ICON = ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'];

function closeIcon(): SVGSVGElement {
  let d = '';
  CLOSE_ICON.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 5 5');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function group(kind: 'added' | 'fixed', label: string, items: readonly string[] | undefined): HTMLElement | null {
  if (!items?.length) return null;
  const section = el('section', `rn-group rn-${kind}`);
  const list = el('ul', 'rn-list');
  list.setAttribute('aria-label', label);
  for (const item of items) list.append(el('li', 'rn-item', item));
  section.append(el('h3', 'rn-label', label), list);
  return section;
}

export interface ReleaseCard {
  element: HTMLElement;
  dispose(): void;
}

export function createReleaseCard(version: string, note: ReleaseNote, onSeen: () => void): ReleaseCard {
  const card = el('section', 'rn-card');
  const titleId = `rn-title-${version.replace(/\W/g, '-')}`;
  card.setAttribute('aria-labelledby', titleId);

  const scene = el('div', 'rn-scene');
  scene.append(createReleaseHama(true), createReleaseHama(false));
  scene.children[0]!.classList.add('rn-hama-light');
  scene.children[1]!.classList.add('rn-hama-dark');

  const body = el('div', 'rn-body');
  const title = el('h2', 'rn-title', `HamaEditor ${version}`);
  title.id = titleId;
  const groups = el('div', 'rn-groups');
  groups.append(...[group('added', '새 기능', note.added), group('fixed', '고친 문제', note.fixed)]
    .filter((node): node is HTMLElement => node !== null));
  body.append(title, groups);

  const close = el('button', 'rn-close');
  close.type = 'button';
  close.setAttribute('aria-label', '릴리스 노트 닫기');
  close.title = '닫기';
  close.append(closeIcon());

  card.append(scene, body, close);

  // 홈이 가려진 채 붙으면 크기가 0 이다. 처음 크기가 생길 때(홈이 보일 때) 본 것으로 적는다.
  let seen = false;
  const visibility = new ResizeObserver(() => {
    if (seen || !card.offsetWidth) return;
    seen = true;
    visibility.disconnect();
    onSeen();
  });
  visibility.observe(card);

  function dispose(): void {
    visibility.disconnect();
    card.remove();
  }

  close.addEventListener('click', () => {
    const scroller = card.closest<HTMLElement>('.dh-scroll');
    dispose();
    scroller?.focus({ preventScroll: true });
  });

  return { element: card, dispose };
}

interface ReleaseCardHost {
  rhwpDesktop?: unknown;
  location?: { search: string };
  localStorage?: Storage;
}

/**
 * 데스크톱 앱이면 이번 버전의 노트를 slot 에 붙인다. Vite 개발 서버에서는 `?release-notes` 로
 * 본 기록과 상관없이 가장 최근 노트를 띄운다(`?release-notes=3.0.11` 처럼 버전을 고를 수도 있다).
 */
export function mountReleaseCard(slot: HTMLElement, host: ReleaseCardHost = window, version = __APP_VERSION__): void {
  if (import.meta.env.DEV) {
    const forced = new URLSearchParams(host.location?.search ?? '').get('release-notes');
    if (forced !== null) {
      const shown = forced && RELEASE_NOTES[forced] ? forced : Object.keys(RELEASE_NOTES).at(-1);
      if (shown) slot.append(createReleaseCard(shown, RELEASE_NOTES[shown]!, () => {}).element);
      return;
    }
  }
  if (!host.rhwpDesktop) return;
  let storage: Storage | undefined;
  try {
    storage = host.localStorage;
  } catch {
    return;
  }
  if (!storage) return;
  const store = storage;
  const note = pendingReleaseNotes(version, store);
  if (note) slot.append(createReleaseCard(version, note, () => markReleaseNotesSeen(version, store)).element);
}
