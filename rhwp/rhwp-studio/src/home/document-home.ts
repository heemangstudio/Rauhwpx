/**
 * 문서 홈. 위에는 새 문서(빈 문서·템플릿), 아래에는 열어 본 문서가 종이 카드로 놓인다.
 * 문서가 없을 때 편집 영역의 기본 화면이고, 문서가 열려 있으면 그 위를 덮었다가 돌아간다.
 * 모양은 styles/document-home.css.
 *
 * 목록은 저장소에서 바로 그리고, 파일 확인·첫 쪽 그림은 보이는 카드부터 뒤에서 채운다.
 */
import type { DocumentTemplate } from '../agent/types.ts';
import type { RecentDoc } from '../recent/recent-store.ts';
import { beginInlineRename } from '../ui/inline-rename.ts';
import { createWorktreeChip, paintWorktreeChip } from '../ui/worktree-chip.ts';
import {
  displayName,
  groupHomeDocuments,
  openedLabel,
  sortHomeDocuments,
  type HomeDocument,
  type HomeSort,
  type HomeWorktree,
} from './home-model.ts';
import {
  defaultHealIo,
  documentThumbnail,
  healRecentDocuments,
  inspectRecentDocuments,
  rememberLiveThumbnail,
  templateThumbnail,
  type DocumentPresence,
  type WorktreeData,
} from './home-data.ts';

export type HomeOpenResult = 'opened' | 'cancelled' | 'missing' | 'failed';

export interface DocumentHomeDeps {
  listRecent(): Promise<RecentDoc[]>;
  loadWorktrees(): Promise<WorktreeData>;
  /** 허브에 닿지 않으면 null. 템플릿 자리를 비운다. */
  listTemplates(): Promise<DocumentTemplate[] | null>;
  templateBytes(template: DocumentTemplate): Promise<Uint8Array>;
  addTemplate?(file: File): Promise<void>;
  /** 이 창에 열려 있는 문서 ID. */
  liveDocumentIds(): ReadonlySet<string>;
  /** 열린 문서는 엔진에서 바로 그린다. 열려 있지 않으면 null. */
  liveThumbnail(documentId: string): Promise<Blob | null> | null;
  createBlank(): void;
  createFromTemplate(template: DocumentTemplate): Promise<void>;
  openFile(): void;
  openDocument(row: RecentDoc): Promise<HomeOpenResult>;
  openWorktree(tree: HomeWorktree): Promise<void>;
  canRename(row: RecentDoc): boolean;
  renameDocument(row: RecentDoc, name: string): Promise<string | null>;
  openInNewWindow?: (row: RecentDoc) => Promise<boolean>;
  reveal?: { label: string; run(row: RecentDoc): Promise<boolean> };
  /** 덮고 있는 문서 이름. 문서가 없으면 null 이고 돌아가기 단추를 숨긴다. */
  returnTarget(): string | null;
  onReturn(): void;
  onDrop?(event: DragEvent): void;
  toast(message: string): void;
}

export interface DocumentHome {
  readonly element: HTMLElement;
  readonly visible: boolean;
  readonly surface: 'editor' | 'focus';
  /** surface: 'editor' 는 편집 영역을, 'focus' 는 에이전트 전체 화면의 작업 막대 아래를 덮는다. */
  show(options?: { surface?: 'editor' | 'focus'; focus?: boolean }): void;
  hide(): void;
  refresh(): void;
  onVisibilityChange(listener: (visible: boolean) => void): () => void;
}

const PREFS_KEY = 'rhwp.documentHome.v1';
const THUMBNAIL_CONCURRENCY = 2;

interface Prefs { sort: HomeSort; view: 'grid' | 'list' }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      sort: raw?.sort === 'name' ? 'name' : 'recent',
      view: raw?.view === 'list' ? 'list' : 'grid',
    };
  } catch {
    return { sort: 'recent', view: 'grid' };
  }
}

function writePrefs(prefs: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 저장소 제한 */ }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(path: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('dh-icon');
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('d', path);
  svg.append(node);
  return svg;
}

const ICONS = {
  back: 'M9.5 3.5 5 8l4.5 4.5',
  plus: 'M8 3v10M3 8h10',
  open: 'M2.5 4.5v8h11v-6h-6l-1.5-2z',
  grid: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
};

export function createDocumentHome(deps: DocumentHomeDeps): DocumentHome {
  const prefs = readPrefs();
  const root = el('section', 'document-home');
  root.id = 'document-home';
  root.setAttribute('aria-label', '문서 홈');
  root.hidden = true;

  const scroller = el('div', 'dh-scroll');
  root.append(scroller);

  // ── 새 문서 ─────────────────────────────────────────────
  const start = el('section', 'dh-start');
  start.setAttribute('aria-labelledby', 'dh-start-title');
  const startInner = el('div', 'dh-inner');
  const startBar = el('div', 'dh-bar');
  const back = button('dh-back', '');
  back.append(icon(ICONS.back, 14), el('span', 'dh-back-label'));
  const startTitle = el('h2', 'dh-heading', '새로 만들기');
  startTitle.id = 'dh-start-title';
  const openFile = button('dh-ghost', '');
  openFile.id = 'document-open-action';
  openFile.append(icon(ICONS.open, 14), el('span', '', '파일 열기'));
  const gallery = button('dh-ghost dh-gallery', '');
  gallery.setAttribute('aria-expanded', 'false');
  gallery.setAttribute('aria-controls', 'dh-templates');
  gallery.append(el('span', '', '템플릿 갤러리'), icon(ICONS.chevron, 14));
  gallery.hidden = true;
  startBar.append(back, startTitle, el('span', 'dh-spacer'), openFile, gallery);
  const templates = el('ul', 'dh-templates');
  templates.id = 'dh-templates';
  templates.setAttribute('aria-label', '새 문서 만들기');
  startInner.append(startBar, templates);
  start.append(startInner);

  // ── 최근 문서 ───────────────────────────────────────────
  const recent = el('section', 'dh-recent');
  recent.setAttribute('aria-labelledby', 'dh-recent-title');
  const recentInner = el('div', 'dh-inner');
  const recentBar = el('div', 'dh-bar');
  const recentTitle = el('h2', 'dh-heading', '최근 문서');
  recentTitle.id = 'dh-recent-title';
  const sortGroup = el('div', 'dh-segment');
  sortGroup.setAttribute('role', 'radiogroup');
  sortGroup.setAttribute('aria-label', '정렬');
  const sortRecent = button('dh-segment-btn', '최근 순');
  const sortName = button('dh-segment-btn', '이름 순');
  sortGroup.append(sortRecent, sortName);
  const viewGroup = el('div', 'dh-segment');
  viewGroup.setAttribute('role', 'radiogroup');
  viewGroup.setAttribute('aria-label', '보기');
  const viewGrid = button('dh-segment-btn dh-segment-icon', '', '바둑판 보기');
  viewGrid.append(icon(ICONS.grid, 14));
  viewGrid.title = '바둑판 보기';
  const viewList = button('dh-segment-btn dh-segment-icon', '', '목록 보기');
  viewList.append(icon(ICONS.list, 14));
  viewList.title = '목록 보기';
  viewGroup.append(viewGrid, viewList);
  recentBar.append(recentTitle, el('span', 'dh-spacer'), sortGroup, viewGroup);
  const grid = el('ul', 'dh-grid');
  grid.setAttribute('aria-label', '최근 문서');
  const status = el('p', 'dh-status');
  status.setAttribute('role', 'status');
  recentInner.append(recentBar, grid, status);
  recent.append(recentInner);
  scroller.append(start, recent);

  const templateInput = el('input');
  templateInput.type = 'file';
  templateInput.accept = '.hwp,.hwpx';
  templateInput.hidden = true;
  root.append(templateInput);

  let visible = false;
  let surface: 'editor' | 'focus' = 'editor';
  let editorHost: HTMLElement | null = null;
  let rows: RecentDoc[] = [];
  let documents: HomeDocument[] = [];
  let presence = new Map<string, DocumentPresence>();
  let templateList: DocumentTemplate[] | null = null;
  let galleryOpen = false;
  let expanded: string | null = null;
  let focusedId: string | null = null;
  const listeners = new Set<(visible: boolean) => void>();
  /** 카드 그림은 다시 그려도 재사용한다. 목록에서 빠진 문서의 그림은 버린다. */
  const blobs = new Map<string, Blob>();
  let observer: IntersectionObserver | null = null;
  let queue: Array<() => Promise<void>> = [];
  let running = 0;
  const pending = new Set<string>();
  /** 새 문서 줄과 최근 문서 격자는 따로 다시 그린다. 그림 주소도 칸마다 따로 거둔다. */
  interface ThumbnailScope { generation: number; urls: Set<string> }
  const templateScope: ThumbnailScope = { generation: 0, urls: new Set() };
  const gridScope: ThumbnailScope = { generation: 0, urls: new Set() };

  // ── 그림 ────────────────────────────────────────────────
  function resetScope(scope: ThumbnailScope, host?: HTMLElement): void {
    scope.generation += 1;
    // 다시 그리기 전의 종이는 관찰을 푼다. 떨어진 카드가 관찰자에 남지 않는다.
    if (host && observer) {
      for (const paper of host.querySelectorAll('.dh-paper[data-thumb-key]')) observer.unobserve(paper);
    }
    for (const url of scope.urls) URL.revokeObjectURL(url);
    scope.urls.clear();
  }

  function paintImage(scope: ThumbnailScope, paper: HTMLElement, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    scope.urls.add(url);
    const image = el('img', 'dh-thumb');
    image.alt = '';
    image.draggable = false;
    image.decoding = 'async';
    image.src = url;
    image.addEventListener('load', () => paper.classList.add('has-thumb'), { once: true });
    paper.querySelector('.dh-thumb')?.remove();
    paper.append(image);
  }

  function drain(): void {
    while (running < THUMBNAIL_CONCURRENCY && queue.length && visible) {
      const task = queue.shift()!;
      running += 1;
      void task().catch(() => {}).finally(() => { running -= 1; drain(); });
    }
  }

  function ensureObserver(): IntersectionObserver {
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        const start = (entry.target as HTMLElement & { loadThumbnail?: () => Promise<void> }).loadThumbnail;
        if (start) queue.push(start);
      }
      drain();
    }, { root: scroller, rootMargin: '240px 0px' });
    return observer;
  }

  function lazyThumbnail(scope: ThumbnailScope, paper: HTMLElement, key: string, load: () => Promise<Blob | null>): void {
    paper.dataset.thumbKey = key;
    const known = blobs.get(key);
    if (known) {
      paintImage(scope, paper, known);
      return;
    }
    const token = scope.generation;
    (paper as HTMLElement & { loadThumbnail?: () => Promise<void> }).loadThumbnail = async () => {
      if (token !== scope.generation || !visible || pending.has(key)) return;
      pending.add(key);
      try {
        const blob = await load();
        if (!blob) return;
        blobs.set(key, blob);
        if (!visible) return;
        // 그사이 목록을 다시 그렸으면 같은 문서의 새 카드에 칠한다.
        for (const target of root.querySelectorAll<HTMLElement>(`[data-thumb-key="${CSS.escape(key)}"]`)) {
          if (!target.querySelector('.dh-thumb')) paintImage(scope, target, blob);
        }
      } finally {
        pending.delete(key);
      }
    };
    ensureObserver().observe(paper);
  }

  function resetThumbnails(): void {
    observer?.disconnect();
    observer = null;
    queue = [];
    resetScope(templateScope);
    resetScope(gridScope);
  }

  // ── 종이 ────────────────────────────────────────────────
  function placeholderPaper(title: string, extra = ''): HTMLElement {
    const paper = el('span', `dh-paper${extra ? ` ${extra}` : ''}`);
    paper.setAttribute('aria-hidden', 'true');
    const sheet = el('span', 'dh-sheet');
    sheet.append(el('span', 'dh-sheet-title', title));
    for (let line = 0; line < 7; line += 1) sheet.append(el('span', 'dh-sheet-line'));
    paper.append(sheet);
    return paper;
  }

  // ── 새 문서 줄 ──────────────────────────────────────────
  function templateCard(
    label: string,
    detail: string,
    paper: HTMLElement,
    activate: () => void,
    id?: string,
  ): HTMLLIElement {
    const item = el('li', 'dh-template');
    const card = button('dh-template-card', '');
    if (id) card.id = id;
    card.setAttribute('aria-label', detail ? `${label}, ${detail}` : label);
    const text = el('span', 'dh-template-text');
    text.append(el('span', 'dh-template-name', label));
    if (detail) text.append(el('span', 'dh-template-detail', detail));
    card.append(paper, text);
    card.addEventListener('click', activate);
    item.append(card);
    return item;
  }

  function renderTemplates(): void {
    resetScope(templateScope, templates);
    const items: HTMLLIElement[] = [];
    const blank = el('span', 'dh-paper dh-paper-blank');
    blank.setAttribute('aria-hidden', 'true');
    blank.append(icon(ICONS.plus, 28));
    items.push(templateCard('빈 문서', '', blank, () => deps.createBlank(), 'document-new-action'));
    for (const template of templateList ?? []) {
      const paper = placeholderPaper(template.name);
      const pages = template.pageCount > 0 ? `${template.pageCount}쪽` : '';
      items.push(templateCard(template.name, ['템플릿', pages].filter(Boolean).join(' · '), paper, () => {
        void deps.createFromTemplate(template).catch((error) => {
          deps.toast(error instanceof Error ? error.message : '템플릿으로 문서를 만들지 못했습니다.');
        });
      }));
      lazyThumbnail(templateScope, paper, `template:${template.id}:${template.revision}`, () => templateThumbnail(template, () => deps.templateBytes(template)));
    }
    if (templateList && deps.addTemplate) {
      const add = el('span', 'dh-paper dh-paper-add');
      add.setAttribute('aria-hidden', 'true');
      add.append(icon(ICONS.plus, 20));
      items.push(templateCard('템플릿 추가', 'HWP · HWPX', add, () => templateInput.click()));
    }
    templates.replaceChildren(...items);
    fitTemplates();
  }

  /** 접힌 갤러리는 한 줄만 보인다. 넘치는 템플릿이 있을 때만 펼치기 단추를 둔다. */
  function fitTemplates(): void {
    const width = templates.clientWidth;
    const items = [...templates.children] as HTMLElement[];
    const style = getComputedStyle(templates);
    const card = parseFloat(style.gridTemplateColumns) || 120;
    const gap = parseFloat(style.columnGap) || 16;
    const columns = Math.max(1, Math.floor((width + gap) / (card + gap)));
    const overflow = items.length > columns;
    gallery.hidden = !overflow;
    if (!overflow) galleryOpen = false;
    gallery.setAttribute('aria-expanded', String(galleryOpen));
    gallery.classList.toggle('is-open', galleryOpen);
    items.forEach((item, index) => { item.hidden = !galleryOpen && index >= columns; });
  }

  // ── 최근 문서 ───────────────────────────────────────────
  const rowFor = (doc: HomeDocument) => rows.find((row) => row.id === doc.recentId) ?? null;

  function metaFor(doc: HomeDocument, liveIds: ReadonlySet<string>): HTMLElement {
    const meta = el('span', 'dh-card-meta');
    const live = liveIds.has(doc.documentId);
    const state = presence.get(doc.recentId)?.state;
    meta.append(el('span', 'dh-format', doc.sourceFormat.toUpperCase()));
    if (live) meta.append(el('span', 'dh-live', '열려 있음'));
    else if (state === 'unavailable') meta.append(el('span', 'dh-unavailable', '연결 안 됨'));
    else meta.append(el('span', 'dh-date', openedLabel(doc.openedAt)));
    if (doc.worktrees.length) {
      const trees = el('span', 'dh-tree-count');
      trees.setAttribute('aria-label', `작업 트리 ${doc.worktrees.length}개`);
      trees.title = doc.worktrees.map((tree) => tree.branch).join(', ');
      for (const tree of doc.worktrees.slice(0, 3)) {
        const dot = el('span', 'dh-tree-dot');
        dot.style.setProperty('--worktree-color', tree.color);
        trees.append(dot);
      }
      trees.append(el('span', '', `⑂ ${doc.worktrees.length}`));
      meta.append(trees);
    }
    return meta;
  }

  function renderRecent(): void {
    const keepFocus = root.contains(document.activeElement) && document.activeElement?.closest('.dh-grid');
    resetScope(gridScope, grid);

    grid.classList.toggle('is-list', prefs.view === 'list');
    sortRecent.setAttribute('role', 'radio');
    sortName.setAttribute('role', 'radio');
    viewGrid.setAttribute('role', 'radio');
    viewList.setAttribute('role', 'radio');
    sortRecent.setAttribute('aria-checked', String(prefs.sort === 'recent'));
    sortName.setAttribute('aria-checked', String(prefs.sort === 'name'));
    viewGrid.setAttribute('aria-checked', String(prefs.view === 'grid'));
    viewList.setAttribute('aria-checked', String(prefs.view === 'list'));

    const keys = new Set(documents.map((doc) => doc.documentId));
    for (const key of [...blobs.keys()]) {
      if (key.startsWith('document:') && !keys.has(key.slice('document:'.length))) blobs.delete(key);
    }
    if (!documents.length) {
      grid.replaceChildren();
      expanded = null;
      const empty = el('li', 'dh-empty');
      empty.append(el('span', 'dh-empty-title', '최근 문서가 없습니다'));
      grid.append(empty);
      return;
    }
    if (expanded && !documents.some((doc) => doc.recentId === expanded)) expanded = null;
    if (!focusedId || !documents.some((doc) => doc.recentId === focusedId)) focusedId = documents[0]!.recentId;

    const items: HTMLLIElement[] = [];
    const liveIds = deps.liveDocumentIds();
    for (const doc of documents) {
      const item = el('li', 'dh-item');
      const card = button('dh-card', '');
      card.dataset.id = doc.recentId;
      card.tabIndex = doc.recentId === focusedId ? 0 : -1;
      card.setAttribute('aria-expanded', String(expanded === doc.recentId));
      card.setAttribute('aria-label', `${displayName(doc.fileName)}, ${doc.sourceFormat.toUpperCase()}, ${openedLabel(doc.openedAt)} 열람`);
      const stack = doc.worktrees.length ? ' dh-paper-stack' : '';
      const paper = placeholderPaper(displayName(doc.fileName), `dh-doc-paper${stack}`);
      const text = el('span', 'dh-card-text');
      const name = el('span', 'dh-card-name', displayName(doc.fileName));
      name.title = doc.fileName;
      const chip = createWorktreeChip();
      if (doc.branch) paintWorktreeChip(chip, { branch: doc.branch.branch, primary: doc.branch.primary, color: doc.branch.color });
      const title = el('span', 'dh-card-title');
      title.append(name, chip);
      text.append(title, metaFor(doc, liveIds));
      card.append(paper, text);
      if (presence.get(doc.recentId)?.state === 'unavailable') item.classList.add('is-unavailable');
      item.append(card);
      items.push(item);
      const row = rowFor(doc);
      if (row) lazyThumbnail(gridScope, paper, `document:${doc.documentId}`, () => loadDocumentThumbnail(row));
    }
    grid.replaceChildren(...items);
    placeDetail();
    if (keepFocus) cardFor(focusedId)?.focus({ preventScroll: true });
  }

  async function loadDocumentThumbnail(row: RecentDoc): Promise<Blob | null> {
    const live = deps.liveThumbnail(row.documentId);
    if (live) {
      const blob = await live;
      if (blob) void rememberLiveThumbnail(row.documentId, blob);
      return blob;
    }
    const result = await documentThumbnail(row, presence.get(row.id));
    if (result.corrupt) {
      // 엔진이 읽지 못한 파일은 열 수도 없다. 목록에서 뺀다.
      await defaultHealIo.forget(row);
      drop(new Set([row.id]));
      return null;
    }
    return result.blob;
  }

  const cardFor = (id: string | null) => (id ? grid.querySelector<HTMLButtonElement>(`.dh-card[data-id="${CSS.escape(id)}"]`) : null);

  function columns(): number {
    if (prefs.view === 'list') return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template.split(' ').filter(Boolean).length);
  }

  // ── 펼친 작업 ───────────────────────────────────────────
  function detailFor(doc: HomeDocument): HTMLLIElement {
    const row = rowFor(doc)!;
    const detail = el('li', 'dh-detail');
    detail.id = 'dh-detail';
    detail.setAttribute('role', 'group');
    detail.setAttribute('aria-label', `${displayName(doc.fileName)} 작업`);
    const main = el('div', 'dh-detail-main');
    const head = el('div', 'dh-detail-head');
    const name = el('span', 'dh-detail-name', doc.fileName);
    head.append(name);
    if (doc.branch) {
      const chip = createWorktreeChip();
      paintWorktreeChip(chip, { branch: doc.branch.branch, primary: doc.branch.primary, color: doc.branch.color });
      head.append(chip);
    }
    const state = presence.get(doc.recentId)?.state;
    const sub = [
      doc.sourceFormat.toUpperCase(),
      `${openedLabel(doc.openedAt)} 열람`,
      deps.liveDocumentIds().has(doc.documentId) ? '이 창에 열려 있음' : '',
      state === 'unavailable' ? '파일이 있는 위치에 연결되어 있지 않음' : '',
    ].filter(Boolean).join(' · ');
    main.append(head, el('p', 'dh-detail-sub', sub));

    const actions = el('div', 'dh-actions');
    const open = button('dh-action dh-action-primary', '열기');
    open.addEventListener('click', () => void openRow(row));
    actions.append(open);
    if (deps.openInNewWindow) {
      const newWindow = button('dh-action', '새 창에서 열기');
      newWindow.addEventListener('click', () => {
        void deps.openInNewWindow!(row).then((ok) => { if (!ok) deps.toast('파일을 찾을 수 없어 새 창에서 열지 못했습니다.'); });
      });
      actions.append(newWindow);
    }
    if (deps.reveal) {
      const reveal = button('dh-action', deps.reveal.label);
      reveal.addEventListener('click', () => {
        void deps.reveal!.run(row).then((ok) => { if (!ok) deps.toast('파일 위치를 찾을 수 없습니다.'); });
      });
      actions.append(reveal);
    }
    if (deps.canRename(row)) {
      const rename = button('dh-action', '이름 바꾸기');
      rename.addEventListener('click', () => beginRename(doc, row, name));
      actions.append(rename);
    }
    const forget = button('dh-action dh-action-quiet', '목록에서 제거');
    forget.addEventListener('click', () => {
      void defaultHealIo.forget(row).then(() => {
        const index = documents.findIndex((entry) => entry.recentId === row.id);
        focusedId = documents[index + 1]?.recentId ?? documents[index - 1]?.recentId ?? null;
        drop(new Set([row.id]));
        cardFor(focusedId)?.focus();
      });
    });
    actions.append(forget);
    main.append(actions);
    detail.append(main);

    if (doc.worktrees.length) {
      const trees = el('div', 'dh-trees');
      trees.append(el('h3', 'dh-trees-title', `작업 트리 ${doc.worktrees.length}`));
      const list = el('ul', 'dh-tree-list');
      for (const tree of doc.worktrees) {
        const item = el('li');
        const entry = button('dh-tree', '');
        entry.setAttribute('aria-label', `작업 트리 ${tree.branch} 열기`);
        const chip = createWorktreeChip();
        paintWorktreeChip(chip, { branch: tree.branch, primary: tree.primary, color: tree.color });
        entry.append(chip, el('span', 'dh-tree-name', displayName(tree.fileName)), el('span', 'dh-tree-date', openedLabel(tree.updatedAt)));
        entry.addEventListener('click', () => {
          void deps.openWorktree(tree).catch((error) => {
            deps.toast(error instanceof Error ? error.message : '작업 트리를 열지 못했습니다.');
          });
        });
        item.append(entry);
        list.append(item);
      }
      trees.append(list);
      detail.append(trees);
    }
    detail.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      const id = expanded;
      collapse();
      cardFor(id)?.focus();
    });
    return detail;
  }

  /** 펼친 작업 칸은 고른 카드가 있는 줄 바로 아래에 놓인다. */
  function placeDetail(): void {
    grid.querySelector('.dh-detail')?.remove();
    for (const card of grid.querySelectorAll<HTMLElement>('.dh-card')) {
      card.setAttribute('aria-expanded', String(card.dataset.id === expanded));
      card.toggleAttribute('aria-controls', false);
    }
    const doc = documents.find((entry) => entry.recentId === expanded);
    const card = cardFor(expanded);
    if (!doc || !card || !rowFor(doc)) return;
    card.setAttribute('aria-controls', 'dh-detail');
    const index = documents.indexOf(doc);
    const perRow = columns();
    const rowEnd = Math.min(documents.length - 1, Math.floor(index / perRow) * perRow + perRow - 1);
    const anchor = grid.children[rowEnd] as HTMLElement | undefined;
    const detail = detailFor(doc);
    const cardBox = card.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    detail.style.setProperty('--dh-notch', `${Math.round(cardBox.left - gridBox.left + cardBox.width / 2)}px`);
    anchor?.after(detail);
  }

  function toggle(id: string): void {
    expanded = expanded === id ? null : id;
    focusedId = id;
    placeDetail();
    if (expanded) {
      const detail = grid.querySelector<HTMLElement>('.dh-detail');
      detail?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function collapse(): void {
    if (!expanded) return;
    expanded = null;
    placeDetail();
  }

  function beginRename(doc: HomeDocument, row: RecentDoc, target: HTMLElement): void {
    beginInlineRename(target, {
      value: doc.fileName,
      label: '문서 이름',
      selectBaseName: true,
      maxLength: 200,
      commit: async (value) => {
        const renamed = await deps.renameDocument(row, value);
        if (!renamed) return null;
        row.fileName = renamed;
        documents = documents.map((entry) => (entry.recentId === row.id ? { ...entry, fileName: renamed } : entry));
        const card = cardFor(row.id);
        const name = card?.querySelector('.dh-card-name');
        if (name) { name.textContent = displayName(renamed); (name as HTMLElement).title = renamed; }
        return renamed;
      },
    });
  }

  async function openRow(row: RecentDoc): Promise<void> {
    const result = await deps.openDocument(row);
    if (result === 'failed') {
      // 열지 못한 파일(손상·지원하지 않는 형식)은 목록에서 뺀다. 이유는 열기 오류가 이미 알렸다.
      await defaultHealIo.forget(row);
      drop(new Set([row.id]));
    } else if (result === 'missing') {
      await defaultHealIo.forget(row);
      drop(new Set([row.id]));
      deps.toast(`"${displayName(row.fileName)}" 파일을 찾을 수 없어 목록에서 뺐습니다.`);
    }
  }

  function drop(ids: ReadonlySet<string>): void {
    if (!ids.size) return;
    rows = rows.filter((row) => !ids.has(row.id));
    documents = documents.filter((doc) => !ids.has(doc.recentId));
    if (expanded && ids.has(expanded)) expanded = null;
    for (const id of ids) {
      const item = cardFor(id)?.closest('.dh-item');
      item?.classList.add('is-leaving');
    }
    // 사라지는 모양을 잠깐 보인 뒤 줄을 다시 짠다.
    window.setTimeout(() => { if (visible) renderRecent(); }, 160);
  }

  // ── 자료 ────────────────────────────────────────────────
  async function load(): Promise<void> {
    const token = ++loadToken;
    status.textContent = '';
    let worktreeData: WorktreeData | null = null;
    try {
      const [recentRows, trees] = await Promise.all([
        deps.listRecent(),
        deps.loadWorktrees().catch((error) => {
          console.warn('[document-home] 작업 트리를 읽지 못했습니다:', error);
          return null;
        }),
      ]);
      if (token !== loadToken) return;
      rows = recentRows;
      worktreeData = trees;
    } catch (error) {
      if (token !== loadToken) return;
      console.warn('[document-home] 최근 문서를 읽지 못했습니다:', error);
      rows = [];
      documents = [];
      renderRecent();
      grid.replaceChildren();
      status.replaceChildren(el('span', '', '최근 문서를 불러오지 못했습니다. '));
      const retry = button('dh-link', '다시 시도');
      retry.addEventListener('click', () => void load());
      status.append(retry);
      return;
    }
    const regroup = () => {
      documents = sortHomeDocuments(groupHomeDocuments(
        rows,
        worktreeData?.trees ?? [],
        worktreeData?.colorOf ?? (() => '#379cff'),
      ), prefs.sort);
    };
    regroup();
    renderRecent();

    // 첫 화면을 그린 뒤에 파일을 확인한다. 지워진 파일은 빠지고, 옮겨진 파일은 새 이름이 된다.
    void (async () => {
      const inspected = await inspectRecentDocuments(rows).catch(() => new Map<string, DocumentPresence>());
      if (token !== loadToken) return;
      presence = inspected;
      const healed = await healRecentDocuments(rows, presence, defaultHealIo);
      if (token !== loadToken) return;
      for (const [id, fileName] of healed.renamed) {
        const row = rows.find((entry) => entry.id === id);
        if (row) row.fileName = fileName;
        const current = presence.get(id);
        if (current?.state === 'missing') presence.delete(id);
      }
      rows = rows.filter((row) => !healed.removed.has(row.id));
      regroup();
      if (visible) renderRecent();
    })();

    void loadTemplates(token, 0);
  }

  /** 앱을 막 켰을 때는 허브가 아직 붙지 않았을 수 있다. 몇 번만 다시 묻는다. */
  async function loadTemplates(token: number, attempt: number): Promise<void> {
    const list = await deps.listTemplates().catch(() => null);
    if (token !== loadToken) return;
    if (list || templateList === null) {
      templateList = list;
      renderTemplates();
    }
    if (!list && attempt < 3) {
      window.setTimeout(() => { if (visible && token === loadToken) void loadTemplates(token, attempt + 1); }, 2000 * (attempt + 1));
    }
  }
  let loadToken = 0;

  // ── 입력 ────────────────────────────────────────────────
  grid.addEventListener('click', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>('.dh-card');
    if (!card?.dataset.id) return;
    for (const other of grid.querySelectorAll<HTMLElement>('.dh-card')) other.tabIndex = -1;
    card.tabIndex = 0;
    toggle(card.dataset.id);
  });
  grid.addEventListener('dblclick', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>('.dh-card');
    const row = rows.find((entry) => entry.id === card?.dataset.id);
    if (row) void openRow(row);
  });
  grid.addEventListener('keydown', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>('.dh-card');
    if (!card?.dataset.id || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = documents.findIndex((doc) => doc.recentId === card.dataset.id);
    if (index < 0) return;
    const perRow = columns();
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight': next = Math.min(documents.length - 1, index + 1); break;
      case 'ArrowLeft': next = Math.max(0, index - 1); break;
      case 'ArrowDown': next = Math.min(documents.length - 1, index + perRow); break;
      case 'ArrowUp': next = Math.max(0, index - perRow); break;
      case 'Home': next = 0; break;
      case 'End': next = documents.length - 1; break;
      case 'Enter': {
        event.preventDefault();
        const row = rowFor(documents[index]!);
        if (row) void openRow(row);
        return;
      }
      case ' ': event.preventDefault(); toggle(card.dataset.id); return;
      case 'Escape':
        if (!expanded) return;
        event.preventDefault();
        event.stopPropagation();
        collapse();
        card.focus();
        return;
      default: return;
    }
    event.preventDefault();
    const target = documents[next];
    if (!target) return;
    focusedId = target.recentId;
    for (const other of grid.querySelectorAll<HTMLElement>('.dh-card')) other.tabIndex = -1;
    const nextCard = cardFor(focusedId);
    if (nextCard) {
      nextCard.tabIndex = 0;
      nextCard.focus();
      nextCard.scrollIntoView({ block: 'nearest' });
    }
    // 펼친 칸은 다른 줄로 옮기면 따라간다.
    if (expanded && expanded !== focusedId) {
      expanded = focusedId;
      placeDetail();
    }
  });
  templates.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const cards = [...templates.querySelectorAll<HTMLButtonElement>('.dh-template:not([hidden]) .dh-template-card')];
    const index = cards.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    if (expanded) { event.preventDefault(); const id = expanded; collapse(); cardFor(id)?.focus(); return; }
    if (canLeave()) { event.preventDefault(); leave(); }
  });

  const setSort = (sort: HomeSort) => {
    if (prefs.sort === sort) return;
    prefs.sort = sort;
    writePrefs(prefs);
    documents = sortHomeDocuments(documents, sort);
    renderRecent();
  };
  const setView = (view: 'grid' | 'list') => {
    if (prefs.view === view) return;
    prefs.view = view;
    writePrefs(prefs);
    renderRecent();
  };
  sortRecent.addEventListener('click', () => setSort('recent'));
  sortName.addEventListener('click', () => setSort('name'));
  viewGrid.addEventListener('click', () => setView('grid'));
  viewList.addEventListener('click', () => setView('list'));
  for (const group of [sortGroup, viewGroup]) {
    group.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const options = [...group.querySelectorAll<HTMLButtonElement>('button')];
      const index = options.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = options[(index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]!;
      next.click();
      next.focus();
    });
  }
  gallery.addEventListener('click', () => {
    galleryOpen = !galleryOpen;
    fitTemplates();
  });
  openFile.addEventListener('click', () => deps.openFile());
  back.addEventListener('click', () => leave());
  templateInput.addEventListener('change', () => {
    const file = templateInput.files?.[0];
    templateInput.value = '';
    if (!file || !deps.addTemplate) return;
    void deps.addTemplate(file).then(async () => {
      templateList = await deps.listTemplates();
      renderTemplates();
    }).catch((error) => deps.toast(error instanceof Error ? error.message : '템플릿을 추가하지 못했습니다.'));
  });
  if (deps.onDrop) {
    root.addEventListener('dragover', (event) => { event.preventDefault(); root.classList.add('is-drag-over'); });
    root.addEventListener('dragleave', (event) => {
      if (!root.contains(event.relatedTarget as Node | null)) root.classList.remove('is-drag-over');
    });
    root.addEventListener('drop', (event) => {
      root.classList.remove('is-drag-over');
      deps.onDrop!(event);
    });
  }
  new ResizeObserver(() => {
    if (!visible) return;
    fitTemplates();
    if (expanded) placeDetail();
  }).observe(root);

  /** 에이전트 전체 화면에서는 언제나 대화로 돌아갈 수 있다. 편집 영역에서는 열린 문서가 있을 때만. */
  const canLeave = () => surface === 'focus' || deps.returnTarget() !== null;

  function leave(): void {
    if (surface === 'focus') hide();
    else deps.onReturn();
  }

  function paintReturn(): void {
    const target = surface === 'focus' ? '대화' : deps.returnTarget();
    back.hidden = target === null;
    const label = back.querySelector('.dh-back-label')!;
    label.textContent = target ? displayName(target) : '';
    const action = surface === 'focus' ? '대화로 돌아가기' : '문서로 돌아가기';
    back.setAttribute('aria-label', target && surface !== 'focus' ? `${target}(으)로 돌아가기` : action);
    back.title = `${action} (Esc)`;
  }

  let focusWatch: MutationObserver | null = null;

  function mount(next: 'editor' | 'focus'): void {
    surface = next;
    focusWatch?.disconnect();
    focusWatch = null;
    editorHost ??= document.getElementById('editor-area');
    const host = next === 'focus' ? document.body : editorHost ?? document.body;
    if (root.parentElement !== host) host.append(root);
    root.classList.toggle('is-focus-surface', next === 'focus');
    // 에이전트 전체 화면에서는 작업 막대를 남겨 두고 그 아래만 덮는다.
    const bar = next === 'focus' ? document.querySelector('.ag-fullscreen .ag-workspace-bar') : null;
    root.style.top = bar ? `${Math.round(bar.getBoundingClientRect().bottom)}px` : '';
    // 전체 화면을 나가면 편집 영역으로 돌아온다. 문서가 열려 있으면 그 문서를 보인다.
    const workspace = bar?.closest('.ag-fullscreen');
    if (workspace) {
      focusWatch = new MutationObserver(() => {
        if (workspace.classList.contains('ag-fullscreen')) return;
        if (deps.returnTarget() === null) mount('editor');
        else hide();
      });
      focusWatch.observe(workspace, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    focusWatch?.disconnect();
    focusWatch = null;
    root.classList.remove('is-shown');
    root.hidden = true;
    expanded = null;
    resetThumbnails();
    for (const listener of listeners) listener(false);
  }

  return {
    element: root,
    get visible() { return visible; },
    get surface() { return surface; },
    show(options = {}) {
      mount(options.surface ?? (visible ? surface : 'editor'));
      paintReturn();
      const wasVisible = visible;
      visible = true;
      // 문서 그림은 열 때마다 저장소에서 다시 읽는다. 그사이 고친 문서가 옛 그림으로 남지 않는다.
      if (!wasVisible) for (const key of [...blobs.keys()]) if (key.startsWith('document:')) blobs.delete(key);
      root.hidden = false;
      if (!wasVisible) {
        root.classList.remove('is-shown');
        // 다음 프레임에 나타나는 전환을 건다. 줄이기 설정이면 CSS 가 전환을 끈다.
        requestAnimationFrame(() => root.classList.add('is-shown'));
        scroller.scrollTop = 0;
        for (const listener of listeners) listener(true);
      }
      void load().then(() => {
        if (options.focus !== false && visible && !root.contains(document.activeElement)) {
          (cardFor(focusedId) ?? templates.querySelector<HTMLElement>('.dh-template-card'))?.focus({ preventScroll: true });
        }
      });
    },
    hide,
    refresh() {
      if (visible) { paintReturn(); void load(); }
    },
    onVisibilityChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
