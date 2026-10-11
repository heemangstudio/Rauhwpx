export interface InlineRenameOptions {
  /** 칸에 처음 넣을 값 */
  value: string;
  /** 화면 낭독기가 읽는 칸 이름 */
  label: string;
  /** 확장자 앞까지만 골라 둔다 (파일 이름) */
  selectBaseName?: boolean;
  maxLength?: number;
  /**
   * 새 이름을 적용한다. 화면에 둘 글자를 돌려주고, 적용하지 못했으면 null.
   * 소유자가 그사이 글자를 다시 그렸으면 그것을 그대로 둔다.
   */
  commit: (value: string) => Promise<string | null> | string | null;
}

/**
 * 글자 자리에서 바로 이름을 고친다. 모양은 styles/inline-rename.css (앱 전역·사이드바가 불러온다). Enter·포커스 이탈은 확정, Esc 는 취소.
 * 값이 그대로면 아무것도 바꾸지 않는다.
 */
export function beginInlineRename(target: HTMLElement, options: InlineRenameOptions): void {
  if (target.querySelector('.inline-rename-input')) return;
  const previousText = target.textContent ?? '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-rename-input';
  input.value = options.value;
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (options.maxLength) input.maxLength = options.maxLength;
  input.setAttribute('aria-label', options.label);
  target.replaceChildren(input);

  let settled = false;
  const finish = async (save: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    let shown: string | null = previousText;
    if (save && next && next !== options.value) {
      input.disabled = true;
      try {
        shown = await options.commit(next) ?? previousText;
      } catch {
        shown = previousText;
      }
    }
    if (input.isConnected) target.textContent = shown;
  };

  input.addEventListener('keydown', (event) => {
    // 편집기·사이드바 단축키가 이 칸의 글자를 가로채지 않게 한다.
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => { void finish(true); });
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());

  input.focus();
  const dot = options.selectBaseName ? options.value.lastIndexOf('.') : -1;
  input.setSelectionRange(0, dot > 0 ? dot : options.value.length);
}
