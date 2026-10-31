/**
 * 업데이트한 뒤 첫 실행에 앱 위로 뜨는 릴리스 노트 창. 처음 설정과 같은 모양의 가운데 카드로,
 * 위에 상자를 연 픽셀 하마를 두고 아래에 버전과 노트 전부를 새 기능·고친 문제로 나눠 보인다.
 *
 * 부트 화면이 걷히고 처음 설정이 닫힌 뒤에 뜨고, 뜨면 본 것으로 적는다. 확인·닫기·Esc·바깥
 * 누르기로 닫는다. 다음 실행부터는 뜨지 않는다.
 */
import './release-card.css';
import { createReleaseHama } from '../agent-sidebar/chat-hama.ts';
import { createIcon } from '../agent-sidebar/icons.ts';
import { afterBootScreen } from '../boot-screen.ts';
import { isInitialSetupActive, onInitialSetupInactive } from '../initial-setup/active.ts';
import {
  markReleaseNotesSeen,
  pendingReleaseNotes,
  RELEASE_NOTES,
  type ReleaseNote,
} from './release-notes.ts';

/** 닫히는 전환(release-card.css 의 .rn-overlay)이 끝난 뒤 떼어 낸다. */
const CLOSE_MS = 420;

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

export interface ReleaseNotesWindow {
  element: HTMLElement;
  close(): void;
}

export function openReleaseNotes(version: string, note: ReleaseNote): ReleaseNotesWindow {
  const overlay = el('div', 'rn-overlay');
  const dialog = el('section', 'rn-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const scene = el('div', 'rn-scene');
  const light = createReleaseHama(true);
  const dark = createReleaseHama(false);
  light.classList.add('rn-hama-light');
  dark.classList.add('rn-hama-dark');
  scene.append(light, dark);

  const close = el('button', 'rn-close');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.title = '닫기';
  close.append(createIcon('close'));

  const title = el('h2', 'rn-title', `HamaEditor ${version}`);
  title.id = `rn-title-${version.replace(/\W/g, '-')}`;
  dialog.setAttribute('aria-labelledby', title.id);
  const groups = el('div', 'rn-groups');
  groups.append(...[group('added', '새 기능', note.added), group('fixed', '고친 문제', note.fixed)]
    .filter((node): node is HTMLElement => node !== null));

  const footer = el('footer', 'rn-footer');
  const confirm = el('button', 'rn-confirm', '확인');
  confirm.type = 'button';
  footer.append(confirm);

  dialog.append(scene, close, title, groups, footer);
  overlay.append(dialog);

  const lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }

  function dismiss(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.classList.remove('rn-open');
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    window.setTimeout(() => overlay.remove(), CLOSE_MS);
  }

  close.addEventListener('click', dismiss);
  confirm.addEventListener('click', dismiss);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKeyDown, true);

  document.body.append(overlay);
  requestAnimationFrame(() => {
    if (closed) return;
    overlay.classList.add('rn-open');
    dialog.focus({ preventScroll: true });
  });
  return { element: overlay, close: dismiss };
}

function whenSetupInactive(): Promise<void> {
  if (!isInitialSetupActive()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = onInitialSetupInactive(() => {
      stop();
      resolve();
    });
  });
}

interface ReleaseNotesHost {
  rhwpDesktop?: unknown;
  location?: { search: string };
  localStorage?: Storage;
}

/**
 * 데스크톱 앱이면 이번 버전의 노트를 띄운다. Vite 개발 서버에서는 `?release-notes` 로
 * 본 기록과 상관없이 가장 최근 노트를 띄운다(`?release-notes=3.0.11` 처럼 버전을 고를 수도 있다).
 */
export async function showPendingReleaseNotes(host: ReleaseNotesHost = window, version = __APP_VERSION__): Promise<void> {
  let shown: string | undefined;
  let onShown = (): void => {};
  const forced = import.meta.env.DEV ? new URLSearchParams(host.location?.search ?? '').get('release-notes') : null;
  if (forced !== null) {
    shown = forced && RELEASE_NOTES[forced] ? forced : Object.keys(RELEASE_NOTES).at(-1);
  } else {
    if (!host.rhwpDesktop) return;
    let storage: Storage | undefined;
    try {
      storage = host.localStorage;
    } catch {
      return;
    }
    if (!storage || !pendingReleaseNotes(version, storage)) return;
    const store = storage;
    shown = version;
    onShown = () => markReleaseNotesSeen(version, store);
  }
  if (!shown) return;
  await afterBootScreen();
  await whenSetupInactive();
  openReleaseNotes(shown, RELEASE_NOTES[shown]!);
  onShown();
}
