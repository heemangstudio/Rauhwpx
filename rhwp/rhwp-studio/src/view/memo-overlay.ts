/**
 * 메모(한컴 "메모", 풍선 주석) 화면 오버레이.
 *
 * - 앵커 글자에 메모 모양의 채우기 색으로 반투명 강조와 얇은 테두리를 그린다.
 * - 각 쪽 오른쪽에 메모 창(풍선)을 두고, 앵커 높이에 맞춰 겹치지 않게 쌓으며 앵커와
 *   지시선으로 잇는다. 풍선에는 작성자·날짜·본문이 있고 본문을 눌러 바로 고친다.
 * - 렌더 트리에는 아무것도 넣지 않는다 — 캔버스·내보내기·인쇄는 그대로다 (한컴 기본값도
 *   메모를 인쇄하지 않는다).
 *
 * 편집은 모두 InputHandler.executeOperation({kind:'snapshot'}) 으로 기록해 실행 취소·
 * 다시 실행·수정 표시가 일반 편집과 같다.
 */
import type { EventBus } from '@/core/event-bus';
import type { MemoNoteInfo, MemoNotePath, MemoNoteRect } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';
import { commitMemoDelete, commitMemoEdit, commitMemoInsert } from '@/core/memo-edits';
import type { InputHandler } from '@/engine/input-handler';
import { showToast } from '@/ui/toast';
import type { ViewportManager } from './viewport-manager';
import type { VirtualScroll } from './virtual-scroll';

const BALLOON_GAP_PX = 16;
const BALLOON_WIDTH_PX = 220;
const BALLOON_STACK_GAP_PX = 6;

export interface MemoOverlayDeps {
  /** #scroll-container */
  container: HTMLElement;
  wasm: WasmBridge;
  eventBus: EventBus;
  virtualScroll: VirtualScroll;
  viewportManager: ViewportManager;
  getInputHandler(): InputHandler | null;
  /** 새 메모 작성자 (사용자 이름). 없으면 빈 문자열. */
  getAuthor?(): string;
  /**
   * 풍선 편집 중 누른 키가 앱 단축키(저장·열기 등 파일 명령)이면 그 명령 실행 함수를,
   * 아니면 null 을 돌려준다. 풍선은 먼저 확정되고 나서 명령이 실행된다.
   */
  matchAppShortcut?(e: KeyboardEvent): (() => void) | null;
}

/** 풍선 안에서 글 편집으로 쓰는 Ctrl 조합 — 앱 단축키로 넘기지 않는다. */
const TEXT_EDITING_CHORD_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'enter', 'backspace', 'delete',
  'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end']);

/** 아직 문서에 넣지 않은 새 메모 — 내용을 쓰고 확정해야 하나의 실행 취소 단위로 들어간다. */
interface MemoDraft {
  path: MemoNotePath;
  start: number;
  end: number;
}

interface PlacedMemo {
  memo: MemoNoteInfo | null;
  draft: MemoDraft | null;
  rects: MemoNoteRect[];
  page: number;
  anchorTop: number;
  anchorMidY: number;
  anchorRight: number;
  paneLeft: number;
}

export function memoDateLabel(createdAt: string | null): string {
  if (!createdAt) return '';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `#RRGGBB` → `rgba(r,g,b,a)` */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(203,255,153,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** contentEditable 본문을 평문으로 읽는다 (끝 줄바꿈 하나는 브라우저가 붙인 것). */
function editableText(el: HTMLElement): string {
  return (el.innerText ?? el.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
}

export class MemoOverlay {
  private layer: HTMLDivElement;
  private svg: SVGSVGElement;
  private visible = true;
  private renderScheduled = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private editingFieldId: number | null = null;
  private draft: MemoDraft | null = null;
  private unsubscribers: Array<() => void> = [];
  private openMenu: HTMLElement | null = null;
  /** 에이전트가 검토 대기 중인 메모 (fieldId) — 풍선에 표시만 한다. */
  private pendingFieldIds = new Set<number>();

  constructor(private deps: MemoOverlayDeps) {
    this.layer = document.createElement('div');
    this.layer.className = 'memo-layer';
    this.layer.dataset.rhwpMemoLayer = '';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('memo-leaders');
    this.svg.setAttribute('aria-hidden', 'true');
    this.layer.appendChild(this.svg);
    this.attach();
    const schedule = () => this.scheduleRender();
    const { eventBus } = deps;
    this.unsubscribers.push(
      eventBus.on('document-changed', schedule),
      eventBus.on('document-mutated', schedule),
      eventBus.on('document-view-changed', schedule),
      eventBus.on('zoom-changed', schedule),
      eventBus.on('viewport-resize', schedule),
      eventBus.on('viewport-inset-changed', schedule),
      eventBus.on('document-swapped', schedule),
      eventBus.on('document-context-changed', schedule),
      eventBus.on('history-jumped', schedule),
      eventBus.on('page-layout-changed', schedule),
    );
    this.layer.addEventListener('mousedown', (e) => {
      // 풍선 안의 누름은 편집기 캐럿 이동/선택으로 번지지 않는다.
      if ((e.target as HTMLElement).closest('.memo-balloon')) e.stopPropagation();
    });
    this.layer.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.memo-balloon')) e.stopPropagation();
    });
    this.layer.addEventListener('keydown', (e) => e.stopPropagation());
    document.addEventListener('mousedown', this.closeMenuOnOutside, true);
    // 창·탭을 닫을 때 쓰던 풍선을 먼저 확정해 문서 수정 표시(이탈 확인)에 들어가게 한다.
    // 캡처 단계라 DocumentDirtyState 의 beforeunload 처리보다 먼저 돈다.
    window.addEventListener('beforeunload', this.commitLiveEdit, true);
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.renderTimer) clearTimeout(this.renderTimer);
    document.removeEventListener('mousedown', this.closeMenuOnOutside, true);
    window.removeEventListener('beforeunload', this.commitLiveEdit, true);
    this.layer.remove();
  }

  /** 편집 중인 풍선이 있으면 확정한다 (빈 새 메모는 버린다). */
  commitLiveEdit = (): void => {
    if (!this.isEditingLive()) return;
    (document.activeElement as HTMLElement | null)?.blur();
  };

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (!on) {
      this.draft = null;
      this.editingFieldId = null;
    }
    this.render();
  }

  /** 에이전트 검토 대기 메모 표시. */
  setPendingFieldIds(ids: Iterable<number>): void {
    this.pendingFieldIds = new Set(ids);
    this.scheduleRender();
  }

  /** 새 메모 풍선을 편집 상태로 연다. 내용을 쓰고 확정할 때 문서에 들어간다. */
  openDraft(path: MemoNotePath, start: number, end: number): void {
    if (!this.visible) this.setVisible(true);
    this.draft = { path, start, end };
    this.editingFieldId = null;
    this.render();
    this.focusEditor();
  }

  /** 기존 메모 풍선을 편집 상태로 연다. */
  openEditor(fieldId: number): void {
    if (!this.visible) this.setVisible(true);
    this.draft = null;
    this.editingFieldId = fieldId;
    this.render();
    this.focusEditor();
  }

  scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const run = () => {
      this.renderScheduled = false;
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
      this.render();
    };
    // rAF 는 가려진 탭에서 멈춘다 — 짧은 timeout 을 함께 걸어 먼저 오는 쪽으로 그린다.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.renderScheduled) run();
      });
    }
    this.renderTimer = setTimeout(() => {
      if (this.renderScheduled) run();
    }, 50);
  }

  /** 현재 문서의 메모 목록 (표시와 무관). */
  list(): MemoNoteInfo[] {
    try {
      return this.deps.wasm.getMemoNoteList();
    } catch {
      return [];
    }
  }

  private attach(): void {
    if (this.layer.isConnected) return;
    const scrollContent = this.deps.container.querySelector('#scroll-content');
    scrollContent?.appendChild(this.layer);
  }

  private closeMenuOnOutside = (e: MouseEvent): void => {
    if (!this.openMenu) return;
    if ((e.target as HTMLElement | null)?.closest?.('.memo-menu')) return;
    this.openMenu.remove();
    this.openMenu = null;
  };

  /** 편집 중 풍선이 있으면 다시 그리지 않는다 — 입력 중인 글이 날아가지 않게. */
  private isEditingLive(): boolean {
    const active = document.activeElement;
    return !!active && this.layer.contains(active) && (active as HTMLElement).isContentEditable;
  }

  render(): void {
    this.attach();
    if (this.isEditingLive()) return;
    this.openMenu?.remove();
    this.openMenu = null;
    for (const child of [...this.layer.children]) {
      if (child !== this.svg) child.remove();
    }
    this.svg.replaceChildren();
    if (!this.visible || this.deps.wasm.pageCount === 0) {
      this.layer.hidden = true;
      return;
    }
    this.layer.hidden = false;
    const placed = this.collect();
    if (placed.length === 0) return;
    const scrollContent = this.deps.container.querySelector('#scroll-content') as HTMLElement | null;
    const zoom = this.deps.viewportManager.getZoom();
    const contentWidth = scrollContent?.clientWidth ?? 0;
    this.svg.setAttribute('width', String(scrollContent?.scrollWidth ?? contentWidth));
    this.svg.setAttribute('height', String(scrollContent?.scrollHeight ?? 0));

    // 앵커 강조
    for (const item of placed) {
      const fill = item.memo ? item.memo.shape.fillColor : '#CBFF99';
      const line = item.memo ? item.memo.shape.lineColor : '#A9A9A9';
      for (const rect of item.rects) {
        if (rect.w <= 0) continue;
        const left = this.deps.virtualScroll.getPageLeftResolved(rect.pageIndex, contentWidth);
        const top = this.deps.virtualScroll.getPageOffset(rect.pageIndex);
        const hl = document.createElement('div');
        hl.className = 'memo-anchor-highlight';
        hl.dataset.memoFieldId = item.memo ? String(item.memo.fieldId) : 'draft';
        hl.style.left = `${left + rect.x * zoom}px`;
        hl.style.top = `${top + rect.y * zoom}px`;
        hl.style.width = `${rect.w * zoom}px`;
        hl.style.height = `${rect.h * zoom}px`;
        hl.style.background = withAlpha(fill, 0.45);
        hl.style.outlineColor = line;
        this.layer.appendChild(hl);
      }
    }

    // 쪽마다 앵커 높이 순으로 겹치지 않게 쌓는다.
    placed.sort((a, b) => a.page - b.page || a.anchorTop - b.anchorTop);
    let page = -1;
    let nextTop = -Infinity;
    for (const item of placed) {
      if (item.page !== page) {
        page = item.page;
        nextTop = -Infinity;
      }
      const balloon = this.buildBalloon(item);
      const top = Math.max(item.anchorTop - 4, nextTop + BALLOON_STACK_GAP_PX);
      balloon.style.left = `${item.paneLeft}px`;
      balloon.style.top = `${top}px`;
      this.layer.appendChild(balloon);
      nextTop = top + (balloon.offsetHeight || 64);
      this.drawLeader(item, top);
    }
  }

  private collect(): PlacedMemo[] {
    const { wasm, virtualScroll } = this.deps;
    const scrollContent = this.deps.container.querySelector('#scroll-content') as HTMLElement | null;
    const contentWidth = scrollContent?.clientWidth ?? 0;
    const zoom = this.deps.viewportManager.getZoom();
    const place = (memo: MemoNoteInfo | null, draft: MemoDraft | null, rects: MemoNoteRect[]): PlacedMemo | null => {
      const first = rects[0];
      if (!first) return null;
      const page = first.pageIndex;
      const pageLeft = virtualScroll.getPageLeftResolved(page, contentWidth);
      const pageTop = virtualScroll.getPageOffset(page);
      const samePage = rects.filter((r) => r.pageIndex === page);
      const last = samePage[samePage.length - 1] ?? first;
      return {
        memo,
        draft,
        rects,
        page,
        anchorTop: pageTop + first.y * zoom,
        anchorMidY: pageTop + (first.y + first.h / 2) * zoom,
        anchorRight: pageLeft + (last.x + last.w) * zoom,
        paneLeft: pageLeft + virtualScroll.getPageWidth(page) + BALLOON_GAP_PX,
      };
    };
    const out: PlacedMemo[] = [];
    for (const memo of this.list()) {
      if (!memo.anchor) continue;
      let rects: MemoNoteRect[] = [];
      try {
        rects = wasm.getMemoNoteAnchorRects(memo.fieldId);
      } catch {
        rects = [];
      }
      const item = place(memo, null, rects);
      if (item) out.push(item);
    }
    if (this.draft) {
      const item = place(null, this.draft, this.draftRects(this.draft));
      if (item) out.push(item);
    }
    return out;
  }

  private draftRects(draft: MemoDraft): MemoNoteRect[] {
    const { wasm } = this.deps;
    try {
      const path = draft.path.cellPath ?? [];
      const raw = path.length
        ? wasm.getSelectionRectsByPath(
          draft.path.sectionIdx, draft.path.paraIdx, path,
          path[path.length - 1].cellParaIndex, draft.start, path[path.length - 1].cellParaIndex, draft.end,
        )
        : wasm.getSelectionRects(draft.path.sectionIdx, draft.path.paraIdx, draft.start, draft.path.paraIdx, draft.end);
      return (raw as Array<{ pageIndex: number; x: number; y: number; width: number; height: number }>)
        .map((r) => ({ pageIndex: r.pageIndex, x: r.x, y: r.y, w: r.width, h: r.height }));
    } catch {
      return [];
    }
  }

  private drawLeader(item: PlacedMemo, balloonTop: number): void {
    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    const color = item.memo ? item.memo.shape.lineColor : '#A9A9A9';
    const y1 = item.anchorMidY;
    const x1 = item.anchorRight;
    const x2 = item.paneLeft;
    const y2 = balloonTop + 12;
    path.setAttribute('d', `M${x1},${y1} L${x2 - BALLOON_GAP_PX / 2},${y1} L${x2},${y2}`);
    path.setAttribute('stroke', color);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-dasharray', '3 2');
    path.setAttribute('stroke-width', '1');
    this.svg.appendChild(path);
  }

  private buildBalloon(item: PlacedMemo): HTMLElement {
    const memo = item.memo;
    const balloon = document.createElement('div');
    balloon.className = 'memo-balloon';
    balloon.style.width = `${BALLOON_WIDTH_PX}px`;
    if (memo) {
      balloon.dataset.memoFieldId = String(memo.fieldId);
      balloon.style.borderColor = memo.shape.lineColor;
      balloon.style.background = withAlpha(memo.shape.fillColor, 0.92);
      if (this.pendingFieldIds.has(memo.fieldId)) balloon.classList.add('memo-balloon-pending');
    } else {
      balloon.dataset.memoDraft = '';
      balloon.classList.add('memo-balloon-draft');
    }

    const header = document.createElement('div');
    header.className = 'memo-balloon-header';
    const author = document.createElement('span');
    author.className = 'memo-balloon-author';
    author.textContent = memo ? (memo.author || '메모') : (this.deps.getAuthor?.() || '새 메모');
    const date = document.createElement('span');
    date.className = 'memo-balloon-date';
    date.textContent = memo ? memoDateLabel(memo.createdAt) : '';
    header.append(author, date);
    if (memo) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'memo-balloon-more';
      more.title = '메모 메뉴';
      more.setAttribute('aria-label', '메모 메뉴');
      more.textContent = '⋯';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showMenu(more, memo);
      });
      header.appendChild(more);
    }
    balloon.appendChild(header);

    if (memo && memo.anchorText === '') {
      const note = document.createElement('div');
      note.className = 'memo-balloon-orphan';
      note.textContent = '(앵커 글자가 지워짐)';
      balloon.appendChild(note);
    }

    const body = document.createElement('div');
    body.className = 'memo-balloon-body';
    body.textContent = memo ? memo.text : '';
    const editing = memo ? this.editingFieldId === memo.fieldId : true;
    if (editing) {
      this.makeEditable(body, memo);
      balloon.classList.add('memo-balloon-editing');
    } else if (memo) {
      body.title = '눌러서 메모 고치기';
      body.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEditor(memo.fieldId);
      });
    }
    balloon.appendChild(body);
    return balloon;
  }

  private makeEditable(body: HTMLElement, memo: MemoNoteInfo | null): void {
    body.contentEditable = 'plaintext-only';
    if (body.contentEditable !== 'plaintext-only') body.contentEditable = 'true';
    body.setAttribute('role', 'textbox');
    body.setAttribute('aria-multiline', 'true');
    body.setAttribute('aria-label', memo ? '메모 내용' : '새 메모 내용');
    body.dataset.placeholder = '메모 내용을 입력하세요';
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const text = editableText(body);
      this.editingFieldId = null;
      const draft = this.draft;
      this.draft = null;
      body.contentEditable = 'false';
      if (commit) {
        if (memo) this.commitEdit(memo, text);
        else if (draft && text.trim() !== '') this.commitDraft(draft, text);
      }
      this.render();
      this.deps.getInputHandler()?.focus?.();
    };
    body.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const run = (e.ctrlKey || e.metaKey) && !e.isComposing
        && !TEXT_EDITING_CHORD_KEYS.has(e.key.toLowerCase())
        ? this.deps.matchAppShortcut?.(e) ?? null
        : null;
      if (run) {
        // Ctrl+S 같은 앱 단축키: 쓰던 메모를 문서에 넣은 뒤 명령을 실행한다.
        e.preventDefault();
        finish(true);
        run();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    body.addEventListener('blur', () => finish(true));
  }

  private focusEditor(): void {
    const body = this.layer.querySelector<HTMLElement>('.memo-balloon-editing .memo-balloon-body');
    if (!body) return;
    body.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    body.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private commitEdit(memo: MemoNoteInfo, text: string): void {
    const ih = this.deps.getInputHandler();
    if (ih) commitMemoEdit(ih, this.deps.wasm, memo.fieldId, text);
  }

  private commitDraft(draft: MemoDraft, text: string): void {
    const ih = this.deps.getInputHandler();
    if (!ih) return;
    try {
      commitMemoInsert(ih, draft.path, draft.start, draft.end, text, this.deps.getAuthor?.());
    } catch (error) {
      // 넣기 명령이 미리 막지만, 그 사이 문서가 바뀌어 실패해도 죽은 풍선을 남기지 않는다.
      const reason = error instanceof Error ? error.message : String(error);
      showToast({ message: `메모를 넣지 못했습니다: ${reason}` });
    }
  }

  /** 메모 하나를 지운다 (실행 취소 가능). */
  deleteMemo(fieldId: number): void {
    const ih = this.deps.getInputHandler();
    if (!ih) return;
    commitMemoDelete(ih, fieldId);
    this.scheduleRender();
  }

  private showMenu(anchor: HTMLElement, memo: MemoNoteInfo): void {
    this.openMenu?.remove();
    const menu = document.createElement('div');
    menu.className = 'memo-menu';
    menu.setAttribute('role', 'menu');
    const item = (label: string, run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'memo-menu-item';
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        this.openMenu = null;
        run();
      });
      menu.appendChild(button);
    };
    item('메모 고치기', () => this.openEditor(memo.fieldId));
    item('메모 지우기', () => this.deleteMemo(memo.fieldId));
    const balloon = anchor.closest('.memo-balloon') as HTMLElement | null;
    menu.style.left = `${(balloon?.offsetLeft ?? 0) + BALLOON_WIDTH_PX - 120}px`;
    menu.style.top = `${(balloon?.offsetTop ?? 0) + 24}px`;
    this.layer.appendChild(menu);
    this.openMenu = menu;
  }
}
