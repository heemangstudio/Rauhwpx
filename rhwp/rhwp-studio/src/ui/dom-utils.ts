const SVG_ROOT = 'svg';

/** SVG XML 문자열을 파싱해 대상 요소에 추가한다. */
export function appendSvgMarkup(parent: Element, svgMarkup: string): void {
  const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return;

  const root = parsed.documentElement;
  if (root.nodeName.toLowerCase() !== SVG_ROOT) return;

  parent.appendChild(document.importNode(root, true));
}

/** 더 보기 창 안의 버튼이면, 명령 뒤 그 창이 닫히므로 창을 여는 버튼을 펼침 메뉴의 기준점으로 쓴다. */
export function menuAnchor(element: HTMLElement): HTMLElement {
  const popover = element.closest<HTMLElement>('[role="dialog"][id]');
  const opener = popover && document.querySelector<HTMLElement>(`[aria-controls="${popover.id}"]`);
  return opener?.getClientRects().length ? opener : element;
}

export function makeOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}
