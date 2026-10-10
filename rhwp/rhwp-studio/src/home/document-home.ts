/**
 * 문서 홈. 창 전체를 덮는 시작 화면이다. 위에는 새로 만들기(빈 문서·템플릿), 아래에는 열어 본
 * 문서가 종이 카드로 놓인다. 문서가 없을 때 기본 화면이고, 문서가 열려 있으면 편집기·사이드바를
 * 가렸다가 그대로 돌려준다. 모양은 styles/document-home.css.
 *
 * 새로 만들기 줄은 바로 그리고, 목록은 저장소에서 읽는 대로 그린다. 파일 확인·첫 쪽 그림은
 * 그 뒤에 보이는 카드부터 채운다.
 */
import type { DocumentTemplate } from '../agent/types.ts';
import type { RecentDoc } from '../recent/recent-store.ts';
import { beginInlineRename } from '../ui/inline-rename.ts';
import { createBranchIcon, createWorktreeChip, paintWorktreeChip } from '../ui/worktree-chip.ts';
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
  inspectAndHeal,
  judgeOpenFailure,
  rememberLiveThumbnail,
  templateThumbnail,
  type DocumentPresence,
  type WorktreeData,
} from './home-data.ts';
import { releaseThumbnailWorker } from './thumbnail-render.ts';

export type HomeOpenResult = 'opened' | 'cancelled' | 'missing' | 'failed';

/** 홈을 닫으면 돌아갈 곳. 열린 문서, 또는 에이전트 전체 화면의 채팅. */
export interface HomeReturnTarget {
  kind: 'document' | 'chat';
  label: string;
}

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
  /** 문서를 여는 중이면 끝날 때까지 기다린다. 미리보기는 그 뒤에 그린다. */
  whenIdle(): Promise<void>;
  createBlank(): void;
  createFromTemplate(template: DocumentTemplate): Promise<void>;
  openFile(): void;
  openDocument(row: RecentDoc): Promise<HomeOpenResult>;
  openWorktree(tree: HomeWorktree): Promise<void>;
  canRename(row: RecentDoc): boolean;
  renameDocument(row: RecentDoc, name: string): Promise<string | null>;
  openInNewWindow?: (row: RecentDoc) => Promise<boolean>;
  reveal?: { label: string; run(row: RecentDoc): Promise<boolean> };
  returnTarget(): HomeReturnTarget | null;
  /** 닫힐 때 열기 전 초점 자리가 사라졌으면 편집기나 입력기로 초점을 돌린다. */
  restoreFocus(): void;
  onDrop?(event: DragEvent): void;
  toast(message: string): void;
}

export interface DocumentHome {
  readonly element: HTMLElement;
  readonly visible: boolean;
  /** focus: false 면 카드에 초점을 두지 않는다(앱 시작). 키보드는 홈 안에 머문다. */
  show(options?: { focus?: boolean }): void;
  hide(): void;
  refresh(): void;
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
  upload: 'M8 10.5V3M5 6l3-3 3 3M3 10.5v2.5h10v-2.5',
  open: 'M2.5 4.5v8h11v-6h-6l-1.5-2z',
  grid: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
};

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createDocumentHome(deps: DocumentHomeDeps): DocumentHome {
  const prefs = readPrefs();
  const root = el('section', 'document-home');
  root.id = 'document-home';
  root.setAttribute('aria-label', '문서 홈');
  root.hidden = true;

  // ── 위 막대: 제품 표시와 돌아가기 ──────────────────────────
  const topbar = el('header', 'dh-topbar');
  const brand = el('span', 'dh-brand');
  const brandMark = el('span', 'ag-rau-icon dh-brand-mark');
  brandMark.setAttribute('aria-hidden', 'true');
  brand.append(brandMark, el('span', 'dh-brand-name', 'Rauhwpx'));
  const back = button('dh-back', '');
  back.append(icon(ICONS.back, 14), el('span', 'dh-back-label'));
  topbar.append(brand, back);

  const scroller = el('div', 'dh-scroll');
  // 앱을 켰을 때 키보드가 머무는 자리. 카드에 초점 고리를 띄우지 않는다.
  scroller.tabIndex = -1;
  root.append(topbar, scroller);

  // ── 새로 만들기 ─────────────────────────────────────────
  const start = el('section', 'dh-start');
  start.setAttribute('aria-labelledby', 'dh-start-title');
  const startInner = el('div', 'dh-inner');
  const startBar = el('div', 'dh-bar');
  const startTitle = el('h2', 'dh-heading', '새로 만들기');
  startTitle.id = 'dh-start-title';
  const gallery = button('dh-ghost dh-gallery', '');
  gallery.setAttribute('aria-expanded', 'false');
  gallery.setAttribute('aria-controls', 'dh-templates');
  gallery.append(el('span', '', '템플릿 갤러리'), icon(ICONS.chevron, 14));
  gallery.hidden = true;
  startBar.append(startTitle, el('span', 'dh-spacer'), gallery);
  const templates = el('ul', 'dh-templates');
  templates.id = 'dh-templates';
  templates.setAttribute('aria-label', '새로 만들기');
  startInner.append(startBar, templates);
  start.append(startInner);

  // ── 최근 문서 ───────────────────────────────────────────
  const recent = el('section', 'dh-recent');
  recent.setAttribute('aria-labelledby', 'dh-recent-title');
  const recentInner = el('div', 'dh-inner');
  const recentBar = el('div', 'dh-bar');
  const recentTitle = el('h2', 'dh-heading', '최근 문서');
  recentTitle.id = 'dh-recent-title';
  const openFile = button('dh-ghost', '');
  openFile.id = 'document-open-action';
  openFile.append(icon(ICONS.open, 14), el('span', '', '파일 열기'));
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
  for (const option of [sortRecent, sortName, viewGrid, viewList]) option.setAttribute('role', 'radio');
  const listControls = el('span', 'dh-list-controls');
  listControls.append(sortGroup, viewGroup);
  recentBar.append(recentTitle, el('span', 'dh-spacer'), openFile, listControls);
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
  document.body.append(root);

  let visible = false;
  let returnFocus: HTMLElement | null = null;
  let rows: RecentDoc[] = [];
  let documents: HomeDocument[] = [];
  let loaded = false;
  let presence = new Map<string, DocumentPresence>();
  /** 이번에 못 찾았거나 열지 못해 흐리게 둔 기록과 그 까닭. */
  const flagged = new Map<string, string>();
  const openFailures = new Map<string, number>();
  let opening: string | null = null;
  let templateList: DocumentTemplate[] | null = null;
  let galleryOpen = false;
  let expanded: string | null = null;
  let focusedId: string | null = null;
  let loadToken = 0;
  /** 카드 그림은 다시 그려도 재사용한다. 목록에서 빠진 문서의 그림은 버린다. */
  const blobs = new Map<string, Blob>();
  let observer: IntersectionObserver | null = null;
  let queue: Array<() => Promise<void>> = [];
  let running = 0;
  const pending = new Set<string>();
  /** 새로 만들기 줄과 최근 문서 격자는 따로 다시 그린다. 그림 주소도 칸마다 따로 거둔다. */
  interface ThumbnailScope { generation: number }
  const templateScope: ThumbnailScope = { generation: 0 };
  const gridScope: ThumbnailScope = { generation: 0 };
  /**
   * 그림 하나에 주소 하나. 다시 그린 카드도 같은 주소를 쓰므로, 아직 읽히는 그림의 주소를 거두는
   * 일이 없다. 그림을 버리거나 홈을 닫을 때만 거둔다.
   */
  const objectUrls = new Map<string, { blob: Blob; url: string }>();

  function urlFor(key: string, blob: Blob): string {
    const known = objectUrls.get(key);
    if (known?.blob === blob) return known.url;
    if (known) URL.revokeObjectURL(known.url);
    const url = URL.createObjectURL(blob);
    objectUrls.set(key, { blob, url });
    return url;
  }

  function forgetBlob(key: string): void {
    blobs.delete(key);
    const known = objectUrls.get(key);
    if (known) URL.revokeObjectURL(known.url);
    objectUrls.delete(key);
  }

  function revokeAllUrls(): void {
    for (const { url } of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  // ── 그림 ────────────────────────────────────────────────
  function resetScope(scope: ThumbnailScope, host?: HTMLElement): void {
    scope.generation += 1;
    // 다시 그리기 전의 종이는 관찰을 푼다. 떨어진 카드가 관찰자에 남지 않는다.
    if (host && observer) {
      for (const paper of host.querySelectorAll('.dh-paper[data-thumb-key]')) observer.unobserve(paper);
    }
  }

  function paintImage(paper: HTMLElement, key: string, blob: Blob): void {
    const url = urlFor(key, blob);
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
        const begin = (entry.target as HTMLElement & { loadThumbnail?: () => Promise<void> }).loadThumbnail;
        if (!begin) continue;
        // 차례를 기다리는 동안에도 그리는 중으로 보인다.
        entry.target.classList.add('is-loading');
        queue.push(begin);
      }
      drain();
    }, { root: scroller, rootMargin: '240px 0px' });
    return observer;
  }

  function lazyThumbnail(scope: ThumbnailScope, paper: HTMLElement, key: string, load: () => Promise<Blob | null>): void {
    paper.dataset.thumbKey = key;
    const known = blobs.get(key);
    if (known) {
      paintImage(paper, key, known);
      return;
    }
    const token = scope.generation;
    (paper as HTMLElement & { loadThumbnail?: () => Promise<void> }).loadThumbnail = async () => {
      const papers = () => root.querySelectorAll<HTMLElement>(`[data-thumb-key="${CSS.escape(key)}"]`);
      if (token !== scope.generation || !visible || pending.has(key)) {
        if (!pending.has(key)) paper.classList.remove('is-loading');
        return;
      }
      pending.add(key);
      try {
        // 앱을 켜며 문서를 여는 중이면 그 일이 먼저다.
        await deps.whenIdle();
        if (!visible) return;
        const blob = await load();
        if (!blob) return;
        blobs.set(key, blob);
        if (!visible) return;
        // 그사이 목록을 다시 그렸으면 같은 문서의 새 카드에 칠한다.
        for (const target of papers()) {
          if (!target.querySelector('.dh-thumb')) paintImage(target, key, blob);
        }
      } finally {
        pending.delete(key);
        for (const target of papers()) target.classList.remove('is-loading');
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
    revokeAllUrls();
  }

  // ── 종이 ────────────────────────────────────────────────
  /** 그림을 그리는 동안에는 글줄을, 그림이 없으면 형식 표시만 둔 빈 종이를 보인다. */
  function paperFor(format: string, extra = ''): HTMLElement {
    const paper = el('span', `dh-paper${extra ? ` ${extra}` : ''}`);
    paper.setAttribute('aria-hidden', 'true');
    const sheet = el('span', 'dh-sheet');
    for (let line = 0; line < 6; line += 1) sheet.append(el('span', 'dh-sheet-line'));
    paper.append(sheet, el('span', 'dh-paper-format', format.toUpperCase()));
    return paper;
  }

  // ── 새로 만들기 줄 ──────────────────────────────────────
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
    const focusedTemplate = templates.contains(document.activeElement)
      ? [...templates.querySelectorAll('.dh-template-card')].indexOf(document.activeElement as Element)
      : -1;
    resetScope(templateScope, templates);
    const items: HTMLLIElement[] = [];
    const blank = el('span', 'dh-paper dh-paper-blank');
    blank.setAttribute('aria-hidden', 'true');
    blank.append(icon(ICONS.plus, 28));
    items.push(templateCard('빈 문서', '', blank, () => deps.createBlank(), 'document-new-action'));
    for (const template of templateList ?? []) {
      const paper = paperFor(template.format);
      const pages = template.pageCount > 0 ? `${template.pageCount}쪽` : '';
      items.push(templateCard(template.name, pages, paper, () => {
        void deps.createFromTemplate(template).catch((error) => {
          deps.toast(error instanceof Error ? error.message : '템플릿으로 문서를 만들지 못했습니다.');
        });
      }));
      lazyThumbnail(templateScope, paper, `template:${template.id}:${template.revision}`, () => templateThumbnail(template, () => deps.templateBytes(template)));
    }
    if (templateList && deps.addTemplate) {
      const add = el('span', 'dh-paper dh-paper-add');
      add.setAttribute('aria-hidden', 'true');
      add.append(icon(ICONS.upload, 18));
      items.push(templateCard('템플릿 추가', 'HWP · HWPX', add, () => templateInput.click()));
    }
    templates.replaceChildren(...items);
    fitTemplates();
    if (focusedTemplate >= 0) {
      templates.querySelectorAll<HTMLElement>('.dh-template-card')[focusedTemplate]?.focus({ preventScroll: true });
    }
  }

  /** 접힌 갤러리는 한 줄만 보인다. 넘치는 템플릿이 있을 때만 펼치기 단추를 둔다. */
  function fitTemplates(): void {
    const width = templates.clientWidth;
    const items = [...templates.children] as HTMLElement[];
    const style = getComputedStyle(templates);
    const card = parseFloat(style.gridTemplateColumns) || 116;
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
  const cardFor = (id: string | null) => (id ? grid.querySelector<HTMLButtonElement>(`.dh-card[data-id="${CSS.escape(id)}"]`) : null);

  /** 작업 트리 묶음 표시 하나: 가지 색 점들과 사본 수. */
  function treeToken(doc: HomeDocument): HTMLElement {
    const token = el('span', 'dh-tree-token');
    token.setAttribute('aria-label', `작업 트리 ${doc.worktrees.length}개`);
    token.title = doc.worktrees.map((tree) => tree.branch).join(', ');
    token.append(createBranchIcon());
    const dots = el('span', 'dh-tree-dots');
    for (const tree of doc.worktrees.slice(0, 3)) {
      const dot = el('span', 'dh-tree-dot');
      dot.style.setProperty('--worktree-color', tree.color);
      dots.append(dot);
    }
    token.append(dots, el('span', '', String(doc.worktrees.length)));
    return token;
  }

  function metaFor(doc: HomeDocument, liveIds: ReadonlySet<string>): HTMLElement {
    const meta = el('span', 'dh-card-meta');
    meta.append(el('span', 'dh-format', doc.sourceFormat.toUpperCase()));
    const state = presence.get(doc.recentId)?.state;
    const note = flagged.get(doc.recentId);
    if (liveIds.has(doc.documentId)) meta.append(el('span', 'dh-live', '열려 있음'));
    else if (note) meta.append(el('span', 'dh-flag', note));
    else if (state === 'unavailable') meta.append(el('span', 'dh-flag', '연결 안 됨'));
    else meta.append(el('span', 'dh-date', openedLabel(doc.openedAt)));
    if (doc.worktrees.length) meta.append(treeToken(doc));
    return meta;
  }

  function renderRecent(): void {
    const keepFocus = root.contains(document.activeElement) && document.activeElement?.closest('.dh-grid');
    resetScope(gridScope, grid);

    grid.classList.toggle('is-list', prefs.view === 'list');
    sortRecent.setAttribute('aria-checked', String(prefs.sort === 'recent'));
    sortName.setAttribute('aria-checked', String(prefs.sort === 'name'));
    viewGrid.setAttribute('aria-checked', String(prefs.view === 'grid'));
    viewList.setAttribute('aria-checked', String(prefs.view === 'list'));
    listControls.hidden = documents.length === 0;

    const keys = new Set(documents.map((doc) => doc.documentId));
    for (const key of [...blobs.keys()]) {
      if (key.startsWith('document:') && !keys.has(key.slice('document:'.length))) forgetBlob(key);
    }
    if (!documents.length) {
      grid.replaceChildren();
      expanded = null;
      if (loaded) {
        const empty = el('li', 'dh-empty');
        empty.append(el('span', 'dh-empty-title', '최근 문서가 없습니다'));
        grid.append(empty);
      }
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
      const paper = paperFor(doc.sourceFormat, `dh-doc-paper${stack}`);
      const text = el('span', 'dh-card-text');
      const name = el('span', 'dh-card-name', displayName(doc.fileName));
      name.title = doc.fileName;
      const title = el('span', 'dh-card-title');
      title.append(name);
      // 원본은 이름만으로 충분하다. 사본일 때만 가지를 붙인다.
      if (doc.branch && !doc.branch.primary) {
        const chip = createWorktreeChip();
        paintWorktreeChip(chip, { branch: doc.branch.branch, primary: false, color: doc.branch.color });
        title.append(chip);
      }
      text.append(title, metaFor(doc, liveIds));
      card.append(paper, text);
      const state = presence.get(doc.recentId)?.state;
      if (state === 'unavailable' || flagged.has(doc.recentId)) item.classList.add('is-dimmed');
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
    return documentThumbnail(row, presence.get(row.id));
  }

  function columns(): number {
    if (prefs.view === 'list') return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template.split(' ').filter(Boolean).length);
  }

  // ── 펼친 작업 ───────────────────────────────────────────
  function action(label: string, run: () => void, className = 'dh-action'): HTMLButtonElement {
    const node = button(className, label);
    node.addEventListener('click', run);
    return node;
  }

  function detailFor(doc: HomeDocument, row: RecentDoc): HTMLLIElement {
    const detail = el('li', 'dh-detail');
    detail.id = 'dh-detail';
    detail.setAttribute('role', 'group');
    detail.setAttribute('aria-label', `${displayName(doc.fileName)} 작업`);
    const panel = el('div', 'dh-detail-panel');
    const actions = el('div', 'dh-actions');
    actions.append(action('열기', () => void openRow(row), 'dh-action dh-action-primary'));
    const live = deps.liveDocumentIds().has(doc.documentId);
    if (deps.openInNewWindow && !live) {
      actions.append(action('새 창에서 열기', () => {
        void deps.openInNewWindow!(row).then((ok) => { if (!ok) deps.toast('파일을 찾을 수 없어 새 창에서 열지 못했습니다.'); });
      }));
    }
    if (deps.reveal) {
      actions.append(action(deps.reveal.label, () => {
        void deps.reveal!.run(row).then((ok) => { if (!ok) deps.toast('파일 위치를 찾을 수 없습니다.'); });
      }));
    }
    if (deps.canRename(row)) actions.append(action('이름 바꾸기', () => beginRename(doc, row, actions)));
    actions.append(action('목록에서 제거', () => {
      void defaultHealIo.forget(row).then(() => {
        const index = documents.findIndex((entry) => entry.recentId === row.id);
        focusedId = documents[index + 1]?.recentId ?? documents[index - 1]?.recentId ?? null;
        drop(new Set([row.id]));
        window.setTimeout(() => cardFor(focusedId)?.focus(), 200);
      });
    }, 'dh-action dh-action-quiet'));
    panel.append(actions);
    const note = flagged.get(doc.recentId);
    if (note) panel.append(el('p', 'dh-detail-note', note === '열 수 없음' ? '이 파일을 열지 못했습니다.' : '파일을 찾을 수 없습니다.'));

    if (doc.worktrees.length) {
      const trees = el('div', 'dh-trees');
      trees.append(el('h3', 'dh-trees-title', '작업 트리'));
      const list = el('ul', 'dh-tree-list');
      for (const tree of doc.worktrees) {
        const item = el('li');
        const entry = button('dh-tree', '');
        entry.setAttribute('aria-label', `작업 트리 ${tree.branch} 열기`);
        const chip = createWorktreeChip();
        paintWorktreeChip(chip, { branch: tree.branch, primary: tree.primary, color: tree.color });
        entry.append(chip);
        if (displayName(tree.fileName) !== displayName(doc.fileName)) entry.append(el('span', 'dh-tree-name', displayName(tree.fileName)));
        entry.append(el('span', 'dh-tree-date', openedLabel(tree.updatedAt)));
        entry.addEventListener('click', () => {
          void deps.openWorktree(tree).catch((error) => {
            deps.toast(error instanceof Error ? error.message : '작업 트리를 열지 못했습니다.');
          });
        });
        item.append(entry);
        list.append(item);
      }
      trees.append(list);
      panel.append(trees);
    }
    detail.append(panel);
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

  /**
   * 펼친 작업은 고른 카드가 있는 줄 바로 아래, 그 카드에 붙은 작은 판으로 놓인다. 판은 카드
   * 쪽으로 붙되 격자 밖으로 나가지 않고, 꼭지가 카드 가운데를 가리킨다.
   */
  function placeDetail(): void {
    grid.querySelector('.dh-detail')?.remove();
    for (const card of grid.querySelectorAll<HTMLElement>('.dh-card')) {
      card.setAttribute('aria-expanded', String(card.dataset.id === expanded));
      card.removeAttribute('aria-controls');
    }
    const doc = documents.find((entry) => entry.recentId === expanded);
    const card = cardFor(expanded);
    const row = doc ? rowFor(doc) : null;
    if (!doc || !card || !row) return;
    card.setAttribute('aria-controls', 'dh-detail');
    const index = documents.indexOf(doc);
    const perRow = columns();
    const rowEnd = Math.min(documents.length - 1, Math.floor(index / perRow) * perRow + perRow - 1);
    const anchor = grid.children[rowEnd] as HTMLElement | undefined;
    const detail = detailFor(doc, row);
    anchor?.after(detail);
    const panel = detail.querySelector<HTMLElement>('.dh-detail-panel')!;
    const cardBox = card.getBoundingClientRect();
    const gridBox = grid.getBoundingClientRect();
    const panelWidth = panel.getBoundingClientRect().width;
    const center = cardBox.left - gridBox.left + cardBox.width / 2;
    const left = Math.max(0, Math.min(gridBox.width - panelWidth, cardBox.left - gridBox.left));
    panel.style.setProperty('--dh-panel-left', `${Math.round(left)}px`);
    panel.style.setProperty('--dh-notch', `${Math.round(center - left)}px`);
  }

  function toggle(id: string): void {
    expanded = expanded === id ? null : id;
    focusedId = id;
    placeDetail();
    if (expanded) {
      grid.querySelector<HTMLElement>('.dh-detail')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function collapse(): void {
    if (!expanded) return;
    expanded = null;
    placeDetail();
  }

  /** 판의 단추 줄 자리에서 이름을 고친다. 끝나면 판을 다시 그린다. */
  function beginRename(doc: HomeDocument, row: RecentDoc, actions: HTMLElement): void {
    const field = el('div', 'dh-rename');
    const target = el('span', 'dh-rename-target', doc.fileName);
    field.append(target);
    actions.replaceWith(field);
    field.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!field.isConnected || target.querySelector('input')) return;
        placeDetail();
        cardFor(row.id)?.focus({ preventScroll: true });
      }, 0);
    });
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
        const name = cardFor(row.id)?.querySelector<HTMLElement>('.dh-card-name');
        if (name) { name.textContent = displayName(renamed); name.title = renamed; }
        return renamed;
      },
    });
  }

  async function openRow(row: RecentDoc): Promise<void> {
    // 같은 문서를 거듭 눌러도 열기는 한 번만 한다.
    if (opening) return;
    opening = row.id;
    try {
      const result = await deps.openDocument(row);
      if (result === 'opened') {
        openFailures.delete(row.id);
        flagged.delete(row.id);
        return;
      }
      if (result !== 'failed' && result !== 'missing') return;
      const failures = (openFailures.get(row.id) ?? 0) + 1;
      openFailures.set(row.id, failures);
      const judged = judgeOpenFailure(row, result, failures);
      if (judged.forget) {
        await defaultHealIo.forget(row);
        drop(new Set([row.id]));
        deps.toast(`"${displayName(row.fileName)}" 을(를) 열 수 없어 목록에서 뺐습니다.`);
        return;
      }
      if (judged.missingSince !== undefined && row.missingSince === undefined) {
        row.missingSince = judged.missingSince;
        await defaultHealIo.update(row, { missingSince: judged.missingSince });
      }
      flagged.set(row.id, result === 'missing' ? '찾을 수 없음' : '열 수 없음');
      if (result === 'missing') deps.toast(`"${displayName(row.fileName)}" 파일을 찾을 수 없습니다.`);
      if (visible) renderRecent();
    } finally {
      opening = null;
    }
  }

  function drop(ids: ReadonlySet<string>): void {
    if (!ids.size) return;
    rows = rows.filter((row) => !ids.has(row.id));
    documents = documents.filter((doc) => !ids.has(doc.recentId));
    if (expanded && ids.has(expanded)) expanded = null;
    for (const id of ids) {
      cardFor(id)?.closest('.dh-item')?.classList.add('is-leaving');
    }
    // 사라지는 모양을 잠깐 보인 뒤 줄을 다시 짠다.
    window.setTimeout(() => { if (visible) renderRecent(); }, reducedMotion() ? 0 : 160);
  }

  // ── 자료 ────────────────────────────────────────────────
  async function load(): Promise<void> {
    const token = ++loadToken;
    status.textContent = '';
    void loadTemplates(token, 0);
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
      loaded = false;
      renderRecent();
      status.replaceChildren(el('span', '', '최근 문서를 불러오지 못했습니다. '));
      const retry = button('dh-link', '다시 시도');
      retry.addEventListener('click', () => void load());
      status.append(retry);
      return;
    }
    loaded = true;
    for (const row of rows) {
      if (row.missingSince !== undefined && !flagged.has(row.id)) flagged.set(row.id, '찾을 수 없음');
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

    // 첫 화면을 그린 뒤에 파일을 확인한다. 정리는 한 번에 하나만 돈다.
    void inspectAndHeal(rows).then(({ presence: inspected, healed }) => {
      if (token !== loadToken) return;
      presence = inspected;
      for (const [id, fileName] of healed.renamed) {
        const row = rows.find((entry) => entry.id === id);
        if (row) { row.fileName = fileName; delete row.missingSince; }
        flagged.delete(id);
      }
      for (const [id, state] of presence) {
        if (state.state === 'present' && flagged.get(id) === '찾을 수 없음') flagged.delete(id);
      }
      for (const id of healed.stale) flagged.set(id, '찾을 수 없음');
      rows = rows.filter((row) => !healed.removed.has(row.id));
      regroup();
      if (visible) renderRecent();
    }).catch((error) => console.warn('[document-home] 파일 확인 실패:', error));
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

  // ── 입력 ────────────────────────────────────────────────
  grid.addEventListener('click', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLButtonElement>('.dh-card');
    if (!card?.dataset.id) return;
    for (const other of grid.querySelectorAll<HTMLElement>('.dh-card')) other.tabIndex = -1;
    card.tabIndex = 0;
    // 두 번 누르기의 두 번째 누름은 펼침을 되돌리지 않는다. 열기는 dblclick 이 한다.
    if (event.detail > 1) return;
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
    // 펼친 판은 다른 카드로 옮기면 따라간다.
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
  // Esc 는 문서 전체에서 받는다. 빈 곳을 눌러 초점이 몸체로 가도 홈을 닫을 수 있다.
  // 입력 칸·대화상자·펼친 판이 먼저 받은 Esc 는 건드리지 않는다.
  document.addEventListener('keydown', (event) => {
    if (!visible || event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target !== document.body && !root.contains(target)) return;
    if (target?.closest('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]')) return;
    // 홈이 받은 Esc 는 뒤의 앱(에이전트 전체 화면 닫기 등)으로 넘기지 않는다.
    event.preventDefault();
    if (expanded) { const id = expanded; collapse(); cardFor(id)?.focus(); return; }
    if (deps.returnTarget()) hide();
    // 캡처 단계에서 받는다. 가린 앱의 Esc 처리(에이전트 전체 화면 닫기 등)보다 먼저다.
  }, true);

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
  back.addEventListener('click', () => hide());
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

  // ── 보이기·숨기기 ───────────────────────────────────────
  function paintReturn(): void {
    const target = deps.returnTarget();
    back.hidden = target === null;
    back.querySelector('.dh-back-label')!.textContent = target ? displayName(target.label) : '';
    const action = target?.kind === 'chat' ? '채팅으로 돌아가기' : '문서로 돌아가기';
    back.setAttribute('aria-label', action);
    back.title = `${action} (Esc)`;
  }

  /**
   * 홈 뒤의 앱(편집기·사이드바)은 보이지도, 초점을 받지도 않는다. 레이아웃은 그대로 두어 문서의
   * 스크롤·선택·캔버스 크기가 돌아올 때 그대로다.
   */
  function coverApp(covered: boolean): void {
    document.documentElement.classList.toggle('document-home-open', covered);
    for (const child of document.body.children) {
      if (child.id === 'studio-root' || child.id === 'agent-sidebar') (child as HTMLElement).inert = covered;
    }
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    root.classList.remove('is-shown');
    root.hidden = true;
    expanded = null;
    resetThumbnails();
    // 미리보기 일꾼의 엔진 메모리를 돌려준다. 다음에 열 때 새로 띄운다.
    releaseThumbnailWorker();
    coverApp(false);
    const target = returnFocus;
    returnFocus = null;
    // 열기 전 초점 자리로 돌아간다. 그 자리가 사라졌거나 문서가 바뀌었으면 편집기·입력기로.
    if (target?.isConnected && !target.closest('[inert]') && target.checkVisibility?.() !== false) {
      target.focus({ preventScroll: true });
    } else {
      deps.restoreFocus();
    }
  }

  function show(options: { focus?: boolean } = {}): void {
    paintReturn();
    const wasVisible = visible;
    if (!wasVisible) {
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      // Electron 은 창 끌기 영역을 문서 순서로 적용한다. 홈을 뒤에 두어 가린 앱의 영역을 덮는다.
      if (root.nextElementSibling) document.body.append(root);
      coverApp(true);
      // 문서 그림은 열 때마다 저장소에서 다시 읽는다. 그사이 고친 문서가 옛 그림으로 남지 않는다.
      for (const key of [...blobs.keys()]) if (key.startsWith('document:')) forgetBlob(key);
    }
    visible = true;
    root.hidden = false;
    if (!wasVisible) {
      root.classList.remove('is-shown');
      requestAnimationFrame(() => root.classList.add('is-shown'));
      scroller.scrollTop = 0;
      // 새로 만들기 줄은 목록을 기다리지 않고 바로 그린다.
      renderTemplates();
      renderRecent();
    }
    if (!root.contains(document.activeElement)) {
      if (options.focus === false) scroller.focus({ preventScroll: true });
      else templates.querySelector<HTMLElement>('.dh-template-card')?.focus({ preventScroll: true });
    }
    void load().then(() => {
      if (options.focus === false || !visible) return;
      // 목록이 오면 키보드를 가장 최근 문서로 옮긴다. 그사이 사용자가 옮겼으면 두고 둔다.
      const active = document.activeElement;
      if (active === templates.querySelector('.dh-template-card')) cardFor(focusedId)?.focus({ preventScroll: true });
    });
  }

  renderTemplates();

  return {
    element: root,
    get visible() { return visible; },
    show,
    hide,
    refresh() {
      if (visible) { paintReturn(); void load(); }
    },
  };
}
