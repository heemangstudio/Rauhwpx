/**
 * 사이드바와 연구 프로젝트를 잇는 자리.
 *
 * - 집중 보기의 프로젝트 칸: 처음 열 때 만들어 .ag-stage 에 붙인다. 언제 보일지는
 *   사이드바(index.ts)의 오른쪽 칸 상태가 정하고, 여기서는 setActive 로 받는다.
 * - 답변의 인용 칩 훅: 사이드바마다 한 벌. 프로젝트가 바뀌면 그려 둔 칩을 다시 맞춘다.
 * - 입력기의 @ 멘션: 고른 항목을 첨부 줄의 칩으로 두고, 보낼 때 id 를 꺼내 준다.
 */
import type { ProjectClient } from '../../../agent/project-service.ts';
import type { ThreadMention } from '../../../agent/threads.ts';
import { MAX_DOCUMENT_MENTIONS, type DocumentMention, type ProjectSnapshot } from '../../../agent/types.ts';
import { refreshCitations } from '../chat-markdown.ts';
import { createIcon } from '../icons.ts';
import { createMentionPicker, renderMentionPill, type MentionDocument } from '../mention-picker.ts';
import { projectCitationTarget, type CitationHooks, type CitationRequest } from '../wikilinks.ts';
import { clipThumbElement } from './clip-thumbs.ts';
import { createProjectColumn, type ProjectColumn, type ProjectPreviewTarget, type ProjectTab } from './project-column.ts';
import { el, itemIconName, projectIcon } from './project-ui.ts';

export interface ProjectHostDeps {
  client: ProjectClient | null;
  /** 칸을 붙일 곳 (.ag-stage). */
  stage: HTMLElement;
  /** 답변 목록. 프로젝트가 바뀌면 이 안의 칩을 다시 맞춘다. */
  messages: HTMLElement;
  /**
   * 칸을 보여 달라는 요청. 사이드바가 집중 보기와 오른쪽 칸 상태를 맞춘 뒤 then 을 부른다.
   */
  requestOpen(then: () => void): void;
  requestClose(): void;
  /** 자료는 별도 작업 탭에서 연다. */
  openPreview?(target: ProjectPreviewTarget): boolean | void;
  openBoard?(tab?: ProjectTab): boolean | void;
  /** `d…` 문서 노드를 열 때 — 그 문서로 옮겨 간다. */
  openDocument(documentId: string): void;
  onChange?(project: ProjectSnapshot | null): void;
}

export interface ProjectHost {
  /** 답변 렌더러에 넘기는 인용 훅. 같은 객체를 계속 쓴다. */
  readonly citations: CitationHooks;
  /** 칸을 연다. target 이 있으면 미리보기까지 연다. */
  open(target?: ProjectPreviewTarget, tab?: ProjectTab): void;
  /** 오른쪽 칸 상태가 바뀔 때 사이드바가 부른다. */
  setActive(active: boolean): void;
  contains(node: Node): boolean;
  project(): ProjectSnapshot | null;
  /** 칸이 아직 없으면 null. */
  column(): ProjectColumn | null;
  dispose(): void;
}

export function createProjectHost(deps: ProjectHostDeps): ProjectHost {
  const { client } = deps;
  let column: ProjectColumn | null = null;
  let active = false;
  let refreshFrame: number | null = null;
  /** `${projectId}:${itemId}#c${n}` → 쪽 번호 (조회 중이면 Promise). */
  const chunkPages = new Map<string, number | null | Promise<number | null>>();
  let cachedProjectId: string | null = null;

  const project = () => client?.store.get() ?? null;

  function ensureColumn(): ProjectColumn | null {
    if (column || !client) return column;
    column = createProjectColumn({
      store: client.store,
      service: client.service,
      worktrees: client.worktrees ?? null,
      onClose: () => deps.requestClose(),
      openDocument: (documentId) => deps.openDocument(documentId),
    });
    column.element.setAttribute('aria-hidden', 'true');
    column.element.inert = true;
    deps.stage.append(column.element);
    return column;
  }

  function open(target?: ProjectPreviewTarget, tab?: ProjectTab): void {
    if (!client) return;
    if (target && deps.openPreview && deps.openPreview(target) !== false) return;
    if (!target && deps.openBoard && deps.openBoard(tab) !== false) return;
    deps.requestOpen(() => {
      const opened = ensureColumn();
      if (tab) opened?.setTab(tab);
      if (target) opened?.openPreview(target);
      else opened?.closePreview();
    });
  }

  function openCitation(request: CitationRequest): void {
    if (request.id.startsWith('d')) {
      const member = project()?.members.find((row) => row.nodeId === request.id);
      if (member) deps.openDocument(member.documentId);
      return;
    }
    open({ itemId: request.id, anchor: request.anchor, quote: request.quote });
  }

  const citations: CitationHooks = {
    resolveItem: (id) => projectCitationTarget(project(), id),
    openCitation,
    clipThumb(clip, source) {
      const current = project();
      if (!client || !current) return null;
      return clipThumbElement({ projectId: current.id, clip, source, size: 'chip', load: client.service.fileBlob });
    },
    chunkPage(id, n) {
      const current = project();
      const item = current?.items.find((row) => row.id === id);
      if (!client || !current || item?.kind !== 'file') return null;
      const key = `${current.id}:${id}#c${n}`;
      const known = chunkPages.get(key);
      if (known !== undefined) return known;
      const lookup = client.service.chunk(current.id, id, `c${n}`)
        .then((chunk) => (typeof chunk.page === 'number' && chunk.page > 0 ? chunk.page : null))
        .catch(() => null)
        .then((page) => {
          chunkPages.set(key, page);
          return page;
        });
      chunkPages.set(key, lookup);
      return lookup;
    },
  };

  function scheduleRefresh(): void {
    if (refreshFrame !== null) return;
    refreshFrame = window.requestAnimationFrame(() => {
      refreshFrame = null;
      refreshCitations(deps.messages, citations);
    });
  }

  const unsubscribe = client?.store.subscribe((next) => {
    if ((next?.id ?? null) !== cachedProjectId) {
      cachedProjectId = next?.id ?? null;
      chunkPages.clear();
    }
    scheduleRefresh();
    deps.onChange?.(next);
  }) ?? (() => undefined);
  cachedProjectId = project()?.id ?? null;
  deps.onChange?.(project());

  return {
    citations,
    open,
    setActive(next) {
      if (next) ensureColumn();
      active = next;
      if (!column) return;
      column.element.setAttribute('aria-hidden', active ? 'false' : 'true');
      column.element.inert = !active;
      column.setVisible(active);
    },
    contains: (node) => column?.element.contains(node) ?? false,
    project,
    column: () => column,
    dispose() {
      unsubscribe();
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      column?.dispose();
      column = null;
    },
  };
}

/* ── 입력기 @ 멘션 ───────────────────────────────────────── */

const MAX_MENTIONS = 20;

export interface ComposerMentionsDeps {
  client: ProjectClient | null;
  /** @ 의 '문서' 묶음 — 이 창에 열린 문서와 최근 문서 (채팅의 문서는 뺀다). 없으면 묶음이 없다. */
  listDocuments?: () => Promise<MentionDocument[]>;
  textarea: HTMLTextAreaElement;
  /** 칩을 놓을 첨부 줄. */
  row: HTMLElement;
  onChange?(): void;
}

/** 멘션 칩을 프로젝트 항목 id 와 문서 멘션으로 나눈다 — 메시지의 mentions·documentMentions. */
export function splitThreadMentions(mentions: readonly ThreadMention[]): { itemIds: string[]; documents: DocumentMention[] } {
  const itemIds: string[] = [];
  const documents: DocumentMention[] = [];
  for (const mention of mentions) {
    if (mention.kind !== 'document') itemIds.push(mention.id);
    else if (documents.length < MAX_DOCUMENT_MENTIONS && !documents.some((row) => row.documentId === mention.id)) {
      documents.push({ documentId: mention.id, title: mention.title, ...(mention.open ? { open: true as const } : {}) });
    }
  }
  return { itemIds, documents };
}

function mentionKey(mention: ThreadMention): string {
  return `${mention.kind ?? 'item'}:${mention.id}`;
}

export interface ComposerMentions {
  list(): ThreadMention[];
  /** 보낼 때 꺼내고 비운다. */
  take(): ThreadMention[];
  /** 채팅을 오가며 초안을 되살린다. */
  set(mentions: readonly ThreadMention[]): void;
  /** 끌어 놓은 프로젝트 항목을 칩으로 더한다. 지금 프로젝트에 없는 항목이면 false. */
  addItem(projectId: string, itemId: string): boolean;
  dispose(): void;
}

export function createComposerMentions(deps: ComposerMentionsDeps): ComposerMentions {
  const { client, textarea, row } = deps;
  const chips = new Map<string, { mention: ThreadMention; root: HTMLElement }>();
  /** '문서' 묶음 — @ 를 입력할 때마다 다시 읽고, 그동안은 지난 목록을 보인다. */
  let documents: MentionDocument[] = [];
  let documentsLoad = 0;

  function loadDocuments(): void {
    if (!deps.listDocuments) return;
    const load = ++documentsLoad;
    void deps.listDocuments().then((rows) => {
      if (load !== documentsLoad) return;
      documents = rows;
      picker?.refresh();
    }, () => undefined);
  }

  function remove(key: string): void {
    const chip = chips.get(key);
    if (!chip) return;
    chip.root.remove();
    chips.delete(key);
    deps.onChange?.();
  }

  function add(mention: ThreadMention, kindIcon?: SVGSVGElement): void {
    const key = mentionKey(mention);
    if (chips.has(key) || chips.size >= MAX_MENTIONS) return;
    if (mention.kind === 'document'
      && [...chips.values()].filter((chip) => chip.mention.kind === 'document').length >= MAX_DOCUMENT_MENTIONS) return;
    const root = el('span', 'ag-reference-upload-chip ag-mention-draft');
    root.dataset.mentionId = mention.id;
    root.title = mention.title;
    const close = el('button', 'ag-reference-upload-remove');
    close.type = 'button';
    close.title = '언급 빼기';
    close.setAttribute('aria-label', `${mention.title} 언급 빼기`);
    close.append(createIcon('close'));
    close.addEventListener('click', () => {
      remove(key);
      textarea.focus();
    });
    const icon = kindIcon ?? projectIcon(mention.kind === 'document' ? 'documentNode' : 'file');
    root.append(icon, el('span', 'ag-reference-upload-chip-name', mention.title), close);
    row.append(root);
    chips.set(key, { mention, root });
    deps.onChange?.();
  }

  const picker = client || deps.listDocuments
    ? createMentionPicker({
      textarea,
      getItems: () => client?.store.get()?.items ?? [],
      columnName: (id) => client?.store.get()?.columns.find((entry) => entry.id === id)?.name ?? null,
      onPick: (item) => add({ id: item.id, title: item.title }, projectIcon(itemIconName(item))),
      ...(deps.listDocuments
        ? {
          getDocuments: () => documents,
          onPickDocument: (document: MentionDocument) => add({
            id: document.documentId, title: document.title, kind: 'document', ...(document.open ? { open: true as const } : {}),
          }),
          onOpen: loadDocuments,
        }
        : {}),
    })
    : null;
  const unsubscribe = client?.store.subscribe(() => picker?.refresh()) ?? (() => undefined);

  function clear(): void {
    for (const chip of chips.values()) chip.root.remove();
    chips.clear();
  }

  return {
    list: () => [...chips.values()].map((chip) => ({ ...chip.mention })),
    take() {
      const taken = [...chips.values()].map((chip) => ({ ...chip.mention }));
      clear();
      if (taken.length) deps.onChange?.();
      return taken;
    },
    set(mentions) {
      clear();
      const items = client?.store.get()?.items ?? [];
      for (const mention of mentions) {
        const item = mention.kind === 'document' ? undefined : items.find((entry) => entry.id === mention.id);
        add(mention, item ? projectIcon(itemIconName(item)) : undefined);
      }
      deps.onChange?.();
    },
    addItem(projectId, itemId) {
      const snapshot = client?.store.get();
      const item = snapshot?.id === projectId
        ? snapshot.items.find((entry) => entry.id === itemId && !entry.trashedAt)
        : undefined;
      if (!item) return false;
      add({ id: item.id, title: item.title }, projectIcon(itemIconName(item)));
      return true;
    },
    dispose() {
      unsubscribe();
      picker?.destroy();
      clear();
    },
  };
}

/** 사용자 말풍선의 멘션 칩 줄. 누르면 프로젝트 칸에서 그 항목을 연다. */
export function renderMessageMentions(mentions: readonly ThreadMention[], hooks: CitationHooks | null): HTMLElement {
  const row = el('div', 'ag-msg-attachments ag-msg-mentions');
  for (const mention of mentions) {
    const pill = renderMentionPill(mention);
    if (mention.kind === 'document' || !hooks) {
      pill.tabIndex = -1;
      row.append(pill);
      continue;
    }
    pill.setAttribute('aria-label', `${mention.title} 열기`);
    pill.addEventListener('click', () => {
      if (!hooks.resolveItem(mention.id, null)) return;
      hooks.openCitation({ id: mention.id, anchor: null, quote: null });
    });
    row.append(pill);
  }
  return row;
}
