import type { EditorToolbarOverflow } from './editor-toolbar-overflow';
import type { EditorStyleOverflow } from './editor-style-overflow';

export const COMPACT_TOOLBAR_ATTR = 'data-compact-toolbar';

/**
 * 한 줄 도구 상자: 기본 도구 상자(아이콘)와 서식 도구 상자를 한 줄에 나눠 담는다.
 * 서식 칸이 먼저 폭을 갖고, 기본 도구 상자는 남는 폭에서 뒤쪽 묶음부터 더 보기로 접는다.
 * 헤더의 data-compact-toolbar 속성이 켜짐 상태다.
 */
export class CompactToolbarLayout {
  private readonly resizeObserver: ResizeObserver;
  private readonly attributeObserver: MutationObserver;
  private lastWidth = -1;
  private enabled = false;

  constructor(
    private readonly header: HTMLElement,
    private readonly ribbon: EditorToolbarOverflow,
    private readonly style: EditorStyleOverflow,
  ) {
    ribbon.onLayout = () => this.layout();
    style.onLayout = () => this.layout();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.header.clientWidth !== this.lastWidth) this.layout();
    });
    this.resizeObserver.observe(header);
    this.attributeObserver = new MutationObserver(() => this.sync());
    this.attributeObserver.observe(header, { attributes: true, attributeFilter: [COMPACT_TOOLBAR_ATTR] });
    this.sync();
  }

  private sync(): void {
    const enabled = this.header.hasAttribute(COMPACT_TOOLBAR_ATTR);
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.style.singleRow = enabled;
    if (!enabled) {
      this.ribbonBar.style.removeProperty('flex-basis');
      this.styleBar.style.removeProperty('flex-basis');
    }
    this.lastWidth = -1;
    this.ribbon.refresh();
    this.style.refresh();
    this.layout();
    // 켜고 끄는 명령이 보낸 resize 는 배치가 끝나기 전의 헤더 높이를 잰다.
    // 다시 알려 편집 영역과 사이드바가 바뀐 헤더 아래에 자리 잡게 한다.
    window.dispatchEvent(new Event('resize'));
  }

  private get ribbonBar(): HTMLElement {
    return this.header.querySelector<HTMLElement>('#icon-toolbar')!;
  }

  private get styleBar(): HTMLElement {
    return this.header.querySelector<HTMLElement>('#style-bar')!;
  }

  private layout(): void {
    if (!this.enabled) return;
    const width = this.header.clientWidth;
    if (!width) return;
    this.lastWidth = width;
    const styleNatural = this.style.naturalWidth;
    const ribbonNatural = this.ribbon.naturalWidth;
    const styleWidth = styleNatural + ribbonNatural <= width
      ? styleNatural
      : Math.max(0, Math.min(styleNatural, width - this.ribbon.minimumWidth));
    // 기본 도구 상자는 펼친 묶음만큼만 차지하고, 남는 폭은 서식 칸 뒤 줄 끝으로 간다.
    this.setBasis(this.ribbonBar, this.ribbon.fitWidth(width - styleWidth));
    this.setBasis(this.styleBar, styleWidth);
  }

  private setBasis(element: HTMLElement, width: number): void {
    const basis = `${Math.max(0, Math.ceil(width))}px`;
    if (element.style.flexBasis !== basis) element.style.flexBasis = basis;
  }
}
