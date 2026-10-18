/**
 * 문서 연결 단추 — 사이드바 아래 줄의 브라우저 단추 옆. 아이콘은 지금 상태다: 문서에 붙은 채팅이면 겹친 사슬,
 * 떨어진 채팅이면 끊긴 사슬. 누르면 반대로 간다(툴팁이 그 동작). 상태가 바뀌면 사이 한 칸(꼬리만 빠진 고리)을
 * 거치므로, 분리하면 고리가 풀려 벌어지고 연결하면 다시 걸린다.
 * 모양은 document-link-toggle.css.
 */
import { createIcon, LINK_PARTING_PATH } from './icons.ts';
import './document-link-toggle.css';

export interface DocumentLinkToggle {
  readonly element: HTMLButtonElement;
  /** linked: 문서에 붙은 채팅(겹친 사슬, 누르면 분리), 아니면 끊긴 사슬(누르면 연결). disabledReason 이 있으면 비활성이고 툴팁이 그 이유다. hidden 이면 숨긴다. */
  update(state: { linked: boolean; disabledReason: string | null; hidden: boolean }): void;
}

/** 사이 한 칸을 보이는 시간. 다음 모양까지 두 칸, 200ms 쯤이다. */
const STEP_MS = 100;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createDocumentLinkToggle(onActivate: (linked: boolean) => void): DocumentLinkToggle {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'ag-doc-link-toggle';

  let linked: boolean | null = null;
  let disabled = false;
  let step = 0;
  const show = (state: boolean): void => {
    element.replaceChildren(createIcon(state ? 'link' : 'unlink'));
  };
  element.addEventListener('click', () => {
    if (disabled || linked === null) return;
    onActivate(linked);
  });

  return {
    element,
    update(state) {
      element.hidden = state.hidden;
      disabled = state.disabledReason !== null;
      // 비활성이어도 초점과 툴팁은 남긴다 — 툴팁이 이유다.
      if (disabled) element.setAttribute('aria-disabled', 'true');
      else element.removeAttribute('aria-disabled');
      const label = state.linked ? '문서에서 분리' : '문서 연결';
      element.setAttribute('aria-label', label);
      element.title = state.disabledReason ?? label;
      if (linked === state.linked) return;
      const changed = linked !== null;
      linked = state.linked;
      element.dataset.linked = String(state.linked);
      window.clearTimeout(step);
      // 처음 그릴 때와 숨어 있을 때는 바로 바꾼다. 상태가 바뀔 때만 사이 한 칸을 거친다.
      if (!changed || state.hidden || reducedMotion()) {
        show(state.linked);
        return;
      }
      const parting = createIcon('link');
      parting.querySelector('path')!.setAttribute('d', LINK_PARTING_PATH);
      element.replaceChildren(parting);
      step = window.setTimeout(() => show(state.linked), STEP_MS);
    },
  };
}
