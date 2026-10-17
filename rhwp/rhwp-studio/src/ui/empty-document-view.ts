/**
 * 문서가 없을 때 용지 자리 — 점선 종이 하나와 새 문서·파일 열기 두 단추. 문서 없는 채팅 옆에서는 이
 * 두 단추가 그 채팅에 문서를 잇는다(편집기가 정한다). 문서가 열리면 바로 내려간다.
 * 모양은 styles/empty-document-view.css.
 */
export interface EmptyDocumentView {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
}

export function createEmptyDocumentView(actions: { create(): void; open(): void }): EmptyDocumentView {
  const element = document.createElement('div');
  element.className = 'empty-document-view';
  element.hidden = true;
  const paper = document.createElement('div');
  paper.className = 'empty-document-paper';
  paper.setAttribute('aria-hidden', 'true');
  const row = document.createElement('div');
  row.className = 'empty-document-actions';
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'empty-document-action empty-document-create';
  create.textContent = '새 문서';
  create.addEventListener('click', () => actions.create());
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'empty-document-action empty-document-open';
  open.textContent = '파일 열기';
  open.addEventListener('click', () => actions.open());
  row.append(create, open);
  element.append(paper, row);
  return {
    element,
    setVisible(visible) {
      element.hidden = !visible;
    },
  };
}
