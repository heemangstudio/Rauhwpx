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
  } = {},
): () => void {
  // 이름 글자와 작업 트리 표시를 나눠 둔다. 이름 바꾸기는 이름 글자만 고친다.
  const titleHost = document.getElementById?.('editor-document-title');
  const nameText = document.createElement?.('span');
  const worktreeChip = titleHost && nameText ? createWorktreeChip() : null;
  if (titleHost && nameText && worktreeChip) {
    nameText.className = 'editor-document-title-name';
    titleHost.replaceChildren(nameText, worktreeChip);
  }
  // Chromium 설치형 창은 앱 이름을 직접 붙이므로 페이지 제목에는 파일명만 둔다.
  // 일반 브라우저의 전체 화면은 설치형 창으로 분류하지 않는다.
  const appModes = window.matchMedia(
    '(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)',
  );
  const update = () => {
    const loaded = bridge.hasLoadedDocument();
    document.title = loaded
      ? (appModes.matches ? bridge.fileName : `${bridge.fileName} - HamaEditor`)
      : 'HamaEditor';
    if (!titleHost) return;
    if (nameText && worktreeChip) {
      if (!nameText.querySelector('.inline-rename-input')) nameText.textContent = loaded ? bridge.fileName : '';
      paintWorktreeChip(worktreeChip, loaded ? options.worktree?.() ?? null : null);
      titleHost.title = loaded ? [bridge.fileName, worktreeChip.title].filter(Boolean).join(' · ') : '';
    } else {
      titleHost.textContent = loaded ? bridge.fileName : '';
      titleHost.title = loaded ? bridge.fileName : '';
    }
    titleHost.hidden = !loaded;
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
      beginInlineRename(nameText, {
        value: bridge.fileName,
        label: '문서 이름',
        selectBaseName: true,
        maxLength: 255,
        commit: (name) => rename(name),
      });
    });
  }
  bridge.onFileNameChanged = update;
  appModes.addEventListener('change', update);
  update();
  return update;
}
