/**
 * 설정 → 보관함. 보관한 채팅을 복원하거나 영구히 지운다.
 * 목록은 채팅 저장소의 변경을 따라 다시 그린다.
 */
import {
  listArchivedThreads,
  restoreThread,
  subscribeThreadChanges,
  type ChatThread,
} from '../../agent/threads.ts';
import { setArchiveConfirmEnabled, shouldConfirmArchive } from './archive-confirm.ts';

export interface ArchiveSettingsPaneDeps {
  /** 채팅 하나를 확인 후 지운다. 사이드바의 삭제 경로를 그대로 쓴다. */
  deleteThread(thread: ChatThread): Promise<boolean>;
}

export interface ArchiveSettingsPane {
  element: HTMLElement;
  open(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatArchivedAt(at: number): string {
  return new Date(at).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function createArchiveSettingsPane(deps: ArchiveSettingsPaneDeps): ArchiveSettingsPane {
  const element = el('div', 'ag-settings-destination-content ag-archive-pane');

  const chats = el('section', 'ag-settings-group ag-pset-group');
  const heading = el('div', 'ag-settings-group-heading');
  heading.append(el('h2', 'ag-settings-group-title', '보관한 채팅'));
  const list = el('div', 'ag-pset-storage ag-archive-list');
  const body = el('div', 'ag-settings-group-body');
  body.append(list);
  chats.append(heading, body);

  // 보관 확인 스위치 — "다시 보지 않기"를 고른 뒤에도 여기서 되돌린다.
  const askGroup = el('section', 'ag-settings-group ag-pset-group');
  const askRow = el('div', 'ag-pset-row ag-pset-toggle-row');
  const askCopy = el('div', 'ag-pset-copy');
  askCopy.append(el('span', 'ag-settings-control-label', '보관 전에 묻기'));
  const askInput = el('input', 'ag-settings-toggle-input');
  askInput.type = 'checkbox';
  askInput.setAttribute('role', 'switch');
  askInput.setAttribute('aria-label', '보관 전에 묻기');
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  const askSwitch = el('label', 'ag-pset-switch');
  askSwitch.append(askInput, track);
  askRow.append(askCopy, askSwitch);
  askRow.addEventListener('click', (event) => {
    if (event.target === askRow || askCopy.contains(event.target as Node)) askInput.click();
  });
  askInput.addEventListener('change', () => setArchiveConfirmEnabled(askInput.checked));
  const askBody = el('div', 'ag-settings-group-body');
  askBody.append(askRow);
  askGroup.append(askBody);

  element.append(chats, askGroup);

  function render(): void {
    askInput.checked = shouldConfirmArchive();
    const archived = listArchivedThreads();
    list.replaceChildren();
    if (archived.length === 0) {
      const empty = el('div', 'ag-pset-row ag-archive-empty');
      empty.append(el('span', 'ag-settings-control-description', '보관한 채팅이 없습니다'));
      list.append(empty);
      return;
    }
    for (const thread of archived) {
      const row = el('div', 'ag-pset-row ag-archive-row');
      row.dataset.threadId = thread.id;
      const copy = el('div', 'ag-pset-copy');
      copy.append(
        el('span', 'ag-settings-control-label ag-archive-title', thread.title || '새 채팅'),
        el(
          'span',
          'ag-settings-control-description ag-archive-meta',
          `${thread.docKey ?? '문서 없음'} · ${formatArchivedAt(thread.archivedAt!)}`,
        ),
      );
      const actions = el('div', 'ag-settings-actions ag-pset-storage-actions');
      const restore = el('button', 'ag-settings-btn ag-archive-restore', '복원');
      restore.type = 'button';
      restore.addEventListener('click', () => restoreThread(thread.id));
      const remove = el('button', 'ag-settings-btn ag-settings-danger ag-archive-delete', '삭제');
      remove.type = 'button';
      remove.addEventListener('click', () => void deps.deleteThread(thread));
      actions.append(restore, remove);
      row.append(copy, actions);
      list.append(row);
    }
  }

  const unsubscribe = subscribeThreadChanges(() => {
    if (element.isConnected) render();
  });
  render();

  return {
    element,
    open: render,
    dispose: () => unsubscribe(),
  };
}
