// Windows 의 기본 <select> 팝업은 앱 테마와 따로 노는 흰 상자다. 설정 화면의 select 는
// Windows 데스크톱에서 이 작은 메뉴로 연다. 값의 주인은 여전히 <select> 이고, 고르면
// input/change 를 그대로 보내므로 각 설정 코드는 바뀌지 않는다.

const SCOPE = '.ag-settings-page select';
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

function usesCustomMenu(select: HTMLSelectElement): boolean {
  return document.documentElement.classList.contains('desktop-windows')
    && !select.disabled
    && !select.multiple
    && select.size <= 1
    && select.matches(SCOPE);
}

type Entry = { kind: 'group'; label: string } | { kind: 'option'; option: HTMLOptionElement };

function entriesOf(select: HTMLSelectElement): Entry[] {
  const entries: Entry[] = [];
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      if (child.label) entries.push({ kind: 'group', label: child.label });
      for (const option of Array.from(child.children)) {
        if (option instanceof HTMLOptionElement && !option.hidden) entries.push({ kind: 'option', option });
      }
    } else if (child instanceof HTMLOptionElement && !child.hidden) {
      entries.push({ kind: 'option', option: child });
    }
  }
  return entries;
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

export function installSelectMenus(host: HTMLElement): () => void {
  let close: (() => void) | null = null;
  let openSelect: HTMLSelectElement | null = null;
  let menuKeydown: ((event: KeyboardEvent) => void) | null = null;

  function open(select: HTMLSelectElement): void {
    close?.();
    const menu = document.createElement('div');
    menu.className = 'ag-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    const items: Array<{ node: HTMLElement; option: HTMLOptionElement }> = [];
    for (const entry of entriesOf(select)) {
      if (entry.kind === 'group') {
        const group = document.createElement('div');
        group.className = 'ag-select-menu-group';
        group.textContent = entry.label;
        menu.append(group);
        continue;
      }
      const node = document.createElement('div');
      node.className = 'ag-select-menu-item';
      node.setAttribute('role', 'option');
      node.textContent = entry.option.textContent ?? entry.option.label;
      const selected = entry.option.value === select.value;
      node.setAttribute('aria-selected', String(selected));
      if (entry.option.disabled) node.setAttribute('aria-disabled', 'true');
      menu.append(node);
      items.push({ node, option: entry.option });
    }
    if (!items.length) return;

    let active = Math.max(0, items.findIndex((item) => item.option.value === select.value));
    const setActive = (index: number) => {
      items[active]?.node.classList.remove('ag-active');
      active = index;
      items[active]?.node.classList.add('ag-active');
      items[active]?.node.scrollIntoView({ block: 'nearest' });
    };
    const step = (delta: number) => {
      for (let i = 1; i <= items.length; i++) {
        const next = (active + delta * i + items.length * i) % items.length;
        if (!items[next]!.option.disabled) return setActive(next);
      }
    };
    const choose = (index: number) => {
      const option = items[index]?.option;
      if (!option || option.disabled) return;
      const changed = select.value !== option.value;
      close?.();
      select.focus({ preventScroll: true });
      if (!changed) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    menu.addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
      const index = items.findIndex((item) => item.node === (event.target as Element).closest('.ag-select-menu-item'));
      if (index >= 0) choose(index);
    });
    menu.addEventListener('mousemove', (event) => {
      const index = items.findIndex((item) => item.node === (event.target as Element).closest('.ag-select-menu-item'));
      if (index >= 0 && index !== active && !items[index]!.option.disabled) setActive(index);
    });
    // 키는 host 캡처에서 받는다. 라벨 클릭이 초점을 select 로 돌려도 메뉴가 키를 잃지 않는다.
    menuKeydown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') step(1);
      else if (event.key === 'ArrowUp') step(-1);
      else if (event.key === 'Home') setActive(items.findIndex((item) => !item.option.disabled));
      else if (event.key === 'End') {
        for (let i = items.length - 1; i >= 0; i--) if (!items[i]!.option.disabled) { setActive(i); break; }
      } else if (event.key === 'Enter' || event.key === ' ') choose(active);
      else if (event.key === 'Escape' || event.key === 'Tab') {
        close?.();
        select.focus({ preventScroll: true });
        if (event.key === 'Tab') return;
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };

    // 테마 토큰을 그대로 물려받도록 사이드바 안에 붙이고, 창 기준 좌표로 띄운다.
    host.append(menu);
    const rect = select.getBoundingClientRect();
    const width = Math.max(rect.width, menu.offsetWidth);
    const below = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const height = menu.offsetHeight;
    const flip = height > below && above > below;
    menu.style.minWidth = `${Math.round(rect.width)}px`;
    menu.style.maxHeight = `${Math.max(120, Math.floor(flip ? above : below))}px`;
    menu.style.left = `${Math.round(Math.min(Math.max(VIEWPORT_MARGIN, rect.right - width), window.innerWidth - width - VIEWPORT_MARGIN))}px`;
    menu.style.top = flip
      ? `${Math.round(rect.top - MENU_GAP - Math.min(height, above))}px`
      : `${Math.round(rect.bottom + MENU_GAP)}px`;
    if (flip) menu.classList.add('ag-flip');
    setActive(active);
    select.setAttribute('aria-expanded', 'true');
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
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    close = () => {
      close = null;
      openSelect = null;
      menuKeydown = null;
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      select.setAttribute('aria-expanded', 'false');
      menu.remove();
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
    const opens = event.key === 'F4'
      || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
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
