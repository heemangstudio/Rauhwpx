/**
 * 상태 바의 "글꼴 N개 대체됨"을 누르면 여는 문서 글꼴 목록.
 * 실제 글꼴로 보이지 않는 글꼴과 대신 쓰는 글꼴을 먼저, 연결된 글꼴을 그 아래에 둔다.
 */
import type { DocumentFontStatusReport } from '@/core/document-font-status';
import { enableDialogDrag } from './dialog-drag';

export interface DocumentFontsDialogOptions {
  /** 연결된 글꼴의 파일 이름 (데스크톱·허브·폴더 색인에서 온 경우) */
  sourceFileFor?: (fontName: string) => string | null;
  /** 글꼴 폴더 연결 (브라우저). 클릭 처리 안에서 바로 불러야 한다. */
  connectFolder?: (() => void) | null;
}

let openOverlay: HTMLDivElement | null = null;

function row(name: string, detail: string | null): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'document-fonts-row';
  const nameEl = document.createElement('span');
  nameEl.className = 'document-fonts-name';
  nameEl.textContent = name;
  line.appendChild(nameEl);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'document-fonts-detail';
    detailEl.textContent = detail;
    line.appendChild(detailEl);
  }
  return line;
}

function section(label: string, rows: HTMLDivElement[]): HTMLElement | null {
  if (!rows.length) return null;
  const wrap = document.createElement('section');
  wrap.className = 'document-fonts-section';
  const heading = document.createElement('div');
  heading.className = 'document-fonts-heading';
  heading.textContent = `${label} ${rows.length}`;
  wrap.appendChild(heading);
  for (const line of rows) wrap.appendChild(line);
  return wrap;
}

export function showDocumentFontsDialog(report: DocumentFontStatusReport, options: DocumentFontsDialogOptions = {}): void {
  openOverlay?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  openOverlay = overlay;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (openOverlay === overlay) openOverlay = null;
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const dialog = document.createElement('div');
  dialog.className = 'dialog-wrap document-fonts-dialog';

  const title = document.createElement('div');
  title.className = 'dialog-title';
  title.textContent = '문서 글꼴';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'dialog-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.addEventListener('click', close);
  title.appendChild(closeBtn);
  dialog.appendChild(title);
  enableDialogDrag(dialog, title);

  const body = document.createElement('div');
  body.className = 'dialog-body document-fonts-body';
  const substituted = report.fonts
    .filter(item => item.status !== 'available')
    .map(item => row(item.fontName, `→ ${item.loadedFace ?? item.substituteFont ?? '기본 글꼴'}`));
  const connected = report.fonts
    .filter(item => item.status === 'available')
    .map(item => row(item.fontName, options.sourceFileFor?.(item.fontName) ?? null));
  for (const part of [section('대체됨', substituted), section('연결됨', connected)]) {
    if (part) body.appendChild(part);
  }
  dialog.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'dialog-footer';
  if (options.connectFolder && substituted.length) {
    const folderBtn = document.createElement('button');
    folderBtn.className = 'dialog-btn';
    folderBtn.textContent = '글꼴 폴더 연결';
    folderBtn.addEventListener('click', () => {
      options.connectFolder!();
      close();
    });
    footer.appendChild(folderBtn);
  }
  const doneBtn = document.createElement('button');
  doneBtn.className = 'dialog-btn dialog-btn-primary';
  doneBtn.textContent = '닫기';
  doneBtn.addEventListener('click', close);
  footer.appendChild(doneBtn);
  dialog.appendChild(footer);

  overlay.appendChild(dialog);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  doneBtn.focus();
}
