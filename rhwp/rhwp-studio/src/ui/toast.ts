/**
 * 우상단 슬라이드 토스트 알림 (#196).
 *
 * - 크롬(제목 막대 + 도구 모음) 바로 아래 오른쪽에 쌓인다
 * - 200ms 슬라이드·페이드, 동작 줄이기 설정에서는 페이드만
 * - 자동 페이드 (기본 8초)
 * - 사용자 닫기 버튼 (×)
 * - 선택적 액션 버튼 (텍스트 링크 스타일)
 * - 일반 재사용 가능 — 다른 안내에도 활용 가능
 */

import { autofixReady, type AutofixRequest } from './autofix/autofix.ts';
import { createAutofixButton } from './autofix/autofix-button.ts';

const CONTAINER_ID = 'rhwp-toast-container';
const DEFAULT_DURATION_MS = 8000;
/** 등장·퇴장 시간. base.css 의 .rhwp-toast transition 과 같다. */
const EXIT_DURATION_MS = 200;
/** 크롬(제목 막대 + 도구 모음) 아래로 띄우는 간격 */
const CHROME_GAP_PX = 8;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** 메시지 본문 (필수). \n 줄바꿈 지원. */
  message: string;
  /** 자동 페이드 시간 (ms). 기본 8000ms. 0 이면 자동 페이드 없음 (사용자 닫기만). */
  durationMs?: number;
  /** 액션 버튼 (선택, 텍스트 링크 스타일). */
  action?: ToastAction;
  /**
   * 확인 버튼 라벨 (선택). 지정 시 우측에 명시적 확인 버튼 추가.
   * 자동 페이드를 끄고 사용자 닫기를 강제하는 용도 (durationMs: 0 와 함께 사용).
   */
  confirmLabel?: string;
  /** 오류 안내면 true — 데스크톱 앱에서 '버그 제보' 단추를 함께 둔다. */
  report?: boolean;
  /**
   * 다시 해도 풀리지 않는 오류. 자동 수정을 켠 데스크톱 앱에서는 자동 수정 단추를 앞에 두고 액션은 그 옆의
   * 링크로 남긴다(자동 수정이 실패해도 쓸 수 있다). 고치면 onFixed 를 부르고 토스트를 닫는다.
   */
  autofix?: AutofixRequest & { onFixed: () => void };
}

let reporter: (() => void) | null = null;

/** 오류 토스트의 '버그 제보' 가 부를 함수. 데스크톱 앱만 건다. */
export function setToastReporter(next: (() => void) | null): void {
  reporter = next;
}

/** 토스트 칸의 최소 폭(.rhwp-toast min-width)과 오른쪽 여백. base.css 와 같다. */
const TOAST_LANE_PX = 280 + 16;

/** 레이아웃은 남지만 보이지 않는 요소(문서 홈이 덮은 편집 화면 등)는 측정하지 않는다. */
function isShown(el: Element): boolean {
  return getComputedStyle(el).visibility !== 'hidden';
}

/**
 * 제목 막대와 도구 모음을 가리지 않도록 크롬 판 바로 아래에 둔다.
 * 오른쪽에 에이전트 사이드바 머리줄(또는 전체 화면 작업 막대)이 있으면 그 아래로 내려,
 * 들어오는 동안 반투명한 토스트가 살아 있는 조작 위에 겹쳐 보이지 않게 한다.
 * 문서 홈이 창을 덮고 있으면 뒤의 편집 크롬은 보이지 않으므로 홈 위 막대 아래에 둔다.
 */
function chromeBottom(): number {
  if (document.documentElement.classList.contains('document-home-open')) {
    const topbar = document.querySelector('.document-home .dh-topbar');
    return Math.max(0, Math.round(topbar?.getBoundingClientRect().bottom ?? 0));
  }
  const header = document.getElementById('studio-header');
  let bottom = header && isShown(header) ? header.getBoundingClientRect().bottom : 0;
  const laneLeft = window.innerWidth - TOAST_LANE_PX;
  for (const bar of document.querySelectorAll<HTMLElement>(
    '.ag-root:not(.ag-collapsed) :is(.ag-header, .ag-workspace-bar)',
  )) {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.right <= laneLeft || !isShown(bar)) continue;
    bottom = Math.max(bottom, rect.bottom);
  }
  return Math.max(0, Math.round(bottom));
}

function ensureContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.className = 'rhwp-toast-stack';
    document.body.appendChild(container);
  }
  container.style.top = `${chromeBottom() + CHROME_GAP_PX}px`;
  return container;
}

function createCloseIcon(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3 3l6 6M9 3L3 9');
  svg.appendChild(path);
  return svg;
}

/**
 * 토스트 알림을 표시한다.
 *
 * @param options 메시지·지속시간·액션
 */
export function showToast(options: ToastOptions): void {
  const container = ensureContainer();
  const duration = options.durationMs ?? DEFAULT_DURATION_MS;

  const toast = document.createElement('div');
  toast.className = 'rhwp-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  // 본문
  const body = document.createElement('div');
  body.className = 'rhwp-toast-message';
  body.textContent = options.message;
  toast.appendChild(body);

  // 자동 수정 (켠 데스크톱 앱) — 액션 앞에 선다.
  const autofix = options.autofix && autofixReady() ? options.autofix : null;
  if (autofix) {
    const { onFixed, ...request } = autofix;
    toast.appendChild(createAutofixButton({
      className: 'rhwp-toast-autofix',
      request: () => request,
      onFixed: () => {
        removeToast();
        onFixed();
      },
    }).element);
  }

  // 액션 버튼 (선택, 텍스트 링크 스타일)
  if (options.action) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'rhwp-toast-action';
    actionBtn.textContent = options.action.label;
    actionBtn.addEventListener('click', () => {
      options.action!.onClick();
      // 액션 클릭 시 토스트 자동 닫지 않음 — confirmLabel 가 있으면 사용자가 명시적으로 닫음
      if (!options.confirmLabel) removeToast();
    });
    toast.appendChild(actionBtn);
  }

  // 문제 보고 (오류 토스트, 데스크톱). 토스트가 보이는 채로 화면을 찍은 뒤 닫는다.
  const report = options.report ? reporter : null;
  if (report) {
    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'rhwp-toast-action rhwp-toast-report';
    reportBtn.textContent = '버그 제보';
    reportBtn.addEventListener('click', () => {
      report();
      window.setTimeout(removeToast, 400);
    });
    toast.appendChild(reportBtn);
  }

  // 확인 버튼 (선택, 강조 스타일) 또는 닫기 버튼
  if (options.confirmLabel) {
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'rhwp-toast-confirm';
    confirmBtn.textContent = options.confirmLabel;
    confirmBtn.addEventListener('click', () => removeToast());
    toast.appendChild(confirmBtn);
  } else {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'rhwp-toast-close';
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.appendChild(createCloseIcon());
    closeBtn.addEventListener('click', () => removeToast());
    toast.appendChild(closeBtn);
  }

  container.appendChild(toast);

  // 다음 프레임에서 들어온다 — 첫 프레임은 퇴장 위치에서 칠해져야 전환이 걸린다.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('rhwp-toast-in'));
  });

  let removed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function removeToast(): void {
    if (removed) return;
    removed = true;
    if (timer) clearTimeout(timer);
    toast.classList.remove('rhwp-toast-in');
    setTimeout(() => {
      toast.remove();
    }, EXIT_DURATION_MS);
  }

  // 자동 페이드
  if (duration > 0) {
    timer = setTimeout(removeToast, duration);
  }
}
