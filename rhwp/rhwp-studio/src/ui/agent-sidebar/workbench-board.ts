import './workbench-board.css';
import type { ProjectClient } from '../../agent/project-service.ts';
import { createProjectColumn, type ProjectTab } from './project/project-column.ts';
import type { ProjectPreviewRequest } from './project/project-preview.ts';
import { button, el, errorText, projectIcon } from './project/project-ui.ts';

export interface WorkbenchBoardDeps {
  client: ProjectClient | null;
  openPreview(request: ProjectPreviewRequest): void;
  openDocument?(documentId: string): void;
}

export interface WorkbenchBoard {
  element: HTMLElement;
  setVisible(visible: boolean): void;
  setTab(tab: ProjectTab): void;
  dispose(): void;
}

/** 작업 보기는 프로젝트 저장소를 그대로 쓰며 보드 편집·자료 업로드를 함께 유지한다. */
export function createWorkbenchBoard(deps: WorkbenchBoardDeps): WorkbenchBoard {
  const element = el('section', 'ag-workbench-board');
  element.setAttribute('aria-label', '자료 보드');
  const empty = el('div', 'ag-workbench-board-empty');
  const icon = projectIcon('board', 'ag-workbench-board-empty-icon');
  const title = el('h3', '', deps.client ? '연결된 프로젝트가 없습니다' : '프로젝트에 연결되지 않았습니다');
  const message = el('p', '', deps.client ? '이 문서의 프로젝트 자료를 불러옵니다.' : '에이전트에 연결하면 자료 보드를 사용할 수 있습니다.');
  message.setAttribute('role', 'status');
  const retry = button('ag-workbench-board-retry', '다시 불러오기', { icon: 'refresh' });
  retry.hidden = !deps.client;
  empty.append(icon, title, message, retry);
  element.append(empty);

  const client = deps.client;
  const column = client ? createProjectColumn({
    store: client.store,
    service: client.service,
    worktrees: client.worktrees,
    initialTab: 'board',
    openPreview: deps.openPreview,
    openDocument: deps.openDocument,
  }) : null;
  if (column) element.append(column.element);

  const count = el('span', 'ag-workbench-board-count');
  count.setAttribute('aria-label', '자료 수');
  column?.element.querySelector('.ag-project-heading')?.append(count);
  let visible = false;
  let disposed = false;

  function render(): void {
    if (disposed) return;
    const project = client?.store.get();
    empty.hidden = Boolean(project);
    if (column) {
      column.element.hidden = !project;
      column.setVisible(visible && Boolean(project));
    }
    if (project) {
      const items = project.items.filter((item) => !item.trashedAt);
      count.textContent = `자료 ${items.length}`;
    }
  }

  retry.addEventListener('click', async () => {
    if (!client || retry.disabled || disposed) return;
    retry.disabled = true;
    message.textContent = '자료를 불러오는 중…';
    element.setAttribute('aria-busy', 'true');
    try {
      const project = await client.store.refresh();
      if (disposed) return;
      message.textContent = project ? '' : '이 문서에 연결된 프로젝트가 없습니다.';
    } catch (error) {
      if (disposed) return;
      message.textContent = errorText(error);
    } finally {
      if (!disposed) {
        retry.disabled = false;
        element.removeAttribute('aria-busy');
        render();
      }
    }
  });

  const unsubscribe = client?.store.subscribe(render);
  render();
  return {
    element,
    setTab(tab) { column?.setTab(tab); },
    setVisible(next) {
      visible = next;
      column?.setVisible(next && Boolean(client?.store.get()));
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      column?.dispose();
      element.remove();
    },
  };
}
