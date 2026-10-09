/**
 * 연구 프로젝트 HTTP 클라이언트와 현재 프로젝트 스냅샷 저장소.
 *
 * 허브 경로는 참고자료와 같은 인증을 쓴다. 이 모듈은 브리지를 모른다 — 주소 만들기와
 * 인증 헤더는 주입받은 transport 가 맡는다. 저장소는 서버 스냅샷(확정본) 위에 아직 응답을
 * 받지 못한 편집 묶음을 다시 얹어 화면용 스냅샷을 만든다. 서버 revision 이 묶음의 응답
 * revision 을 따라잡으면 그 묶음을 걷어 낸다.
 */
import type {
  ProjectActivityEntry,
  ProjectActor,
  ProjectChunk,
  ProjectClipItem,
  ProjectFileItem,
  ProjectFileText,
  ProjectItem,
  ProjectLibrarianAction,
  ProjectLibrarianItemStatus,
  ProjectLibrarianState,
  ProjectNote,
  ProjectNoteItem,
  ProjectOp,
  ProjectOpsResult,
  ProjectSettings,
  ProjectSettingsPayload,
  ProjectSnapshot,
  ProjectSummary,
  ProjectUndoResult,
} from './types.ts';

// ── transport ───────────────────────────────────────────

export type ProjectQuery = Record<string, string | number | boolean | undefined>;

/** 통합 단계에서 브리지의 referenceUrl + 참고자료 토큰으로 채운다. */
export interface ProjectTransport {
  /** 허브 경로와 쿼리로 절대 주소를 만든다 (세션 id 같은 공통 쿼리 포함). */
  url(path: string, query?: ProjectQuery): string;
  /** 인증 헤더를 붙여 요청한다. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export class ProjectRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ProjectRequestError';
    this.code = code;
    this.status = status;
  }
}

export function isRevisionMismatch(error: unknown): boolean {
  return error instanceof ProjectRequestError && error.code === 'PROJECT_REVISION_MISMATCH';
}

// ── 서비스 ──────────────────────────────────────────────

export interface ProjectService {
  current(): Promise<ProjectSnapshot | null>;
  list(): Promise<ProjectSummary[]>;
  get(projectId: string, options?: { trash?: boolean }): Promise<ProjectSnapshot>;
  create(input: { name: string; documentId?: string }): Promise<ProjectSnapshot>;
  remove(projectId: string): Promise<void>;
  applyOps(
    projectId: string,
    ops: ProjectOp[],
    options?: { expectedRevision?: number; actor?: ProjectActor },
  ): Promise<ProjectOpsResult>;
  undo(projectId: string, activityId: string): Promise<ProjectUndoResult>;
  activity(projectId: string, options?: { limit?: number; before?: string }): Promise<ProjectActivityEntry[]>;
  uploadFile(projectId: string, file: File, options?: { column?: string }): Promise<ProjectFileItem>;
  fileBlob(projectId: string, itemId: string): Promise<Blob>;
  chunk(projectId: string, itemId: string, chunkId: string): Promise<ProjectChunk>;
  fileText(projectId: string, itemId: string, page?: number): Promise<ProjectFileText>;
  note(projectId: string, noteId: string): Promise<ProjectNote>;
  join(projectId: string, documentId: string): Promise<ProjectSnapshot | null>;
  leave(projectId: string, documentId: string): Promise<ProjectSnapshot | null>;
  emptyTrash(projectId: string): Promise<void>;
  librarian(projectId: string, action: ProjectLibrarianAction, itemId?: string): Promise<void>;
  getSettings(): Promise<ProjectSettingsPayload>;
  saveSettings(settings: ProjectSettings): Promise<ProjectSettingsPayload>;
}

const USER_ACTOR: ProjectActor = { kind: 'user' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathId(value: string): string {
  return encodeURIComponent(value);
}

async function readError(response: Response): Promise<ProjectRequestError> {
  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text.trim() ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const body = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : `HTTP_${response.status}`;
  const message = isRecord(body) && typeof body.message === 'string'
    ? body.message
    : `프로젝트 요청이 실패했습니다 (${response.status})`;
  return new ProjectRequestError(code, message, response.status);
}

export function createProjectService(transport: ProjectTransport): ProjectService {
  async function send(path: string, init: RequestInit & { query?: ProjectQuery } = {}): Promise<Response> {
    const { query, ...rest } = init;
    let response: Response;
    try {
      response = await transport.fetch(transport.url(path, query), rest);
    } catch (error) {
      throw new ProjectRequestError(
        'PROJECT_OFFLINE',
        `프로젝트 서버에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }
    if (!response.ok) throw await readError(response);
    return response;
  }

  async function json(path: string, init: RequestInit & { query?: ProjectQuery } = {}): Promise<unknown> {
    const response = await send(path, init);
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ProjectRequestError('PROJECT_BAD_RESPONSE', '프로젝트 서버 응답을 읽지 못했습니다.', response.status);
    }
  }

  function post(path: string, body: unknown, query?: ProjectQuery): Promise<unknown> {
    return json(path, {
      method: 'POST',
      query,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function snapshotFrom(payload: unknown): ProjectSnapshot {
    const raw = isRecord(payload) && 'project' in payload ? payload.project : payload;
    const snapshot = normalizeProjectSnapshot(raw);
    if (!snapshot) throw new ProjectRequestError('PROJECT_BAD_RESPONSE', '프로젝트 정보를 읽지 못했습니다.', 200);
    return snapshot;
  }

  function optionalSnapshot(payload: unknown): ProjectSnapshot | null {
    const raw = isRecord(payload) && 'project' in payload ? payload.project : payload;
    return normalizeProjectSnapshot(raw);
  }

  function settingsFrom(payload: unknown): ProjectSettingsPayload {
    const body = isRecord(payload) ? payload : {};
    const capabilities = isRecord(body.capabilities) ? body.capabilities : {};
    return {
      settings: normalizeProjectSettings(body.settings),
      capabilities: {
        homeAccess: capabilities.homeAccess === true,
        platform: typeof capabilities.platform === 'string' ? capabilities.platform : 'browser',
      },
    };
  }

  const base = (projectId: string) => `/projects/${pathId(projectId)}`;

  return {
    async current() {
      return optionalSnapshot(await json('/projects/current'));
    },
    async list() {
      const payload = await json('/projects');
      const rows = isRecord(payload) && Array.isArray(payload.projects) ? payload.projects : [];
      return rows.flatMap((row): ProjectSummary[] => {
        if (!isRecord(row) || typeof row.id !== 'string') return [];
        const usage = isRecord(row.usage) ? row.usage : {};
        return [{
          id: row.id,
          name: typeof row.name === 'string' ? row.name : row.id,
          implicit: row.implicit === true,
          members: Array.isArray(row.members) ? row.members as ProjectSummary['members'] : [],
          usage: { files: Number(usage.files) || 0, bytes: Number(usage.bytes) || 0 },
          updatedAt: Number(row.updatedAt) || 0,
        }];
      });
    },
    async get(projectId, options) {
      return snapshotFrom(await json(base(projectId), { query: options?.trash ? { trash: 1 } : undefined }));
    },
    async create(input) {
      return snapshotFrom(await post('/projects', input));
    },
    async remove(projectId) {
      await send(base(projectId), { method: 'DELETE' });
    },
    async applyOps(projectId, ops, options) {
      const payload = await post(`${base(projectId)}/ops`, {
        ops,
        actor: options?.actor ?? USER_ACTOR,
        ...(options?.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
      });
      const body = isRecord(payload) ? payload : {};
      return {
        revision: Number(body.revision) || 0,
        applied: Number(body.applied) || 0,
        created: isRecord(body.created) ? body.created as Record<number, string> : {},
        unresolvedLinks: Array.isArray(body.unresolvedLinks) ? body.unresolvedLinks.filter((id): id is string => typeof id === 'string') : [],
      };
    },
    async undo(projectId, activityId) {
      const payload = await post(`${base(projectId)}/undo`, { activityId });
      const body = isRecord(payload) ? payload : {};
      const skipped = Array.isArray(body.skipped) ? body.skipped.length : Number(body.skipped) || 0;
      return { revision: Number(body.revision) || 0, applied: Number(body.applied) || 0, skipped };
    },
    async activity(projectId, options) {
      const payload = await json(`${base(projectId)}/activity`, {
        query: { limit: options?.limit ?? 50, before: options?.before },
      });
      const entries = isRecord(payload) && Array.isArray(payload.entries) ? payload.entries : [];
      return entries.filter((entry): entry is ProjectActivityEntry => (
        isRecord(entry) && typeof entry.id === 'string' && typeof entry.summary === 'string'
      ));
    },
    async uploadFile(projectId, file, options) {
      const payload = await json(`${base(projectId)}/files`, {
        method: 'POST',
        query: options?.column ? { column: options.column } : undefined,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          // Fetch 헤더는 ByteString 이라 한글 파일명은 percent-encode 한다.
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      const item = isRecord(payload) ? payload.item : null;
      if (!isRecord(item) || item.kind !== 'file') {
        throw new ProjectRequestError('PROJECT_BAD_RESPONSE', '올린 파일 정보를 읽지 못했습니다.', 200);
      }
      return item as unknown as ProjectFileItem;
    },
    async fileBlob(projectId, itemId) {
      const response = await send(`${base(projectId)}/files/${pathId(itemId)}/blob`);
      return response.blob();
    },
    async chunk(projectId, itemId, chunkId) {
      return await json(`${base(projectId)}/files/${pathId(itemId)}/chunks/${pathId(chunkId)}`) as ProjectChunk;
    },
    async fileText(projectId, itemId, page) {
      return await json(`${base(projectId)}/files/${pathId(itemId)}/text`, { query: { page } }) as ProjectFileText;
    },
    async note(projectId, noteId) {
      return await json(`${base(projectId)}/notes/${pathId(noteId)}`) as ProjectNote;
    },
    async join(projectId, documentId) {
      return optionalSnapshot(await post(`${base(projectId)}/join`, { documentId }));
    },
    async leave(projectId, documentId) {
      return optionalSnapshot(await post(`${base(projectId)}/leave`, { documentId }));
    },
    async emptyTrash(projectId) {
      await post(`${base(projectId)}/trash/empty`, {});
    },
    async librarian(projectId, action, itemId) {
      await post(`${base(projectId)}/librarian`, itemId ? { action, itemId } : { action });
    },
    async getSettings() {
      return settingsFrom(await json('/project-settings'));
    },
    async saveSettings(settings) {
      return settingsFrom(await json('/project-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      }));
    },
  };
}

// ── 설정 기본값 ─────────────────────────────────────────

export const DEFAULT_PROJECT_FILE_TYPES: readonly string[] = [
  'pdf', 'hwp', 'hwpx', 'hml', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp',
];

export const DEFAULT_PROJECT_COLUMNS: readonly string[] = ['수집함', '검토 중', '핵심', '보류'];

export function defaultProjectSettings(): ProjectSettings {
  return {
    version: 1,
    librarian: {
      enabled: true,
      provider: 'auto',
      model: null,
      effort: null,
      actions: { rename: true, classify: true, link: true },
      concurrency: 2,
    },
    ingest: { homeSearch: true, fileTypes: [...DEFAULT_PROJECT_FILE_TYPES], excludedFolders: [], maxFileMb: 100 },
    agent: { chatMayEdit: true, summarySize: 'medium' },
    board: { defaultColumns: [...DEFAULT_PROJECT_COLUMNS], trashDays: 30 },
  };
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
}

/** 허브가 준 설정을 계약의 모양으로 다듬는다. 모르는 값은 기본값으로 둔다. */
export function normalizeProjectSettings(raw: unknown): ProjectSettings {
  const defaults = defaultProjectSettings();
  const body = isRecord(raw) ? raw : {};
  const librarian = isRecord(body.librarian) ? body.librarian : {};
  const actions = isRecord(librarian.actions) ? librarian.actions : {};
  const ingest = isRecord(body.ingest) ? body.ingest : {};
  const agent = isRecord(body.agent) ? body.agent : {};
  const board = isRecord(body.board) ? body.board : {};
  const provider = ['auto', 'chat', 'claude', 'codex', 'pi'].includes(librarian.provider as string)
    ? librarian.provider as ProjectSettings['librarian']['provider']
    : defaults.librarian.provider;
  const concurrency = Math.round(Number(librarian.concurrency));
  const maxFileMb = Math.round(Number(ingest.maxFileMb));
  const trashDays = Number(board.trashDays);
  const columns = stringList(board.defaultColumns, defaults.board.defaultColumns);
  return {
    version: 1,
    librarian: {
      enabled: typeof librarian.enabled === 'boolean' ? librarian.enabled : defaults.librarian.enabled,
      provider,
      model: provider !== 'auto' && provider !== 'chat' && typeof librarian.model === 'string' && librarian.model ? librarian.model : null,
      effort: provider !== 'auto' && provider !== 'chat' && typeof librarian.effort === 'string' && librarian.effort ? librarian.effort : null,
      actions: {
        rename: typeof actions.rename === 'boolean' ? actions.rename : true,
        classify: typeof actions.classify === 'boolean' ? actions.classify : true,
        link: typeof actions.link === 'boolean' ? actions.link : true,
      },
      concurrency: (concurrency >= 1 && concurrency <= 4 ? concurrency : 2) as 1 | 2 | 3 | 4,
    },
    ingest: {
      homeSearch: typeof ingest.homeSearch === 'boolean' ? ingest.homeSearch : true,
      fileTypes: [...new Set(stringList(ingest.fileTypes, defaults.ingest.fileTypes)
        .map((type) => type.replace(/^\./, '').toLowerCase()))],
      excludedFolders: [...new Set(stringList(ingest.excludedFolders, []))],
      maxFileMb: Number.isFinite(maxFileMb) ? Math.min(100, Math.max(1, maxFileMb)) : 100,
    },
    agent: {
      chatMayEdit: typeof agent.chatMayEdit === 'boolean' ? agent.chatMayEdit : true,
      summarySize: ['small', 'medium', 'large'].includes(agent.summarySize as string)
        ? agent.summarySize as ProjectSettings['agent']['summarySize']
        : 'medium',
    },
    board: {
      defaultColumns: columns.length ? columns : [...defaults.board.defaultColumns],
      trashDays: trashDays === 7 || trashDays === 90 ? trashDays : 30,
    },
  };
}

// ── 스냅샷 ──────────────────────────────────────────────

const LIBRARIAN_STATES: readonly ProjectLibrarianState[] = ['idle', 'running', 'paused'];

/** 허브 스냅샷을 받아들일 수 있는 모양인지 보고 빠진 배열을 채운다. */
export function normalizeProjectSnapshot(raw: unknown): ProjectSnapshot | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const librarian = isRecord(raw.librarian) ? raw.librarian : {};
  const graph = isRecord(raw.graph) ? raw.graph : {};
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    implicit: raw.implicit === true,
    revision: Number(raw.revision) || 0,
    columns: Array.isArray(raw.columns) ? raw.columns as ProjectSnapshot['columns'] : [],
    tags: Array.isArray(raw.tags) ? raw.tags as ProjectSnapshot['tags'] : [],
    members: Array.isArray(raw.members) ? raw.members as ProjectSnapshot['members'] : [],
    items: Array.isArray(raw.items)
      ? (raw.items as ProjectItem[]).filter((item) => isRecord(item) && typeof item.id === 'string')
      : [],
    links: Array.isArray(raw.links) ? raw.links as ProjectSnapshot['links'] : [],
    graph: { pinned: isRecord(graph.pinned) ? graph.pinned as Record<string, [number, number]> : {} },
    librarian: {
      state: LIBRARIAN_STATES.includes(librarian.state as ProjectLibrarianState)
        ? librarian.state as ProjectLibrarianState
        : 'idle',
      queued: Number(librarian.queued) || 0,
      running: Number(librarian.running) || 0,
    },
    usage: { files: Number(usage.files) || 0, bytes: Number(usage.bytes) || 0 },
  };
}

/** 항목이 놓인 열. 열이 없거나 사라진 열이면 첫 열로 본다. */
export function itemColumnId(project: Pick<ProjectSnapshot, 'columns'>, item: Pick<ProjectItem, 'column'>): string | null {
  const first = project.columns[0]?.id ?? null;
  if (item.column && project.columns.some((column) => column.id === item.column)) return item.column;
  return first;
}

/** 한 열의 항목을 보드 순서(order → 만든 시각 → id)로 돌려준다. */
export function columnItems(project: Pick<ProjectSnapshot, 'columns' | 'items'>, columnId: string): ProjectItem[] {
  return project.items
    .filter((item) => !item.trashedAt && itemColumnId(project, item) === columnId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

const TAG_FALLBACK_COLORS = ['#379cff', '#e7ae45', '#cb79d7', '#53bdab', '#8e9dff', '#ed8592'];

function cloneSnapshot(project: ProjectSnapshot): ProjectSnapshot {
  return {
    ...project,
    columns: project.columns.map((column) => ({ ...column })),
    tags: project.tags.map((tag) => ({ ...tag })),
    members: project.members.map((member) => ({ ...member })),
    items: project.items.map((item) => ({ ...item, tags: [...item.tags] }) as ProjectItem),
    links: project.links.map((link) => ({ ...link })),
    graph: { pinned: { ...project.graph.pinned } },
    librarian: { ...project.librarian },
    usage: { ...project.usage },
  };
}

function placeInColumn(project: ProjectSnapshot, item: ProjectItem, columnId: string, index?: number): void {
  const source = itemColumnId(project, item);
  const target = columnItems(project, columnId).filter((entry) => entry.id !== item.id);
  const at = index === undefined ? target.length : Math.max(0, Math.min(target.length, Math.trunc(index)));
  target.splice(at, 0, item);
  item.column = columnId;
  target.forEach((entry, order) => { entry.order = order; });
  if (source && source !== columnId) {
    columnItems(project, source).forEach((entry, order) => { entry.order = order; });
  }
}

export interface LocalOpsOptions {
  now?: number;
  /** 낙관 적용에서 아직 서버 id 가 없는 새 항목·연결의 id. */
  tempId?: () => string;
}

/**
 * 연산 묶음을 스냅샷 사본에 적용한다. 서버가 거절할 연산(없는 항목 등)은 조용히 건너뛴다.
 * 결과는 화면용 예측일 뿐이며 서버 스냅샷이 오면 그것으로 갈음한다.
 */
export function applyProjectOps(project: ProjectSnapshot, ops: readonly ProjectOp[], options: LocalOpsOptions = {}): ProjectSnapshot {
  const next = cloneSnapshot(project);
  const now = options.now ?? Date.now();
  let counter = 0;
  const tempId = options.tempId ?? (() => `tmp-${now.toString(36)}-${counter++}`);
  const itemById = (id: string) => next.items.find((item) => item.id === id);
  const ensureTag = (name: string) => {
    if (next.tags.some((tag) => tag.name === name)) return;
    next.tags.push({ name, color: TAG_FALLBACK_COLORS[next.tags.length % TAG_FALLBACK_COLORS.length] });
  };
  const lock = (item: ProjectItem, field: 'title' | 'column' | 'tags') => {
    if (item.kind === 'file') item.locked = { ...item.locked, [field]: true };
  };

  for (const op of ops) {
    switch (op.op) {
      case 'rename': {
        const item = itemById(op.id);
        const name = op.name.trim();
        if (!item || !name) break;
        item.title = name;
        item.updatedAt = now;
        lock(item, 'title');
        break;
      }
      case 'tag': {
        const item = itemById(op.id);
        if (!item) break;
        const tags = op.tags.map((tag) => tag.trim()).filter(Boolean);
        const mode = op.mode ?? 'set';
        if (mode === 'set') item.tags = [...new Set(tags)];
        else if (mode === 'add') item.tags = [...new Set([...item.tags, ...tags])];
        else item.tags = item.tags.filter((tag) => !tags.includes(tag));
        for (const tag of item.tags) ensureTag(tag);
        item.updatedAt = now;
        lock(item, 'tags');
        break;
      }
      case 'move': {
        const item = itemById(op.id);
        if (!item || !next.columns.some((column) => column.id === op.column)) break;
        placeInColumn(next, item, op.column, op.index);
        item.updatedAt = now;
        lock(item, 'column');
        break;
      }
      case 'pin': {
        const item = itemById(op.id);
        if (item) item.pinned = op.pinned;
        break;
      }
      case 'link':
        next.links.push({
          id: tempId(),
          from: op.from,
          to: op.to,
          origin: 'explicit',
          ...(op.label ? { label: op.label } : {}),
          ...(op.fromAnchor ? { fromAnchor: op.fromAnchor } : {}),
          ...(op.toAnchor ? { toAnchor: op.toAnchor } : {}),
        });
        break;
      case 'unlink':
        next.links = next.links.filter((link) => link.id !== op.id);
        break;
      case 'note': {
        const existing = op.id ? itemById(op.id) : undefined;
        if (existing) {
          if (op.name?.trim()) existing.title = op.name.trim();
          if (existing.kind === 'note') {
            existing.bytes = op.mode === 'append' ? existing.bytes + op.body.length : op.body.length;
          }
          existing.updatedAt = now;
          break;
        }
        if (op.id) break;
        const columnId = op.column && next.columns.some((column) => column.id === op.column)
          ? op.column
          : next.columns[0]?.id ?? null;
        const note: ProjectNoteItem = {
          id: tempId(),
          kind: 'note',
          title: op.name?.trim() || '새 노트',
          column: columnId,
          order: columnId ? columnItems(next, columnId).length : 0,
          tags: [...new Set(op.tags ?? [])],
          pinned: false,
          summary: '',
          createdAt: now,
          updatedAt: now,
          addedBy: { kind: 'user' },
          bytes: op.body.length,
        };
        for (const tag of note.tags) ensureTag(tag);
        next.items.push(note);
        break;
      }
      case 'clip': {
        const existing = op.id ? itemById(op.id) : undefined;
        if (existing) {
          if (existing.kind !== 'clip') break;
          if (op.name?.trim()) existing.title = op.name.trim();
          if (op.page !== undefined) existing.page = op.page;
          if (op.rect) existing.rect = [...op.rect];
          if (op.tags) existing.tags = [...new Set(op.tags)];
          if (op.column && next.columns.some((column) => column.id === op.column)) placeInColumn(next, existing, op.column);
          existing.updatedAt = now;
          break;
        }
        const source = op.source ? itemById(op.source) : undefined;
        if (op.id || !op.rect || source?.kind !== 'file') break;
        const columnId = op.column && next.columns.some((column) => column.id === op.column)
          ? op.column
          : next.columns[0]?.id ?? null;
        const clip: ProjectClipItem = {
          id: tempId(),
          kind: 'clip',
          title: op.name?.trim() || source.title,
          column: columnId,
          order: columnId ? columnItems(next, columnId).length : 0,
          tags: [...new Set(op.tags ?? [])],
          pinned: false,
          summary: '',
          createdAt: now,
          updatedAt: now,
          addedBy: { kind: 'user' },
          sourceId: source.id,
          page: op.page ?? 1,
          rect: [...op.rect],
        };
        for (const tag of clip.tags) ensureTag(tag);
        next.items.push(clip);
        next.links.push({ id: tempId(), from: clip.id, to: source.id, origin: 'clip' });
        break;
      }
      case 'columns': {
        const columns = op.columns
          .map((column) => ({ id: column.id ?? tempId(), name: column.name.trim() }))
          .filter((column) => column.name);
        if (!columns.length) break;
        const kept = new Set(columns.map((column) => column.id));
        const orphans = next.items
          .filter((item) => !item.trashedAt && !kept.has(itemColumnId(next, item) ?? ''))
          .sort((a, b) => a.order - b.order);
        next.columns = columns;
        const first = columns[0].id;
        let order = columnItems({ ...next, items: next.items.filter((item) => !orphans.includes(item)) }, first).length;
        for (const item of orphans) {
          item.column = first;
          item.order = order++;
        }
        break;
      }
      case 'goal':
        next.goal = op.body.slice(0, 2000);
        break;
      case 'trash': {
        const item = itemById(op.id);
        if (!item) break;
        // 파일을 버리면 그 파일의 영역 조각도 함께 휴지통으로 간다 (허브와 같다).
        const gone = new Set([op.id, ...next.items.filter((entry) => entry.kind === 'clip' && entry.sourceId === op.id).map((entry) => entry.id)]);
        const columns = new Set(next.items.filter((entry) => gone.has(entry.id)).map((entry) => itemColumnId(next, entry)));
        next.items = next.items.filter((entry) => !gone.has(entry.id));
        next.links = next.links.filter((link) => !gone.has(link.from) && !gone.has(link.to));
        for (const column of columns) if (column) columnItems(next, column).forEach((entry, order) => { entry.order = order; });
        break;
      }
      case 'restore':
        // 휴지통 항목은 화면 스냅샷에 없다. 서버 스냅샷이 오면 다시 나타난다.
        break;
      case 'graph-pin':
        next.graph.pinned[op.id] = [op.x, op.y];
        break;
      case 'graph-unpin':
        delete next.graph.pinned[op.id];
        break;
      default: {
        const _exhaustive: never = op;
        void _exhaustive;
      }
    }
  }
  return next;
}

// ── 저장소 ──────────────────────────────────────────────

export type ProjectStoreListener = (project: ProjectSnapshot | null) => void;

export interface ProjectStore {
  /** 화면용 스냅샷: 확정본 + 아직 확정되지 않은 내 편집. */
  get(): ProjectSnapshot | null;
  /** 서버가 마지막으로 보낸 스냅샷. */
  confirmed(): ProjectSnapshot | null;
  projectId(): string | null;
  /** 응답을 기다리거나 서버 스냅샷에 아직 반영되지 않은 편집 묶음 수. */
  pendingCount(): number;
  subscribe(listener: ProjectStoreListener): () => void;
  /** 허브 이벤트를 받는다. 프로젝트 이벤트였으면 true. */
  applyEvent(message: unknown): boolean;
  /** 서버에서 받은 스냅샷으로 바꾼다 (다른 프로젝트면 대기 편집을 버린다). */
  replace(project: ProjectSnapshot | null): void;
  /** 낙관 적용 후 서버에 보낸다. 실패하면 화면이 서버 상태로 돌아가고 오류를 던진다. */
  edit(ops: ProjectOp[]): Promise<ProjectOpsResult>;
  refresh(): Promise<ProjectSnapshot | null>;
  dispose(): void;
}

interface PendingBatch {
  key: number;
  ops: ProjectOp[];
  /** 서버가 이 묶음을 반영한 revision. 응답 전에는 null. */
  ackRevision: number | null;
}

export interface ProjectStoreOptions {
  service?: ProjectService | null;
  actor?: ProjectActor;
  /** 편집 응답 뒤 이 시간 안에 project-changed 가 오지 않으면 스냅샷을 다시 받는다. */
  reconcileDelayMs?: number;
}

export function createProjectStore(options: ProjectStoreOptions = {}): ProjectStore {
  const service = options.service ?? null;
  const actor = options.actor ?? USER_ACTOR;
  const reconcileDelayMs = options.reconcileDelayMs ?? 600;
  const listeners = new Set<ProjectStoreListener>();
  let confirmed: ProjectSnapshot | null = null;
  let view: ProjectSnapshot | null = null;
  let batches: PendingBatch[] = [];
  let batchKey = 0;
  let tempCounter = 0;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const tempId = () => `tmp-${++tempCounter}`;

  function rebuild(): void {
    view = confirmed
      ? batches.reduce((project, batch) => applyProjectOps(project, batch.ops, { tempId }), confirmed)
      : null;
    for (const listener of [...listeners]) listener(view);
  }

  function accept(project: ProjectSnapshot): void {
    if (confirmed && confirmed.id === project.id && project.revision < confirmed.revision) return;
    if (!confirmed || confirmed.id !== project.id) batches = [];
    confirmed = project;
    batches = batches.filter((batch) => batch.ackRevision === null || batch.ackRevision > project.revision);
    rebuild();
  }

  function scheduleReconcile(): void {
    if (!service || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (disposed || !batches.some((batch) => batch.ackRevision !== null)) return;
      void store.refresh().catch(() => undefined);
    }, reconcileDelayMs);
  }

  function applyLibrarianStatus(message: Record<string, unknown>): void {
    if (!confirmed || confirmed.id !== message.projectId) return;
    const state = LIBRARIAN_STATES.includes(message.state as ProjectLibrarianState)
      ? message.state as ProjectLibrarianState
      : confirmed.librarian.state;
    const statuses = new Map<string, ProjectLibrarianItemStatus>();
    if (Array.isArray(message.items)) {
      for (const entry of message.items) {
        if (isRecord(entry) && typeof entry.id === 'string' && typeof entry.status === 'string') {
          statuses.set(entry.id, entry as unknown as ProjectLibrarianItemStatus);
        }
      }
    }
    confirmed = {
      ...confirmed,
      librarian: { state, queued: Number(message.queued) || 0, running: Number(message.running) || 0 },
      items: confirmed.items.map((item) => {
        const status = statuses.get(item.id);
        if (!status || item.kind !== 'file') return item;
        return { ...item, librarian: { status: status.status, ...(status.error ? { error: status.error } : {}) } };
      }),
    };
    rebuild();
  }

  const store: ProjectStore = {
    get: () => view,
    confirmed: () => confirmed,
    projectId: () => confirmed?.id ?? null,
    pendingCount: () => batches.length,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applyEvent(message) {
      if (!isRecord(message) || typeof message.type !== 'string') return false;
      if (message.type === 'project-bound' || message.type === 'project-changed') {
        const project = normalizeProjectSnapshot(message.project);
        if (project) {
          if (message.type === 'project-bound' && confirmed?.id !== project.id) batches = [];
          accept(project);
        }
        return true;
      }
      if (message.type === 'project-librarian-status') {
        applyLibrarianStatus(message);
        return true;
      }
      return false;
    },
    replace(project) {
      if (!project) {
        confirmed = null;
        batches = [];
        rebuild();
        return;
      }
      accept(project);
    },
    async edit(ops) {
      if (!confirmed) throw new ProjectRequestError('PROJECT_NOT_FOUND', '열린 프로젝트가 없습니다.', 0);
      if (!ops.length) return { revision: confirmed.revision, applied: 0, created: {}, unresolvedLinks: [] };
      const projectId = confirmed.id;
      const batch: PendingBatch = { key: ++batchKey, ops: [...ops], ackRevision: null };
      batches.push(batch);
      rebuild();
      if (!service) {
        // 서비스가 없으면 화면에서만 적용한다 (미리보기·테스트).
        batches = batches.filter((entry) => entry !== batch);
        confirmed = applyProjectOps(confirmed, ops, { tempId });
        confirmed.revision += 1;
        rebuild();
        return { revision: confirmed.revision, applied: ops.length, created: {}, unresolvedLinks: [] };
      }
      try {
        const result = await service.applyOps(projectId, ops, { actor });
        if (disposed || confirmed?.id !== projectId) return result;
        batch.ackRevision = result.revision;
        if (confirmed.revision >= result.revision) {
          batches = batches.filter((entry) => entry !== batch);
          rebuild();
        } else {
          scheduleReconcile();
        }
        return result;
      } catch (error) {
        batches = batches.filter((entry) => entry !== batch);
        rebuild();
        throw error;
      }
    },
    async refresh() {
      if (!service) return view;
      const projectId = confirmed?.id ?? null;
      const project = projectId ? await service.get(projectId) : await service.current();
      if (disposed) return view;
      if (project) accept(project);
      else store.replace(null);
      return view;
    },
    dispose() {
      disposed = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      listeners.clear();
    },
  };
  return store;
}

// ── 통합 전 연결점 ─────────────────────────────────────

/** 브리지(또는 미리보기 모의 브리지)가 함께 들고 다니는 프로젝트 클라이언트. */
export interface ProjectClient {
  service: ProjectService;
  store: ProjectStore;
}

/**
 * host.projects 가 프로젝트 클라이언트면 꺼낸다. SidebarBridge 에 `projects` 가 붙기 전에도
 * 설정·참고자료 화면이 같은 경로로 서비스를 찾게 한다.
 */
export function projectClientOf(host: unknown): ProjectClient | null {
  if (typeof host !== 'object' || host === null) return null;
  const candidate = (host as { projects?: unknown }).projects;
  if (!isRecord(candidate)) return null;
  const { service, store } = candidate as { service?: unknown; store?: unknown };
  if (!isRecord(service) || typeof (service as { getSettings?: unknown }).getSettings !== 'function') return null;
  if (!isRecord(store) || typeof (store as { subscribe?: unknown }).subscribe !== 'function') return null;
  return candidate as unknown as ProjectClient;
}
