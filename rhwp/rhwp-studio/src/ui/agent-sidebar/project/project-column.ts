/**
 * 집중 보기의 프로젝트 칸.
 *
 * 머리: 프로젝트 이름, 목표, 정리 도우미 상태, 활동·휴지통·닫기.
 * 본문: 보드 / 그래프 / 파일 탭. 활동과 휴지통은 탭 자리를 잠시 대신한다.
 * 항목을 열면 미리보기(slice D 의 createProjectPreview)가 칸 위로 밀려 들어온다.
 * 미리보기 모듈이 아직 없으면 항목 요약을 보여 주는 자리표시를 쓴다.
 */
import './project.css';
import { confirmSheet } from '../sheet.ts';
import type { ProjectService, ProjectStore } from '../../../agent/project-service.ts';
import type {
  ProjectActivityEntry,
  ProjectItem,
  ProjectSnapshot,
} from '../../../agent/types.ts';
import { createProjectBoard } from './project-board.ts';
import { createProjectFiles } from './project-files.ts';
import { createProjectGraph } from './project-graph.ts';
import type { ProjectPreviewRequest } from './project-preview.ts';
import {
  actorLabel,
  button,
  el,
  errorText,
  formatRelative,
  itemIconName,
  itemMeta,
  projectIcon,
  tagColor,
  type ProjectIconName,
} from './project-ui.ts';

export type ProjectTab = 'board' | 'graph' | 'files';
type AsideView = 'activity' | 'trash' | null;

/** 미리보기가 열 대상. 인용 칩의 `[[id#c3|…]]` 와 같은 정보다. */
export type ProjectPreviewTarget = ProjectPreviewRequest;

interface PreviewHandle {
  element: HTMLElement;
  open(target: ProjectPreviewTarget): void | Promise<void>;
  refresh?(): void;
  destroy?(): void;
}

// 미리보기(PDF 보기 포함)는 처음 열 때 불러온다. 모듈이 없으면 빈 목록이 되어 자리표시로 돌아간다.
const previewModules = import.meta.glob<typeof import('./project-preview.ts')>('./project-preview.ts');

export interface ProjectColumnDeps {
  store: ProjectStore;
  service?: ProjectService | null;
  /** 칸 닫기 단추. 없으면 단추를 숨긴다. */
  onClose?(): void;
  /** 그래프의 문서 노드를 눌렀을 때. */
  openDocument?(documentId: string): void;
  initialTab?: ProjectTab;
}

export interface ProjectColumn {
  element: HTMLElement;
  tab(): ProjectTab;
  setTab(tab: ProjectTab): void;
  openPreview(target: ProjectPreviewTarget | string): void;
  closePreview(): void;
  /** 칸이 화면에 보이는지. 그래프 시뮬레이션과 그리기를 여기에 맞춘다. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

const TABS: ReadonlyArray<{ id: ProjectTab; label: string; icon: ProjectIconName }> = [
  { id: 'board', label: '보드', icon: 'board' },
  { id: 'graph', label: '그래프', icon: 'graph' },
  { id: 'files', label: '파일', icon: 'list' },
];

let columnCount = 0;

export function createProjectColumn(deps: ProjectColumnDeps): ProjectColumn {
  const { store } = deps;
  const service = deps.service ?? null;
  const uid = `ag-project-${++columnCount}`;
  let currentTab: ProjectTab = deps.initialTab ?? 'board';
  let aside: AsideView = null;
  let visible = false;
  let project: ProjectSnapshot | null = store.get();
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let editingGoal = false;
  let preview: PreviewHandle | null = null;
  let previewLoading: Promise<PreviewHandle | null> | null = null;
  let previewOpen = false;
  let previewReturnFocus: HTMLElement | null = null;
  let activityEntries: ProjectActivityEntry[] = [];
  let trashItems: ProjectItem[] = [];
  let asideBusy = false;

  const element = el('aside', 'ag-project-column');
  element.id = uid;
  element.setAttribute('aria-labelledby', `${uid}-title`);

  // ── 머리 ──────────────────────────────────────────────
  const head = el('header', 'ag-project-head');
  const heading = el('div', 'ag-project-heading');
  const title = el('h2', 'ag-project-title');
  title.id = `${uid}-title`;
  const goal = el('button', 'ag-project-goal');
  goal.type = 'button';
  heading.append(title, goal);
  const actions = el('div', 'ag-project-head-actions');
  const librarian = el('button', 'ag-project-librarian');
  librarian.type = 'button';
  librarian.hidden = true;
  const librarianDot = el('span', 'ag-project-librarian-dot');
  librarianDot.setAttribute('aria-hidden', 'true');
  const librarianLabel = el('span', 'ag-project-librarian-label');
  librarian.append(librarianDot, librarianLabel);
  const activityButton = button('ag-project-icon-btn', '활동', { icon: 'history' });
  activityButton.setAttribute('aria-pressed', 'false');
  const trashButton = button('ag-project-icon-btn', '휴지통', { icon: 'trash' });
  trashButton.setAttribute('aria-pressed', 'false');
  const closeButton = button('ag-project-icon-btn', '프로젝트 닫기', { icon: 'close' });
  closeButton.hidden = !deps.onClose;
  actions.append(librarian, activityButton, trashButton, closeButton);
  head.append(heading, actions);

  // ── 탭 ────────────────────────────────────────────────
  const tabs = el('div', 'ag-project-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '프로젝트 보기');
  const tabButtons = new Map<ProjectTab, HTMLButtonElement>();
  const panels = new Map<ProjectTab, HTMLElement>();
  const body = el('div', 'ag-project-body');
  for (const tab of TABS) {
    const control = el('button', 'ag-project-tab');
    control.type = 'button';
    control.id = `${uid}-tab-${tab.id}`;
    control.setAttribute('role', 'tab');
    control.setAttribute('aria-controls', `${uid}-panel-${tab.id}`);
    control.append(projectIcon(tab.icon), el('span', '', tab.label));
    control.addEventListener('click', () => setTab(tab.id));
    tabButtons.set(tab.id, control);
    tabs.append(control);
    const panel = el('section', 'ag-project-panel');
    panel.id = `${uid}-panel-${tab.id}`;
    panel.dataset.tab = tab.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', control.id);
    panels.set(tab.id, panel);
    body.append(panel);
  }
  tabs.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = TABS.map((tab) => tab.id);
    const index = ids.indexOf(currentTab);
    const next = event.key === 'Home' ? ids[0]
      : event.key === 'End' ? ids[ids.length - 1]
        : ids[(index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    setTab(next);
    tabButtons.get(next)?.focus();
  });

  const asidePanel = el('section', 'ag-project-aside');
  asidePanel.hidden = true;
  asidePanel.setAttribute('aria-labelledby', `${uid}-aside-title`);
  body.append(asidePanel);

  const empty = el('div', 'ag-project-empty');
  empty.hidden = true;

  const status = el('p', 'ag-project-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const previewLayer = el('div', 'ag-project-preview');
  previewLayer.setAttribute('aria-hidden', 'true');
  previewLayer.inert = true;

  element.append(head, tabs, body, empty, status, previewLayer);

  function announce(message: string, tone?: 'error'): void {
    status.textContent = message;
    status.classList.toggle('ag-error', tone === 'error');
    status.classList.add('ag-visible');
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.classList.remove('ag-visible');
      statusTimer = null;
    }, tone === 'error' ? 6000 : 3200);
  }

  const board = createProjectBoard({ store, service, openPreview: (id) => openPreview(id), announce });
  const graph = createProjectGraph({ store, service, openPreview: (id) => openPreview(id), openDocument: deps.openDocument, announce });
  const files = createProjectFiles({ store, service, openPreview: (id) => openPreview(id), announce });
  panels.get('board')!.append(board.element);
  panels.get('graph')!.append(graph.element);
  panels.get('files')!.append(files.element);

  // ── 상태 → DOM ────────────────────────────────────────

  function renderHead(): void {
    title.textContent = project?.name || '프로젝트';
    if (!editingGoal) {
      goal.textContent = project?.goal || '목표 추가';
      goal.classList.toggle('ag-placeholder', !project?.goal);
      goal.title = project?.goal ? '목표 고치기' : '';
      goal.disabled = !project;
    }
    renderLibrarian();
  }

  function renderLibrarian(): void {
    const state = project?.librarian;
    const failed = project?.items.filter((item) => item.kind === 'file' && item.librarian.status === 'failed').length ?? 0;
    const busy = (state?.queued ?? 0) + (state?.running ?? 0);
    librarian.hidden = true;
    if (!state) return;
    if (state.state === 'paused') {
      librarian.hidden = false;
      librarian.dataset.state = 'paused';
      librarianLabel.textContent = busy ? `정리 멈춤 · ${busy}` : '정리 멈춤';
      librarian.title = '정리 다시 시작';
      librarian.setAttribute('aria-label', `정리 도우미 멈춤${busy ? `, 대기 ${busy}개` : ''}. 다시 시작`);
    } else if (state.state === 'running' || busy > 0) {
      librarian.hidden = false;
      librarian.dataset.state = 'running';
      librarianLabel.textContent = `정리 중 · ${busy}`;
      librarian.title = '정리 멈추기';
      librarian.setAttribute('aria-label', `정리 도우미 작업 중, ${busy}개. 멈추기`);
    } else if (failed > 0) {
      librarian.hidden = false;
      librarian.dataset.state = 'failed';
      librarianLabel.textContent = `정리 실패 · ${failed}`;
      librarian.title = '다시 정리';
      librarian.setAttribute('aria-label', `정리 실패 ${failed}개. 다시 정리`);
    }
  }

  function renderTabs(): void {
    for (const tab of TABS) {
      const selected = tab.id === currentTab && aside === null;
      const control = tabButtons.get(tab.id)!;
      control.classList.toggle('ag-active', tab.id === currentTab);
      control.setAttribute('aria-selected', String(tab.id === currentTab));
      control.tabIndex = tab.id === currentTab ? 0 : -1;
      const panel = panels.get(tab.id)!;
      panel.hidden = !selected;
      panel.inert = !selected;
    }
    tabs.classList.toggle('ag-muted', aside !== null);
    asidePanel.hidden = aside === null;
    activityButton.setAttribute('aria-pressed', String(aside === 'activity'));
    trashButton.setAttribute('aria-pressed', String(aside === 'trash'));
    graph.setActive(visible && aside === null && currentTab === 'graph' && !previewOpen);
  }

  function renderEmpty(): void {
    const missing = !project;
    empty.hidden = !missing;
    tabs.hidden = missing;
    body.hidden = missing;
    activityButton.disabled = missing;
    trashButton.disabled = missing;
    if (missing) {
      empty.replaceChildren(el('p', 'ag-project-empty-text', service ? '프로젝트를 불러오는 중…' : '프로젝트에 연결되지 않았습니다.'));
    }
  }

  function render(): void {
    project = store.get();
    renderHead();
    renderEmpty();
    board.update(project);
    graph.update(project);
    files.update(project);
    renderTabs();
    if (aside === 'trash' && project) void loadTrash();
  }

  function setTab(tab: ProjectTab): void {
    currentTab = tab;
    if (aside) aside = null;
    renderTabs();
  }

  // ── 목표 ──────────────────────────────────────────────

  goal.addEventListener('click', () => {
    if (!project || editingGoal) return;
    editingGoal = true;
    const input = el('textarea', 'ag-project-goal-input');
    input.value = project.goal;
    input.maxLength = 2000;
    input.rows = 2;
    input.placeholder = '이 프로젝트로 쓰려는 글';
    input.setAttribute('aria-label', '프로젝트 목표');
    goal.hidden = true;
    goal.after(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      goal.hidden = false;
      editingGoal = false;
      renderHead();
      goal.focus({ preventScroll: true });
      if (!save || !project || value === project.goal) return;
      try {
        await store.edit([{ op: 'goal', body: value }]);
      } catch (error) {
        announce(errorText(error), 'error');
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void finish(false);
      }
    });
    input.addEventListener('blur', () => void finish(true));
  });

  // ── 정리 도우미 ───────────────────────────────────────

  librarian.addEventListener('click', async () => {
    const projectId = store.projectId();
    if (!service || !projectId) return;
    const state = librarian.dataset.state;
    const action = state === 'paused' ? 'resume' : state === 'failed' ? 'retry' : 'pause';
    librarian.disabled = true;
    try {
      await service.librarian(projectId, action);
      announce(action === 'pause' ? '정리를 멈췄습니다.' : action === 'resume' ? '정리를 다시 시작합니다.' : '다시 정리합니다.');
      await store.refresh();
    } catch (error) {
      announce(errorText(error), 'error');
    } finally {
      librarian.disabled = false;
    }
  });

  // ── 활동 · 휴지통 ─────────────────────────────────────

  function asideHeader(text: string, extra?: HTMLElement): HTMLElement {
    const row = el('div', 'ag-project-aside-head');
    const back = button('ag-project-icon-btn', '돌아가기', { icon: 'back' });
    back.addEventListener('click', () => setAside(null));
    const label = el('h3', 'ag-project-aside-title', text);
    label.id = `${uid}-aside-title`;
    row.append(back, label);
    if (extra) row.append(extra);
    return row;
  }

  function renderActivity(): void {
    const list = el('ol', 'ag-project-log');
    for (const entry of activityEntries) {
      const row = el('li', 'ag-project-log-row');
      const copy = el('div', 'ag-project-log-copy');
      copy.append(
        el('span', 'ag-project-log-summary', entry.summary),
        el('span', 'ag-project-log-meta', `${actorLabel(entry.actor)} · ${formatRelative(entry.at)}`),
      );
      const undo = el('button', 'ag-project-text-btn', '되돌리기');
      undo.type = 'button';
      undo.setAttribute('aria-label', `${entry.summary} 되돌리기`);
      undo.hidden = entry.inverse.length === 0;
      undo.addEventListener('click', () => void undoEntry(entry, undo));
      row.append(copy, undo);
      list.append(row);
    }
    asidePanel.replaceChildren(asideHeader('활동'));
    if (!activityEntries.length) asidePanel.append(el('p', 'ag-project-aside-empty', asideBusy ? '불러오는 중…' : '기록이 없습니다.'));
    else asidePanel.append(list);
  }

  async function loadActivity(): Promise<void> {
    const projectId = store.projectId();
    if (!service || !projectId) return;
    asideBusy = true;
    renderActivity();
    try {
      activityEntries = await service.activity(projectId, { limit: 50 });
    } catch (error) {
      announce(errorText(error), 'error');
    } finally {
      asideBusy = false;
      if (aside === 'activity') renderActivity();
    }
  }

  async function undoEntry(entry: ProjectActivityEntry, control: HTMLButtonElement): Promise<void> {
    const projectId = store.projectId();
    if (!service || !projectId) return;
    control.disabled = true;
    try {
      const result = await service.undo(projectId, entry.id);
      announce(result.skipped
        ? `되돌렸습니다. ${result.skipped}개는 그 뒤에 바뀌어 그대로 둡니다.`
        : '되돌렸습니다.');
      await store.refresh();
      await loadActivity();
    } catch (error) {
      control.disabled = false;
      announce(errorText(error), 'error');
    }
  }

  function renderTrash(): void {
    const emptyTrash = el('button', 'ag-project-text-btn ag-project-danger', '비우기');
    emptyTrash.type = 'button';
    emptyTrash.disabled = trashItems.length === 0;
    emptyTrash.addEventListener('click', async () => {
      const projectId = store.projectId();
      if (!service || !projectId || !trashItems.length) return;
      if (!await confirmSheet(emptyTrash, '휴지통 비우기', `${trashItems.length}개 항목을 영구히 삭제합니다.`, { confirmLabel: '비우기', destructive: true })) return;
      try {
        await service.emptyTrash(projectId);
        trashItems = [];
        announce('휴지통을 비웠습니다.');
        renderTrash();
        await store.refresh();
      } catch (error) {
        announce(errorText(error), 'error');
      }
    });
    asidePanel.replaceChildren(asideHeader('휴지통', emptyTrash));
    if (!trashItems.length) {
      asidePanel.append(el('p', 'ag-project-aside-empty', asideBusy ? '불러오는 중…' : '휴지통이 비어 있습니다.'));
      return;
    }
    const list = el('ul', 'ag-project-log');
    for (const item of trashItems) {
      const row = el('li', 'ag-project-log-row ag-project-trash-row');
      const icon = projectIcon(itemIconName(item), 'ag-project-log-icon');
      const copy = el('div', 'ag-project-log-copy');
      copy.append(
        el('span', 'ag-project-log-summary', item.title),
        el('span', 'ag-project-log-meta', `${itemMeta(item)}${item.trashedAt ? ` · ${formatRelative(item.trashedAt)} 삭제` : ''}`),
      );
      const restore = el('button', 'ag-project-text-btn', '복원');
      restore.type = 'button';
      restore.setAttribute('aria-label', `${item.title} 복원`);
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        try {
          await store.edit([{ op: 'restore', id: item.id }]);
          trashItems = trashItems.filter((entry) => entry.id !== item.id);
          announce(`“${item.title}”을 복원했습니다.`);
          renderTrash();
          await store.refresh();
        } catch (error) {
          restore.disabled = false;
          announce(errorText(error), 'error');
        }
      });
      row.append(icon, copy, restore);
      list.append(row);
    }
    asidePanel.append(list);
  }

  let trashRequest = 0;
  async function loadTrash(): Promise<void> {
    const projectId = store.projectId();
    if (!service || !projectId) return;
    const request = ++trashRequest;
    asideBusy = trashItems.length === 0;
    if (asideBusy) renderTrash();
    try {
      const snapshot = await service.get(projectId, { trash: true });
      if (request !== trashRequest) return;
      trashItems = snapshot.items
        .filter((item) => item.trashedAt)
        .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
    } catch (error) {
      announce(errorText(error), 'error');
    } finally {
      asideBusy = false;
      if (aside === 'trash' && request === trashRequest) renderTrash();
    }
  }

  function setAside(next: AsideView): void {
    aside = next;
    renderTabs();
    if (next === 'activity') void loadActivity();
    else if (next === 'trash') void loadTrash();
    else tabButtons.get(currentTab)?.focus({ preventScroll: true });
    if (next) requestAnimationFrame(() => asidePanel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }));
  }

  activityButton.addEventListener('click', () => setAside(aside === 'activity' ? null : 'activity'));
  trashButton.addEventListener('click', () => setAside(aside === 'trash' ? null : 'trash'));
  closeButton.addEventListener('click', () => deps.onClose?.());

  // ── 미리보기 ──────────────────────────────────────────

  function placeholderPreview(): PreviewHandle {
    const root = el('div', 'ag-project-preview-placeholder');
    return {
      element: root,
      open(target) {
        const item = store.get()?.items.find((entry) => entry.id === target.itemId);
        const bar = el('div', 'ag-project-preview-bar');
        const back = button('ag-project-icon-btn', '미리보기 닫기', { icon: 'back' });
        back.addEventListener('click', () => closePreview());
        bar.append(back, el('span', 'ag-project-preview-title', item?.title ?? target.itemId));
        const content = el('div', 'ag-project-preview-content');
        if (item) {
          content.append(el('p', 'ag-project-preview-meta', itemMeta(item)));
          if (item.tags.length) {
            const tags = el('div', 'ag-project-preview-tags');
            for (const name of item.tags) {
              const chip = el('span', 'ag-pcard-tag', name);
              const color = project ? tagColor(project, name) : null;
              if (color) chip.style.setProperty('--ag-ptag-color', color);
              tags.append(chip);
            }
            content.append(tags);
          }
          if (item.summary) content.append(el('p', 'ag-project-preview-summary', item.summary));
        }
        root.replaceChildren(bar, content);
      },
    };
  }

  async function ensurePreview(): Promise<PreviewHandle | null> {
    if (preview) return preview;
    previewLoading ??= (async () => {
      const loader = previewModules['./project-preview.ts'];
      let handle: PreviewHandle | null = null;
      if (loader) {
        try {
          const module = await loader();
          if (service) {
            handle = module.createProjectPreview({
              service,
              project: () => store.get(),
              edit: (ops) => store.edit(ops),
              onClose: () => closePreview(),
              openDocument: deps.openDocument,
            });
          }
        } catch (error) {
          announce(`미리보기를 열지 못했습니다. ${errorText(error)}`, 'error');
        }
      }
      handle ??= placeholderPreview();
      preview = handle;
      previewLayer.append(handle.element);
      return handle;
    })();
    return previewLoading;
  }

  function openPreview(target: ProjectPreviewTarget | string): void {
    const resolved = typeof target === 'string' ? { itemId: target } : target;
    if (!previewOpen) {
      previewReturnFocus = document.activeElement instanceof HTMLElement && element.contains(document.activeElement)
        ? document.activeElement
        : null;
    }
    previewOpen = true;
    element.classList.add('ag-preview-open');
    previewLayer.setAttribute('aria-hidden', 'false');
    previewLayer.inert = false;
    renderTabs();
    void ensurePreview().then(async (handle) => {
      if (!handle || !previewOpen) return;
      await handle.open(resolved);
      if (!previewLayer.contains(document.activeElement)) {
        previewLayer.querySelector<HTMLElement>('button, [tabindex="0"], a[href]')?.focus({ preventScroll: true });
      }
    });
  }

  function closePreview(): void {
    if (!previewOpen) return;
    previewOpen = false;
    element.classList.remove('ag-preview-open');
    previewLayer.setAttribute('aria-hidden', 'true');
    previewLayer.inert = true;
    renderTabs();
    const focusTarget = previewReturnFocus?.isConnected ? previewReturnFocus : tabButtons.get(currentTab);
    previewReturnFocus = null;
    focusTarget?.focus({ preventScroll: true });
  }

  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (previewOpen) {
      event.preventDefault();
      event.stopPropagation();
      closePreview();
    } else if (aside) {
      event.preventDefault();
      event.stopPropagation();
      setAside(null);
    }
  });

  const unsubscribe = store.subscribe(() => {
    render();
    if (previewOpen) preview?.refresh?.();
  });
  render();
  if (!project && service) void store.refresh().catch((error: unknown) => announce(errorText(error), 'error'));

  return {
    element,
    tab: () => currentTab,
    setTab,
    openPreview,
    closePreview,
    setVisible(next) {
      visible = next;
      renderTabs();
    },
    dispose() {
      unsubscribe();
      if (statusTimer !== null) clearTimeout(statusTimer);
      board.dispose();
      graph.dispose();
      files.dispose();
      preview?.destroy?.();
      element.remove();
    },
  };
}
