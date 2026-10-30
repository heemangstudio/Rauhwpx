import { ModalDialog } from './dialog';
import { isTopModal } from './modal-stack';

/** 한컴 지우기 확인(c04a, c02b): 제목 '지우기', 단추 '지움(Y)'·'취소(N)'. Y·N 키로도 답한다. Esc 는 취소다. */
class NoteDeleteDialog extends ModalDialog {
  private accepted = false;
  private settled = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  protected override sheet = true;

  constructor(private readonly message: string, private readonly done: (ok: boolean) => void) {
    super('지우기', 360);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'dialog-sheet-message';
    body.textContent = this.message;
    return body;
  }

  protected onConfirm(): void {
    this.accepted = true;
  }

  override show(): void {
    super.show();
    const buttons = [...this.dialog.querySelectorAll<HTMLButtonElement>('.dialog-footer .dialog-btn')];
    for (const button of buttons) button.textContent = button.classList.contains('dialog-btn-primary') ? '지움(Y)' : '취소(N)';
    this.keyHandler = (e: KeyboardEvent) => {
      if (!isTopModal(this) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'KeyY' && e.code !== 'KeyN') return;
      e.preventDefault();
      e.stopPropagation();
      this.accepted = e.code === 'KeyY';
      this.hide();
    };
    document.addEventListener('keydown', this.keyHandler, true);
  }

  override hide(): void {
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    super.hide();
    if (this.settled) return;
    this.settled = true;
    this.done(this.accepted);
  }
}

export const NOTE_NUMBER_DELETE_MESSAGE = '[번호 넣기] 를 지울까요?';

/** 본문 표시를 하나 지울 때의 물음. */
export function noteMarkDeleteMessage(kind: string): string {
  return kind === 'endnote' ? '[미주] 를 지울까요?' : '[각주] 를 지울까요?';
}

export function confirmNoteDelete(message: string): Promise<boolean> {
  return new Promise((resolve) => new NoteDeleteDialog(message, resolve).show());
}
