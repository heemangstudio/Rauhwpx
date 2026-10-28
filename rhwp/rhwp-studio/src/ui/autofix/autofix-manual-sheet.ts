/**
 * 직접 부르는 자동 수정 시트. 사용자가 지금 상태를 짧게 적으면 그 글을 오류 대신 넘겨 자동 수정을 돌린다.
 * 버그 제보 시트의 면(ag-sheet)과 입력 칸(ir-field)을 그대로 쓴다.
 *
 * 적기 → 고치는 중 → 결과. 고쳤으면 이제 잘 되는지 묻고 그 답을 확인 결과로 메인에 알린다(아직 안 되면
 * 적은 글을 그대로 두고 다시 고칠 수 있다 — 다음 실행은 앞선 시도를 맥락으로 받는다). 고치지 못했으면
 * 원인과 버그 제보를 보인다. 고치는 중에 닫아도 실행은 이어지고, 끝나면 토스트로 알려 결과를 다시 연다.
 * 고치는 동안은 픽셀 하마가 못을 박고(autofix-hama.ts) 지난 시간을 센다.
 */
import '../agent-sidebar/sheet.css';
import '../issue-report/issue-report.css';
import './autofix-manual.css';
import { isTopModal, popModal, pushModal } from '../modal-stack.ts';
import { showToast } from '../toast.ts';
import { createAutofixHama, type AutofixHama } from './autofix-hama.ts';
import { noteAutofixOutcome, runAutofixResult, type AutofixResult } from './autofix.ts';

export const MANUAL_AUTOFIX_SURFACE = 'manual';
const DESCRIPTION_MAX = 2000;
const TITLE_MAX = 120;

export interface ManualAutofixSheetOptions {
  /** 고치지 못했을 때 버그 제보를 연다. 없으면 단추를 두지 않는다. */
  reportIssue?: () => void;
  /** 실행이 시작되고 끝날 때(제목 막대 단추의 표시) */
  onBusy?: (busy: boolean) => void;
}

/** 시트를 닫아도 남는 실행: 고치는 중이거나, 고쳤는데 아직 잘 되는지 답하지 않았다. */
interface ManualRun {
  description: string;
  promise: Promise<AutofixResult>;
  result: AutofixResult | null;
  startedAt: number;
}

let current: ManualRun | null = null;
/** 보내지 않았거나 아직 안 된다고 답한 글. 다음에 열 때 다시 채운다. */
let draft = '';
let openSheet: { focus(): void; show(result: AutofixResult): void } | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 지난 시간: 0:07, 3:42 */
export function formatAutofixElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 적은 글의 첫 줄이 보고의 제목이 된다. */
export function manualAutofixRequest(description: string) {
  const text = description.trim().slice(0, DESCRIPTION_MAX);
  const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return {
    surface: MANUAL_AUTOFIX_SURFACE,
    title: firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine,
    detail: text,
    attempts: 0,
  };
}

const UNAVAILABLE_TEXT = '자동 수정을 쓸 수 없습니다. 설정의 AI에서 Codex나 Claude에 로그인되어 있는지 확인하세요.';

function startRun(description: string, options: ManualAutofixSheetOptions): ManualRun {
  const run: ManualRun = { description, promise: runAutofixResult(manualAutofixRequest(description)), result: null, startedAt: Date.now() };
  current = run;
  options.onBusy?.(true);
  void run.promise.then((result) => {
    run.result = result;
    options.onBusy?.(false);
    if (current !== run) return;
    // 고치지 못했거나 쓸 수 없으면 답을 기다릴 것이 없다. 적은 글은 다음에 다시 쓸 수 있게 남긴다.
    if (result.status !== 'fixed') {
      current = null;
      draft = description;
    }
    if (openSheet) {
      openSheet.show(result);
      return;
    }
    showToast({
      message: result.status === 'fixed'
        ? '자동 수정을 마쳤습니다. 이제 잘 되는지 알려 주세요.'
        : result.status === 'unavailable' ? UNAVAILABLE_TEXT : '자동 수정이 고치지 못했습니다.',
      durationMs: result.status === 'fixed' ? 0 : 8000,
      ...(result.status === 'unavailable' ? {} : { action: { label: '결과 보기', onClick: () => openManualAutofixSheet(options, result) } }),
    });
  });
  return run;
}

/**
 * 시트를 연다. 이미 열려 있으면 앞으로 가져온다. 고치는 중이면 진행을, 고쳤는데 답하지 않았으면 결과를 보인다.
 * shown 은 이미 끝난 실행의 결과를 다시 보일 때(토스트의 결과 보기) 쓴다.
 */
export function openManualAutofixSheet(options: ManualAutofixSheetOptions = {}, shown: AutofixResult | null = null): void {
  if (openSheet) {
    openSheet.focus();
    return;
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = el('div', 'ag-sheet-layer ir-layer afm-layer');
  layer.dataset.host = 'body';
  layer.dataset.placement = 'center';
  const backdrop = el('div', 'ag-sheet-backdrop');
  const sheet = el('section', 'ag-sheet ir-sheet afm-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'afm-title');
  sheet.tabIndex = -1;

  const title = el('h2', 'ag-sheet-title', '자동 수정');
  title.id = 'afm-title';
  const lead = el('p', 'ag-sheet-message afm-lead', '무엇이 이상한지 짧게 적어 주세요. AI가 이 컴퓨터의 앱 설정과 실행 기록을 살펴 고칩니다. 문서는 건드리지 않습니다.');
  const message = el('textarea', 'ir-field ir-message afm-message');
  message.placeholder = '예: 사이드바가 계속 연결 중에서 멈춰 있어요';
  message.setAttribute('aria-label', '지금 상태');
  message.maxLength = DESCRIPTION_MAX;
  message.rows = 3;

  const status = el('div', 'afm-status');
  const stage = el('div', 'afm-stage');
  // 지난 시간은 초마다 바뀌므로 스크린리더에 알리지 않는다. 상태 글만 알린다.
  const elapsed = el('span', 'afm-elapsed');
  elapsed.setAttribute('aria-hidden', 'true');
  const statusText = el('span', 'afm-status-text');
  statusText.setAttribute('role', 'status');
  status.append(stage, elapsed, statusText);

  const result = el('div', 'afm-result');
  const resultHead = el('p', 'afm-result-head');
  const cause = el('p', 'afm-cause');
  const question = el('p', 'afm-question', '이제 잘 되나요?');
  result.append(resultHead, cause, question);

  const actions = el('div', 'ag-sheet-actions');
  const cancel = el('button', 'ag-sheet-btn ag-sheet-cancel', '취소');
  cancel.type = 'button';
  const report = el('button', 'ag-sheet-btn ag-sheet-cancel afm-report', '버그 제보');
  report.type = 'button';
  const confirm = el('button', 'ag-sheet-btn ag-sheet-confirm', '자동 수정');
  confirm.type = 'button';
  actions.append(cancel, report, confirm);

  sheet.append(title, lead, message, status, result, actions);
  layer.append(backdrop, sheet);
  document.body.appendChild(layer);

  type View = 'form' | 'running' | 'fixed' | 'failed' | 'unavailable';
  let view: View = 'form';
  let closed = false;
  const modalToken = {};
  let hama: AutofixHama | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;

  /** 고치는 동안만 하마가 움직이고 시계가 간다. */
  const animate = (on: boolean): void => {
    if (on && !hama) {
      hama = createAutofixHama();
      stage.append(hama.element);
      const tick = () => { elapsed.textContent = `고치는 중 · ${formatAutofixElapsed(Date.now() - (current?.startedAt ?? Date.now()))}`; };
      tick();
      clock = setInterval(tick, 1000);
    } else if (!on && hama) {
      hama.dispose();
      hama.element.remove();
      hama = null;
      if (clock !== null) clearInterval(clock);
      clock = null;
    }
  };

  const render = (next: View, outcome: AutofixResult | null = null, retry = false): void => {
    view = next;
    sheet.dataset.view = next;
    const form = next === 'form';
    message.readOnly = !form;
    message.hidden = next === 'unavailable';
    lead.hidden = !form;
    status.hidden = next !== 'running' && !(form && retry);
    stage.hidden = next !== 'running';
    elapsed.hidden = next !== 'running';
    statusText.textContent = next === 'running'
      ? '창을 닫아도 됩니다'
      : '아직 안 되면 다시 고쳐 볼 수 있습니다. AI가 앞선 시도를 참고합니다.';
    animate(next === 'running');
    result.hidden = form || next === 'running';
    question.hidden = next !== 'fixed';
    resultHead.textContent = next === 'fixed' ? '고쳤습니다.' : next === 'failed' ? '고치지 못했습니다.' : UNAVAILABLE_TEXT;
    cause.textContent = outcome?.cause ? `원인: ${outcome.cause}` : '';
    cause.hidden = !outcome?.cause || next === 'unavailable';
    report.hidden = next !== 'failed' || !options.reportIssue;
    cancel.textContent = form ? '취소' : next === 'fixed' ? '아직 안 돼요' : '닫기';
    confirm.hidden = !(form || next === 'fixed');
    confirm.textContent = next === 'fixed' ? '잘 돼요' : '자동 수정';
    syncConfirm();
  };
  const syncConfirm = (): void => {
    confirm.disabled = view === 'form' && message.value.trim().length === 0;
  };
  message.addEventListener('input', syncConfirm);

  const focusables = (): HTMLElement[] => [...sheet.querySelectorAll<HTMLElement>(
    'textarea:not([disabled]):not([hidden]), button:not([disabled]):not([hidden])',
  )].filter((node) => node.offsetParent !== null);

  const close = (): void => {
    if (closed) return;
    closed = true;
    openSheet = null;
    animate(false);
    if (view === 'form') draft = message.value;
    document.removeEventListener('keydown', onKeyDown, true);
    popModal(modalToken);
    layer.classList.remove('ag-sheet-open');
    layer.classList.add('ag-sheet-closing');
    if (reducedMotion()) layer.remove();
    else window.setTimeout(() => layer.remove(), 480);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };

  /** 고친 뒤의 답. 아직 안 되면 적은 글을 남겨 다시 고칠 수 있게 한다. */
  const answer = (ok: boolean): void => {
    const run = current;
    current = null;
    noteAutofixOutcome(MANUAL_AUTOFIX_SURFACE, ok);
    if (ok) {
      draft = '';
      close();
      return;
    }
    message.value = run?.description ?? message.value;
    render('form', null, true);
    message.focus({ preventScroll: true });
  };

  const submit = (): void => {
    if (view !== 'form' || confirm.disabled) return;
    const description = message.value.trim();
    draft = '';
    render('running');
    startRun(description, options);
  };

  const dismiss = (): void => {
    // 고친 뒤 답하지 않고 닫으면 확인은 메인이 기다리다 '확인 못 함'으로 보낸다. 다음에 열면 다시 묻는다.
    if (view === 'failed' || view === 'unavailable') current = null;
    close();
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (!isTopModal(modalToken)) return;
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (view === 'form') submit();
      return;
    }
    if (event.key !== 'Tab') {
      // 시트 밖 편집기·사이드바 단축키가 받지 않게 한다.
      if (sheet.contains(event.target as Node)) event.stopPropagation();
      return;
    }
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !sheet.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  cancel.addEventListener('click', () => {
    if (view === 'fixed') answer(false);
    else dismiss();
  });
  confirm.addEventListener('click', () => {
    if (view === 'fixed') answer(true);
    else submit();
  });
  report.addEventListener('click', () => {
    close();
    options.reportIssue?.();
  });
  backdrop.addEventListener('click', dismiss);
  pushModal(modalToken);
  document.addEventListener('keydown', onKeyDown, true);

  const show = (outcome: AutofixResult): void => {
    if (closed) return;
    if (outcome.status === 'fixed') render('fixed', outcome);
    else render(outcome.status === 'unavailable' ? 'unavailable' : 'failed', outcome);
    (view === 'fixed' ? confirm : cancel).focus({ preventScroll: true });
  };
  openSheet = {
    focus: () => (view === 'form' ? message : sheet).focus({ preventScroll: true }),
    show,
  };

  if (current && !current.result) {
    message.value = current.description;
    render('running');
  } else if (current?.result?.status === 'fixed') {
    message.value = current.description;
    show(current.result);
  } else if (shown) {
    message.value = draft;
    show(shown);
  } else {
    message.value = draft;
    render('form');
  }
  requestAnimationFrame(() => {
    layer.classList.add('ag-sheet-open');
    if (view === 'form') message.focus({ preventScroll: true });
    else if (view === 'running') sheet.focus({ preventScroll: true });
  });
}
