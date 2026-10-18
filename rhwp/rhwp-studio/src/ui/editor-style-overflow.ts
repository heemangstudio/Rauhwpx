type OverflowItem = { element: HTMLElement; anchor: Comment; field: boolean };

/** Keeps the formatting fields compact while preserving each command's original listener. */
export class EditorStyleOverflow {
  /** 문서 순서. 더 보기 창에도 이 순서로 쌓는다. */
  private readonly items: OverflowItem[];
  /** 폭이 모자랄 때 먼저 접는 순서. 기본은 명령 띠 단위, 한 줄 도구 상자는 필드와 명령 묶음 단위. */
  private readonly bandFoldOrder: OverflowItem[];
  private readonly singleRowFoldOrder: OverflowItem[];
  private readonly more: HTMLButtonElement;
  private readonly popover: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private lastWidth = -1;
  /** 한 줄 도구 상자: 두 줄 격자 대신 필드도 더 보기로 접는다. */
  singleRow = false;
  /** 모든 필드와 명령을 펼쳤을 때의 폭 */
  naturalWidth = 0;
  onLayout: (() => void) | null = null;

  constructor(private readonly bar: HTMLElement) {
    const item = (element: HTMLElement, field: boolean): OverflowItem => {
      const anchor = document.createComment(field ? 'format field' : 'format band');
      element.before(anchor);
      return { element, anchor, field };
    };
    const field = (selector: string) => item(bar.querySelector(selector)!.closest<HTMLElement>('.sb-field')!, true);
    const [styleName, fontLang, lineSpacing] = ['#style-name', '#font-lang', '#linespacing-select'].map(field);
    const bands = Array.from(bar.querySelectorAll<HTMLElement>(':scope > .sb-command-band')).map(band => item(band, false));
    const groups = Array.from(bar.querySelectorAll<HTMLElement>(':scope > .sb-command-band > .sb-ribbon-group'))
      .map(group => item(group, false));
    this.items = [styleName, fontLang, lineSpacing, ...bands, ...groups];
    this.bandFoldOrder = [...bands].reverse();
    // 문단 정렬부터 접고, 필드 다음 글자색·글자 서식 순서로 접는다.
    this.singleRowFoldOrder = [groups[groups.length - 1], lineSpacing, styleName, fontLang, ...groups.slice(0, -1).reverse()];
    this.more = document.createElement('button');
    this.more.id = 'style-bar-more';
    this.more.type = 'button';
    this.more.title = '서식 더 보기';
    this.more.setAttribute('aria-label', '서식 더 보기');
    this.more.setAttribute('aria-haspopup', 'dialog');
    this.more.setAttribute('aria-expanded', 'false');
    this.more.setAttribute('aria-controls', 'style-bar-overflow');
    this.more.innerHTML = '<span aria-hidden="true">⋯</span><span class="sb-more-label">더 보기</span>';
    this.more.hidden = true;
    this.popover = document.createElement('div');
    this.popover.id = 'style-bar-overflow';
    this.popover.setAttribute('role', 'dialog');
    this.popover.setAttribute('aria-label', '서식 더 보기');
    this.popover.hidden = true;
    this.content = document.createElement('div');
    this.popover.append(this.content);
    bar.querySelector('.sb-collapse-btn')?.before(this.more);
    bar.append(this.popover);

    this.more.addEventListener('click', () => this.popover.hidden ? this.open() : this.close(true));
    this.popover.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('.sb-btn');
      if (button && !button.classList.contains('sb-has-arrow')) this.close(false);
    });
    this.bar.addEventListener('focusout', this.onFocusOut);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.observer = new ResizeObserver(() => {
      if (bar.clientWidth !== this.lastWidth) this.refresh();
    });
    this.observer.observe(bar);
    window.addEventListener('resize', this.onResize);
    this.refresh();
  }

  refresh(): void {
    const width = this.bar.clientWidth;
    if (!width) return;
    this.lastWidth = width;
    const focused = this.bar.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const wasOpen = !this.popover.hidden;
    this.bar.style.visibility = 'hidden';
    this.restore();
    this.bar.removeAttribute('data-style-compact');
    this.bar.toggleAttribute('data-style-condensed', this.singleRow || width < 700);
    this.more.hidden = false;
    const field = this.bar.querySelector<HTMLElement>('.sb-field-ribbon-group')!;
    const collapse = this.bar.querySelector<HTMLElement>('.sb-collapse-btn')!;
    const style = getComputedStyle(this.bar);
    const outer = (element: HTMLElement): number => {
      const css = getComputedStyle(element);
      if (css.display === 'none') return 0;
      return element.getBoundingClientRect().width
        + (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
    };
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const available = width - padding;
    const used = Array.from(this.bar.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement
        && child !== this.more && child !== this.popover)
      .reduce((sum, child) => sum + outer(child), 0);
    this.naturalWidth = Math.ceil(padding + used);
    if (!this.singleRow && outer(field) + outer(this.more) + outer(collapse) > available) {
      this.bar.setAttribute('data-style-compact', '');
      this.items.filter(item => this.bandFoldOrder.includes(item)).forEach(({ element }) => this.content.append(element));
    } else if (used > available) {
      const fieldGap = parseFloat(getComputedStyle(field.querySelector('.sb-field-grid')!).columnGap) || 0;
      let remaining = used + outer(this.more);
      const folded = new Set<OverflowItem>();
      for (const item of this.singleRow ? this.singleRowFoldOrder : this.bandFoldOrder) {
        if (remaining <= available) break;
        remaining -= outer(item.element) + (item.field ? fieldGap : 0);
        folded.add(item);
      }
      this.items.filter(item => folded.has(item)).forEach(({ element }) => this.content.append(element));
    }
    this.more.hidden = this.content.childElementCount === 0;
    if (this.more.hidden || !wasOpen) this.close(false);
    else this.open();
    this.bar.style.visibility = '';
    if (focused && document.activeElement !== focused) {
      if (focused.getClientRects().length && !this.popover.hidden) focused.focus({ preventScroll: true });
      else if (!this.more.hidden) this.more.focus({ preventScroll: true });
    }
    this.onLayout?.();
  }

  private restore(): void {
    this.items.forEach(({ element, anchor }) => anchor.after(element));
  }

  private open(): void {
    if (this.more.hidden) return;
    this.popover.hidden = false;
    this.more.setAttribute('aria-expanded', 'true');
    this.bar.classList.add('sb-overflow-open');
    const anchor = this.more.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, innerWidth - this.popover.offsetWidth - 8));
    const top = Math.max(8, Math.min(anchor.bottom + 4, innerHeight - this.popover.offsetHeight - 8));
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${top}px`;
  }

  private close(focusMore: boolean): void {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.more.setAttribute('aria-expanded', 'false');
    this.bar.classList.remove('sb-overflow-open');
    if (focusMore) this.more.focus({ preventScroll: true });
  }

  private readonly onResize = (): void => this.refresh();
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.popover.hidden && !this.popover.contains(event.target as Node)
      && !this.more.contains(event.target as Node)) this.close(false);
  };
  private readonly onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (!this.popover.hidden && next instanceof Node
      && !this.popover.contains(next) && !this.more.contains(next)) this.close(false);
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.popover.hidden) return;
    const dropdown = this.popover.querySelector<HTMLElement>('.sb-dropdown.open');
    if (dropdown) { dropdown.classList.remove('open'); return; }
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };
}
