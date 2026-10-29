import { closeDocumentDropdown } from './document-switcher/dropdown.ts';
import { beginInlineRename } from './inline-rename.ts';
import { createWorktreeChip, paintWorktreeChip, type WorktreeIdentity } from './worktree-chip.ts';

/** 메인 문서만 연결한다. 비교용 bridge는 브라우저 제목을 변경하지 않는다. */
export function installDocumentTitle(
  bridge: {
    readonly fileName: string;
    hasLoadedDocument(): boolean;
    onFileNameChanged?: (fileName: string) => void;
  },
  options: {
    /** 제목을 두 번 눌러 문서 이름을 바꾼다. 바뀐 파일 이름, 못 바꿨으면 null. */
    rename?: (name: string) => Promise<string | null>;
    /** 지금 문서의 이름을 바꿀 수 있는가. 바꿀 수 없으면 두 번 눌러도 칸을 열지 않는다. */
    canRename?: () => boolean;
    /** 같은 이름의 작업 트리 사본을 가리는 가지 표시. */
    worktree?: () => WorktreeIdentity | null;
    /** 제목을 누르면 열린 문서 목록을 편다. count 는 이 창에 열린 문서 수. */
    switcher?: { count: () => number; toggle: (anchor: HTMLElement) => void };
  } = {},
): () => void {
  // 이름 글자와 작업 트리 표시를 나눠 둔다. 이름 바꾸기는 이름 글자만 고친다.
  const titleHost = document.getElementById?.('editor-document-title');
  const nameText = document.createElement?.('span');
  const worktreeChip = titleHost && nameText ? createWorktreeChip() : null;
  const switchMark = titleHost && options.switcher ? document.createElement('span') : null;
  if (titleHost && nameText && worktreeChip) {
    nameText.className = 'editor-document-title-name';
    titleHost.replaceChildren(nameText, worktreeChip);
    if (switchMark) {
      switchMark.className = 'editor-document-switch';
      switchMark.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span');
      count.className = 'editor-document-switch-count';
      const chevron = document.createElement('span');
      chevron.className = 'editor-document-switch-chevron';
      chevron.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4.5 3 3 3-3"/></svg>';
      switchMark.append(count, chevron);
      titleHost.append(switchMark);
    }
  }
  // Chromium 설치형 창은 앱 이름을 직접 붙이므로 페이지 제목에는 파일명만 둔다.
  // 일반 브라우저의 전체 화면은 설치형 창으로 분류하지 않는다.
  const appModes = window.matchMedia(
    '(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)',
  );
  const update = () => {
    const loaded = bridge.hasLoadedDocument();
    const pageTitle = loaded
      ? (appModes.matches ? bridge.fileName : `${bridge.fileName} - HamaEditor`)
      : 'HamaEditor';
    if (document.title !== pageTitle) document.title = pageTitle;
    if (!titleHost) return;
    // 버전 상태가 바뀔 때마다(입력마다) 불리므로 값이 같으면 DOM 을 건드리지 않는다.
    const name = loaded ? bridge.fileName : '';
    if (nameText && worktreeChip) {
      if (!nameText.querySelector('.inline-rename-input') && nameText.textContent !== name) nameText.textContent = name;
      paintWorktreeChip(worktreeChip, loaded ? options.worktree?.() ?? null : null);
      const title = loaded ? [bridge.fileName, worktreeChip.title].filter(Boolean).join(', ') : '';
      if (titleHost.title !== title) titleHost.title = title;
    } else {
      if (titleHost.textContent !== name) titleHost.textContent = name;
      if (titleHost.title !== name) titleHost.title = name;
    }
    if (titleHost.hidden !== !loaded) titleHost.hidden = !loaded;
    if (switchMark && options.switcher) {
      const count = options.switcher.count();
      const countText = count > 1 ? String(count) : '';
      const countEl = switchMark.firstElementChild as HTMLElement;
      if (countEl.textContent !== countText) countEl.textContent = countText;
      titleHost.classList.toggle('editor-document-title-switcher', loaded);
      if (loaded) {
        titleHost.setAttribute('role', 'button');
        titleHost.tabIndex = 0;
        titleHost.setAttribute('aria-haspopup', 'dialog');
        titleHost.setAttribute('aria-label', count > 1 ? `열린 문서 ${count}개` : '열린 문서');
      } else {
        titleHost.removeAttribute('role');
        titleHost.removeAttribute('tabindex');
      }
    }
    // 이름을 바꿀 수 없는 문서의 제목은 창 끌기·확대를 그대로 받는다.
    if (options.rename) {
      titleHost.classList.toggle('editor-document-title-renamable', loaded && options.canRename?.() !== false);
    }
  };
  if (titleHost && nameText && options.rename) {
    const rename = options.rename;
    titleHost.addEventListener('dblclick', (event) => {
      if (!bridge.hasLoadedDocument() || options.canRename?.() === false) return;
      event.preventDefault();
      closeDocumentDropdown();
      beginInlineRename(nameText, {
        value: bridge.fileName,
        label: '문서 이름',
        selectBaseName: true,
        maxLength: 255,
        commit: (name) => rename(name),
      });
    });
  }
  if (titleHost && options.switcher) {
    const switcher = options.switcher;
    // 한 번 누르면 목록을 편다. 두 번 누르기(이름 바꾸기)의 두 번째 누름은 목록을 다시 접지 않는다.
    titleHost.addEventListener('click', (event) => {
      if (!bridge.hasLoadedDocument() || event.detail > 1) return;
      if (nameText?.querySelector('.inline-rename-input')) return;
      switcher.toggle(titleHost);
    });
    titleHost.addEventListener('keydown', (event) => {
      if (event.target !== titleHost || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      switcher.toggle(titleHost);
    });
  }
  bridge.onFileNameChanged = update;
  appModes.addEventListener('change', update);
  update();
  return update;
}
