import type { CharPatch, ParaPatch } from '../core/heemang-adapter';
import { enableDialogDrag } from './dialog-drag';
import { isTopModal, openModalCount, popModal, pushModal } from './modal-stack';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(text: string, action: () => void, className = 'dialog-btn'): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let nextControlId = 0;

function row(body: HTMLElement, text: string, control: HTMLElement, find = false): HTMLElement {
  const wrap = element('div', find ? 'find-dialog-row' : 'dialog-row');
  const label = element('label', find ? 'find-dialog-label' : 'dialog-label', text);
  control.id = `heemang-edit-field-${++nextControlId}`;
  label.htmlFor = control.id;
  wrap.append(label, control);
  body.append(wrap);
  return wrap;
}

function select(body: HTMLElement, label: string, options: [string, string][]): HTMLSelectElement {
  const control = element('select', 'dialog-select');
  for (const [value, text] of options) control.add(new Option(text, value));
  row(body, label, control);
  return control;
}

function numberInput(body: HTMLElement, label: string): HTMLInputElement {
  const input = element('input', 'dialog-input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.placeholder = '변경 안 함';
  row(body, label, input);
  return input;
}

function readNumber(input: HTMLInputElement, scale: number, min: number, max: number): number | undefined {
  if (!input.value.trim()) return undefined;
  const scaled = Number(input.value) * scale;
  const value = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - value) > 0.000001 || value < min || value > max) {
    input.focus();
    throw new Error('입력 범위와 소수 자릿수를 확인해 주세요.');
  }
  return value;
}

function showFormat(title: string, onClose: () => void, build: (body: HTMLElement) => () => void): void {
  const previousFocus = document.activeElement;
  const overlay = element('div', 'modal-overlay');
  const dialog = element('div', 'dialog-wrap');
  dialog.style.width = '340px';
  dialog.style.maxWidth = 'calc(100vw - 32px)';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  const titleBar = element('div', 'dialog-title', title);
  const body = element('div', 'dialog-body');
  const applyPatch = build(body);
  const error = element('div', 'formula-error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  body.append(error);
  const footer = element('div', 'dialog-footer');
  let closed = false;
  const cleanupDrag = enableDialogDrag(dialog, titleBar);
  const close = () => {
    if (closed) return;
    closed = true;
    popModal(dialog);
    document.removeEventListener('keydown', keydown, true);
    cleanupDrag();
    overlay.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    onClose();
  };
  const apply = () => {
    try {
      applyPatch();
    } catch (cause) {
      error.textContent = message(cause);
      error.hidden = false;
      return;
    }
    close();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!isTopModal(dialog)) return;
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (event.target instanceof HTMLButtonElement) event.target.click();
      else apply();
    } else if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const closeButton = button('×', close, 'dialog-close');
  closeButton.setAttribute('aria-label', '닫기');
  titleBar.append(closeButton);
  footer.append(button('적용', apply, 'dialog-btn dialog-btn-primary'), button('취소', close));
  dialog.append(titleBar, body, footer);
  overlay.append(dialog);
  document.body.append(overlay);
  pushModal(dialog);
  document.addEventListener('keydown', keydown, true);
  body.querySelector<HTMLElement>('input, select')?.focus();
}

export function showHeemangCharacterFormat(
  onApply: (patch: CharPatch) => void,
  onClose: () => void,
  field?: 'bold' | 'italic' | 'underline',
): void {
  showFormat('글자 모양', onClose, body => {
    const toggles: Partial<Record<'bold' | 'italic' | 'underline', HTMLSelectElement>> = {};
    for (const [key, label] of [['bold', '진하게'], ['italic', '기울임'], ['underline', '밑줄']] as const) {
      if (field && field !== key) continue;
      toggles[key] = select(body, label, field
        ? [['true', '켬'], ['false', '끔']]
        : [['', '변경 안 함'], ['true', '켬'], ['false', '끔']]);
    }
    const size = field ? undefined : numberInput(body, '크기 (pt)');
    const color = field ? undefined : element('input', 'dialog-text-input');
    if (color) {
      color.type = 'text';
      color.placeholder = '#rrggbb';
      row(body, '글자 색', color);
    }
    return () => {
      const patch: CharPatch = {};
      for (const key of ['bold', 'italic', 'underline'] as const) {
        const value = toggles[key]?.value;
        if (value) patch[key] = value === 'true';
      }
      if (size) {
        const value = readNumber(size, 100, 1, 0x7fffffff);
        if (value !== undefined) patch.size = value;
      }
      if (color?.value.trim()) {
        const value = color.value.trim();
        if (!/^#[0-9a-f]{6}$/i.test(value)) {
          color.focus();
          throw new Error('글자 색은 #rrggbb 형식으로 입력해 주세요.');
        }
        // native COLORREF는 0x00bbggrr 순서다.
        patch.color = parseInt(value.slice(1, 3), 16)
          | (parseInt(value.slice(3, 5), 16) << 8)
          | (parseInt(value.slice(5, 7), 16) << 16);
      }
      if (Object.keys(patch).length) onApply(patch);
    };
  });
}

export function showHeemangParagraphFormat(onApply: (patch: ParaPatch) => void, onClose: () => void): void {
  showFormat('문단 모양', onClose, body => {
    const align = select(body, '정렬', [['', '변경 안 함'], ['left', '왼쪽'], ['center', '가운데'],
      ['right', '오른쪽'], ['justify', '양쪽'], ['distribute', '배분'], ['divide', '나눔']]);
    const fields = [
      ['indent', '들여쓰기 (pt)'], ['left', '왼쪽 여백 (pt)'],
      ['spaceBefore', '문단 위 (pt)'], ['spaceAfter', '문단 아래 (pt)'], ['lineSpacing', '줄 간격 (%)'],
    ] as const;
    const inputs = fields.map(([key, label]) => ({ key, input: numberInput(body, label) }));
    return () => {
      const patch: ParaPatch = {};
      if (align.value) patch.align = align.value as ParaPatch['align'];
      for (const { key, input } of inputs) {
        const percent = key === 'lineSpacing';
        const value = readNumber(input, percent ? 1 : 100, percent ? 1 : -0x40000000, percent ? 0x7fffffff : 0x3fffffff);
        if (value !== undefined) patch[key] = value;
      }
      if (Object.keys(patch).length) onApply(patch);
    };
  });
}

export function showHeemangFind(actions: {
  find(query: string, caseSensitive: boolean, backward: boolean): boolean;
  replace(query: string, replacement: string, caseSensitive: boolean): boolean;
  replaceAll(query: string, replacement: string, caseSensitive: boolean): number;
  close(): void;
}, mode: 'find' | 'replace'): { focus(): void; hide(): void; findNext(): void; setMode(mode: 'find' | 'replace'): void } {
  const dialog = element('div', 'find-dialog');
  dialog.setAttribute('role', 'dialog');
  const titleBar = element('div', 'find-dialog-title');
  const title = element('span');
  const body = element('div', 'find-dialog-body');
  const query = element('input', 'find-dialog-input');
  query.type = 'text';
  const replacement = element('input', 'find-dialog-input');
  replacement.type = 'text';
  row(body, '찾을 내용:', query, true);
  const replaceRow = row(body, '바꿀 내용:', replacement, true);
  const options = element('div', 'find-dialog-row');
  const caseLabel = element('label');
  const caseSensitive = element('input');
  caseSensitive.type = 'checkbox';
  caseLabel.append(caseSensitive, ' 대소문자 구분');
  const status = element('span', 'find-dialog-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  options.append(caseLabel, status);
  body.append(options);
  let closed = false;
  const cleanupDrag = enableDialogDrag(dialog, titleBar);
  const focus = () => { if (!closed) { query.focus(); query.select(); } };
  const hide = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', keydown, true);
    cleanupDrag();
    dialog.remove();
    actions.close();
  };
  const run = (action: () => string) => {
    if (closed) return;
    status.textContent = '';
    if (!query.value) return;
    try { status.textContent = action(); }
    catch (error) { status.textContent = message(error); }
  };
  const search = (backward: boolean) => run(() => actions.find(query.value, caseSensitive.checked, backward) ? '' : '검색 결과 없음');
  const replace = () => run(() => actions.replace(query.value, replacement.value, caseSensitive.checked) ? '' : '검색 결과 없음');
  const findButtons = element('div', 'find-dialog-buttons');
  findButtons.append(button('이전 찾기', () => search(true)), button('다음 찾기', () => search(false)));
  const replaceButtons = element('div', 'find-dialog-buttons');
  replaceButtons.append(button('바꾸기', replace), button('모두 바꾸기', () => run(() => {
    const count = actions.replaceAll(query.value, replacement.value, caseSensitive.checked);
    return `${count}개 바꿈`;
  })));
  const setMode = (nextMode: 'find' | 'replace') => {
    mode = nextMode;
    title.textContent = mode === 'replace' ? '찾아 바꾸기' : '찾기';
    dialog.setAttribute('aria-label', title.textContent);
    replaceRow.style.display = mode === 'replace' ? '' : 'none';
    replaceButtons.style.display = mode === 'replace' ? '' : 'none';
    findButtons.classList.toggle('find-dialog-buttons--joined', mode === 'replace');
    status.textContent = '';
    if (mode === 'find' && document.activeElement === replacement) focus();
  };
  const keydown = (event: KeyboardEvent) => {
    if (closed || openModalCount() || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    } else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (event.target instanceof HTMLButtonElement) event.target.click();
      else if (event.target === replacement && !event.shiftKey) replace();
      else search(event.shiftKey);
    }
  };
  const closeButton = button('×', hide, 'dialog-close');
  closeButton.setAttribute('aria-label', '닫기');
  titleBar.append(title, closeButton);
  dialog.append(titleBar, body, findButtons, replaceButtons);
  setMode(mode);
  document.body.append(dialog);
  document.addEventListener('keydown', keydown, true);
  focus();
  return { focus, hide, findNext: () => search(false), setMode };
}
