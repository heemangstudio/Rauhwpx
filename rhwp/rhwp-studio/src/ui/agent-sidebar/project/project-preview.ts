/**
 * 프로젝트 항목 미리보기. 프로젝트 열 위로 미끄러져 들어오는 면 하나이며,
 * 인용 칩·보드·그래프·파일 목록이 모두 이 면으로 항목을 연다.
 *
 * - PDF: pdf-viewer.ts 로 열고 인용 조각을 강조한다.
 * - 이미지: blob URL 로 띄우고 맞춤/원래 크기를 오간다.
 * - PDF·이미지 위에는 영역 조각 층(clip-layer.ts)을 덮는다. 조각을 열면 원본의 그 쪽으로 가서
 *   테두리로 보여 주고, 영역 도구로 새 조각을 그린다.
 * - 노트: 채팅과 같은 Markdown 렌더러로 그리고, 바로 고쳐 `note` 연산으로 저장한다.
 * - 그 밖의 문서: 허브가 뽑은 글자를 읽기 보기로 보여 주고 조각을 강조한다.
 * 어떤 경우에도 원문 HTML 을 해석하지 않는다.
 */

import './project-preview.css';
import type {
  ProjectChunk,
  ProjectClipItem,
  ProjectFileItem,
  ProjectItem,
  ProjectNoteItem,
  ProjectOp,
  ProjectOpsResult,
  ProjectSnapshot,
} from '../../../agent/types.ts';
import { defaultClipTitle } from '../../../agent/clip-geometry.ts';
import { createClipLayer, type ClipLayer } from './clip-layer.ts';
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
  /** 노트·영역 저장. ProjectStore.edit 를 넘기면 보드가 바로 따라온다. 없으면 service.applyOps 로 보낸다. */
  edit?: (ops: ProjectOp[]) => Promise<ProjectOpsResult | unknown>;
  onClose: () => void;
  /** 탭을 쓰는 호스트는 인용을 새 항목 탭으로 연다. */
  onOpen?: (request: ProjectPreviewRequest) => void;
  onDirtyChange?: () => void;
  /** 탭 호스트가 초안 확인과 뷰 해제를 맡는다. */
  managedClose?: boolean;
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
  setVisible(visible: boolean): void;
  /** 같은 원본의 쪽·인용 이동은 배율과 노트 초안을 보존한다. */
  reveal(request: ProjectPreviewRequest): Promise<void>;
  readonly hasUnsavedChanges: boolean;
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
  let clipLayer: ClipLayer | null = null;
  let objectUrl: string | null = null;
  let cleanupView: (() => void) | null = null;
  let isVisible = true;
  let dirty = () => false;

  /** 조각 → 쪽 번호. 받은 값은 숫자로 바꿔 두어, 다시 그린 칩이 바로 같은 모양이 된다. */
  const chunkPages = new Map<string, number | null | Promise<number | null>>();
  /** 노트 안의 칩은 미리보기 안에서 연다. */
  const citations: CitationHooks = {
    resolveItem: (id) => projectCitationTarget(deps.project(), id),
    openCitation: (request) => {
      const target = { itemId: request.id, anchor: request.anchor, quote: request.quote };
      if (deps.onOpen) deps.onOpen(target);
      else void open(target);
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
    dirty = () => false;
    deps.onDirtyChange?.();
    cleanupView?.();
    cleanupView = null;
    clipLayer?.destroy();
    clipLayer = null;
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

  function saveOps(projectId: string, ops: ProjectOp[]): Promise<ProjectOpsResult | unknown> {
    return deps.edit ? deps.edit(ops) : deps.service.applyOps(projectId, ops);
  }

  /** 원본 위에 영역 조각 층을 깔고 머리에 영역 도구를 단다. */
  function mountClipLayer(projectId: string, source: ProjectFileItem): ClipLayer {
    const tool = button('ag-pp-text-button ag-pp-clip-tool', '영역 그리기', { icon: 'clip', text: '영역' });
    tool.setAttribute('aria-pressed', 'false');
    const layer = createClipLayer({
      clips: () => (deps.project()?.items ?? []).filter((entry): entry is ProjectClipItem => (
        entry.kind === 'clip' && entry.sourceId === source.id && !entry.trashedAt
      )),
      async create(page, rect) {
        const name = defaultClipTitle(source.title, page, source.fileKind === 'pdf');
        const result = await saveOps(projectId, [{ op: 'clip', source: source.id, page, rect, name }]) as ProjectOpsResult | undefined;
        return result?.created?.[0] ?? null;
      },
      async update(clipId, rect) {
        await saveOps(projectId, [{ op: 'clip', id: clipId, rect }]);
      },
      async rename(clipId, name) {
        await saveOps(projectId, [{ op: 'rename', id: clipId, name }]);
      },
      async remove(clipId) {
        await saveOps(projectId, [{ op: 'trash', id: clipId }]);
      },
      onDrawingChange(drawing) {
        tool.setAttribute('aria-pressed', String(drawing));
        tool.classList.toggle('ag-active', drawing);
        root.dataset.clipDrawing = drawing ? 'true' : 'false';
      },
    });
    tool.addEventListener('click', () => layer.setDrawing(!layer.drawing));
    tools.prepend(tool);
    clipLayer = layer;
    return layer;
  }

  async function showPdf(
    projectId: string,
    item: ProjectFileItem,
    anchor: WikilinkAnchor | null,
    quote: string | null,
    token: number,
    focus: ProjectClipItem | null = null,
  ): Promise<void> {
    root.dataset.kind = 'pdf';
    const pdf = createPdfViewer({
      onPageChange: (page, total) => { meta.textContent = `${page} / ${total}`; },
    });
    viewer = pdf;
    pdf.setVisible(isVisible);
    zoomTools(() => pdf.zoomOut(), () => pdf.zoomIn());
    busy();
    const [blob, chunk] = await Promise.all([
      deps.service.fileBlob(projectId, item.id),
      chunkFor(projectId, item.id, anchor),
    ]);
    if (token !== generation) return;
    body.replaceChildren(pdf.element);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (token !== generation) return;
    await pdf.load(bytes);
    if (token !== generation) return;
    body.removeAttribute('aria-busy');
    const layer = mountClipLayer(projectId, item);
    for (const page of pdf.pages()) layer.attach(page.page, page.element);
    if (focus) {
      pdf.scrollToRegion(focus.page, focus.rect);
      layer.reveal(focus.id);
    } else if (chunk?.page) {
      await pdf.highlight(chunk.page, { chunk, quote });
    } else if (anchor?.kind === 'page') {
      pdf.showPage(anchor.n);
    }
  }

  async function showImage(projectId: string, item: ProjectFileItem, token: number, focus: ProjectClipItem | null = null): Promise<void> {
    root.dataset.kind = 'image';
    busy();
    const blob = await deps.service.fileBlob(projectId, item.id);
    if (token !== generation) return;
    objectUrl = URL.createObjectURL(blob);
    const frame = el('div', 'ag-pp-image');
    // 영역 층은 그림 상자와 같은 크기의 감싸개 위에 덮는다.
    const page = el('span', 'ag-pp-image-page');
    const image = el('img');
    image.alt = item.title;
    image.decoding = 'async';
    image.src = objectUrl;
    page.append(image);
    frame.append(page);
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
    const layer = mountClipLayer(projectId, item);
    layer.attach(1, page);
    if (focus) {
      const reveal = () => {
        if (token !== generation) return;
        const box = layer.reveal(focus.id);
        box?.scrollIntoView({ block: 'center', inline: 'center' });
      };
      if (image.complete) reveal();
      else image.addEventListener('load', reveal, { once: true });
    }
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
      dirty = () => editor.value !== source;
      editor.addEventListener('input', () => deps.onDirtyChange?.());
      editor.setAttribute('aria-label', '노트 내용');
      editor.spellcheck = false;
      const cancel = button('ag-pp-text-button', '편집 취소', { text: '취소' });
      const save = button('ag-pp-text-button ag-pp-primary', '노트 저장', { text: '저장' });
      tools.replaceChildren(cancel, save);
      body.replaceChildren(editor);
      if (isVisible) editor.focus();
      const finish = () => {
        dirty = () => false;
        deps.onDirtyChange?.();
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
        const savedBody = editor.value;
        const ops: ProjectOp[] = [{ op: 'note', id: item.id, body: savedBody, mode: 'replace' }];
        try {
          if (deps.edit) await deps.edit(ops);
          else await deps.service.applyOps(projectId, ops);
          if (token !== generation) return;
          source = savedBody;
          render();
          if (editor.value === savedBody) finish();
          else {
            save.disabled = false;
            cancel.disabled = false;
            deps.onDirtyChange?.();
          }
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
    // 영역 조각은 원본을 그 쪽에서 열고 테두리로 보여 준다.
    const found = findItem(request.itemId);
    const clip = found?.kind === 'clip' ? found : null;
    const item = clip ? findItem(clip.sourceId) : found;
    if (!project || !item || item.kind === 'clip') {
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
      if (item.fileKind === 'pdf') await showPdf(project.id, item, anchor, quote, token, clip);
      else if (item.fileKind === 'image') await showImage(project.id, item, token, clip);
      else if (item.status === 'failed') message('글자를 읽지 못한 파일입니다.');
      else await showReader(project.id, item, anchor, quote, token);
    } catch (error) {
      if (token !== generation) return;
      if ((error as Error)?.message === 'closed') return;
      body.removeAttribute('aria-busy');
      message(errorText(error));
      const retry = button('ag-pp-text-button', '다시 열기', { text: '다시 시도' });
      retry.addEventListener('click', () => { void show(request); });
      body.append(retry);
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
    if (!deps.managedClose) clear();
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
    // 그리던 영역·영역 도구·고른 영역을 먼저 푼다.
    if (clipLayer?.escape()) {
      event.stopPropagation();
      return;
    }
    goBack();
  });
  syncBack();

  return {
    element: root,
    open,
    refresh() {
      if (!current) return;
      const found = findItem(current.itemId);
      const item = found?.kind === 'clip' ? findItem(found.sourceId) : found;
      if (item) {
        title.textContent = item.title;
        title.title = item.title;
      }
      clipLayer?.refresh();
      refreshCitations(body, citations);
    },
    clear,
    setVisible(next) {
      isVisible = next;
      root.inert = !next;
      viewer?.setVisible(next);
    },
    async reveal(request) {
      const found = findItem(request.itemId);
      const source = found?.kind === 'clip' ? findItem(found.sourceId) : found;
      const previous = current ? findItem(current.itemId) : null;
      const previousSource = previous?.kind === 'clip' ? findItem(previous.sourceId) : previous;
      if (!source || source.id !== previousSource?.id) return open(request);
      current = request;
      if (source.kind === 'note') return;
      if (!viewer) {
        if (found?.kind === 'clip') {
          const box = clipLayer?.reveal(found.id);
          box?.scrollIntoView({ block: 'center', inline: 'center' });
        } else if (source.kind === 'file' && source.fileKind !== 'image' && (request.anchor || request.quote)) {
          const projectId = deps.project()?.id;
          if (projectId) await showReader(projectId, source, parseAnchor(request.anchor), request.quote?.trim() || null, ++generation);
        }
        return;
      }
      const pdf = viewer;
      const token = generation;
      if (found?.kind === 'clip') {
        pdf.scrollToRegion(found.page, found.rect);
        clipLayer?.reveal(found.id);
        return;
      }
      const anchor = parseAnchor(request.anchor);
      if (anchor?.kind === 'page') pdf.showPage(anchor.n);
      else if (anchor?.kind === 'chunk') {
        const projectId = deps.project()?.id;
        if (!projectId) return;
        const chunk = await chunkFor(projectId, source.id, anchor);
        if (token !== generation || pdf !== viewer || !isVisible) return;
        if (chunk?.page) await pdf.highlight(chunk.page, { chunk, quote: request.quote });
      }
    },
    get hasUnsavedChanges() { return dirty(); },
    get current() {
      return current;
    },
    destroy() {
      clear();
    },
  };
}
