import type { BrowserEvent } from '../../agent/types.ts';

export type AgentPointerPhase = 'move' | 'down' | 'up' | 'click';
/** 허브가 보낸 에이전트 포인터. 좌표는 페이지 뷰포트의 CSS px(Playwright page.mouse와 같은 공간)이다. */
export interface AgentPointer { tabId: string; x: number; y: number; phase: AgentPointerPhase; durationMs: number }

/** 너무 긴 이동은 다음 동작을 가린다. 허브 값이 이상해도 이 범위에서 끝낸다. */
const MAX_GLIDE_MS = 600;
const PHASES: readonly AgentPointerPhase[] = ['move', 'down', 'up', 'click'];

export function readAgentPointer(event: BrowserEvent): AgentPointer | null {
  if (event.type !== 'owned_browser_pointer') return null;
  const tabId = event.tab?.tabId ?? event.tabId;
  const { x, y, phase, durationMs } = event as { x?: unknown; y?: unknown; phase?: unknown; durationMs?: unknown };
  if (typeof tabId !== 'string' || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!PHASES.includes(phase as AgentPointerPhase)) return null;
  const duration = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, Math.min(MAX_GLIDE_MS, durationMs)) : 0;
  return { tabId, x, y, phase: phase as AgentPointerPhase, durationMs: duration };
}

/**
 * 페이지 뷰포트 좌표를 화면에 그린 프레임 위 좌표로 옮긴다.
 * `displayed`는 커서를 그리는 상자 기준의 프레임 위치와 크기다. 프레임 밖이면 그리지 않는다.
 */
export function viewportPointToDisplay(point: { x: number; y: number }, viewport: { width: number; height: number },
  displayed: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (!(viewport.width > 0 && viewport.height > 0 && displayed.width > 0 && displayed.height > 0)) return null;
  if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) return null;
  return { x: displayed.left + point.x * displayed.width / viewport.width, y: displayed.top + point.y * displayed.height / viewport.height };
}

const ARROW = '<svg viewBox="0 0 18 22" width="18" height="22" aria-hidden="true"><path d="M2 2v15.2l3.9-3.6 2.8 6.3 2.7-1.2-2.8-6.2h5.3z"/></svg>';

/**
 * 프레임 위에 그리는 에이전트 커서. 페이지 DOM에는 넣지 않는다.
 * 이동은 CSS 전환으로 미끄러지고, 누름은 이동이 끝난 뒤(실제 클릭 약 40 ms 전)에 짧게 줄어든다.
 */
export function createAgentCursor(host: HTMLElement, { idleMs = 1200 } = {}) {
  const node = document.createElement('div'); node.className = 'ag-browser-agent-cursor'; node.hidden = true; node.setAttribute('aria-hidden', 'true');
  node.innerHTML = ARROW; host.append(node);
  let shown = false; let remembered = false; let phaseTimer: ReturnType<typeof setTimeout> | null = null; let idleTimer: ReturnType<typeof setTimeout> | null = null; let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = (timer: ReturnType<typeof setTimeout> | null) => { if (timer) clearTimeout(timer); return null; };
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** `forget`가 아니면 마지막 자리를 기억해 다음 동작이 그 자리에서 미끄러져 나온다. */
  function hide(forget = true): void {
    phaseTimer = clear(phaseTimer); idleTimer = clear(idleTimer); releaseTimer = clear(releaseTimer);
    shown = false; node.hidden = true; delete node.dataset.pressed; delete node.dataset.idle;
    if (forget) remembered = false;
  }
  function land(phase: AgentPointerPhase): void {
    phaseTimer = null; releaseTimer = clear(releaseTimer);
    if (phase === 'down') node.dataset.pressed = 'true';
    else if (phase === 'up') delete node.dataset.pressed;
    else if (phase === 'click') { node.dataset.pressed = 'true'; releaseTimer = setTimeout(() => { releaseTimer = null; delete node.dataset.pressed; }, 110); }
    // 끌기 중에는 놓을 때까지 남긴다. 다음 동작이 없으면 조용히 사라진다.
    idleTimer = clear(idleTimer);
    idleTimer = setTimeout(() => { node.style.transitionDuration = '200ms'; node.dataset.idle = 'true'; idleTimer = setTimeout(() => hide(false), 220); }, node.dataset.pressed === 'true' && phase !== 'click' ? idleMs * 4 : idleMs);
  }
  return {
    element: node,
    /** `to`는 커서 상자 기준 좌표다. */
    show(pointer: AgentPointer, to: { x: number; y: number }): void {
      phaseTimer = clear(phaseTimer); idleTimer = clear(idleTimer);
      const target = `translate(${to.x}px, ${to.y}px)`;
      if (!shown) {
        node.style.transitionDuration = '0ms'; if (!remembered) node.style.transform = target;
        node.hidden = false; shown = true; void node.offsetWidth;
      }
      const duration = remembered && !reducedMotion() ? pointer.durationMs : 0;
      delete node.dataset.idle;
      node.style.transitionDuration = `${duration}ms`; node.style.transform = target; remembered = true;
      phaseTimer = setTimeout(() => land(pointer.phase), duration);
    },
    hide: () => hide(),
    visible: () => shown,
    dispose(): void { hide(); node.remove(); },
  };
}
export type AgentCursor = ReturnType<typeof createAgentCursor>;
