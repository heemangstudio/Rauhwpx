/**
 * 미리보기의 프로젝트 장면 (`?project=board|graph|files`). 사이드바가 붙인 실제 프로젝트
 * 칸을 sidebar.openProject 로 연다 — 앱과 같은 경로다.
 */
import type { AgentSidebarHandle } from '../ui/agent-sidebar/index.ts';
import type { ProjectTab } from '../ui/agent-sidebar/project/project-column.ts';

export interface ProjectScene {
  open(options?: { tab?: ProjectTab; itemId?: string }): Promise<void>;
  close(): void;
  column(): HTMLElement | null;
}

async function until(read: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!read()) {
    if (performance.now() > deadline) throw new Error('project column did not open');
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export function createProjectScene(sidebar: Pick<AgentSidebarHandle, 'root' | 'openProject'>): ProjectScene {
  const root = sidebar.root;
  const column = () => root.querySelector<HTMLElement>('.ag-project-column');
  return {
    async open(options = {}) {
      sidebar.openProject(options.itemId ? { itemId: options.itemId } : undefined, options.tab);
      await until(() => root.classList.contains('ag-project-drawer-open') && column() !== null);
    },
    close() {
      column()?.querySelector<HTMLButtonElement>('button[aria-label="프로젝트 닫기"]')?.click();
    },
    column,
  };
}
