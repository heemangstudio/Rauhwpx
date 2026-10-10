/** 사이드바 위의 탭과 작업 면. 데이터와 문서 수명은 각 보기에서 관리한다. */
import './workbench.css';
import { createIcon } from './icons.ts';
import { projectIcon } from './project/project-ui.ts';

export type WorkbenchView = 'board' | 'changes' | 'agents' | 'documents';
export interface WorkbenchResource { id: string; title: string; dirty: boolean; }
export interface SidebarWorkbench {
  navigation: HTMLElement;
  header: HTMLElement;
  /** 지금 보기의 머리 동작. 연결하는 쪽이 보기마다 채운다. */
  actions: HTMLElement;
  element: HTMLElement;
  select(view: WorkbenchView | null, options?: { recordTab?: boolean }): void;
  current(): WorkbenchView | null;
  setResources(resources: readonly WorkbenchResource[], activeId: string | null): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const views: ReadonlyArray<{ id: WorkbenchView; title: string }> = [
  { id: 'board', title: '보드' },
  { id: 'changes', title: '변경 사항' },
  { id: 'agents', title: '서브에이전트' },
  { id: 'documents', title: 'PDF · 문서' },
];
let sequence = 0;

export function createSidebarWorkbench(deps: {
  mount(view: WorkbenchView, host: HTMLElement): void;
  onSelect(view: WorkbenchView | null): void;
  onChat(): void;
  selectResource?(id: string | null): void;
  closeResource?(id: string): void;
}): SidebarWorkbench {
  const uid = `ag-workbench-${++sequence}`;
  const navigation = document.createElement('nav');
  navigation.className = 'ag-workbench-nav';
  navigation.setAttribute('aria-label', '작업 보기');
  const controls = new Map<WorkbenchView, HTMLButtonElement>();
  const element = document.createElement('section');
  element.className = 'ag-workbench-page';
  element.id = uid;
  element.hidden = true;
  element.inert = true;
  const head = document.createElement('header');
  head.className = 'ag-workbench-head';
  const title = document.createElement('h2');
  title.id = `${uid}-title`;
  title.className = 'ag-workbench-title';
  element.setAttribute('aria-labelledby', title.id);
  const close = document.createElement('button');
  close.className = 'ag-workbench-back';
  close.type = 'button';
  close.title = '대화로 돌아가기';
  close.setAttribute('aria-label', close.title);
  close.append(createIcon('close'));
  const body = document.createElement('div');
  body.className = 'ag-workbench-body';
  const strip = document.createElement('div');
  strip.className = 'ag-workbench-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', '열린 작업 탭');
  const previous = document.createElement('button');
  const next = document.createElement('button');
  for (const [button, label, direction] of [[previous, '이전 탭 보기', -1], [next, '다음 탭 보기', 1]] as const) {
    button.type = 'button';
    button.className = 'ag-workbench-scroll';
    button.setAttribute('aria-label', label);
    button.textContent = direction === -1 ? '‹' : '›';
    button.addEventListener('click', () => strip.scrollBy({ left: direction * strip.clientWidth * .75,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }
  const actions = document.createElement('div');
  actions.className = 'ag-workbench-actions';
  head.append(title, previous, strip, next, actions, close);
  element.append(head, body);
  let selected: WorkbenchView | null = null;
  let visible = true;
  let disposed = false;
  const panels = new Map<WorkbenchView, HTMLElement>();
  const opened: WorkbenchView[] = [];
  let closingFocusedResource: string | null = null;
  let resources: readonly WorkbenchResource[] = [];
  let activeResource: string | null = null;
  let stripFrame: number | null = null;
  let tabSequence = 0;
  const tabRows = new Map<string, { row: HTMLElement; button: HTMLButtonElement; label: HTMLElement; close: HTMLButtonElement }>();
  function activeKey(): string | null {
    return selected === 'documents' && activeResource ? `resource:${activeResource}` : selected;
  }
  function tabKeys(): string[] { return [...opened, ...resources.map(resource => `resource:${resource.id}`)]; }
  function revealActive(): void {
    if (stripFrame !== null) cancelAnimationFrame(stripFrame);
    stripFrame = requestAnimationFrame(() => {
      stripFrame = null;
      if (disposed) return;
      const tab = tabRows.get(activeKey() ?? '')?.row;
      if (tab && !head.hidden) {
        const rect = tab.getBoundingClientRect();
        const frame = strip.getBoundingClientRect();
        if (rect.left < frame.left) strip.scrollLeft += rect.left - frame.left;
        else if (rect.right > frame.right) strip.scrollLeft += rect.right - frame.right;
      }
      updateScrollControls();
    });
  }
  function updateScrollControls(): void {
    previous.disabled = strip.scrollWidth <= strip.clientWidth + 1 || strip.scrollLeft <= 1;
    next.disabled = strip.scrollWidth <= strip.clientWidth + 1 || strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    for (const button of [previous, next]) {
      // 버튼 자리를 유지하여 가로 스크롤이 ResizeObserver의 선택 탭 복귀를 일으키지 않게 한다.
      button.style.visibility = button.disabled ? 'hidden' : 'visible';
    }
  }
  function activateTab(key: string): void {
    if (key === 'chat') { deps.onChat(); return; }
    if (key.startsWith('resource:')) {
      select('documents', { recordTab: false });
      deps.selectResource?.(key.slice(9));
    } else {
      select(key as WorkbenchView);
      if (key === 'documents') deps.selectResource?.(null);
    }
  }
  function closeTab(key: string): void {
    if (key.startsWith('resource:')) {
      if (tabRows.get(key)?.row.contains(document.activeElement)) closingFocusedResource = key;
      deps.closeResource?.(key.slice(9));
      return;
    }
    const before = tabKeys();
    const index = before.indexOf(key);
    const position = opened.indexOf(key as WorkbenchView);
    if (position < 0) return;
    const restoreFocus = tabRows.get(key)?.row.contains(document.activeElement);
    opened.splice(position, 1);
    if (activeKey() === key) {
      const after = tabKeys();
      if (after.length) activateTab(after[Math.min(index, after.length - 1)]);
      else select(null);
    }
    paintTabs();
    if (restoreFocus) {
      const target = tabRows.get(activeKey() ?? '')?.button;
      if (target) target.focus({ preventScroll: true });
      else deps.onChat();
    }
  }
  function paintTabs(): void {
    const keys = tabKeys();
    const focused = strip.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    let restoreFocus = false;
    for (const [key, tab] of tabRows) {
      if (!keys.includes(key)) {
        restoreFocus ||= tab.row.contains(document.activeElement);
        tab.row.remove(); tabRows.delete(key);
      }
    }
    for (const [index, key] of keys.entries()) {
      let tab = tabRows.get(key);
      if (!tab) {
        const row = document.createElement('div');
        row.className = 'ag-workbench-tab-row';
        const button = document.createElement('button');
        button.className = 'ag-workbench-tab';
        button.type = 'button';
        button.id = `${uid}-tab-${++tabSequence}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', `${uid}-panel-${key.startsWith('resource:') ? 'documents' : key}`);
        if (key.startsWith('resource:')) button.dataset.resourceId = key.slice(9);
        else button.dataset.view = key;
        const label = document.createElement('span');
        label.className = 'ag-workbench-tab-label';
        const icon = key === 'board' ? projectIcon('board') : createIcon(key === 'changes' ? 'changes' : key === 'agents' ? 'skillBot' : 'document');
        button.append(icon, label);
        const closeButton = document.createElement('button');
        closeButton.className = 'ag-workbench-tab-close';
        closeButton.type = 'button';
        closeButton.tabIndex = -1;
        closeButton.append(createIcon('close'));
        row.append(button, closeButton);
        button.addEventListener('click', () => activateTab(key));
        closeButton.addEventListener('click', () => closeTab(key));
        row.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); closeTab(key); } });
        tab = { row, button, label, close: closeButton };
        tabRows.set(key, tab);
        strip.append(row);
      }
      if (strip.children[index] !== tab.row) strip.insertBefore(tab.row, strip.children[index] ?? null);
      const resource = key.startsWith('resource:') ? resources.find(item => `resource:${item.id}` === key) : null;
      const label = resource?.title ?? (views.find(view => view.id === key)?.title ?? '');
      tab.label.textContent = label;
      tab.button.title = label;
      tab.button.setAttribute('aria-label', label);
      tab.close.setAttribute('aria-label', `${label} 닫기`);
      tab.close.hidden = false;
      tab.row.classList.toggle('ag-dirty', resource?.dirty ?? false);
      const isActive = key === activeKey();
      tab.row.classList.toggle('ag-selected', isActive);
      tab.button.setAttribute('aria-selected', String(isActive));
      tab.button.tabIndex = isActive ? 0 : -1;
      if (isActive) panels.get(selected!)?.setAttribute('aria-labelledby', tab.button.id);
    }
    const closeRemoved = closingFocusedResource !== null && !keys.includes(closingFocusedResource);
    const target = tabRows.get(activeKey() ?? '')?.button;
    if ((restoreFocus || closeRemoved) && target) {
      target.focus({ preventScroll: true });
      closingFocusedResource = null;
    }
    else if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    revealActive();
  }
  strip.addEventListener('keydown', event => {
    const current = Array.from(tabRows.entries()).find(([, tab]) => tab.button === event.target);
    if (!current) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); closeTab(current[0]); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const keys = tabKeys();
    const index = keys.indexOf(current[0]);
    const position = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    activateTab(keys[position]);
    tabRows.get(keys[position])?.button.focus({ preventScroll: true });
  });
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.deltaX || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  };
  strip.addEventListener('wheel', onWheel, { passive: false });
  strip.addEventListener('scroll', updateScrollControls, { passive: true });
  const observer = new ResizeObserver(revealActive);
  observer.observe(strip);
  for (const view of views) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-workbench-launch';
    button.dataset.view = view.id;
    button.setAttribute('aria-label', view.title);
    button.setAttribute('aria-controls', uid);
    const icon = view.id === 'board' ? projectIcon('board')
      : createIcon(view.id === 'changes' ? 'changes' : view.id === 'agents' ? 'skillBot' : 'document');
    const label = document.createElement('span');
    label.textContent = view.title;
    button.append(icon, label);
    button.addEventListener('click', () => activateTab(view.id));
    controls.set(view.id, button);
    navigation.append(button);
  }
  function paint(): void {
    element.hidden = selected === null || !visible;
    element.inert = element.hidden;
    element.setAttribute('aria-hidden', String(element.hidden));
    head.hidden = !visible;
    close.hidden = selected === null;
    for (const [id, panel] of panels) {
      panel.hidden = id !== selected;
      panel.inert = panel.hidden || !visible;
    }
    for (const [view, button] of controls) {
      button.classList.toggle('ag-selected', selected === view);
      button.setAttribute('aria-expanded', String(selected === view && visible));
    }
    paintTabs();
  }
  function select(view: WorkbenchView | null, options?: { recordTab?: boolean }): void {
    if (disposed) return;
    if (view !== null && !panels.has(view)) {
      const panel = document.createElement('div');
      panel.className = `ag-workbench-panel ag-workbench-${view}`;
      panel.dataset.view = view;
      panel.id = `${uid}-panel-${view}`;
      panel.setAttribute('role', 'tabpanel');
      body.append(panel);
      panels.set(view, panel);
      deps.mount(view, panel);
    }
    if (view && options?.recordTab !== false && !opened.includes(view)) opened.push(view);
    if (!view) closingFocusedResource = null;
    selected = view;
    title.textContent = views.find((entry) => entry.id === view)?.title ?? '';
    paint();
    deps.onSelect(view);
  }
  close.addEventListener('click', () => {
    activateTab('chat');
  });
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close.click();
  });
  paint();
  return {
    navigation, header: head, actions, element, select,
    current: () => selected,
    setResources(next, activeId) {
      const before = tabKeys();
      const index = before.indexOf(activeKey() ?? '');
      const hadFocus = visible && (element.contains(document.activeElement) || document.activeElement === document.body);
      const closedActive = activeResource !== null && !activeId;
      resources = next;
      activeResource = activeId;
      // 직접 연 자료의 마지막 탭을 닫으면 탭 없는 자료 목록이 남는다. 옆 탭으로 옮기거나 대화로 돌아간다.
      if (closedActive && selected === 'documents' && !opened.includes('documents')) {
        const after = tabKeys();
        if (after.length) activateTab(after[Math.min(Math.max(index, 0), after.length - 1)]);
        else if (hadFocus) deps.onChat();
        else select(null);
        return;
      }
      paintTabs();
    },
    setVisible(next) { visible = next; paint(); },
    dispose() { disposed = true; observer.disconnect(); if (stripFrame !== null) cancelAnimationFrame(stripFrame);
      strip.removeEventListener('wheel', onWheel); element.remove(); head.remove(); navigation.remove(); controls.clear(); panels.clear(); tabRows.clear(); },
  };
}
