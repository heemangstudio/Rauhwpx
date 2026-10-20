/**
 * 문제 보고 시트. 확인 시트(ag-sheet)의 층·면·버튼을 그대로 쓰고 입력 칸만 더한다.
 * 보내기에 실패하면 시트와 쓴 글을 그대로 두고 짧은 오류만 보인다.
 */
import '../agent-sidebar/sheet.css';
import './issue-report.css';
import type { IssueReportFailureCode, IssueReportResult } from './types.ts';
import type { PreparedScreenshot } from './screenshot.ts';

export interface IssueReportSheetForm {
  message: string;
  email: string;
  unblur: boolean;
  includeChat: boolean;
  document: { name: string; bytes: Uint8Array } | null;
}

export interface IssueReportSheetOptions {
  screenshot: PreparedScreenshot | null;
  /** '보낼 정보' 에 그대로 보이는 글(앱 정보와 진단 기록). */
  info: string;
  message: string;
  email: string;
  chatAvailable: boolean;
  /** 열린 문서. 없으면 문서 포함을 끈다. */
  documentAvailable: boolean;
  /** 문서 포함을 켤 때 지금 문서를 내보낸다. 보낼 수 없으면 이유를 준다. */
  loadDocument(): Promise<{ name: string; bytes: Uint8Array } | { reason: string }>;
  submit(form: IssueReportSheetForm): Promise<IssueReportResult>;
  /** 닫힐 때 한 번. sent 가 아니면 쓰던 글을 다음에 다시 채운다. */
  onClose(state: { sent: boolean; message: string; email: string }): void;
}

const FAILURE_TEXT: Record<IssueReportFailureCode, string> = {
  rate_limited: '보고가 많아 잠시 받을 수 없습니다. 나중에 다시 보내십시오.',
  busy: '서버가 다른 보고를 받는 중입니다. 잠시 뒤 다시 보내십시오.',
  too_large: '첨부가 너무 큽니다. 문서나 대화를 빼고 보내십시오.',
  offline: '서버에 연결하지 못했습니다. 인터넷 연결을 확인하십시오.',
  timeout: '서버가 응답하지 않습니다. 다시 보내십시오.',
  invalid: '보고를 보내지 못했습니다.',
  rejected: '보고를 보내지 못했습니다.',
  server: '보고를 보내지 못했습니다. 잠시 뒤 다시 보내십시오.',
};

export function issueReportFailureText(result: Extract<IssueReportResult, { ok: false }>): string {
  if (result.code === 'invalid' && result.field === 'email') return '이메일 주소를 확인하십시오.';
  return FAILURE_TEXT[result.code] ?? FAILURE_TEXT.server;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

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

function choice(label: string): { row: HTMLLabelElement; box: HTMLInputElement; reason: HTMLSpanElement } {
  const row = el('label', 'ag-sheet-choice');
  const box = el('input');
  box.type = 'checkbox';
  const reason = el('span', 'ir-choice-reason');
  reason.hidden = true;
  row.append(box, document.createTextNode(label), reason);
  return { row, box, reason };
}

let openSheet: { focus(): void } | null = null;

/** 열린 문제 보고 시트가 있으면 앞으로 가져온다. */
export function focusOpenIssueReport(): boolean {
  if (!openSheet) return false;
  openSheet.focus();
  return true;
}

export function openIssueReportSheet(options: IssueReportSheetOptions): void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = el('div', 'ag-sheet-layer ir-layer');
  layer.dataset.host = 'body';
  layer.dataset.placement = 'center';
  const backdrop = el('div', 'ag-sheet-backdrop');
  const sheet = el('section', 'ag-sheet ir-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'ir-title');
  sheet.tabIndex = -1;

  const title = el('h2', 'ag-sheet-title', '문제 보고');
  title.id = 'ir-title';

  const message = el('textarea', 'ir-field ir-message');
  message.placeholder = '문제 설명';
  message.setAttribute('aria-label', '문제 설명');
  message.maxLength = 5000;
  message.rows = 5;
  message.value = options.message;

  const email = el('input', 'ir-field ir-email');
  email.type = 'email';
  email.placeholder = '답장 받을 이메일';
  email.setAttribute('aria-label', '답장 받을 이메일');
  email.autocomplete = 'email';
  email.maxLength = 254;
  email.value = options.email;

  sheet.append(title, message, email);

  const urls: string[] = [];
  const blurChoice = choice('블러 해제');
  if (options.screenshot) {
    const shot = el('figure', 'ir-shot');
    const image = el('img');
    image.alt = '보낼 화면';
    const show = (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      image.src = url;
    };
    show(options.screenshot.blurred);
    shot.append(image);
    sheet.append(shot);
    blurChoice.row.hidden = !options.screenshot.hasBlur;
    blurChoice.box.addEventListener('change', () => {
      if (options.screenshot) show(blurChoice.box.checked ? options.screenshot.sharp : options.screenshot.blurred);
    });
  } else {
    blurChoice.row.hidden = true;
  }

  const choices = el('div', 'ag-sheet-choices');
  const chatChoice = choice('대화 포함');
  chatChoice.box.disabled = !options.chatAvailable;
  const documentChoice = choice('문서 포함');
  documentChoice.box.disabled = !options.documentAvailable;
  choices.append(blurChoice.row, chatChoice.row, documentChoice.row);
  sheet.append(choices);

  let documentPayload: { name: string; bytes: Uint8Array } | null = null;
  let documentLoading: Promise<void> | null = null;
  documentChoice.box.addEventListener('change', () => {
    if (!documentChoice.box.checked || documentPayload) return;
    documentChoice.reason.hidden = true;
    documentLoading = options.loadDocument().then((loaded) => {
      if ('reason' in loaded) {
        documentChoice.box.checked = false;
        documentChoice.box.disabled = true;
        documentChoice.reason.textContent = loaded.reason;
        documentChoice.reason.hidden = false;
        return;
      }
      documentPayload = loaded;
    }).finally(() => { documentLoading = null; });
  });

  const details = el('details', 'ir-details');
  details.append(el('summary', undefined, '보낼 정보'), el('pre', undefined, options.info));
  sheet.append(details);

  const error = el('p', 'ir-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  sheet.append(error);

  const actions = el('div', 'ag-sheet-actions');
  const cancel = el('button', 'ag-sheet-btn ag-sheet-cancel', '취소');
  cancel.type = 'button';
  const send = el('button', 'ag-sheet-btn ag-sheet-confirm', '보내기');
  send.type = 'button';
  actions.append(cancel, send);
  sheet.append(actions);

  layer.append(backdrop, sheet);
  document.body.appendChild(layer);

  let sending = false;
  let closed = false;
  const syncSend = () => {
    send.disabled = sending || message.value.trim().length === 0;
  };
  message.addEventListener('input', () => {
    syncSend();
    if (!error.hidden) error.hidden = true;
  });
  email.addEventListener('input', () => {
    if (!error.hidden) error.hidden = true;
  });
  syncSend();

  const focusables = (): HTMLElement[] => [...sheet.querySelectorAll<HTMLElement>(
    'textarea:not([disabled]), input:not([disabled]):not([hidden]), button:not([disabled]), summary',
  )].filter((node) => node.offsetParent !== null);

  const close = (sent: boolean): void => {
    if (closed) return;
    closed = true;
    openSheet = null;
    document.removeEventListener('keydown', onKeyDown, true);
    layer.classList.remove('ag-sheet-open');
    layer.classList.add('ag-sheet-closing');
    const remove = () => {
      layer.remove();
      for (const url of urls) URL.revokeObjectURL(url);
    };
    if (reducedMotion()) remove();
    else window.setTimeout(remove, 480);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    options.onClose({ sent, message: message.value, email: email.value });
  };

  const submit = async (): Promise<void> => {
    if (sending || send.disabled) return;
    const address = email.value.trim();
    if (address && !EMAIL_RE.test(address)) {
      error.textContent = '이메일 주소를 확인하십시오.';
      error.hidden = false;
      email.focus();
      return;
    }
    sending = true;
    syncSend();
    send.textContent = '보내는 중…';
    error.hidden = true;
    try {
      if (documentLoading) await documentLoading;
      const result = await options.submit({
        message: message.value,
        email: address,
        unblur: blurChoice.box.checked,
        includeChat: chatChoice.box.checked,
        document: documentChoice.box.checked ? documentPayload : null,
      });
      if (result.ok) {
        close(true);
        return;
      }
      error.textContent = issueReportFailureText(result);
    } catch {
      error.textContent = FAILURE_TEXT.server;
    }
    sending = false;
    send.textContent = '보내기';
    syncSend();
    error.hidden = false;
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!sending) close(false);
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
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

  cancel.addEventListener('click', () => { if (!sending) close(false); });
  backdrop.addEventListener('click', () => { if (!sending) close(false); });
  send.addEventListener('click', () => void submit());
  document.addEventListener('keydown', onKeyDown, true);

  openSheet = { focus: () => message.focus({ preventScroll: true }) };
  requestAnimationFrame(() => {
    layer.classList.add('ag-sheet-open');
    message.focus({ preventScroll: true });
  });
}
