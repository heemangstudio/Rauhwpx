/** 집중 화면 오른쪽의 작업 칸. 칸을 여닫는 상태와 선택한 보기는 따로 둔다. 데이터와 문서 수명은 각 보기에서 관리한다. */
import './workbench.css';
import { createIcon } from './icons.ts';
import { projectIcon } from './project/project-ui.ts';

export type WorkbenchView = 'board' | 'changes' | 'agents' | 'documents';
export interface WorkbenchResource { id: string; title: string; dirty: boolean; }
export interface SidebarWorkbench {
  header: HTMLElement;
  /** 지금 보기의 머리 동작. 연결하는 쪽이 보기마다 채운다. */
  actions: HTMLElement;
  element: HTMLElement;
  /** null은 칸을 닫는다. */
  select(view: WorkbenchView | null, options?: { recordTab?: boolean }): void;
  /** 열린 칸에 탭 대신 작업 목록을 보인다. */
  showLauncher(options?: { focus?: boolean }): void;
  /** 닫혀 있으면 마지막 탭(없으면 작업 목록)으로 연다. */
  toggle(): void;
  isOpen(): boolean;
  current(): WorkbenchView | null;
  setResources(resources: readonly WorkbenchResource[], activeId: string | null): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const views: ReadonlyArray<{ id: WorkbenchView; title: string; key: string; code: string }> = [
  { id: 'board', title: '보드', key: 'B', code: 'KeyB' },
  { id: 'changes', title: '변경 사항', key: 'C', code: 'KeyC' },
  { id: 'agents', title: '서브에이전트', key: 'S', code: 'KeyS' },
  { id: 'documents', title: 'PDF · 문서', key: 'P', code: 'KeyP' },
];
const LAUNCHER_TITLE = '작업 열기';
function viewIcon(view: WorkbenchView): SVGSVGElement {
  return view === 'board' ? projectIcon('board')
    : createIcon(view === 'changes' ? 'changes' : view === 'agents' ? 'skillBot' : 'document');
}
let sequence = 0;

export function createSidebarWorkbench(deps: {
  mount(view: WorkbenchView, host: HTMLElement): void;
  onSelect(view: WorkbenchView | null): void;
  onChat(): void;
  selectResource?(id: string | null): void;
  closeResource?(id: string): void;
}): SidebarWorkbench {
  const uid = `ag-workbench-${++sequence}`;
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
  const body = document.createElement('div');
  body.className = 'ag-workbench-body';
  const strip = document.createElement('div');
  strip.className = 'ag-workbench-tabs';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', '열린 작업 탭');
  // 넘친 탭은 오른쪽 화살표 하나로 넘겨 본다. 끝에 닿으면 처음으로 돌아간다.
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'ag-workbench-scroll';
  next.setAttribute('aria-label', '다음 탭 보기');
  next.textContent = '›';
  next.addEventListener('click', () => {
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (atEnd) strip.scrollTo({ left: 0, behavior });
    else strip.scrollBy({ left: strip.clientWidth * .75, behavior });
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ag-workbench-add';
  add.title = LAUNCHER_TITLE;
  add.setAttribute('aria-label', LAUNCHER_TITLE);
  add.append(projectIcon('plus'));
  const actions = document.createElement('div');
  actions.className = 'ag-workbench-actions';
  head.append(title, strip, next, add, actions);
  // T3 Code의 빈 칸처럼 열 수 있는 작업과 글자 단축키를 보인다.
  const launcher = document.createElement('div');
  launcher.className = 'ag-workbench-launcher';
  launcher.setAttribute('role', 'group');
  const launcherTitle = document.createElement('h3');
  launcherTitle.id = `${uid}-launcher-title`;
  launcherTitle.className = 'ag-workbench-launcher-title';
  launcherTitle.textContent = LAUNCHER_TITLE;
  launcher.setAttribute('aria-labelledby', launcherTitle.id);
  const launcherList = document.createElement('div');
  launcherList.className = 'ag-workbench-launcher-list';
  launcher.append(launcherTitle, launcherList);
  body.append(launcher);
  element.append(head, body);
  let open = false;
  let lastKey: string | null = null;
  let tabDrag: { key: string; row: HTMLElement; pointerId: number; startX: number; grabX: number; moved: boolean } | null = null;
  let suppressTabClick = false;
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
  /** 탭 줄의 순서. 끌어서 바꾼 순서를 지키고, 새 탭은 끝에 붙이며, 닫힌 탭은 뺀다. */
  const order: string[] = [];
  function tabKeys(): string[] {
    const live = [...opened, ...resources.map(resource => `resource:${resource.id}`)];
    for (let index = order.length - 1; index >= 0; index -= 1) if (!live.includes(order[index])) order.splice(index, 1);
    for (const key of live) if (!order.includes(key)) order.push(key);
    return [...order];
  }
  function moveTab(key: string, to: number): void {
    const from = tabKeys().indexOf(key);
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, key);
    paintTabs();
  }
  /** 마지막으로 보이게 맞춘 탭. 같은 탭이면 다시 그리거나 크기가 바뀌어도 사용자가 옮긴 스크롤을 지킨다. */
  let revealedKey: string | null = null;
  function revealActive(): void {
    if (stripFrame !== null) cancelAnimationFrame(stripFrame);
    stripFrame = requestAnimationFrame(() => {
      stripFrame = null;
      if (disposed) return;
      const key = activeKey();
      const tab = key === revealedKey ? null : tabRows.get(key ?? '')?.row;
      if (tab && !head.hidden) {
        revealedKey = key;
        const rect = tab.getBoundingClientRect();
        const frame = strip.getBoundingClientRect();
        if (rect.left < frame.left) strip.scrollLeft += rect.left - frame.left;
        else if (rect.right > frame.right) strip.scrollLeft += rect.right - frame.right;
      }
      updateScrollControls();
    });
  }
  function updateScrollControls(): void {
    const overflow = strip.scrollWidth > strip.clientWidth + 1;
    next.hidden = !overflow;
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    next.setAttribute('aria-label', atEnd ? '처음 탭 보기' : '다음 탭 보기');
  }
  function activateTab(key: string): void {
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
      else showLauncher();
    }
    paintTabs();
    if (restoreFocus) {
      const target = tabRows.get(activeKey() ?? '')?.button ?? launcherList.querySelector('button');
      target?.focus({ preventScroll: true });
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
      if (!tabDrag?.moved && strip.children[index] !== tab.row) strip.insertBefore(tab.row, strip.children[index] ?? null);
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
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // 마우스 끌기와 같은 일을 키보드로 한다.
      event.preventDefault();
      event.stopPropagation();
      moveTab(current[0], tabKeys().indexOf(current[0]) + (event.key === 'ArrowRight' ? 1 : -1));
      tabRows.get(current[0])?.button.focus({ preventScroll: true });
      return;
    }
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
  // ── 끌어서 순서 바꾸기 ── 4px 넘게 움직이면 끌기로 본다. 끄는 탭은 포인터를 따르고 나머지는 자리를 비켜 준다.
  function keyForRow(row: Element | null): string | null {
    for (const [key, tab] of tabRows) if (tab.row === row) return key;
    return null;
  }
  function onTabPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || tabDrag || !(event.target instanceof Element)) return;
    if (event.target.closest('.ag-workbench-tab-close')) return;
    const row = event.target.closest<HTMLElement>('.ag-workbench-tab-row');
    const key = keyForRow(row);
    if (!row || !key) return;
    tabDrag = { key, row, pointerId: event.pointerId, startX: event.clientX, grabX: event.clientX - row.getBoundingClientRect().left, moved: false };
  }
  function onTabPointerMove(event: PointerEvent): void {
    const drag = tabDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.moved = true;
      strip.setPointerCapture(drag.pointerId);
      // 줄 안에서 옮기면 탭의 초점이 풀리므로 Esc는 창에서 받는다.
      window.addEventListener('keydown', onTabDragKeyDown, true);
      drag.row.classList.add('ag-dragging');
      strip.classList.add('ag-tab-dragging');
    }
    event.preventDefault();
    const frame = strip.getBoundingClientRect();
    if (event.clientX < frame.left + 24) strip.scrollLeft -= 10;
    else if (event.clientX > frame.right - 24) strip.scrollLeft += 10;
    const others = Array.from(strip.children).filter((row): row is HTMLElement => row !== drag.row && row instanceof HTMLElement);
    let index = others.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2;
    });
    if (index < 0) index = others.length;
    if (index !== Array.from(strip.children).indexOf(drag.row)) {
      const before = new Map(others.map((row) => [row, row.getBoundingClientRect().left]));
      strip.insertBefore(drag.row, others[index] ?? null);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const row of others) {
          const dx = before.get(row)! - row.getBoundingClientRect().left;
          if (dx) row.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 150, easing: 'ease-out' });
        }
      }
    }
    drag.row.style.transform = '';
    drag.row.style.transform = `translateX(${event.clientX - drag.grabX - drag.row.getBoundingClientRect().left}px)`;
  }
  function onTabDragKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !tabDrag?.moved) return;
    event.preventDefault();
    event.stopPropagation();
    endTabDrag(false);
  }
  function endTabDrag(commit: boolean): void {
    const drag = tabDrag;
    if (!drag) return;
    tabDrag = null;
    window.removeEventListener('keydown', onTabDragKeyDown, true);
    if (strip.hasPointerCapture(drag.pointerId)) strip.releasePointerCapture(drag.pointerId);
    if (!drag.moved) return;
    suppressTabClick = true;
    window.setTimeout(() => { suppressTabClick = false; }, 0);
    drag.row.style.transform = '';
    drag.row.classList.remove('ag-dragging');
    strip.classList.remove('ag-tab-dragging');
    if (commit) {
      const keys = Array.from(strip.children).map((row) => keyForRow(row)).filter((key): key is string => key !== null);
      order.splice(0, order.length, ...keys);
      if (drag.key !== activeKey()) activateTab(drag.key);
    }
    // 취소하면 원래 순서로, 끝내면 새 순서로 DOM을 맞춘다.
    paintTabs();
    tabRows.get(drag.key)?.button.focus({ preventScroll: true });
  }
  strip.addEventListener('pointerdown', onTabPointerDown);
  strip.addEventListener('pointermove', onTabPointerMove);
  strip.addEventListener('pointerup', (event) => { if (event.pointerId === tabDrag?.pointerId) endTabDrag(true); });
  strip.addEventListener('pointercancel', () => endTabDrag(false));
  strip.addEventListener('lostpointercapture', () => { if (tabDrag?.moved) endTabDrag(true); });
  // 끌기를 끝낸 뒤 따라오는 click은 탭 전환이나 닫기로 쓰지 않는다.
  strip.addEventListener('click', (event) => {
    if (!suppressTabClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
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
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ag-workbench-launcher-item';
    item.dataset.view = view.id;
    item.setAttribute('aria-keyshortcuts', view.key);
    const itemLabel = document.createElement('span');
    itemLabel.className = 'ag-workbench-launcher-label';
    itemLabel.textContent = view.title;
    const key = document.createElement('kbd');
    key.textContent = view.key;
    item.append(viewIcon(view.id), itemLabel, key);
    item.addEventListener('click', () => openFromLauncher(view.id));
    launcherList.append(item);
  }
  /** 작업 목록이 사라지면 초점이 몸체로 떨어진다. 새 탭으로 옮긴다. */
  function openFromLauncher(view: WorkbenchView): void {
    const hadFocus = launcher.contains(document.activeElement);
    activateTab(view);
    if (hadFocus) tabRows.get(view)?.button.focus({ preventScroll: true });
  }
  launcher.addEventListener('keydown', event => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const items = Array.from(launcherList.querySelectorAll<HTMLButtonElement>('button'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    // 한글 입력 상태에서도 같은 글쇠로 열리도록 문자 대신 글쇠 위치를 본다.
    const view = views.find(entry => entry.code === event.code);
    let target: HTMLButtonElement | undefined;
    if (view && !event.shiftKey) {
      event.preventDefault();
      openFromLauncher(view.id);
      return;
    }
    if (event.key === 'ArrowDown') target = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') target = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
  });
  function paint(): void {
    element.hidden = !open || !visible;
    element.inert = element.hidden;
    element.setAttribute('aria-hidden', String(element.hidden));
    head.hidden = !visible;
    launcher.hidden = selected !== null;
    for (const [id, panel] of panels) {
      panel.hidden = id !== selected;
      panel.inert = panel.hidden || !visible;
    }
    paintTabs();
  }
  function showLauncher(options?: { focus?: boolean }): void {
    if (disposed) return;
    open = true;
    selected = null;
    closingFocusedResource = null;
    title.textContent = LAUNCHER_TITLE;
    paint();
    deps.onSelect(null);
    if (options?.focus) launcherList.querySelector('button')?.focus({ preventScroll: true });
  }
  function select(view: WorkbenchView | null, options?: { recordTab?: boolean }): void {
    if (disposed) return;
    if (!view && open) lastKey = activeKey();
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
    if (!view) { closingFocusedResource = null; revealedKey = null; }
    open = view !== null;
    selected = view;
    title.textContent = views.find((entry) => entry.id === view)?.title ?? '';
    paint();
    deps.onSelect(view);
  }
  add.addEventListener('click', () => showLauncher({ focus: true }));
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    deps.onChat();
  });
  paint();
  return {
    header: head, actions, element, select, showLauncher,
    toggle() {
      if (open) { select(null); return; }
      const keys = tabKeys();
      const key = lastKey && keys.includes(lastKey) ? lastKey : keys[keys.length - 1];
      if (key) activateTab(key);
      else showLauncher({ focus: true });
    },
    isOpen: () => open,
    current: () => selected,
    setResources(next, activeId) {
      const before = tabKeys();
      const index = before.indexOf(activeKey() ?? '');
      const hadFocus = visible && open && (element.contains(document.activeElement) || document.activeElement === document.body);
      const closedActive = activeResource !== null && !activeId;
      resources = next;
      activeResource = activeId;
      // 직접 연 자료의 마지막 탭을 닫으면 탭 없는 자료 목록이 남는다. 옆 탭이나 작업 목록으로 옮긴다.
      if (closedActive && selected === 'documents' && !opened.includes('documents')) {
        const after = tabKeys();
        if (after.length) activateTab(after[Math.min(Math.max(index, 0), after.length - 1)]);
        else showLauncher({ focus: hadFocus });
        return;
      }
      paintTabs();
    },
    setVisible(next) { visible = next; paint(); },
    dispose() { disposed = true; endTabDrag(false); observer.disconnect(); if (stripFrame !== null) cancelAnimationFrame(stripFrame);
      strip.removeEventListener('wheel', onWheel); element.remove(); head.remove(); panels.clear(); tabRows.clear(); },
  };
}
