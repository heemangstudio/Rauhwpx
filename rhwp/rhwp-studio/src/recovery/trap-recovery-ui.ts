/**
 * 엔진 trap 복구 대화상자 — 다시 불러오기 전의 "문서 복구"와 다시 연 뒤의 "문서 복구 결과".
 * 복구본 내려받기는 저장소의 바이트를 그대로 내려받으므로 엔진이 필요 없다.
 */
import { ModalDialog } from '@/ui/dialog';
import { SAVE_FORMAT_DETAILS } from '@/command/save-format';
import { fileNameForFormat } from '@/command/save-target';
import type { AutosaveDraft } from './autosave-store.ts';
import { draftDataFormat } from './recovery-format.ts';

const MUTED = 'var(--color-text-muted, #8b95a1)';
const NOTE = 'var(--color-text-secondary, inherit)';
const ERROR = 'var(--color-danger, #c43b3b)';

function paragraph(text: string, options: { muted?: boolean; margin?: string } = {}): HTMLParagraphElement {
  const element = document.createElement('p');
  element.style.margin = options.margin ?? '0 0 12px';
  element.style.whiteSpace = 'pre-line';
  if (options.muted) element.style.color = MUTED;
  element.textContent = text;
  return element;
}

function rowFrame(): HTMLDivElement {
  const row = document.createElement('div');
  row.classList.add('recovery-draft-copy', 'trap-recovery-row');
  row.style.padding = '10px';
  row.style.border = '1px solid var(--dialog-border, #4b5563)';
  return row;
}

function rowTitle(fileName: string, attached: boolean): HTMLDivElement {
  const title = document.createElement('div');
  title.classList.add('recovery-draft-title');
  title.style.fontWeight = '600';
  title.textContent = attached ? `${fileName} (화면)` : fileName;
  return title;
}

function rowLine(text: string, className: string, color = MUTED): HTMLDivElement {
  const line = document.createElement('div');
  line.className = className;
  line.style.fontSize = '12px';
  line.style.marginTop = '4px';
  line.style.color = color;
  line.textContent = text;
  return line;
}

function list(): HTMLDivElement {
  const container = document.createElement('div');
  container.classList.add('recovery-draft-list');
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '8px';
  return container;
}

// ─── 다시 불러오기 전 ─────────────────────────────

export interface TrapRecoveryDialogRow {
  readonly key: string;
  readonly fileName: string;
  readonly attached: boolean;
  /** 지금 상태. 복구본 저장이 끝나면 바뀐다. */
  status(): string;
  /** 다시 열면서 바뀌거나 잃는 것 */
  readonly notes: readonly string[];
}

export interface TrapRecoveryDialogModel {
  readonly rows: readonly TrapRecoveryDialogRow[];
  /** 복구본 저장이 모두 끝났거나 기다림 상한이 지났다. */
  ready(): boolean;
  /** 상태가 바뀌면 부른다. 해제 함수를 돌려준다. */
  subscribe(listener: () => void): () => void;
  saveCopy(): void;
  /** 페이지를 다시 불러온다. 다시 불러오지 못하면 그 이유를 돌려준다. */
  reopen(): Promise<string | null>;
}

class TrapRecoveryDialog extends ModalDialog {
  private resolve: ((result: 'closed' | 'reloading') => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly statusLines = new Map<string, HTMLDivElement>();
  private errorLine: HTMLParagraphElement | null = null;
  private reopening = false;

  constructor(private readonly model: TrapRecoveryDialogModel) {
    super('문서 복구', 560);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.classList.add('recovery-dialog-body', 'trap-recovery-body');
    body.style.padding = '16px 20px';
    body.style.lineHeight = '1.55';
    body.append(paragraph('문서 엔진이 멈췄습니다. 페이지를 다시 불러와 열린 문서를 모두 다시 엽니다.'));

    const rows = list();
    for (const row of this.model.rows) {
      const frame = rowFrame();
      frame.dataset.trapRow = row.key;
      frame.append(rowTitle(row.fileName, row.attached));
      const status = rowLine(row.status(), 'trap-recovery-status');
      this.statusLines.set(row.key, status);
      frame.append(status);
      for (const note of row.notes) frame.append(rowLine(note, 'trap-recovery-note', NOTE));
      rows.append(frame);
    }
    body.append(rows);
    body.append(paragraph('실행 취소 기록은 복구되지 않습니다.', { muted: true, margin: '12px 0 0' }));
    this.errorLine = paragraph('', { margin: '8px 0 0' });
    this.errorLine.style.color = ERROR;
    this.errorLine.hidden = true;
    body.append(this.errorLine);
    return body;
  }

  protected onConfirm(): boolean {
    if (this.reopening || !this.model.ready()) return false;
    this.reopening = true;
    this.refresh();
    void this.model.reopen().then((problem) => {
      if (problem === null) {
        this.resolve?.('reloading');
        return;
      }
      this.reopening = false;
      if (this.errorLine) {
        this.errorLine.textContent = problem;
        this.errorLine.hidden = false;
      }
      this.refresh();
    });
    return false;
  }

  override hide(): void {
    // 다시 불러오는 중에는 닫지 않는다. 채팅을 멈추고 목록을 적는 중이다.
    if (this.reopening) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.hide();
    this.resolve?.('closed');
  }

  private refresh(): void {
    for (const row of this.model.rows) {
      const line = this.statusLines.get(row.key);
      if (line) line.textContent = row.status();
    }
    const reopen = this.dialog.querySelector<HTMLButtonElement>('.dialog-btn-primary');
    if (reopen) {
      reopen.disabled = this.reopening || !this.model.ready();
      reopen.textContent = this.reopening ? '다시 여는 중…' : '다시 열기';
    }
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('.dialog-footer .dialog-btn:not(.dialog-btn-primary)')) {
      button.disabled = this.reopening;
    }
  }

  showAsync(): Promise<'closed' | 'reloading'> {
    return new Promise((resolve) => {
      let settled = false;
      this.resolve = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      super.show();
      this.dialog.classList.add('recovery-dialog', 'trap-recovery-dialog');
      const footer = this.dialog.querySelector('.dialog-footer');
      const closeButton = footer?.querySelector<HTMLButtonElement>('.dialog-btn:not(.dialog-btn-primary)') ?? null;
      if (closeButton) closeButton.textContent = '닫기';
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'dialog-btn trap-recovery-copy';
      copyButton.textContent = '사본 저장';
      copyButton.title = '화면의 문서를 HWPX 사본으로 내려받습니다.';
      copyButton.addEventListener('click', () => this.model.saveCopy());
      footer?.insertBefore(copyButton, closeButton);
      this.unsubscribe = this.model.subscribe(() => this.refresh());
      this.refresh();
    });
  }
}

/** 다시 열기를 누르면 'reloading' (페이지가 곧 다시 불러와진다), 닫으면 'closed'. */
export function showTrapRecoveryDialog(model: TrapRecoveryDialogModel): Promise<'closed' | 'reloading'> {
  return new TrapRecoveryDialog(model).showAsync();
}

// ─── 다시 연 뒤 ─────────────────────────────

export interface TrapResultRow {
  readonly key: string;
  readonly fileName: string;
  readonly text: string;
  /** 복구본을 내려받는다. 없으면 버튼을 두지 않는다. */
  readonly download?: () => Promise<void>;
  /** 직접 다시 열어 본다. 결과 문구를 돌려준다. */
  readonly open?: () => Promise<string>;
}

class TrapRecoveryResultDialog extends ModalDialog {
  private resolve: (() => void) | null = null;

  constructor(private readonly rows: readonly TrapResultRow[], private readonly lead: string) {
    super('문서 복구 결과', 560);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.classList.add('recovery-dialog-body', 'trap-recovery-body');
    body.style.padding = '16px 20px';
    body.style.lineHeight = '1.55';
    body.append(paragraph(this.lead));
    const rows = list();
    for (const row of this.rows) {
      const frame = rowFrame();
      frame.dataset.trapResult = row.key;
      frame.append(rowTitle(row.fileName, false));
      const text = rowLine(row.text, 'trap-recovery-status');
      frame.append(text);
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      actions.style.marginTop = '8px';
      if (row.download) {
        const download = row.download;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dialog-btn trap-recovery-download';
        button.textContent = '복구본 내려받기';
        button.addEventListener('click', () => {
          void download().catch((error: unknown) => {
            text.textContent = `복구본을 내려받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
          });
        });
        actions.append(button);
      }
      if (row.open) {
        const open = row.open;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dialog-btn trap-recovery-open';
        button.textContent = '열기';
        button.addEventListener('click', () => {
          button.disabled = true;
          void open().then((result) => {
            text.textContent = result;
          }, (error: unknown) => {
            button.disabled = false;
            text.textContent = `열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
          });
        });
        actions.append(button);
      }
      if (actions.childElementCount > 0) frame.append(actions);
      rows.append(frame);
    }
    body.append(rows);
    return body;
  }

  protected onConfirm(): boolean {
    return true;
  }

  override hide(): void {
    super.hide();
    this.resolve?.();
  }

  showAsync(): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      super.show();
      this.dialog.classList.add('recovery-dialog', 'trap-recovery-result-dialog');
      this.dialog.querySelector('.dialog-footer .dialog-btn:not(.dialog-btn-primary)')?.remove();
    });
  }
}

export function showTrapRecoveryResultDialog(rows: readonly TrapResultRow[], lead: string): Promise<void> {
  return new TrapRecoveryResultDialog(rows, lead).showAsync();
}

/** 복구본을 그 형식의 확장자로 내려받는다. 엔진을 거치지 않는다. */
export function downloadRecoveryDraft(draft: AutosaveDraft): void {
  const format = draftDataFormat(draft);
  const details = SAVE_FORMAT_DETAILS[format];
  const named = fileNameForFormat(draft.fileName, format);
  const base = named.slice(0, named.length - details.extension.length) || '문서';
  const url = URL.createObjectURL(new Blob([draft.data as BlobPart], { type: details.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${base} 복구본${details.extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
