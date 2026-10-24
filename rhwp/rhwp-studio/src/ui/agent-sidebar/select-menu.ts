// 설정 화면 select 의 기본 팝업 대신 여는 떠 있는 메뉴. 설정 안의 모든 select 가 플랫폼과 상관없이
// 이 메뉴로 열린다. 문서 편집기의 대화상자 select 는 기본 팝업을 그대로 쓴다.
// 값의 주인은 여전히 <select> 이고, 고르면 input/change 를 그대로 보내므로 각 설정 코드는 바뀌지 않는다.
import type { AgentName } from '../../agent/types.ts';
import { AGENT_LABEL, createProviderIcon } from './providers.ts';

/** 설정 화면과, 설정에서 여는 글쓰기 보정 창의 select. */
const SETTINGS_SCOPE = '.ag-settings-page select, select.ag-settings-select, select.ag-calibration-model-select';
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const MENU_MAX_HEIGHT = 360;
/** 들어올 때 차례로 내려앉는 항목 수. 그 뒤는 함께 나타난다. */
const STAGGER_LIMIT = 8;
const TYPEAHEAD_RESET_MS = 600;

let menuSerial = 0;

function usesCustomMenu(select: HTMLSelectElement): boolean {
  if (select.disabled || select.multiple || select.size > 1) return false;
  return select.matches(SETTINGS_SCOPE);
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

type Group = { label: string; options: HTMLOptionElement[] };

/** 묶음 없는 옵션은 이름 없는 묶음 하나로 모은다. 순서는 select 그대로다. */
function groupsOf(select: HTMLSelectElement): Group[] {
  const groups: Group[] = [];
  let loose: Group | null = null;
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      loose = null;
      const options = Array.from(child.children)
        .filter((node): node is HTMLOptionElement => node instanceof HTMLOptionElement && !node.hidden);
      if (options.length) groups.push({ label: child.label, options });
    } else if (child instanceof HTMLOptionElement && !child.hidden) {
      if (!loose) groups.push(loose = { label: '', options: [] });
      loose.options.push(child);
    }
  }
  return groups;
}

const INTERACTIVE = 'input, textarea, button, a, [contenteditable], [role="switch"], [role="button"]';

/** 누른 곳에 해당하는 select. select 자체이거나, select 하나만 든 설정 줄의 빈 곳(라벨·화살표)이다. */
function selectFor(target: Element): HTMLSelectElement | null {
  const direct = target.closest('select');
  if (direct) return usesCustomMenu(direct) ? direct : null;
  if (target.closest(INTERACTIVE) || target.closest('.ag-select-menu')) return null;
  const field = target.closest('.ag-settings-page .ag-settings-field');
  const selects = field?.querySelectorAll('select');
  if (!selects || selects.length !== 1) return null;
  const select = selects[0]!;
  return usesCustomMenu(select) ? select : null;
}

/** 메뉴가 붙어 나오는 칩. 기본값 막대는 칸 전체, 다른 설정 줄은 select 자신이다. */
function anchorOf(select: HTMLSelectElement): HTMLElement {
  if (select.matches('.ag-settings-defaults select')) return select.closest<HTMLElement>('.ag-settings-field') ?? select;
  return select;
}

function providerOf(select: HTMLSelectElement, option: HTMLOptionElement): AgentName | null {
  if (!select.closest('.ag-settings-provider-field')) return null;
  return Object.hasOwn(AGENT_LABEL, option.value) ? option.value as AgentName : null;
}

function createCheck(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ag-select-menu-check');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2.5 6.3 4.9 8.6 9.5 3.6');
  svg.append(path);
  return svg;
}

export function installSelectMenus(host: HTMLElement): () => void {
  let close: (() => void) | null = null;
  let openSelect: HTMLSelectElement | null = null;
  let menuKeydown: ((event: KeyboardEvent) => void) | null = null;

  function open(select: HTMLSelectElement): void {
    close?.();
    const groups = groupsOf(select);
    if (!groups.length) return;
    const serial = ++menuSerial;
    const menu = document.createElement('div');
    menu.className = 'ag-select-menu';
    menu.id = `ag-select-menu-${serial}`;
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    const name = select.getAttribute('aria-label')
      ?? select.closest('.ag-settings-field')?.querySelector('.ag-settings-field-label')?.textContent;
    if (name) menu.setAttribute('aria-label', name);
    // 긴 목록은 안쪽 판만 스크롤한다. 바깥 판은 그림자와 테두리를 맡는다.
    const list = document.createElement('div');
    list.className = 'ag-select-menu-list';
    menu.append(list);
    // 강조 알약은 항목 사이를 미끄러져 오간다. 스크롤 내용과 함께 움직이도록 목록 안에 둔다.
    const pill = document.createElement('div');
    pill.className = 'ag-select-menu-pill';
    pill.setAttribute('aria-hidden', 'true');
    list.append(pill);

    const items: Array<{ node: HTMLElement; option: HTMLOptionElement; key: string }> = [];
    for (const group of groups) {
      let parent: HTMLElement = list;
      if (group.label || groups.length > 1) {
        parent = document.createElement('div');
        parent.className = 'ag-select-menu-group';
        parent.setAttribute('role', 'group');
        if (group.label) {
          parent.setAttribute('aria-label', group.label);
          const label = document.createElement('div');
          label.className = 'ag-select-menu-group-label';
          label.setAttribute('aria-hidden', 'true');
          label.textContent = group.label;
          parent.append(label);
        }
        list.append(parent);
      }
      for (const option of group.options) {
        const node = document.createElement('div');
        node.className = 'ag-select-menu-item';
        node.id = `${menu.id}-${items.length}`;
        node.setAttribute('role', 'option');
        const selected = option.value === select.value;
        node.setAttribute('aria-selected', String(selected));
        if (option.disabled) node.setAttribute('aria-disabled', 'true');
        if (option.title) node.title = option.title;
        if (items.length < STAGGER_LIMIT) node.style.setProperty('--ag-select-i', String(items.length));
        const provider = providerOf(select, option);
        if (provider) node.append(createProviderIcon(provider));
        const text = option.textContent?.trim() || option.label;
        const label = document.createElement('span');
        label.className = 'ag-select-menu-label';
        label.textContent = text;
        node.append(label);
        if (selected) node.append(createCheck());
        parent.append(node);
        items.push({ node, option, key: text.toLocaleLowerCase() });
      }
    }
    if (!items.length) return;

    let active = -1;
    const enabled = (index: number) => !!items[index] && !items[index]!.option.disabled;
    const placePill = (instant: boolean) => {
      const node = items[active]?.node;
      if (!node) {
        pill.classList.remove('ag-shown');
        return;
      }
      pill.classList.toggle('ag-instant', instant);
      pill.style.transform = `translate(${node.offsetLeft}px, ${node.offsetTop}px)`;
      pill.style.width = `${node.offsetWidth}px`;
      pill.style.height = `${node.offsetHeight}px`;
      pill.classList.add('ag-shown');
      if (instant) void pill.offsetWidth;
      pill.classList.remove('ag-instant');
    };
    const reveal = (node: HTMLElement) => {
      const pad = 6;
      const top = node.offsetTop - pad;
      const bottom = node.offsetTop + node.offsetHeight + pad;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    };
    const setActive = (index: number, options: { instant?: boolean; scroll?: boolean } = {}) => {
      if (!enabled(index)) return;
      items[active]?.node.classList.remove('ag-active');
      active = index;
      const node = items[active]!.node;
      node.classList.add('ag-active');
      menu.setAttribute('aria-activedescendant', node.id);
      if (options.scroll !== false) reveal(node);
      placePill(!!options.instant);
    };
    const step = (delta: number) => {
      for (let i = 1; i <= items.length; i++) {
        const next = ((active + delta * i) % items.length + items.length) % items.length;
        if (enabled(next)) return setActive(next);
      }
    };
    const edge = (fromEnd: boolean) => {
      for (let i = 0; i < items.length; i++) {
        const index = fromEnd ? items.length - 1 - i : i;
        if (enabled(index)) return setActive(index);
      }
    };
    // 첫 글자로 건너뛰기. 같은 글자를 거듭 누르면 그 글자로 시작하는 다음 항목으로 돈다.
    let typed = '';
    let typedAt = 0;
    const typeahead = (char: string) => {
      const now = performance.now();
      typed = now - typedAt > TYPEAHEAD_RESET_MS ? char : typed + char;
      typedAt = now;
      const query = [...typed].every((c) => c === typed[0]) ? typed[0]! : typed;
      const start = query.length === 1 ? active + 1 : active;
      for (let i = 0; i < items.length; i++) {
        const index = (start + i) % items.length;
        if (enabled(index) && items[index]!.key.startsWith(query)) return setActive(index);
      }
    };
    const choose = (index: number) => {
      const option = items[index]?.option;
      if (!option || option.disabled || select.disabled) return;
      const changed = select.value !== option.value;
      close?.();
      select.focus({ preventScroll: true });
      if (!changed) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const itemAt = (target: EventTarget | null) => {
      const node = target instanceof Element ? target.closest('.ag-select-menu-item') : null;
      return node ? items.findIndex((item) => item.node === node) : -1;
    };

    menu.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const index = itemAt(event.target);
      if (index < 0 || !enabled(index)) return;
      if (index !== active) setActive(index, { scroll: false });
      pill.classList.add('ag-pressed');
    });
    menu.addEventListener('click', (event) => {
      const index = itemAt(event.target);
      if (index >= 0) choose(index);
    });
    menu.addEventListener('mousemove', (event) => {
      const index = itemAt(event.target);
      if (index >= 0 && index !== active) setActive(index, { scroll: false });
    });
    menu.addEventListener('mouseup', () => pill.classList.remove('ag-pressed'));
    // 키는 host 캡처에서 받는다. 라벨 클릭이 초점을 select 로 돌려도 메뉴가 키를 잃지 않는다.
    menuKeydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') step(1);
      else if (event.key === 'ArrowUp') step(-1);
      else if (event.key === 'Home' || event.key === 'PageUp') edge(false);
      else if (event.key === 'End' || event.key === 'PageDown') edge(true);
      else if (event.key === 'Enter') choose(active);
      // 글자를 이어 치는 중의 빈칸은 이름의 일부로 본다.
      else if (event.key === ' ' && !(typed && performance.now() - typedAt < TYPEAHEAD_RESET_MS)) choose(active);
      else if (event.key === 'Escape' || event.key === 'Tab') {
        close?.();
        select.focus({ preventScroll: true });
        if (event.key === 'Tab') return;
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        typeahead(event.key.toLocaleLowerCase());
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };

    // 테마 토큰을 그대로 물려받도록 사이드바 안에 붙이고, 창 기준 좌표로 띄운다.
    const anchor = anchorOf(select);
    const field = select.closest<HTMLElement>('.ag-settings-field');
    host.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(rect.width)}px`;
    const width = menu.offsetWidth;
    const height = Math.min(menu.offsetHeight, MENU_MAX_HEIGHT);
    const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const flip = height > below && above > below;
    const room = Math.max(120, Math.floor(flip ? above : below));
    const shown = Math.min(height, room);
    // 기본값 막대는 칩의 왼쪽에 맞추고, 오른쪽에 붙은 설정 줄 select 는 오른쪽에 맞춘다.
    const preferred = anchor === select ? rect.right - width : rect.left;
    const left = Math.min(Math.max(VIEWPORT_MARGIN, preferred), window.innerWidth - width - VIEWPORT_MARGIN);
    const top = flip ? rect.top - MENU_GAP - shown : rect.bottom + MENU_GAP;
    menu.style.maxHeight = `${Math.min(room, MENU_MAX_HEIGHT)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    // 칩 가운데에서 자라 나온다.
    const originX = Math.min(Math.max(rect.left + rect.width / 2 - left, 12), width - 12);
    menu.style.transformOrigin = `${Math.round(originX)}px ${flip ? '100%' : '0'}`;
    if (flip) menu.classList.add('ag-flip');
    if (!reducedMotion()) menu.classList.add('ag-entering');
    menu.addEventListener('animationend', (event) => {
      if (event.target === menu && menu.classList.contains('ag-entering')) menu.classList.remove('ag-entering');
    });
    const current = items.findIndex((item) => item.option.value === select.value);
    if (enabled(current)) setActive(current, { instant: true });
    else {
      edge(false);
      placePill(true);
    }
    // 고른 항목이 가운데 오도록 열 때 한 번 맞춘다.
    const focusNode = items[active]?.node;
    if (focusNode && list.scrollHeight > list.clientHeight) {
      list.scrollTop = Math.max(0, focusNode.offsetTop - (list.clientHeight - focusNode.offsetHeight) / 2);
    }
    // 넘치는 쪽 가장자리만 옅게 지운다.
    const fadeEdges = () => {
      list.classList.toggle('ag-fade-top', list.scrollTop > 1);
      list.classList.toggle('ag-fade-bottom', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    };
    fadeEdges();
    list.addEventListener('scroll', fadeEdges, { passive: true });
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', menu.id);
    field?.classList.add('ag-select-open');
    openSelect = select;
    menu.focus({ preventScroll: true });

    const dismiss = (event: Event) => {
      // 같은 줄을 다시 누르면 mousedown 이 닫기를 맡는다.
      if (event.target instanceof Element && (menu.contains(event.target) || selectFor(event.target) === select)) return;
      close?.();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      close?.();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (menu.contains(next) || next === select)) return;
      if (next) close?.();
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('scroll', onScroll, true);
    menu.addEventListener('focusout', onFocusOut);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    close = () => {
      close = null;
      openSelect = null;
      menuKeydown = null;
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('scroll', onScroll, true);
      menu.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      select.setAttribute('aria-expanded', 'false');
      select.removeAttribute('aria-controls');
      field?.classList.remove('ag-select-open');
      menu.removeAttribute('aria-activedescendant');
      menu.id = '';
      for (const item of items) item.node.removeAttribute('id');
      // 닫힘은 열림보다 짧게 스러진다. 그동안 눌리지 않는다.
      if (reducedMotion() || !menu.isConnected) {
        menu.remove();
        return;
      }
      menu.classList.remove('ag-entering');
      menu.classList.add('ag-leaving');
      const remove = () => menu.remove();
      menu.addEventListener('animationend', remove, { once: true });
      window.setTimeout(remove, 200);
    };
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const select = selectFor(event.target);
    if (!select) return;
    // 기본 팝업을 막는다. 열려 있으면 같은 줄을 다시 눌러 닫는다.
    event.preventDefault();
    if (openSelect === select) {
      close?.();
      select.focus({ preventScroll: true });
      return;
    }
    select.focus({ preventScroll: true });
    open(select);
  };
  // 라벨을 누르면 click 이 select 로 넘어가 초점을 옮긴다. 메뉴가 받은 줄에서는 막는다.
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.tagName !== 'SELECT' && selectFor(event.target)) {
      event.preventDefault();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (menuKeydown) {
      menuKeydown(event);
      return;
    }
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !usesCustomMenu(select)) return;
    const opens = event.key === 'F4' || event.key === 'ArrowDown' || event.key === 'ArrowUp'
      || event.key === ' ' || event.key === 'Enter';
    if (!opens) return;
    event.preventDefault();
    open(select);
  };
  host.addEventListener('mousedown', onMouseDown, true);
  host.addEventListener('click', onClick, true);
  host.addEventListener('keydown', onKeyDown, true);
  return () => {
    close?.();
    host.removeEventListener('mousedown', onMouseDown, true);
    host.removeEventListener('click', onClick, true);
    host.removeEventListener('keydown', onKeyDown, true);
  };
}
