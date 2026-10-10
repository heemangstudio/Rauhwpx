/** 자료별 미리보기와 초안은 탭이 닫힐 때까지 보존한다. 저장하는 것은 항목 id와 탭 순서뿐이다. */
import './workbench-documents.css';
import type { ProjectClient } from '../../agent/project-service.ts';
import type { ProjectFileItem, ProjectItem, ProjectNoteItem, ProjectSnapshot } from '../../agent/types.ts';
import { loadPdfjs, pdfDocumentParams } from '../../agent/pdf-render.ts';
import { createProjectPreview, type ProjectPreview, type ProjectPreviewRequest } from './project/project-preview.ts';
import { button, el, itemIconName, projectIcon } from './project/project-ui.ts';
import { decodeTextBytes, prettyJson, textFormatOf, type TextFormat } from './project/text-decode.ts';

export interface WorkbenchDocumentsDeps {
  client: ProjectClient | null;
  openDocument?: (documentId: string) => void;
  onChange?: () => void;
}

export interface WorkbenchDocuments {
  readonly element: HTMLElement;
  readonly tabCount: number;
  descriptors(): readonly { id: string; itemId: string; title: string; dirty: boolean }[];
  activeTab(): string | null;
  selectTab(id: string | null): Promise<void>;
  closeTab(id: string): void;
  open(request: ProjectPreviewRequest): Promise<boolean>;
  setVisible(visible: boolean): void;
  setClient(client: ProjectClient | null): void;
  dispose(): void;
}

interface ResourceTab {
  id: string;
  itemId: string;
  request: ProjectPreviewRequest;
  root: HTMLElement;
  button: HTMLButtonElement;
  label: HTMLElement;
  panel: HTMLElement;
  preview: ProjectPreview | null;
  loaded: boolean;
  loading: Promise<void> | null;
}

const MAX_TABS = 8;
/** 표지에 쓰는 텍스트 파일 앞부분. */
const EXCERPT_BYTES = 16_384;
const EXCERPT_CHARS = 1_400;
const EXCERPT_LINES = 48;

/** 표지를 그릴 수 있는 자료. 알 수 없는 형식과 글자를 못 뽑은 문서는 표지 자리만 둔다. */
function hasCover(item: ProjectFileItem | ProjectNoteItem): boolean {
  if (item.kind === 'note') return true;
  if (item.status === 'processing' || item.fileKind === 'other') return false;
  if (item.fileKind === 'pdf' || item.fileKind === 'image' || item.fileKind === 'text') return true;
  return item.status === 'ready';
}

/** Markdown 기호를 걷어 낸 한 줄. */
function plainMarkdownLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '• ')
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, id: string, label?: string) => label || id)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^>\s?/, '');
}

/** 첫 줄들을 종이 한 장처럼 그린 표지. 실제 크기로 짜고 CSS 로 줄인다. */
function textSheet(source: string, format: TextFormat): HTMLElement | null {
  const text = (format === 'json' ? prettyJson(source) : source).replace(/\r\n?/g, '\n').slice(0, EXCERPT_CHARS);
  const lines = text.split('\n').slice(0, EXCERPT_LINES);
  if (!lines.some(line => line.trim())) return null;
  const sheet = el('span', `ag-wdocs-sheet${format === 'json' ? ' ag-wdocs-sheet-code' : ''}`);
  const page = el('span', 'ag-wdocs-sheet-page');
  let fence = false;
  for (const raw of lines) {
    if (format === 'markdown' && /^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    const heading = format === 'markdown' && !fence ? /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw) : null;
    const line = heading
      ? el('span', `ag-wdocs-sheet-line ag-wdocs-sheet-h${Math.min(heading[1].length, 3)}`, plainMarkdownLine(heading[2]))
      : el('span', 'ag-wdocs-sheet-line', format === 'markdown' && !fence ? plainMarkdownLine(raw) : raw);
    if (!line.textContent?.trim()) line.classList.add('ag-wdocs-sheet-gap');
    page.append(line);
  }
  sheet.append(page);
  return sheet;
}
const LIBRARY = 'library';
let nextInstance = 0;

export function createWorkbenchDocuments(deps: WorkbenchDocumentsDeps): WorkbenchDocuments {
  const instance = ++nextInstance;
  const root = el('section', 'ag-wdocs');
  root.setAttribute('aria-label', '문서와 자료');
  const strip = el('div', 'ag-wdocs-tabs');
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', '열린 자료');
  const libraryTab = button('ag-wdocs-tab ag-wdocs-library-tab', '자료 목록', { icon: 'file', text: '자료' });
  const panels = el('div', 'ag-wdocs-panels');
  const library = el('section', 'ag-wdocs-library');
  const head = el('header', 'ag-wdocs-library-head');
  const heading = el('div');
  const eyebrow = el('span', 'ag-wdocs-eyebrow', 'LIBRARY');
  const title = el('h2', 'ag-wdocs-heading', '문서와 자료');
  const count = el('p', 'ag-wdocs-subtitle');
  heading.append(eyebrow, title, count);
  const add = button('ag-wdocs-action', '파일 추가', { icon: 'plus', text: '추가' });
  head.append(heading, add);
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  const controls = el('div', 'ag-wdocs-controls');
  const search = el('input', 'ag-wdocs-search');
  search.type = 'search';
  search.placeholder = '자료 검색';
  search.setAttribute('aria-label', '자료 검색');
  const layout = button('ag-wdocs-action ag-wdocs-layout', '목록으로 보기', { text: '목록' });
  controls.append(search, layout);
  const grid = el('div', 'ag-wdocs-grid');
  const notice = el('div', 'ag-wdocs-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  library.append(head, controls, grid, input);
  panels.append(library);
  strip.append(libraryTab);
  root.append(strip, notice, panels);

  let client: ProjectClient | null = null;
  let project: ProjectSnapshot | null = null;
  let projectId: string | null = null;
  let unsubscribe = () => {};
  let visible = false;
  let disposed = false;
  let active = LIBRARY;
  let generation = 0;
  let thumbnailGeneration = 0;
  let list = false;
  const tabs: ResourceTab[] = [];
  const urls = new Set<string>();
  const thumbnailCleanups = new Set<() => void>();
  let observer: IntersectionObserver | null = null;
  let queue: Array<() => Promise<void>> = [];
  let running = 0;
  const key = () => `rhwp.workbench.documents.v1:${projectId}`;
  const find = (id: string): ProjectItem | null => project?.items.find(item => item.id === id && !item.trashedAt) ?? null;

  function identify(element: HTMLElement, panel: HTMLElement, id: string): void {
    element.id = `ag-wdocs-${instance}-tab-${encodeURIComponent(id)}`;
    panel.id = `ag-wdocs-${instance}-panel-${encodeURIComponent(id)}`;
    element.setAttribute('role', 'tab');
    element.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', element.id);
  }
  identify(libraryTab, library, LIBRARY);

  function persist(): void {
    if (!projectId || disposed) return;
    try { localStorage.setItem(key(), JSON.stringify({ version: 1, items: tabs.map(tab => tab.itemId), active })); } catch { /* 저장소 제한 */ }
  }

  function status(text: string): void {
    notice.replaceChildren(el('span', '', text));
    notice.hidden = false;
  }

  function clearNotice(): void {
    notice.hidden = true;
    notice.replaceChildren();
  }

  function cleanupThumbnails(): void {
    thumbnailGeneration += 1;
    observer?.disconnect();
    observer = null;
    queue = [];
    for (const cleanup of thumbnailCleanups) cleanup();
    thumbnailCleanups.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }

  function drain(): void {
    while (running < 2 && queue.length && visible && active === LIBRARY && !disposed) {
      const task = queue.shift()!;
      running += 1;
      void task().catch(() => {}).finally(() => { running -= 1; drain(); });
    }
  }

  /** 보이는 표지 두 장까지만 연다. 탭 전환·프로젝트 변경은 PDF 작업도 닫는다. 글자 자료는 앞부분을 종이에 옮긴다. */
  function thumbnail(frame: HTMLElement, item: ProjectFileItem | ProjectNoteItem): void {
    const token = thumbnailGeneration;
    const owner = client;
    const scope = projectId;
    const valid = () => !disposed && visible && active === LIBRARY && token === thumbnailGeneration
      && owner === client && scope === projectId && frame.isConnected && find(item.id)?.kind === item.kind;
    const render = async () => {
      if (!owner || !scope || !valid()) return;
      let close: (() => void) | null = null;
      let canvas: HTMLCanvasElement | null = null;
      try {
        if (item.kind === 'note' || (item.fileKind !== 'pdf' && item.fileKind !== 'image')) {
          const excerpt = await coverText(owner, scope, item);
          if (excerpt === null || !valid()) return;
          const sheet = textSheet(excerpt, item.kind === 'note' ? 'markdown' : item.fileKind === 'text' ? textFormatOf(item) : 'plain');
          if (sheet) frame.replaceChildren(sheet);
          return;
        }
        const blob = await owner.service.fileBlob(scope, item.id);
        if (!valid()) return;
        if (item.fileKind === 'image') {
          const url = URL.createObjectURL(blob);
          urls.add(url);
          const image = el('img');
          image.src = url;
          image.alt = '';
          frame.replaceChildren(image);
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!valid()) return;
        const pdfjs = await loadPdfjs();
        if (!valid()) return;
        const task = pdfjs.getDocument(pdfDocumentParams(bytes));
        close = () => { void task.destroy().catch(() => {}); };
        thumbnailCleanups.add(close);
        const doc = await task.promise;
        if (!valid()) return;
        const page = await doc.getPage(1);
        if (!valid()) return;
        const unit = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(320 / unit.width, 420 / unit.height) });
        canvas = el('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;
        await page.render({ canvasContext: context, viewport }).promise;
        if (!valid()) return;
        const imageBlob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/jpeg', 0.8));
        if (!imageBlob || !valid()) return;
        const url = URL.createObjectURL(imageBlob);
        urls.add(url);
        const image = el('img');
        image.src = url;
        image.alt = '';
        frame.replaceChildren(image);
      } catch {
        // 표지를 그릴 수 없어도 파일은 목록에서 열 수 있다.
      } finally {
        if (canvas) canvas.width = canvas.height = 0;
        if (close) { thumbnailCleanups.delete(close); close(); }
      }
    };
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        const target = entry.target as HTMLElement & { startThumbnail?: () => Promise<void> };
        if (target.startThumbnail) queue.push(target.startThumbnail);
      }
      drain();
    }, { root: library, rootMargin: '80px' });
    (frame as HTMLElement & { startThumbnail?: () => Promise<void> }).startThumbnail = render;
    observer.observe(frame);
  }

  /** 표지에 쓸 앞부분 글자. 텍스트 파일은 원본 바이트를 직접 풀어 인코딩을 가린다. */
  async function coverText(owner: ProjectClient, scope: string, item: ProjectFileItem | ProjectNoteItem): Promise<string | null> {
    if (item.kind === 'note') return (await owner.service.note(scope, item.id)).body;
    if (item.fileKind === 'text') {
      const blob = await owner.service.fileBlob(scope, item.id);
      const whole = blob.size <= EXCERPT_BYTES;
      const bytes = new Uint8Array(await (whole ? blob : blob.slice(0, EXCERPT_BYTES)).arrayBuffer());
      return decodeTextBytes(bytes, { partial: !whole });
    }
    return (await owner.service.fileText(scope, item.id, 1)).text;
  }

  function renderLibrary(): void {
    cleanupThumbnails();
    const all = project?.items.filter(item => !item.trashedAt && item.kind !== 'clip') ?? [];
    const query = search.value.trim().toLocaleLowerCase();
    const resources = all.filter(item => !query || `${item.title} ${item.summary}`.toLocaleLowerCase().includes(query));
    // PDF 표지를 먼저 보여 주고 나머지 자료는 같은 목록에서 찾는다.
    resources.sort((a, b) => Number(b.kind === 'file' && b.fileKind === 'pdf') - Number(a.kind === 'file' && a.fileKind === 'pdf') || b.updatedAt - a.updatedAt);
    count.textContent = project ? `${project.name} · ${all.length}개 자료` : '프로젝트의 자료를 이곳에서 열어 보세요.';
    add.disabled = !client || !project;
    grid.classList.toggle('ag-wdocs-list', list);
    grid.replaceChildren();
    if (!resources.length) {
      grid.append(el('p', 'ag-wdocs-empty', query ? '검색 결과가 없습니다.' : '파일을 추가하면 여기에 모입니다.'));
      return;
    }
    for (const item of resources) {
      const card = button('ag-wdocs-card', `${item.title} 열기`);
      card.dataset.itemId = item.id;
      const cover = el('span', 'ag-wdocs-cover');
      cover.setAttribute('aria-hidden', 'true');
      const paper = el('span', 'ag-wdocs-paper');
      paper.append(projectIcon(itemIconName(item)), el('span', '', item.kind === 'file' ? item.fileKind.toUpperCase() : 'NOTE'));
      cover.append(paper);
      const text = el('span', 'ag-wdocs-card-text');
      const name = el('span', 'ag-wdocs-card-title', item.title);
      const detail = item.kind === 'file'
        ? item.status === 'processing' ? '처리 중' : `${item.pageCount ? `${item.pageCount}쪽 · ` : ''}${item.fileKind.toUpperCase()}`
        : '노트';
      text.append(name, el('span', 'ag-wdocs-card-meta', detail));
      card.append(cover, text);
      card.addEventListener('click', () => { void open({ itemId: item.id }); });
      grid.append(card);
      if (visible && active === LIBRARY && item.kind !== 'clip' && hasCover(item)) thumbnail(cover, item);
    }
  }

  function sync(): void {
    root.inert = !visible;
    root.setAttribute('aria-hidden', String(!visible));
    libraryTab.setAttribute('aria-selected', String(active === LIBRARY));
    libraryTab.tabIndex = active === LIBRARY ? 0 : -1;
    library.hidden = active !== LIBRARY;
    library.inert = !visible || active !== LIBRARY;
    for (const tab of tabs) {
      const selected = active === tab.id;
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.panel.hidden = !selected;
      tab.panel.inert = !visible || !selected;
      tab.preview?.setVisible(visible && selected);
      tab.root.classList.toggle('ag-wdocs-dirty', tab.preview?.hasUnsavedChanges ?? false);
    }
    persist();
    if (!disposed) deps.onChange?.();
  }

  async function ensureLoaded(tab: ResourceTab): Promise<void> {
    if (disposed || !visible || active !== tab.id || tab.loaded || !client || !projectId) return;
    if (tab.loading) return tab.loading;
    const member = project?.members.find(entry => entry.nodeId === tab.itemId);
    if (member) {
      const openEditor = button('ag-wdocs-action ag-wdocs-open-document', '편집기에서 문서 열기', { text: '편집기에서 열기' });
      openEditor.disabled = !deps.openDocument;
      openEditor.addEventListener('click', () => deps.openDocument?.(member.documentId));
      tab.panel.replaceChildren(el('p', 'ag-wdocs-empty', member.name || '프로젝트 문서'), openEditor);
      tab.loaded = true;
      return;
    }
    const owner = client;
    const scope = projectId;
    const token = generation;
    const valid = () => !disposed && token === generation && scope === projectId && owner === client && tabs.includes(tab);
    tab.preview ??= createProjectPreview({
      service: owner.service,
      project: () => valid() ? project : null,
      edit: ops => valid() ? owner.store.edit(ops) : Promise.reject(new Error('closed')),
      onClose: () => closeTab(tab),
      managedClose: true,
      onOpen: request => { void open(request); },
      onDirtyChange: sync,
      openDocument: deps.openDocument,
    });
    tab.preview.setVisible(true);
    tab.panel.replaceChildren(tab.preview.element);
    const preview = tab.preview;
    tab.loading = preview.open(tab.request).then(() => { if (valid()) tab.loaded = true; }).catch(() => {
      if (valid()) status('자료를 열지 못했습니다. 다시 열어 주세요.');
    }).finally(() => { tab.loading = null; });
    return tab.loading;
  }

  async function select(id: string): Promise<void> {
    if (disposed) return;
    const previous = active;
    active = id;
    clearNotice();
    sync();
    if (active === LIBRARY) {
      if (visible && previous !== LIBRARY) renderLibrary();
    } else {
      if (previous === LIBRARY) cleanupThumbnails();
      const tab = tabs.find(entry => entry.id === id);
      if (tab) await ensureLoaded(tab);
    }
  }

  function removeTab(tab: ResourceTab): void {
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    tabs.splice(index, 1);
    tab.preview?.destroy();
    tab.root.remove();
    tab.panel.remove();
    if (active === tab.id) void select(tabs[Math.min(index, tabs.length - 1)]?.id ?? LIBRARY);
    else sync();
  }

  function closeTab(tab: ResourceTab): void {
    if (tab.preview?.hasUnsavedChanges) {
      void select(tab.id);
      status('저장하지 않은 노트가 있습니다.');
      const keep = button('ag-wdocs-action', '노트 계속 편집', { text: '계속 편집' });
      const discard = button('ag-wdocs-action', '변경 버리고 닫기', { text: '버리고 닫기' });
      keep.addEventListener('click', clearNotice);
      discard.addEventListener('click', () => { clearNotice(); removeTab(tab); });
      notice.append(keep, discard);
      return;
    }
    removeTab(tab);
  }

  function addTab(itemId: string): ResourceTab {
    const id = `${projectId}/${itemId}`;
    const row = el('div', 'ag-wdocs-tab-row');
    const tabButton = button('ag-wdocs-tab', '자료 열기');
    const label = el('span', 'ag-wdocs-tab-label');
    const close = button('ag-wdocs-close', '자료 닫기', { icon: 'close' });
    close.tabIndex = -1;
    const panel = el('section', 'ag-wdocs-panel');
    identify(tabButton, panel, id);
    panel.hidden = true;
    row.append(tabButton, close);
    strip.append(row);
    panels.append(panel);
    const tab: ResourceTab = { id, itemId, request: { itemId }, root: row, button: tabButton, label, panel, preview: null, loaded: false, loading: null };
    tabs.push(tab);
    tabButton.addEventListener('click', () => { void select(id); });
    close.addEventListener('click', () => closeTab(tab));
    row.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); closeTab(tab); } });
    updateTab(tab);
    return tab;
  }

  function updateTab(tab: ResourceTab): void {
    const item = find(tab.itemId);
    const member = project?.members.find(entry => entry.nodeId === tab.itemId);
    const name = item?.title ?? member?.name ?? '문서';
    tab.label.textContent = name;
    tab.button.title = name;
    tab.button.setAttribute('aria-label', `${name} 열기`);
    tab.button.replaceChildren(projectIcon(item ? itemIconName(item) : 'documentNode'), tab.label);
    tab.root.querySelector('.ag-wdocs-close')?.setAttribute('aria-label', `${name} 닫기`);
    tab.preview?.refresh();
  }

  /** 탭을 열지 못하면 false를 돌려준다. 호출한 쪽은 안내가 보이도록 자료 목록을 연다. */
  async function open(request: ProjectPreviewRequest): Promise<boolean> {
    if (disposed || !projectId) return false;
    const item = find(request.itemId);
    const member = project?.members.find(entry => entry.nodeId === request.itemId);
    if (!item && !member) { status('항목을 찾지 못했습니다.'); return false; }
    const itemId = item?.kind === 'clip' ? item.sourceId : request.itemId;
    let tab = tabs.find(entry => entry.itemId === itemId);
    if (!tab && tabs.length >= MAX_TABS) { status('자료는 8개까지 열 수 있습니다. 탭을 닫고 다시 열어 주세요.'); return false; }
    tab ??= addTab(itemId);
    const wasLoaded = tab.loaded;
    tab.request = request;
    await select(tab.id);
    if ((wasLoaded || tab.preview?.current !== request) && active === tab.id && tab.request === request && visible && tabs.includes(tab) && (request.anchor || request.quote || item?.kind === 'clip')) {
      await tab.preview?.reveal(request).catch(() => {});
    }
    return true;
  }

  function restore(): void {
    if (!projectId) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key()) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      const value = saved as { version?: unknown; items?: unknown; active?: unknown };
      if (value.version !== 1 || !Array.isArray(value.items)) return;
      for (const itemId of value.items) {
        if (typeof itemId !== 'string' || tabs.some(tab => tab.itemId === itemId) || tabs.length >= MAX_TABS) continue;
        if (find(itemId) || project?.members.some(member => member.nodeId === itemId)) addTab(itemId);
      }
      active = tabs.find(tab => tab.id === value.active)?.id ?? LIBRARY;
    } catch { /* 망가진 기록은 비운 목록으로 시작한다. */ }
  }

  function update(next: ProjectSnapshot | null): void {
    if (disposed) return;
    if ((next?.id ?? null) !== projectId) {
      generation += 1;
      for (const tab of tabs.splice(0)) { tab.preview?.destroy(); tab.root.remove(); tab.panel.remove(); }
      project = next;
      projectId = next?.id ?? null;
      active = LIBRARY;
      clearNotice();
      restore();
    } else {
      project = next;
      for (const tab of [...tabs]) {
        if (!find(tab.itemId) && !project?.members.some(member => member.nodeId === tab.itemId)) removeTab(tab);
        else updateTab(tab);
      }
    }
    renderLibrary();
    sync();
    const selected = tabs.find(tab => tab.id === active);
    if (selected) void ensureLoaded(selected);
  }

  function setClient(next: ProjectClient | null): void {
    if (disposed || next === client) return;
    unsubscribe();
    // 재연결된 클라이언트의 같은 프로젝트도 이전 비동기 요청을 무효화한다.
    persist();
    projectId = null;
    client = next;
    clearNotice();
    generation += 1;
    for (const tab of tabs.splice(0)) { tab.preview?.destroy(); tab.root.remove(); tab.panel.remove(); }
    update(next?.store.get() ?? null);
    unsubscribe = next?.store.subscribe(update) ?? (() => {});
  }

  libraryTab.addEventListener('click', () => { void select(LIBRARY); });
  search.addEventListener('input', renderLibrary);
  layout.addEventListener('click', () => {
    list = !list;
    layout.textContent = list ? '격자' : '목록';
    layout.setAttribute('aria-label', list ? '격자로 보기' : '목록으로 보기');
    renderLibrary();
  });
  add.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const owner = client;
    const scope = projectId;
    const token = generation;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!owner || !scope || !files.length) return;
    add.disabled = true;
    void (async () => {
      try {
        for (const file of files) {
          if (disposed || owner !== client || token !== generation) return;
          await owner.service.uploadFile(scope, file);
        }
        if (!disposed && owner === client && token === generation) await owner.store.refresh();
      } catch {
        if (!disposed && owner === client && token === generation) status('파일을 추가하지 못했습니다. 다시 시도해 주세요.');
      } finally {
        if (!disposed && owner === client && token === generation) add.disabled = false;
      }
    })();
  });
  strip.addEventListener('keydown', event => {
    if (event.isComposing || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    const buttons = [libraryTab, ...tabs.map(tab => tab.button)];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (event.key === 'Delete' && index > 0) {
      event.preventDefault();
      closeTab(tabs[index - 1]!);
      (active === LIBRARY ? libraryTab : tabs.find(tab => tab.id === active)?.button)?.focus();
    } else if (next !== null) {
      event.preventDefault();
      void select(next === 0 ? LIBRARY : tabs[next - 1]!.id);
      buttons[next]?.focus();
      buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
  setClient(deps.client);
  if (!deps.client) renderLibrary();
  sync();

  return {
    element: root,
    get tabCount() { return tabs.length; },
    descriptors: () => tabs.map(tab => ({ id: tab.id, itemId: tab.itemId, title: tab.label.textContent ?? '', dirty: tab.preview?.hasUnsavedChanges ?? false })),
    activeTab: () => active === LIBRARY ? null : active,
    selectTab(id) { return id === null || tabs.some(tab => tab.id === id) ? select(id ?? LIBRARY) : Promise.resolve(); },
    closeTab(id) { const tab = tabs.find(entry => entry.id === id); if (tab) closeTab(tab); },
    open,
    setClient,
    setVisible(next) {
      if (disposed || visible === next) return;
      visible = next;
      root.inert = !next;
      root.setAttribute('aria-hidden', String(!next));
      sync();
      if (!next) cleanupThumbnails();
      else if (active === LIBRARY) renderLibrary();
      else {
        const tab = tabs.find(entry => entry.id === active);
        if (tab) void ensureLoaded(tab);
      }
    },
    dispose() {
      if (disposed) return;
      persist();
      disposed = true;
      generation += 1;
      unsubscribe();
      cleanupThumbnails();
      for (const tab of tabs.splice(0)) tab.preview?.destroy();
      root.remove();
    },
  };
}
