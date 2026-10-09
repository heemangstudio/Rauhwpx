/**
 * 프로젝트 항목 미리보기. 프로젝트 열 위로 미끄러져 들어오는 면 하나이며,
 * 인용 칩·보드·그래프·파일 목록이 모두 이 면으로 항목을 연다.
 *
 * - PDF: pdf-viewer.ts 로 열고 인용 조각을 강조한다.
 * - 이미지: blob URL 로 띄우고 맞춤/원래 크기를 오간다.
 * - 노트: 채팅과 같은 Markdown 렌더러로 그리고, 바로 고쳐 `note` 연산으로 저장한다.
 * - 그 밖의 문서: 허브가 뽑은 글자를 읽기 보기로 보여 주고 조각을 강조한다.
 * 어떤 경우에도 원문 HTML 을 해석하지 않는다.
 */

import './project-preview.css';
import type {
  ProjectChunk,
  ProjectFileItem,
  ProjectItem,
  ProjectNoteItem,
  ProjectOp,
  ProjectSnapshot,
} from '../../../agent/types.ts';
import type { ProjectService } from '../../../agent/project-service.ts';
import { refreshCitations, renderChatMarkdown } from '../chat-markdown.ts';
import {
  projectCitationTarget,
  type CitationHooks,
  type WikilinkAnchor,
} from '../wikilinks.ts';
import { button, el, itemIconName, projectIcon } from './project-ui.ts';
import { locateInText } from './passage-locate.ts';
import { createPdfViewer, type PdfViewer } from './pdf-viewer.ts';

export interface ProjectPreviewRequest {
  itemId: string;
  /** `{kind:'chunk',n}` 또는 링크 앵커 문자열 `c12`·`p4`. */
  anchor?: WikilinkAnchor | string | null;
  /** 조각 안에서 좁혀 강조할 인용 구절. */
  quote?: string | null;
}

export interface ProjectPreviewDeps {
  service: Pick<ProjectService, 'fileBlob' | 'chunk' | 'fileText' | 'note' | 'applyOps'>;
  /** 지금 프로젝트 스냅샷 (ProjectStore.get). */
  project: () => ProjectSnapshot | null;
  /** 노트 저장. ProjectStore.edit 를 넘기면 보드가 바로 따라온다. 없으면 service.applyOps 로 보낸다. */
  edit?: (ops: ProjectOp[]) => Promise<unknown>;
  onClose: () => void;
  /** `d…` 문서 노드를 열 때. 없으면 미리보기가 안내만 한다. */
  openDocument?: (documentId: string) => void;
}

export interface ProjectPreview {
  readonly element: HTMLElement;
  /** 항목을 연다. 이미 다른 항목이 열려 있으면 뒤로 가기 목록에 쌓는다. */
  open(request: ProjectPreviewRequest): Promise<void>;
  /** 스냅샷이 바뀐 뒤 제목과 본문 칩을 다시 맞춘다. */
  refresh(): void;
  /** 열린 항목과 뒤로 가기 목록을 비운다. */
  clear(): void;
  readonly current: ProjectPreviewRequest | null;
  destroy(): void;
}

function parseAnchor(anchor: ProjectPreviewRequest['anchor']): WikilinkAnchor | null {
  if (!anchor) return null;
  if (typeof anchor !== 'string') return anchor;
  const match = /^([cp])(\d{1,6})$/u.exec(anchor);
  return match ? { kind: match[1] === 'c' ? 'chunk' : 'page', n: Number(match[2]) } : null;
}

function errorText(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'PasswordException') return '암호가 걸린 PDF는 열 수 없습니다.';
  return '파일을 열지 못했습니다.';
}

export function createProjectPreview(deps: ProjectPreviewDeps): ProjectPreview {
  const root = el('section', 'ag-pp');
  root.setAttribute('aria-label', '미리보기');
  root.tabIndex = -1;
  const head = el('header', 'ag-pp-head');
  const back = button('ag-pp-icon ag-pp-back', '미리보기 닫기', { icon: 'close' });
  const kind = el('span', 'ag-pp-kind');
  const title = el('h2', 'ag-pp-title');
  const meta = el('span', 'ag-pp-meta');
  const tools = el('div', 'ag-pp-tools');
  head.append(back, kind, title, meta, tools);
  const body = el('div', 'ag-pp-body');
  root.append(head, body);

  const history: ProjectPreviewRequest[] = [];
  let current: ProjectPreviewRequest | null = null;
  let generation = 0;
  let viewer: PdfViewer | null = null;
  let objectUrl: string | null = null;
  let cleanupView: (() => void) | null = null;

  /** 조각 → 쪽 번호. 받은 값은 숫자로 바꿔 두어, 다시 그린 칩이 바로 같은 모양이 된다. */
  const chunkPages = new Map<string, number | null | Promise<number | null>>();
  /** 노트 안의 칩은 미리보기 안에서 연다. */
  const citations: CitationHooks = {
    resolveItem: (id) => projectCitationTarget(deps.project(), id),
    openCitation: (request) => {
      void open({ itemId: request.id, anchor: request.anchor, quote: request.quote });
    },
    chunkPage: (id, n) => {
      const projectId = deps.project()?.id;
      if (!projectId) return null;
      const key = `${projectId}/${id}#c${n}`;
      if (chunkPages.has(key)) return chunkPages.get(key)!;
      const page = deps.service.chunk(projectId, id, `c${n}`).then((chunk) => chunk.page, () => null);
      chunkPages.set(key, page);
      void page.then((value) => { chunkPages.set(key, value); });
      return page;
    },
  };

  function findItem(id: string): ProjectItem | null {
    return deps.project()?.items.find((item) => item.id === id && !item.trashedAt) ?? null;
  }

  function syncBack(): void {
    const label = history.length ? '뒤로' : '미리보기 닫기';
    back.setAttribute('aria-label', label);
    back.title = label;
    back.replaceChildren(projectIcon(history.length ? 'back' : 'close'));
  }

  function resetView(): void {
    cleanupView?.();
    cleanupView = null;
    viewer?.destroy();
    viewer = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    tools.replaceChildren();
    meta.textContent = '';
    body.replaceChildren();
    body.removeAttribute('aria-busy');
    root.removeAttribute('data-kind');
  }

  function setHeader(text: string, icon: Parameters<typeof projectIcon>[0]): void {
    title.textContent = text;
    title.title = text;
    kind.replaceChildren(projectIcon(icon));
  }

  function message(text: string): void {
    body.replaceChildren(el('p', 'ag-pp-message', text));
  }

  function busy(): void {
    body.setAttribute('aria-busy', 'true');
  }

  function zoomTools(onOut: () => void, onIn: () => void, onFit?: () => void): void {
    const out = button('ag-pp-icon', '축소', { text: '−' });
    const plus = button('ag-pp-icon', '확대', { icon: 'plus' });
    out.addEventListener('click', onOut);
    plus.addEventListener('click', onIn);
    tools.append(out, plus);
    if (onFit) {
      const fit = button('ag-pp-icon', '맞춤', { icon: 'fit' });
      fit.addEventListener('click', onFit);
      tools.append(fit);
    }
  }

  async function chunkFor(projectId: string, itemId: string, anchor: WikilinkAnchor | null): Promise<ProjectChunk | null> {
    if (anchor?.kind !== 'chunk') return null;
    try {
      return await deps.service.chunk(projectId, itemId, `c${anchor.n}`);
    } catch {
      return null;
    }
  }

  async function showPdf(projectId: string, item: ProjectFileItem, anchor: WikilinkAnchor | null, quote: string | null, token: number): Promise<void> {
    root.dataset.kind = 'pdf';
    const pdf = createPdfViewer({
      onPageChange: (page, total) => { meta.textContent = `${page} / ${total}`; },
    });
    viewer = pdf;
    zoomTools(() => pdf.zoomOut(), () => pdf.zoomIn());
    busy();
    const [blob, chunk] = await Promise.all([
      deps.service.fileBlob(projectId, item.id),
      chunkFor(projectId, item.id, anchor),
    ]);
    if (token !== generation) return;
    body.replaceChildren(pdf.element);
    await pdf.load(new Uint8Array(await blob.arrayBuffer()));
    if (token !== generation) return;
    body.removeAttribute('aria-busy');
    if (chunk?.page) {
      await pdf.highlight(chunk.page, { chunk, quote });
    } else if (anchor?.kind === 'page') {
      pdf.showPage(anchor.n);
    }
  }

  async function showImage(projectId: string, item: ProjectFileItem, token: number): Promise<void> {
    root.dataset.kind = 'image';
    busy();
    const blob = await deps.service.fileBlob(projectId, item.id);
    if (token !== generation) return;
    objectUrl = URL.createObjectURL(blob);
    const frame = el('div', 'ag-pp-image');
    const image = el('img');
    image.alt = item.title;
    image.decoding = 'async';
    image.src = objectUrl;
    frame.append(image);
    let zoom = 0; // 0 = 맞춤
    const apply = () => {
      frame.classList.toggle('ag-pp-image-fit', zoom === 0);
      image.style.width = zoom === 0 ? '' : `${Math.round(image.naturalWidth * zoom)}px`;
      meta.textContent = zoom === 0 ? '' : `${Math.round(zoom * 100)}%`;
    };
    const fitZoom = () => (image.naturalWidth ? Math.min(1, frame.clientWidth / image.naturalWidth) : 1);
    const step = (direction: 1 | -1) => {
      const base = zoom || fitZoom();
      zoom = Math.min(8, Math.max(0.1, direction > 0 ? base * 1.25 : base / 1.25));
      apply();
    };
    image.addEventListener('click', () => {
      zoom = zoom === 0 ? 1 : 0;
      apply();
    });
    zoomTools(() => step(-1), () => step(1), () => { zoom = 0; apply(); });
    apply();
    body.replaceChildren(frame);
    body.removeAttribute('aria-busy');
  }

  async function showReader(projectId: string, item: ProjectFileItem, anchor: WikilinkAnchor | null, quote: string | null, token: number): Promise<void> {
    root.dataset.kind = 'reader';
    busy();
    const chunk = await chunkFor(projectId, item.id, anchor);
    const page = chunk?.page ?? (anchor?.kind === 'page' ? anchor.n : undefined);
    const text = await deps.service.fileText(projectId, item.id, page ?? undefined);
    if (token !== generation) return;
    if (text.page) meta.textContent = `p.${text.page}`;
    const reader = el('div', 'ag-pp-reader');
    const match = chunk || quote ? locateInText(text.text, { chunk, quote }) : null;
    if (match) {
      const mark = el('mark', 'ag-pp-hit', text.text.slice(match.start, match.end));
      reader.append(document.createTextNode(text.text.slice(0, match.start)), mark, document.createTextNode(text.text.slice(match.end)));
    } else {
      reader.textContent = text.text;
    }
    body.replaceChildren(reader);
    body.removeAttribute('aria-busy');
    const hit = reader.querySelector<HTMLElement>('.ag-pp-hit');
    if (hit) body.scrollTop = Math.max(0, hit.offsetTop - body.clientHeight / 3);
  }

  async function showNote(projectId: string, item: ProjectNoteItem, token: number): Promise<void> {
    root.dataset.kind = 'note';
    busy();
    const note = await deps.service.note(projectId, item.id);
    if (token !== generation) return;
    let source = note.body;
    const view = el('div', 'ag-pp-note ag-msg ag-msg-assistant');
    const render = () => renderChatMarkdown(view, source, { citations });
    render();
    const editButton = button('ag-pp-text-button', '노트 편집', { text: '편집' });
    tools.append(editButton);
    body.replaceChildren(view);
    body.removeAttribute('aria-busy');

    const startEdit = () => {
      const editor = el('textarea', 'ag-pp-note-editor');
      editor.value = source;
      editor.setAttribute('aria-label', '노트 내용');
      editor.spellcheck = false;
      const cancel = button('ag-pp-text-button', '편집 취소', { text: '취소' });
      const save = button('ag-pp-text-button ag-pp-primary', '노트 저장', { text: '저장' });
      tools.replaceChildren(cancel, save);
      body.replaceChildren(editor);
      editor.focus();
      const finish = () => {
        tools.replaceChildren(editButton);
        body.replaceChildren(view);
      };
      const commit = async () => {
        if (editor.value === source) {
          finish();
          return;
        }
        save.disabled = true;
        cancel.disabled = true;
        const ops: ProjectOp[] = [{ op: 'note', id: item.id, body: editor.value, mode: 'replace' }];
        try {
          if (deps.edit) await deps.edit(ops);
          else await deps.service.applyOps(projectId, ops);
          if (token !== generation) return;
          source = editor.value;
          render();
          finish();
        } catch {
          save.disabled = false;
          cancel.disabled = false;
          save.textContent = '다시 저장';
        }
      };
      cancel.addEventListener('click', finish);
      save.addEventListener('click', () => { void commit(); });
      editor.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      });
    };
    editButton.addEventListener('click', startEdit);
  }

  async function show(request: ProjectPreviewRequest): Promise<void> {
    const token = ++generation;
    resetView();
    current = request;
    syncBack();
    const project = deps.project();
    const anchor = parseAnchor(request.anchor);
    const quote = request.quote?.trim() || null;
    if (request.itemId.startsWith('d')) {
      setHeader('문서', 'documentNode');
      message('문서를 찾지 못했습니다.');
      return;
    }
    const item = findItem(request.itemId);
    if (!project || !item) {
      setHeader('찾을 수 없음', 'file');
      message('항목을 찾지 못했습니다.');
      return;
    }
    setHeader(item.title, itemIconName(item));
    try {
      if (item.kind === 'note') {
        await showNote(project.id, item, token);
        return;
      }
      if (item.status === 'processing') {
        message('파일을 처리하는 중입니다.');
        return;
      }
      if (item.fileKind === 'pdf') await showPdf(project.id, item, anchor, quote, token);
      else if (item.fileKind === 'image') await showImage(project.id, item, token);
      else if (item.status === 'failed') message('글자를 읽지 못한 파일입니다.');
      else await showReader(project.id, item, anchor, quote, token);
    } catch (error) {
      if (token !== generation) return;
      if ((error as Error)?.message === 'closed') return;
      body.removeAttribute('aria-busy');
      message(errorText(error));
    }
  }

  function open(request: ProjectPreviewRequest): Promise<void> {
    // 문서 노드는 미리보기가 아니라 편집기에서 연다.
    const member = request.itemId.startsWith('d')
      ? deps.project()?.members.find((row) => row.nodeId === request.itemId)
      : null;
    if (member && deps.openDocument) {
      deps.openDocument(member.documentId);
      return Promise.resolve();
    }
    if (current && current.itemId !== request.itemId) history.push(current);
    return show(request);
  }

  function goBack(): void {
    const previous = history.pop();
    if (previous) {
      void show(previous);
      return;
    }
    clear();
    deps.onClose();
  }

  function clear(): void {
    generation += 1;
    history.length = 0;
    current = null;
    resetView();
    title.textContent = '';
    kind.replaceChildren();
    syncBack();
  }

  back.addEventListener('click', goBack);
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    goBack();
  });
  syncBack();

  return {
    element: root,
    open,
    refresh() {
      if (!current) return;
      const item = findItem(current.itemId);
      if (item) {
        title.textContent = item.title;
        title.title = item.title;
      }
      refreshCitations(body, citations);
    },
    clear,
    get current() {
      return current;
    },
    destroy() {
      clear();
    },
  };
}
