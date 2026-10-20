/** 자동 수정 단추 DOM. 상태와 실행은 autofix.ts 가 맡는다. 모양은 전역 style.css 가 싣는 autofix.css. */
import { createAutofixController, runAutofix, type AutofixPhase, type AutofixRequest } from './autofix.ts';

const LABELS: ReadonlyArray<[AutofixPhase, string]> = [
  ['idle', '자동 수정'],
  ['fixed', '고침'],
  ['failed', '실패'],
  ['unavailable', '사용 불가'],
];

export interface AutofixButtonOptions {
  /** 누르는 순간의 요청(제목·시도 횟수가 그때 정해진다) */
  request(): AutofixRequest;
  onFixed(): void;
  /** 자리마다 크기를 맞추는 클래스 */
  className?: string;
}

export interface AutofixButton {
  element: HTMLButtonElement;
  phase(): AutofixPhase;
  dispose(): void;
}

/**
 * 초록 자동 수정 단추. 모든 문구를 한 칸에 겹쳐 두어 상태가 바뀌어도 폭이 같다. 실행 중에는 채움이
 * 빠지고 점 셋만 물결치고, 고침은 채움 없는 초록 글자로 남는다. 다시 그려도 상태가 남도록 같은 요소를 옮겨 붙여 쓴다.
 */
export function createAutofixButton(options: AutofixButtonOptions): AutofixButton {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `rhwp-autofix${options.className ? ` ${options.className}` : ''}`;
  button.setAttribute('aria-label', '자동 수정');
  const labels = document.createElement('span');
  labels.className = 'rhwp-autofix-labels';
  labels.setAttribute('aria-hidden', 'true');
  for (const [phase, text] of LABELS) {
    const label = document.createElement('span');
    label.dataset.label = phase;
    if (phase === 'fixed') label.append(checkIcon());
    label.append(text);
    labels.append(label);
  }
  const dots = document.createElement('span');
  dots.dataset.label = 'running';
  dots.className = 'rhwp-autofix-dots';
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement('span');
    dot.className = 'rhwp-autofix-dot';
    dots.append(dot);
  }
  labels.append(dots);
  const status = document.createElement('span');
  status.className = 'rhwp-autofix-status';
  status.setAttribute('role', 'status');
  button.append(labels, status);

  const controller = createAutofixController({
    run: () => runAutofix(options.request()),
    onFixed: () => options.onFixed(),
    onPhase: (phase) => {
      button.dataset.phase = phase;
      const busy = phase !== 'idle';
      button.disabled = busy;
      if (phase === 'running') button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
      // 고침·실패·사용 불가는 스크린리더에도 알린다.
      status.textContent = LABELS.find(([key]) => key === phase && key !== 'idle')?.[1] ?? '';
    },
  });
  button.dataset.phase = 'idle';
  button.addEventListener('click', () => controller.start());
  return { element: button, phase: controller.phase, dispose: controller.dispose };
}

/** 고침 앞의 체크. 고침이 되는 순간 획이 그려진다. */
function checkIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'rhwp-autofix-check');
  svg.setAttribute('viewBox', '0 0 12 12');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2.5 6.3 5 8.7 9.5 3.6');
  path.setAttribute('pathLength', '1');
  svg.append(path);
  return svg;
}

/** 자리의 단추를 갈아 끼운다. 이미 그 단추면 그대로 둔다. 초점이 있던 단추면 새 단추로 옮긴다. */
export function swapSlot(current: HTMLElement, next: HTMLElement): void {
  if (current === next || !current.parentNode) return;
  const focused = current.contains(document.activeElement);
  current.replaceWith(next);
  if (focused) next.focus({ preventScroll: true });
}
