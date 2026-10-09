import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { replaceFileAtomically } from './harness-update.mjs';
import { formatWikilinkAnchor, isProjectAnchor, parseWikilinks } from './project-links.mjs';
import { DEFAULT_PROJECT_SETTINGS } from './project-settings.mjs';
import { defaultReferenceRoot, tokenizeReferenceText } from './reference-store.mjs';

/**
 * 연구 프로젝트 저장소. 허브 앱 데이터 `…/rhwp/projects/` 아래에
 *   index.json                 프로젝트 목록 + 문서·스레드 → 프로젝트 대응
 *   <pid>/project.json         열·항목·연결·그래프 고정 위치·별칭
 *   <pid>/notes/<id>.md        메모 본문
 *   <pid>/activity.jsonl       되돌리기용 활동 기록(역연산 포함), 5천 줄·2MB 에서 회전
 * 를 둔다. 파일 원본은 ReferenceStore 의 project 범위에 있고 항목은 fileId 로 가리킨다.
 * 이름 바꾸기·이동은 메타데이터만 바꾼다.
 */

export const PROJECT_ID_PATTERN = /^p[a-z2-7]{10}$/;
export const ITEM_ID_PATTERN = /^[fndr][a-z2-7]{6}$/;
export const LINK_ID_PATTERN = /^l[a-z2-7]{8}$/;
const COLUMN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ACTIVITY_ID_PATTERN = /^a[a-z2-7]{12}$/;
const PROJECT_SCHEMA_VERSION = 1;
const INDEX_SCHEMA_VERSION = 1;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const DEFAULT_COLUMN_IDS = ['inbox', 'review', 'key', 'hold'];
const MAX_OPS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_TAG_CHARS = 40;
const MAX_TAGS_PER_ITEM = 20;
const MAX_LINK_LABEL_CHARS = 40;
const MAX_NOTE_CHARS = 200_000;
const MAX_GOAL_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_COLUMNS = 12;
const MAX_COLUMN_NAME_CHARS = 40;
const MAX_PROJECT_NAME_CHARS = 120;
const MAX_GRAPH_COORDINATE = 1_000_000;
const MAX_CLIP_PAGE = 100_000;
const CLIP_UNITS = 10_000; // 영역 좌표는 소수 넷째 자리까지 — 1만분의 1 단위
const MIN_CLIP_UNITS = 100; // 0.01
export const DEFAULT_MAX_PROJECT_FILE_ITEMS = 2_000;
export const DEFAULT_MAX_PROJECT_NOTES = 2_000;
export const DEFAULT_MAX_PROJECT_CLIPS = 2_000;
export const DEFAULT_MAX_PROJECT_LINKS = 20_000;
const MAX_PROJECT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_JSON_BYTES = 8 * 1024 * 1024;
const ACTIVITY_ROTATE_ENTRIES = 5_000;
const ACTIVITY_ROTATE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAG_COLORS = ['#c2410c', '#0f766e', '#1d4ed8', '#7c3aed', '#be185d', '#4d7c0f', '#b45309', '#0e7490', '#9333ea', '#475569'];
const ITEM_KINDS = new Set(['file', 'note', 'clip']);
const CLIP_SOURCE_KINDS = new Set(['pdf', 'image']);
const LIBRARIAN_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'skipped']);
const SOURCE_KINDS = new Set(['upload', 'chat-attachment', 'web', 'home', 'text', 'workspace', 'migrated']);
const ACTOR_KINDS = new Set(['user', 'agent', 'librarian']);
const LIBRARIAN_OPS = new Set(['rename', 'tag', 'move', 'link', 'summary']);
const OP_LABELS = {
  rename: '이름 변경',
  tag: '태그',
  move: '이동',
  pin: '고정',
  link: '연결',
  unlink: '연결 해제',
  note: '메모',
  clip: '영역',
  summary: '요약',
  columns: '열 편집',
  goal: '목표',
  trash: '휴지통',
  restore: '복원',
  'graph-pin': '그래프 배치',
  'graph-unpin': '그래프 배치',
};
const FILE_KINDS = {
  '.txt': 'text', '.md': 'text', '.markdown': 'text', '.csv': 'text', '.tsv': 'text', '.json': 'text', '.xml': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.hwp': 'hwp', '.hwpx': 'hwp', '.hml': 'hwp',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.html': 'html', '.htm': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
};

export class ProjectStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function projectError(code, message, details) {
  return new ProjectStoreError(code, message, details);
}

function invalidOp(index, message) {
  return projectError('PROJECT_OP_INVALID', index === null ? message : `ops[${index}]: ${message}`);
}

/** 기본 위치는 참고 자료 저장소 옆(`…/rhwp/projects`)이다. RHWP_PROJECTS_DIR 로 바꾼다. */
export function defaultProjectsRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_PROJECTS_DIR) return path.resolve(env.RHWP_PROJECTS_DIR);
  return path.join(path.dirname(defaultReferenceRoot(env, platform, home)), 'projects');
}

export function fileKindForName(name) {
  return FILE_KINDS[path.extname(String(name ?? '')).toLowerCase()] ?? 'other';
}

function randomBase32(length, random = crypto.randomBytes) {
  const bytes = random(length);
  let out = '';
  for (let index = 0; index < length; index += 1) out += BASE32[bytes[index] & 31];
  return out;
}

function hashBase32(value, length) {
  const digest = crypto.createHash('sha256').update(value).digest();
  let out = '';
  for (let index = 0; index < length; index += 1) out += BASE32[digest[index] & 31];
  return out;
}

/** 프로젝트 안에서 문서 노드 id 는 documentId 에서 정해진다 — 다시 합류해도 같다. */
export function documentNodeId(projectId, documentId) {
  return `d${hashBase32(`${projectId}\u0000${documentId}`, 6)}`;
}

function tagColor(name) {
  return TAG_COLORS[crypto.createHash('sha256').update(name).digest()[0] % TAG_COLORS.length];
}

function cleanText(value, maximum, { allowEmpty = false, multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '');
  const text = multiline ? normalized : normalized.trim();
  if (!allowEmpty && !text.trim()) return null;
  return text.length <= maximum ? text : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function noteTitleFrom(body) {
  for (const line of String(body).split('\n')) {
    const text = line.replace(/^#{1,6}\s+/, '').replace(/[*_`>[\]]/g, '').trim();
    if (text) return text.slice(0, 60);
  }
  return '메모';
}

async function writeFileAtomically(file, content, platform) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const handle = await fs.open(temp, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await replaceFileAtomically(temp, file, { platform });
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function readBoundedText(file, maximum) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw projectError('PROJECT_STORE_CORRUPT', `${path.basename(file)} is not a plain bounded file`);
  }
  return fs.readFile(file, 'utf8');
}

function normalizeActor(raw) {
  if (!isPlainObject(raw) || !ACTOR_KINDS.has(raw.kind)) {
    throw projectError('PROJECT_OP_INVALID', 'actor.kind must be user, agent, or librarian');
  }
  return {
    kind: raw.kind,
    ...(typeof raw.threadId === 'string' && raw.threadId ? { threadId: raw.threadId.slice(0, 256) } : {}),
    ...(typeof raw.agent === 'string' && raw.agent ? { agent: raw.agent.slice(0, 40) } : {}),
  };
}

function compareOrder(left, right) {
  return (left.order - right.order) || (left.createdAt - right.createdAt) || left.id.localeCompare(right.id);
}

/** 바깥으로 내보내는 항목 모양 — 내부 필드(bodySha·trashedWith)는 뺀다. */
function publicItem(item) {
  const { bodySha: _bodySha, trashedWith: _trashedWith, ...rest } = item;
  return structuredClone(rest);
}

/** 영역에서 원본 파일로 가는 연결. 저장하지 않고 스냅숏마다 만든다 — id 는 영역 id 에서 정해진다. */
function clipLinkId(clipId) {
  return `l${hashBase32(`clip\u0000${clipId}`, 8)}`;
}

/**
 * 정규화 좌표 [x, y, w, h] 를 소수 넷째 자리로 맞추고 쪽 안에 들어오는지 본다. 비교는 1만분의 1
 * 단위 정수로 해서 부동소수 오차가 없다. 한 단위까지 넘친 것은 크기를 지키고 자리를 당긴다.
 */
function normalizeClipRect(rect, index) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw invalidOp(index, 'rect must be [x, y, w, h] with four finite numbers');
  }
  let [x, y, w, h] = rect.map((value) => Math.round(value * CLIP_UNITS));
  if (x < 0 || y < 0) throw invalidOp(index, 'rect x and y must be at least 0');
  if (w < MIN_CLIP_UNITS || h < MIN_CLIP_UNITS) throw invalidOp(index, 'rect width and height must be at least 0.01');
  if (x + w > CLIP_UNITS + 1 || y + h > CLIP_UNITS + 1) {
    throw invalidOp(index, 'rect must stay inside the page (x + w and y + h at most 1)');
  }
  w = Math.min(w, CLIP_UNITS);
  h = Math.min(h, CLIP_UNITS);
  x = Math.min(x, CLIP_UNITS - w);
  y = Math.min(y, CLIP_UNITS - h);
  return [x, y, w, h].map((value) => value / CLIP_UNITS || 0);
}

function defaultClipTitle(source, page) {
  const extension = path.extname(source.originalName ?? source.title);
  const stripped = extension && source.title.toLowerCase().endsWith(extension.toLowerCase())
    ? source.title.slice(0, -extension.length).trim()
    : source.title;
  const base = stripped || source.title;
  const suffix = source.fileKind === 'pdf' ? ` p.${page} 영역` : ' 영역';
  return `${base.slice(0, MAX_TITLE_CHARS - suffix.length)}${suffix}`;
}

/** 파일을 휴지통에 넣을 때 그 파일의 살아 있는 영역도 함께 넣는다. */
function trashClipsOf(state, fileId, now) {
  for (const clip of state.items) {
    if (clip.kind !== 'clip' || clip.sourceId !== fileId || clip.trashedAt) continue;
    clip.trashedAt = now;
    clip.trashedWith = fileId;
    clip.updatedAt = now;
  }
}

/** 파일과 함께 휴지통에 들어갔던 영역을 꺼낸다. 꺼낸 영역을 돌려준다. */
function restoreClipsOf(state, fileId, now) {
  const restored = [];
  for (const clip of state.items) {
    if (clip.kind !== 'clip' || clip.trashedWith !== fileId) continue;
    delete clip.trashedWith;
    if (!clip.trashedAt) continue;
    delete clip.trashedAt;
    clip.updatedAt = now;
    restored.push(clip);
  }
  return restored;
}

/**
 * 한 배치를 초안 위에 적용하는 연산 집합. 각 연산은 역연산과, 되돌리기 직전에 확인할 필드
 * (그 연산 직후의 값)를 남긴다. 확인 값이 달라졌으면 되돌리기는 그 연산을 건너뛴다.
 */
class OpApplier {
  constructor(store, state, actor, { now, noteBodies }) {
    this.store = store;
    this.state = state;
    this.actor = actor;
    this.now = now;
    this.noteBodies = noteBodies; // Map<noteId, string|null> — 이 배치가 쓰거나 지운 메모 본문
    this.groups = [];
    this.created = {};
    this.unresolvedLinks = new Set();
    this.skipped = [];
    this.applied = 0;
    this.touchedNotes = new Set();
  }

  item(id, index, { allowTrashed = false } = {}) {
    const resolved = resolveItemId(this.state, id);
    const item = this.state.items.find((entry) => entry.id === resolved);
    if (!item) throw projectError('PROJECT_ITEM_NOT_FOUND', `${index === null ? '' : `ops[${index}]: `}item ${String(id)} was not found`);
    if (item.trashedAt && !allowTrashed) throw invalidOp(index, `item ${item.id} is in the trash; restore it first`);
    return item;
  }

  nodeExists(id) {
    const resolved = resolveItemId(this.state, id);
    if (this.state.members.some((member) => member.nodeId === resolved)) return resolved;
    if (this.state.items.some((item) => item.id === resolved && !item.trashedAt)) return resolved;
    return null;
  }

  readPath(pathKey) {
    const [kind, id, field] = pathKey.split(':');
    if (kind === 'columns') return this.state.columns.map((column) => ({ ...column }));
    if (kind === 'goal') return this.state.goal;
    if (kind === 'link') return this.state.links.find((link) => link.id === id) ?? null;
    if (kind === 'graph') return this.state.graph.pinned[id] ?? null;
    const item = this.state.items.find((entry) => entry.id === id);
    if (!item) return null;
    if (field === 'trashed') return Boolean(item.trashedAt);
    if (field === 'body') return item.bodySha ?? null;
    if (field === 'tags') return [...item.tags].sort();
    return item[field] ?? null;
  }

  record(op, inverse, paths) {
    this.groups.push({
      op,
      inverse,
      expect: paths.map((pathKey) => ({ path: pathKey, value: structuredClone(this.readPath(pathKey)) })),
    });
    this.applied += 1;
  }

  lock(item, field) {
    if (item.kind !== 'file' || this.actor.kind === 'librarian') return;
    item.locked = { ...(item.locked ?? {}), [field]: true };
  }

  lockedForLibrarian(item, field) {
    return this.actor.kind === 'librarian' && item.kind === 'file' && item.locked?.[field] === true;
  }

  columnItems(columnId) {
    return this.state.items.filter((item) => item.column === columnId).sort(compareOrder);
  }

  renumber(columnId, ordered = this.columnItems(columnId)) {
    ordered.forEach((item, index) => { item.order = index; });
  }

  placeItem(item, columnId, index = null) {
    const previousColumn = item.column;
    const source = this.columnItems(previousColumn).filter((entry) => entry !== item);
    if (previousColumn !== columnId) this.renumber(previousColumn, source);
    const target = previousColumn === columnId ? source : this.columnItems(columnId).filter((entry) => entry !== item);
    const position = Number.isSafeInteger(index) ? Math.min(Math.max(0, index), target.length) : target.length;
    target.splice(position, 0, item);
    item.column = columnId;
    this.renumber(columnId, target);
  }

  indexInColumn(item) {
    return this.columnItems(item.column).indexOf(item);
  }

  requireColumn(columnId, index) {
    if (!this.state.columns.some((column) => column.id === columnId)) {
      throw invalidOp(index, `column ${String(columnId)} does not exist`);
    }
    return columnId;
  }

  normalizeTags(tags, index) {
    if (!Array.isArray(tags) || tags.length > MAX_TAGS_PER_ITEM) throw invalidOp(index, `tags must be an array of up to ${MAX_TAGS_PER_ITEM}`);
    const clean = [];
    for (const tag of tags) {
      const text = cleanText(tag, MAX_TAG_CHARS);
      if (!text) throw invalidOp(index, `tags must be 1-${MAX_TAG_CHARS} characters`);
      if (!clean.includes(text)) clean.push(text);
    }
    return clean;
  }

  async apply(op, index) {
    if (!isPlainObject(op) || typeof op.op !== 'string') throw invalidOp(index, 'op is required');
    if (this.actor.kind === 'librarian' && !LIBRARIAN_OPS.has(op.op)) {
      throw invalidOp(index, `the librarian cannot run ${op.op}`);
    }
    const handler = this[`op_${op.op.replace('-', '_')}`];
    if (typeof handler !== 'function') throw invalidOp(index, `unknown op ${op.op}`);
    await handler.call(this, op, index);
  }

  skip(index, op, reason) {
    this.skipped.push({ index, op: op.op, reason });
  }

  op_rename(op, index) {
    const item = this.item(op.id, index);
    const name = cleanText(op.name, MAX_TITLE_CHARS);
    if (!name) throw invalidOp(index, `name must be 1-${MAX_TITLE_CHARS} characters`);
    if (this.lockedForLibrarian(item, 'title')) return this.skip(index, op, 'locked');
    if (item.title === name) return undefined;
    const previous = item.title;
    item.title = name;
    item.updatedAt = this.now;
    this.lock(item, 'title');
    return this.record(op, [{ op: 'rename', id: item.id, name: previous }], [`item:${item.id}:title`]);
  }

  op_tag(op, index) {
    const item = this.item(op.id, index);
    const mode = op.mode ?? 'set';
    if (!['set', 'add', 'remove'].includes(mode)) throw invalidOp(index, 'mode must be set, add, or remove');
    const tags = this.normalizeTags(op.tags, index);
    if (this.lockedForLibrarian(item, 'tags')) return this.skip(index, op, 'locked');
    const previous = [...item.tags];
    let next;
    if (mode === 'set') next = tags;
    else if (mode === 'add') next = [...previous, ...tags.filter((tag) => !previous.includes(tag))];
    else next = previous.filter((tag) => !tags.includes(tag));
    if (next.length > MAX_TAGS_PER_ITEM) throw invalidOp(index, `an item can have up to ${MAX_TAGS_PER_ITEM} tags`);
    if (sameJson(previous, next)) return undefined;
    item.tags = next;
    item.updatedAt = this.now;
    this.lock(item, 'tags');
    return this.record(op, [{ op: 'tag', id: item.id, tags: previous, mode: 'set' }], [`item:${item.id}:tags`]);
  }

  op_move(op, index) {
    const item = this.item(op.id, index);
    const column = this.requireColumn(op.column, index);
    if (op.index !== undefined && (!Number.isSafeInteger(op.index) || op.index < 0)) throw invalidOp(index, 'index must be a non-negative integer');
    if (this.lockedForLibrarian(item, 'column')) return this.skip(index, op, 'locked');
    const previousColumn = item.column;
    const previousIndex = this.indexInColumn(item);
    this.placeItem(item, column, op.index ?? null);
    if (previousColumn === column && this.indexInColumn(item) === previousIndex) return undefined;
    item.updatedAt = this.now;
    this.lock(item, 'column');
    return this.record(op, [{ op: 'move', id: item.id, column: previousColumn, index: previousIndex }], [`item:${item.id}:column`]);
  }

  op_pin(op, index) {
    const item = this.item(op.id, index);
    if (typeof op.pinned !== 'boolean') throw invalidOp(index, 'pinned must be a boolean');
    if (item.pinned === op.pinned) return undefined;
    item.pinned = op.pinned;
    item.updatedAt = this.now;
    return this.record(op, [{ op: 'pin', id: item.id, pinned: !op.pinned }], [`item:${item.id}:pinned`]);
  }

  op_link(op, index) {
    const from = this.nodeExists(op.from);
    const to = this.nodeExists(op.to);
    if (!from) throw projectError('PROJECT_ITEM_NOT_FOUND', `ops[${index}]: link source ${String(op.from)} was not found`);
    if (!to) throw projectError('PROJECT_ITEM_NOT_FOUND', `ops[${index}]: link target ${String(op.to)} was not found`);
    if (from === to) throw invalidOp(index, 'a link needs two different ends');
    const label = op.label === undefined || op.label === null ? null : cleanText(op.label, MAX_LINK_LABEL_CHARS);
    if (op.label !== undefined && op.label !== null && !label) throw invalidOp(index, `label must be 1-${MAX_LINK_LABEL_CHARS} characters`);
    for (const key of ['fromAnchor', 'toAnchor']) {
      if (op[key] !== undefined && op[key] !== null && !isProjectAnchor(op[key])) throw invalidOp(index, `${key} must look like c12 or p4`);
    }
    const existing = this.state.links.find((link) => link.origin === 'explicit'
      && link.from === from && link.to === to
      && (link.fromAnchor ?? null) === (op.fromAnchor ?? null)
      && (link.toAnchor ?? null) === (op.toAnchor ?? null)
      && (link.label ?? null) === label);
    if (existing) {
      this.created[index] = existing.id;
      return undefined;
    }
    if (this.state.links.length >= this.store.maxLinks) throw projectError('PROJECT_LIMIT', `a project can have up to ${this.store.maxLinks} links`);
    let id;
    if (op.id !== undefined) {
      if (typeof op.id !== 'string' || !LINK_ID_PATTERN.test(op.id) || this.state.links.some((link) => link.id === op.id)) {
        throw invalidOp(index, 'link id is invalid or already used');
      }
      id = op.id;
    } else {
      id = this.store.newId(this.state, 'l', 8);
    }
    const link = {
      id,
      from,
      to,
      ...(op.fromAnchor ? { fromAnchor: op.fromAnchor } : {}),
      ...(op.toAnchor ? { toAnchor: op.toAnchor } : {}),
      ...(label ? { label } : {}),
      origin: 'explicit',
    };
    this.state.links.push(link);
    this.created[index] = id;
    return this.record(op, [{ op: 'unlink', id }], [`link:${id}`]);
  }

  op_unlink(op, index) {
    const link = this.state.links.find((entry) => entry.id === op.id);
    if (!link && this.state.items.some((item) => item.kind === 'clip' && clipLinkId(item.id) === op.id)) {
      throw invalidOp(index, 'a clip stays linked to its source file; trash the clip instead');
    }
    if (!link) throw projectError('PROJECT_ITEM_NOT_FOUND', `ops[${index}]: link ${String(op.id)} was not found`);
    if (link.origin !== 'explicit') throw invalidOp(index, 'links written in a note change with the note body');
    this.state.links = this.state.links.filter((entry) => entry !== link);
    const { origin: _origin, noteId: _noteId, ...restore } = link;
    return this.record(op, [{ op: 'link', ...restore }], [`link:${link.id}`]);
  }

  async op_note(op, index) {
    if (typeof op.body !== 'string') throw invalidOp(index, 'body is required');
    if (op.body.length > MAX_NOTE_CHARS) throw invalidOp(index, `body must be at most ${MAX_NOTE_CHARS} characters`);
    const mode = op.mode ?? 'replace';
    if (!['replace', 'append'].includes(mode)) throw invalidOp(index, 'mode must be replace or append');
    const name = op.name === undefined ? null : cleanText(op.name, MAX_TITLE_CHARS);
    if (op.name !== undefined && !name) throw invalidOp(index, `name must be 1-${MAX_TITLE_CHARS} characters`);
    const tags = op.tags === undefined ? null : this.normalizeTags(op.tags, index);
    if (op.column !== undefined) this.requireColumn(op.column, index);
    if (op.id === undefined || op.id === null) {
      if (this.state.items.filter((item) => item.kind === 'note').length >= this.store.maxNotes) {
        throw projectError('PROJECT_LIMIT', `a project can have up to ${this.store.maxNotes} notes`);
      }
      const id = this.store.newId(this.state, 'n', 6);
      const body = op.body;
      const item = {
        id,
        kind: 'note',
        title: name ?? noteTitleFrom(body),
        column: this.state.columns[0].id,
        order: 0,
        tags: tags ?? [],
        pinned: false,
        summary: '',
        createdAt: this.now,
        updatedAt: this.now,
        addedBy: this.actor,
        bytes: Buffer.byteLength(body, 'utf8'),
        bodySha: sha1(body),
      };
      this.state.items.push(item);
      this.placeItem(item, op.column ?? this.state.columns[0].id, null);
      this.noteBodies.set(id, body);
      this.touchedNotes.add(id);
      this.created[index] = id;
      return this.record(op, [{ op: 'trash', id }], [`item:${id}:trashed`]);
    }
    const item = this.item(op.id, index);
    if (item.kind !== 'note') throw invalidOp(index, `${item.id} is not a note`);
    const previousBody = await this.store.noteBody(this.state, item.id, this.noteBodies);
    const body = mode === 'append' ? `${previousBody}${previousBody ? '\n\n' : ''}${op.body}` : op.body;
    if (body.length > MAX_NOTE_CHARS) throw invalidOp(index, `the note would exceed ${MAX_NOTE_CHARS} characters`);
    const inverse = { op: 'note', id: item.id, body: previousBody, mode: 'replace' };
    const paths = [`item:${item.id}:body`];
    if (name && name !== item.title) {
      inverse.name = item.title;
      item.title = name;
      paths.push(`item:${item.id}:title`);
    }
    if (tags && !sameJson(tags, item.tags)) {
      inverse.tags = [...item.tags];
      item.tags = tags;
      paths.push(`item:${item.id}:tags`);
    }
    if (op.column !== undefined && op.column !== item.column) {
      inverse.column = item.column;
      this.placeItem(item, op.column, null);
      paths.push(`item:${item.id}:column`);
    }
    if (body === previousBody && paths.length === 1) return undefined;
    item.bytes = Buffer.byteLength(body, 'utf8');
    item.bodySha = sha1(body);
    item.updatedAt = this.now;
    this.noteBodies.set(item.id, body);
    this.touchedNotes.add(item.id);
    return this.record(op, [inverse], paths);
  }

  /** 영역의 원본: 휴지통에 없는 PDF·그림 파일 항목. */
  clipSource(id, index) {
    const source = this.item(id, index);
    if (source.kind !== 'file' || !CLIP_SOURCE_KINDS.has(source.fileKind)) {
      throw invalidOp(index, `${source.id} is not a PDF or image file`);
    }
    return source;
  }

  clipPage(source, page, index) {
    if (source.fileKind === 'image') {
      if (page !== undefined && page !== null && page !== 1) throw invalidOp(index, 'an image clip is always on page 1');
      return 1;
    }
    const maximum = Number.isSafeInteger(source.pageCount) && source.pageCount > 0 ? source.pageCount : MAX_CLIP_PAGE;
    if (!Number.isSafeInteger(page) || page < 1 || page > maximum) throw invalidOp(index, `page must be an integer from 1 to ${maximum}`);
    return page;
  }

  /**
   * 원본 PDF 쪽·그림의 한 영역. id 가 없으면 만들고, 있으면 쪽·영역·이름·열·태그를 바꾼다.
   * 영역은 처음 원본에 묶이며 다른 파일로 옮기지 않는다.
   */
  op_clip(op, index) {
    if (op.id !== undefined && op.id !== null) return this.updateClip(op, index);
    if (op.source === undefined || op.source === null) throw invalidOp(index, 'source is required to create a clip');
    const source = this.clipSource(op.source, index);
    const page = this.clipPage(source, op.page, index);
    const rect = normalizeClipRect(op.rect, index);
    const name = op.name === undefined || op.name === null ? null : cleanText(op.name, MAX_TITLE_CHARS);
    if (op.name !== undefined && op.name !== null && !name) throw invalidOp(index, `name must be 1-${MAX_TITLE_CHARS} characters`);
    const tags = op.tags === undefined ? [] : this.normalizeTags(op.tags, index);
    const column = op.column === undefined ? this.state.columns[0].id : this.requireColumn(op.column, index);
    if (this.state.items.filter((item) => item.kind === 'clip').length >= this.store.maxClips) {
      throw projectError('PROJECT_LIMIT', `a project can have up to ${this.store.maxClips} clips`);
    }
    const id = this.store.newId(this.state, 'r', 6);
    const item = {
      id,
      kind: 'clip',
      title: name ?? defaultClipTitle(source, page),
      column,
      order: 0,
      tags,
      pinned: false,
      summary: '',
      createdAt: this.now,
      updatedAt: this.now,
      addedBy: this.actor,
      sourceId: source.id,
      page,
      rect,
    };
    this.state.items.push(item);
    this.placeItem(item, column, null);
    this.created[index] = id;
    return this.record(op, [{ op: 'trash', id }], [`item:${id}:trashed`]);
  }

  updateClip(op, index) {
    const clip = this.item(op.id, index);
    if (clip.kind !== 'clip') throw invalidOp(index, `${clip.id} is not a clip`);
    if (op.source !== undefined && op.source !== null && resolveItemId(this.state, op.source) !== clip.sourceId) {
      throw invalidOp(index, 'a clip cannot move to another file; create a new clip instead');
    }
    const source = this.clipSource(clip.sourceId, index);
    // 모두 검사한 뒤에 바꾼다 — 되돌리기는 실패한 연산을 건너뛰고 나머지를 저장한다.
    const next = {};
    if (op.page !== undefined) next.page = this.clipPage(source, op.page, index);
    if (op.rect !== undefined) next.rect = normalizeClipRect(op.rect, index);
    if (op.name !== undefined) {
      next.title = cleanText(op.name, MAX_TITLE_CHARS);
      if (!next.title) throw invalidOp(index, `name must be 1-${MAX_TITLE_CHARS} characters`);
    }
    if (op.tags !== undefined) next.tags = this.normalizeTags(op.tags, index);
    if (op.column !== undefined) next.column = this.requireColumn(op.column, index);
    const inverse = { op: 'clip', id: clip.id };
    const paths = [];
    for (const field of ['page', 'rect', 'title', 'tags', 'column']) {
      if (next[field] === undefined || sameJson(next[field], clip[field])) continue;
      inverse[field === 'title' ? 'name' : field] = structuredClone(clip[field]);
      if (field === 'column') this.placeItem(clip, next.column, null);
      else clip[field] = next[field];
      paths.push(`item:${clip.id}:${field}`);
    }
    if (paths.length === 0) return undefined;
    clip.updatedAt = this.now;
    return this.record(op, [inverse], paths);
  }

  /** 카드에 보이는 한두 문장 요약. 잠그는 필드가 아니다. {summary} 또는 {body} 로 받는다. */
  op_summary(op, index) {
    const item = this.item(op.id, index);
    const summary = cleanText(op.summary ?? op.body ?? '', MAX_SUMMARY_CHARS, { allowEmpty: true });
    if (summary === null) throw invalidOp(index, `summary must be at most ${MAX_SUMMARY_CHARS} characters`);
    if (item.summary === summary) return undefined;
    const previous = item.summary;
    item.summary = summary;
    item.updatedAt = this.now;
    return this.record(op, [{ op: 'summary', id: item.id, summary: previous }], [`item:${item.id}:summary`]);
  }

  op_columns(op, index) {
    if (!Array.isArray(op.columns) || op.columns.length < 1 || op.columns.length > MAX_COLUMNS) {
      throw invalidOp(index, `columns must list 1-${MAX_COLUMNS} columns`);
    }
    const previous = this.state.columns.map((column) => ({ ...column }));
    const next = [];
    for (const raw of op.columns) {
      const name = cleanText(raw?.name, MAX_COLUMN_NAME_CHARS);
      if (!name) throw invalidOp(index, `column names must be 1-${MAX_COLUMN_NAME_CHARS} characters`);
      let id = raw?.id;
      if (id === undefined || id === null) {
        do id = `k${randomBase32(6, this.store.random)}`;
        while (next.some((column) => column.id === id) || previous.some((column) => column.id === id));
      } else if (typeof id !== 'string' || !COLUMN_ID_PATTERN.test(id)) {
        throw invalidOp(index, 'column ids are lowercase letters, digits, and dashes');
      }
      if (next.some((column) => column.id === id)) throw invalidOp(index, `column ${id} is listed twice`);
      next.push({ id, name });
    }
    if (sameJson(previous, next)) return undefined;
    const kept = new Set(next.map((column) => column.id));
    const displaced = this.state.items
      .filter((item) => !kept.has(item.column))
      .map((item) => ({ item, column: item.column, index: this.indexInColumn(item) }));
    this.state.columns = next;
    const inverse = [{ op: 'columns', columns: previous }];
    const paths = ['columns'];
    for (const entry of displaced) {
      this.placeItem(entry.item, next[0].id, null);
      inverse.push({ op: 'move', id: entry.item.id, column: entry.column, index: entry.index });
      paths.push(`item:${entry.item.id}:column`);
    }
    return this.record(op, inverse, paths);
  }

  op_goal(op, index) {
    const body = cleanText(op.body ?? '', MAX_GOAL_CHARS, { allowEmpty: true, multiline: true });
    if (body === null) throw invalidOp(index, `goal must be at most ${MAX_GOAL_CHARS} characters`);
    if (this.state.goal === body) return undefined;
    const previous = this.state.goal;
    this.state.goal = body;
    return this.record(op, [{ op: 'goal', body: previous }], ['goal']);
  }

  /** 파일을 넣으면 그 파일의 영역도 함께 들어가고, 파일을 꺼낼 때 같이 나온다. */
  op_trash(op, index) {
    const item = this.item(op.id, index, { allowTrashed: true });
    if (item.trashedAt) return undefined;
    item.trashedAt = this.now;
    item.updatedAt = this.now;
    if (item.kind === 'file') trashClipsOf(this.state, item.id, this.now);
    return this.record(op, [{ op: 'restore', id: item.id }], [`item:${item.id}:trashed`]);
  }

  op_restore(op, index) {
    const item = this.item(op.id, index, { allowTrashed: true });
    if (!item.trashedAt) return undefined;
    if (item.kind === 'clip') {
      const source = this.state.items.find((entry) => entry.id === item.sourceId);
      if (!source || source.trashedAt) {
        throw invalidOp(index, `${item.id} comes from ${item.sourceId}, which is in the trash; restore its source first`);
      }
    }
    delete item.trashedAt;
    delete item.trashedWith;
    item.updatedAt = this.now;
    const restored = item.kind === 'file' ? [item, ...restoreClipsOf(this.state, item.id, this.now)] : [item];
    for (const entry of restored) {
      if (!this.state.columns.some((column) => column.id === entry.column)) this.placeItem(entry, this.state.columns[0].id, null);
    }
    return this.record(op, [{ op: 'trash', id: item.id }], [`item:${item.id}:trashed`]);
  }

  op_graph_pin(op, index) {
    const id = this.nodeExists(op.id);
    if (!id) throw projectError('PROJECT_ITEM_NOT_FOUND', `ops[${index}]: ${String(op.id)} was not found`);
    for (const key of ['x', 'y']) {
      if (typeof op[key] !== 'number' || !Number.isFinite(op[key]) || Math.abs(op[key]) > MAX_GRAPH_COORDINATE) {
        throw invalidOp(index, `${key} must be a finite coordinate`);
      }
    }
    const previous = this.state.graph.pinned[id] ?? null;
    const next = [Math.round(op.x * 10) / 10, Math.round(op.y * 10) / 10];
    if (sameJson(previous, next)) return undefined;
    this.state.graph.pinned[id] = next;
    const inverse = previous ? { op: 'graph-pin', id, x: previous[0], y: previous[1] } : { op: 'graph-unpin', id };
    return this.record(op, [inverse], [`graph:${id}`]);
  }

  op_graph_unpin(op, index) {
    const id = resolveItemId(this.state, op.id);
    const previous = this.state.graph.pinned[id];
    if (!previous) return undefined;
    delete this.state.graph.pinned[id];
    return this.record(op, [{ op: 'graph-pin', id, x: previous[0], y: previous[1] }], [`graph:${id}`]);
  }
}

function resolveItemId(state, id) {
  let resolved = typeof id === 'string' ? id : '';
  for (let depth = 0; depth < 8 && state.aliases?.[resolved]; depth += 1) resolved = state.aliases[resolved];
  return resolved;
}

function summarizeOps(ops, state) {
  if (ops.length === 1) {
    const op = ops[0];
    const label = OP_LABELS[op.op] ?? op.op;
    const target = typeof op.id === 'string' ? state.items.find((item) => item.id === op.id)?.title : null;
    return target ? `${label}: ${target}`.slice(0, 120) : label;
  }
  const counts = new Map();
  for (const op of ops) {
    const label = OP_LABELS[op.op] ?? op.op;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(' · ');
}

function validateProjectState(raw, projectId) {
  if (!isPlainObject(raw) || raw.schemaVersion !== PROJECT_SCHEMA_VERSION || raw.id !== projectId
    || !Array.isArray(raw.columns) || raw.columns.length < 1 || !Array.isArray(raw.items) || !Array.isArray(raw.links)
    || !Array.isArray(raw.members)) {
    throw projectError('PROJECT_STORE_CORRUPT', `project ${projectId} has an invalid schema`);
  }
  for (const item of raw.items) {
    if (!isPlainObject(item) || !ITEM_ID_PATTERN.test(item.id) || !ITEM_KINDS.has(item.kind)) {
      throw projectError('PROJECT_STORE_CORRUPT', `project ${projectId} has an invalid item`);
    }
    // 허브가 멈춘 사이 진행 중이던 정리는 다시 대기열로 돌린다.
    if (item.kind === 'file' && item.librarian?.status === 'running') item.librarian = { status: 'queued' };
  }
  return {
    ...raw,
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    graph: { pinned: isPlainObject(raw.graph?.pinned) ? raw.graph.pinned : {} },
    aliases: isPlainObject(raw.aliases) ? raw.aliases : {},
    activitySeq: Number.isSafeInteger(raw.activitySeq) ? raw.activitySeq : 0,
    revision: Number.isSafeInteger(raw.revision) ? raw.revision : 0,
  };
}

export class ProjectStore {
  /**
   * @param {{
   *   root?: string, referenceStore: any, settings?: () => any, now?: () => number,
   *   random?: (size: number) => Buffer, platform?: string, logger?: (line: string) => void,
   *   maxFileItems?: number, maxNotes?: number, maxClips?: number, maxLinks?: number,
   * }} options
   */
  constructor({
    root = defaultProjectsRoot(),
    referenceStore,
    settings = () => DEFAULT_PROJECT_SETTINGS,
    now = () => Date.now(),
    random = crypto.randomBytes,
    platform = process.platform,
    logger = null,
    maxFileItems = DEFAULT_MAX_PROJECT_FILE_ITEMS,
    maxNotes = DEFAULT_MAX_PROJECT_NOTES,
    maxClips = DEFAULT_MAX_PROJECT_CLIPS,
    maxLinks = DEFAULT_MAX_PROJECT_LINKS,
  } = {}) {
    if (!referenceStore) throw new Error('ProjectStore requires referenceStore');
    this.root = path.resolve(root);
    this.indexPath = path.join(this.root, 'index.json');
    this.referenceStore = referenceStore;
    this.settings = settings;
    this.now = now;
    this.random = random;
    this.platform = platform;
    this.logger = logger;
    this.maxFileItems = maxFileItems;
    this.maxNotes = maxNotes;
    this.maxClips = maxClips;
    this.maxLinks = maxLinks;
    this.index = { schemaVersion: INDEX_SCHEMA_VERSION, projects: {}, documentProjects: {}, threadProjects: {}, deletedProjects: {} };
    this.projects = new Map();
    this.queues = new Map();
    this.indexQueue = Promise.resolve();
    this.changeListeners = new Set();
    this.itemsAddedListeners = new Set();
    this.librarianStatusProvider = null;
    this.noteSearchCache = new Map();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw projectError('PROJECT_PATH_UNSAFE', `Project path is not a plain directory: ${this.root}`);
    }
    try {
      const raw = JSON.parse(await readBoundedText(this.indexPath, MAX_INDEX_JSON_BYTES));
      if (!isPlainObject(raw) || raw.schemaVersion !== INDEX_SCHEMA_VERSION) throw new Error('unsupported index schema');
      this.index = {
        schemaVersion: INDEX_SCHEMA_VERSION,
        projects: isPlainObject(raw.projects) ? raw.projects : {},
        documentProjects: isPlainObject(raw.documentProjects) ? raw.documentProjects : {},
        threadProjects: isPlainObject(raw.threadProjects) ? raw.threadProjects : {},
        deletedProjects: isPlainObject(raw.deletedProjects) ? raw.deletedProjects : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // 색인이 깨져도 허브는 뜬다 — 원본을 옆에 남기고 프로젝트 폴더에서 다시 만든다.
        this.logger?.(`project index unreadable, rebuilding: ${error?.message ?? error}`);
        await fs.rename(this.indexPath, `${this.indexPath}.corrupt-${this.now()}`).catch(() => undefined);
      }
      await this.#rebuildIndexFromDisk();
      await this.#writeIndex();
    }
    return this;
  }

  async #rebuildIndexFromDisk() {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
      try {
        const raw = JSON.parse(await readBoundedText(path.join(this.root, entry.name, 'project.json'), MAX_PROJECT_JSON_BYTES));
        const state = validateProjectState(raw, entry.name);
        this.index.projects[state.id] = { id: state.id, implicit: state.implicit === true, createdAt: state.createdAt };
        for (const member of state.members) {
          if (typeof member?.documentId === 'string') this.index.documentProjects[member.documentId] = state.id;
        }
      } catch (error) {
        this.logger?.(`project ${entry.name} skipped while rebuilding the index: ${error?.message ?? error}`);
      }
    }
  }

  // ─── 이벤트 ───────────────────────────────────────────────

  onChange(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onItemsAdded(listener) {
    this.itemsAddedListeners.add(listener);
    return () => this.itemsAddedListeners.delete(listener);
  }

  /** 정리 도우미 상태를 스냅숏에 싣는다 — (projectId) => {state, queued, running}. */
  setLibrarianStatusProvider(provider) {
    this.librarianStatusProvider = typeof provider === 'function' ? provider : null;
  }

  #emitChange(projectId, details) {
    for (const listener of this.changeListeners) {
      try { listener(projectId, details); } catch (error) { this.logger?.(`project change listener failed: ${error?.message ?? error}`); }
    }
  }

  #emitItemsAdded(projectId, itemIds) {
    if (itemIds.length === 0) return;
    for (const listener of this.itemsAddedListeners) {
      try { listener(projectId, [...itemIds]); } catch (error) { this.logger?.(`project add listener failed: ${error?.message ?? error}`); }
    }
  }

  // ─── 잠금·적재 ────────────────────────────────────────────

  /** 프로젝트마다 쓰기는 한 번에 하나만 진행된다. */
  #withProject(projectId, task) {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(() => task(), () => task());
    const tail = run.catch(() => undefined);
    this.queues.set(projectId, tail);
    void tail.then(() => {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    });
    return run;
  }

  #withIndex(task) {
    const run = this.indexQueue.then(() => task(), () => task());
    this.indexQueue = run.catch(() => undefined);
    return run;
  }

  #projectDir(projectId) {
    if (!PROJECT_ID_PATTERN.test(String(projectId ?? ''))) throw projectError('PROJECT_NOT_FOUND', 'Project id is invalid');
    return path.join(this.root, projectId);
  }

  #notePath(projectId, noteId) {
    if (!/^n[a-z2-7]{6}$/.test(noteId)) throw projectError('PROJECT_ITEM_NOT_FOUND', 'Note id is invalid');
    return path.join(this.#projectDir(projectId), 'notes', `${noteId}.md`);
  }

  hasProject(projectId) {
    return typeof projectId === 'string' && Boolean(this.index.projects[projectId]);
  }

  projectIdForDocument(documentId) {
    const projectId = typeof documentId === 'string' ? this.index.documentProjects[documentId] : null;
    return projectId && this.index.projects[projectId] ? projectId : null;
  }

  async #load(projectId) {
    const cached = this.projects.get(projectId);
    if (cached) return cached;
    if (!this.hasProject(projectId)) throw projectError('PROJECT_NOT_FOUND', `Project ${String(projectId)} was not found`);
    const file = path.join(this.#projectDir(projectId), 'project.json');
    let state;
    try {
      state = validateProjectState(JSON.parse(await readBoundedText(file, MAX_PROJECT_JSON_BYTES)), projectId);
    } catch (error) {
      if (error?.code === 'ENOENT') throw projectError('PROJECT_NOT_FOUND', `Project ${projectId} has no data`);
      if (error instanceof ProjectStoreError) throw error;
      throw projectError('PROJECT_STORE_CORRUPT', `Could not read project ${projectId}: ${error?.message ?? error}`);
    }
    const activityCount = await this.#countActivity(projectId);
    state.activityCount = activityCount;
    this.projects.set(projectId, state);
    return state;
  }

  async #countActivity(projectId) {
    try {
      const text = await fs.readFile(path.join(this.#projectDir(projectId), 'activity.jsonl'), 'utf8');
      return text.split('\n').filter(Boolean).length;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async #writeIndex() {
    await writeFileAtomically(this.indexPath, `${JSON.stringify(this.index)}\n`, this.platform);
  }

  async #writeProject(state) {
    const { activityCount: _activityCount, ...persisted } = state;
    const serialized = `${JSON.stringify(persisted)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_JSON_BYTES) {
      throw projectError('PROJECT_LIMIT', 'Project metadata is too large');
    }
    await writeFileAtomically(path.join(this.#projectDir(state.id), 'project.json'), serialized, this.platform);
  }

  /**
   * 되돌리기 대상이 아닌 메타데이터 변경(구성원·이름·정리 상태). 사본을 고쳐 저장한 뒤에만
   * 메모리 상태를 바꾼다. mutate 가 false 를 돌려주면 아무것도 쓰지 않는다. 프로젝트 잠금 안에서 부른다.
   */
  async #mutateLocked(projectId, reason, mutate) {
    const state = await this.#load(projectId);
    const draft = structuredClone(state);
    const outcome = await mutate(draft);
    if (outcome === false) return { state, changed: false };
    draft.revision = state.revision + 1;
    draft.updatedAt = this.now();
    await this.#writeProject(draft);
    this.projects.set(projectId, draft);
    this.#emitChange(projectId, { revision: draft.revision, reason });
    return { state: draft, changed: true, outcome };
  }

  newId(state, prefix, length) {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = `${prefix}${randomBase32(length, this.random)}`;
      const used = prefix === 'l'
        ? state.links.some((link) => link.id === id)
        : state.items.some((item) => item.id === id)
          || state.members.some((member) => member.nodeId === id)
          || Boolean(state.aliases?.[id]);
      if (!used) return id;
    }
    throw projectError('PROJECT_ID_CONFLICT', 'Could not allocate a unique project id');
  }

  #newProjectId() {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = `p${randomBase32(10, this.random)}`;
      if (!this.index.projects[id]) return id;
    }
    throw projectError('PROJECT_ID_CONFLICT', 'Could not allocate a unique project id');
  }

  #defaultColumns() {
    const names = this.settings()?.board?.defaultColumns ?? DEFAULT_PROJECT_SETTINGS.board.defaultColumns;
    const columns = names.map((name, index) => ({
      id: DEFAULT_COLUMN_IDS[index] ?? `k${randomBase32(6, this.random)}`,
      name,
    }));
    return columns.length > 0 ? columns : DEFAULT_PROJECT_SETTINGS.board.defaultColumns.map((name, index) => ({ id: DEFAULT_COLUMN_IDS[index], name }));
  }

  /** 새 프로젝트를 디스크와 색인에 만든다 (색인 잠금 안에서 부른다). */
  async #createProjectLocked({ id = this.#newProjectId(), name, implicit, nameSource, members = [] }) {
    const createdAt = this.now();
    const state = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id,
      name,
      nameSource,
      goal: '',
      implicit,
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      columns: this.#defaultColumns(),
      members: members.map((member) => ({ ...member, nodeId: documentNodeId(id, member.documentId) })),
      items: [],
      links: [],
      graph: { pinned: {} },
      aliases: {},
      activitySeq: 0,
      activityCount: 0,
    };
    await fs.mkdir(path.join(this.#projectDir(id), 'notes'), { recursive: true, mode: 0o700 });
    await this.#writeProject(state);
    this.projects.set(id, state);
    this.index.projects[id] = { id, implicit, createdAt };
    return state;
  }

  // ─── 문서·스레드 대응 ─────────────────────────────────────

  /**
   * 문서가 속한 프로젝트. 없으면 그 문서만의 암묵 프로젝트를 만든다. 문서 이름이 오면
   * 구성원 이름과(사용자가 이름을 바꾸지 않은) 암묵 프로젝트 이름을 맞춘다.
   */
  async projectForDocument(documentId, { name = null } = {}) {
    if (typeof documentId !== 'string' || !documentId) throw projectError('PROJECT_OP_INVALID', 'documentId is required');
    const displayName = cleanText(name ?? '', MAX_PROJECT_NAME_CHARS);
    const projectId = await this.#withIndex(async () => {
      const existing = this.projectIdForDocument(documentId);
      if (existing) return existing;
      const state = await this.#createProjectLocked({
        name: displayName ? displayName.replace(/\.(hwpx?|hml)$/i, '') : '문서 자료',
        implicit: true,
        nameSource: displayName ? 'document' : 'default',
        members: [{ documentId, name: displayName ?? '' }],
      });
      this.index.documentProjects[documentId] = state.id;
      await this.#writeIndex();
      return state.id;
    });
    if (displayName) await this.#syncDocumentName(projectId, documentId, displayName);
    return projectId;
  }

  async #syncDocumentName(projectId, documentId, displayName) {
    await this.#withProject(projectId, () => this.#mutateLocked(projectId, 'members', (state) => {
      const member = state.members.find((entry) => entry.documentId === documentId);
      let changed = false;
      if (member && member.name !== displayName) {
        member.name = displayName;
        changed = true;
      }
      const projectName = displayName.replace(/\.(hwpx?|hml)$/i, '');
      if (state.implicit && state.nameSource !== 'user' && state.name !== projectName && state.members.length === 1) {
        state.name = projectName;
        state.nameSource = 'document';
        changed = true;
      }
      return changed;
    }));
  }

  /** 문서 없는 채팅의 암묵 프로젝트. */
  async projectForThread(threadId) {
    if (typeof threadId !== 'string' || !threadId) throw projectError('PROJECT_OP_INVALID', 'threadId is required');
    return this.#withIndex(async () => {
      const existing = this.index.threadProjects[threadId];
      if (existing && this.index.projects[existing]) return existing;
      const state = await this.#createProjectLocked({ name: '채팅 자료', implicit: true, nameSource: 'default' });
      this.index.threadProjects[threadId] = state.id;
      await this.#writeIndex();
      return state.id;
    });
  }

  /** 채팅 시작 때 세션이 묶일 프로젝트: 문서 → 문서 프로젝트, 아니면 스레드 암묵 프로젝트. */
  async bindSession({ threadId = null, documentId = null, documentName = null } = {}) {
    if (typeof documentId === 'string' && documentId) return this.projectForDocument(documentId, { name: documentName });
    return this.projectForThread(threadId);
  }

  // ─── 읽기 ─────────────────────────────────────────────────

  #librarianSummary(state) {
    const provided = this.librarianStatusProvider?.(state.id);
    if (provided && typeof provided === 'object') {
      return {
        state: ['idle', 'running', 'paused'].includes(provided.state) ? provided.state : 'idle',
        queued: Number.isSafeInteger(provided.queued) ? provided.queued : 0,
        running: Number.isSafeInteger(provided.running) ? provided.running : 0,
      };
    }
    let queued = 0;
    let running = 0;
    for (const item of state.items) {
      if (item.kind !== 'file' || item.trashedAt) continue;
      if (item.librarian?.status === 'queued') queued += 1;
      if (item.librarian?.status === 'running') running += 1;
    }
    return { state: running > 0 ? 'running' : 'idle', queued, running };
  }

  #usage(state) {
    let files = 0;
    let bytes = 0;
    for (const item of state.items) {
      if (item.kind !== 'file') continue;
      files += 1;
      bytes += item.size ?? 0;
    }
    return { files, bytes };
  }

  #snapshot(state, { trash = false } = {}) {
    const visible = trash ? state.items : state.items.filter((item) => !item.trashedAt);
    const visibleIds = new Set([...visible.map((item) => item.id), ...state.members.map((member) => member.nodeId)]);
    const used = new Set();
    for (const item of visible) for (const tag of item.tags) used.add(tag);
    const clipLinks = visible
      .filter((item) => item.kind === 'clip' && visibleIds.has(item.sourceId))
      .map((clip) => ({ id: clipLinkId(clip.id), from: clip.id, to: clip.sourceId, origin: 'clip' }));
    return {
      id: state.id,
      name: state.name,
      goal: state.goal,
      implicit: state.implicit,
      revision: state.revision,
      columns: state.columns.map((column) => ({ ...column })),
      tags: [...used].sort((a, b) => a.localeCompare(b, 'ko')).map((name) => ({ name, color: tagColor(name) })),
      members: state.members.map((member) => ({ ...member })),
      items: visible.slice().sort(compareOrder).map(publicItem),
      links: [
        ...state.links.filter((link) => visibleIds.has(link.from) && visibleIds.has(link.to)).map((link) => ({ ...link })),
        ...clipLinks,
      ],
      graph: { pinned: structuredClone(state.graph.pinned) },
      librarian: this.#librarianSummary(state),
      usage: this.#usage(state),
    };
  }

  async get(projectId, { trash = false } = {}) {
    const state = await this.#load(projectId);
    return this.#snapshot(state, { trash });
  }

  async list() {
    const projects = [];
    for (const projectId of Object.keys(this.index.projects)) {
      try {
        const state = await this.#load(projectId);
        projects.push({
          id: state.id,
          name: state.name,
          implicit: state.implicit,
          members: state.members.map((member) => ({ ...member })),
          usage: this.#usage(state),
          updatedAt: state.updatedAt,
        });
      } catch (error) {
        this.logger?.(`project ${projectId} unreadable: ${error?.message ?? error}`);
      }
    }
    return projects.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async revision(projectId) {
    return (await this.#load(projectId)).revision;
  }

  async getItem(projectId, itemId) {
    const state = await this.#load(projectId);
    const resolved = resolveItemId(state, itemId);
    const item = state.items.find((entry) => entry.id === resolved);
    if (!item) throw projectError('PROJECT_ITEM_NOT_FOUND', `Item ${String(itemId)} was not found`);
    return publicItem(item);
  }

  /** fileId(또는 이주로 합쳐진 옛 fileId) 를 가리키는 항목. 없으면 null. */
  async itemForFile(projectId, fileId) {
    const state = await this.#load(projectId);
    const resolvedFile = this.referenceStore.getFile?.(fileId)?.id ?? fileId;
    const item = state.items.find((entry) => entry.kind === 'file' && (entry.fileId === fileId || entry.fileId === resolvedFile));
    return item ? publicItem(item) : null;
  }

  async noteBody(state, noteId, pending = null) {
    if (pending?.has(noteId)) return pending.get(noteId) ?? '';
    try {
      return await readBoundedText(this.#notePath(state.id, noteId), MAX_NOTE_CHARS * 4 + 1024);
    } catch (error) {
      if (error?.code === 'ENOENT') return '';
      throw error;
    }
  }

  async readNote(projectId, noteId) {
    const state = await this.#load(projectId);
    const resolved = resolveItemId(state, noteId);
    const item = state.items.find((entry) => entry.id === resolved && entry.kind === 'note');
    if (!item) throw projectError('PROJECT_ITEM_NOT_FOUND', `Note ${String(noteId)} was not found`);
    return { id: item.id, title: item.title, body: await this.noteBody(state, item.id) };
  }

  async itemsNeedingLibrarian(projectId) {
    const state = await this.#load(projectId);
    return state.items
      .filter((item) => item.kind === 'file' && !item.trashedAt && item.librarian?.status === 'queued')
      .sort(compareOrder)
      .map(publicItem);
  }

  async #readActivityLines(projectId) {
    const dir = this.#projectDir(projectId);
    const entries = [];
    for (const name of ['activity.1.jsonl', 'activity.jsonl']) {
      let text;
      try {
        text = await fs.readFile(path.join(dir, name), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }
    return entries;
  }

  /** 최신 순. before 는 활동 id — 그보다 오래된 항목만. */
  async listActivity(projectId, { limit = 50, before = null } = {}) {
    await this.#load(projectId);
    const entries = (await this.#readActivityLines(projectId)).sort((left, right) => right.seq - left.seq);
    let start = 0;
    if (before) {
      const index = entries.findIndex((entry) => entry.id === before);
      start = index < 0 ? entries.length : index + 1;
    }
    const bounded = Math.min(200, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
    return entries.slice(start, start + bounded);
  }

  /** 메모 검색 — 제목·본문 토큰이 겹치는 정도로 순위를 매기고 짧은 발췌를 붙인다. */
  async searchNotes(projectId, query, limit = 3) {
    const state = await this.#load(projectId);
    const queryTokens = [...new Set(tokenizeReferenceText(query))];
    if (queryTokens.length === 0) return [];
    const hits = [];
    for (const item of state.items) {
      if (item.kind !== 'note' || item.trashedAt) continue;
      const cacheKey = `${state.id}:${item.id}`;
      let cached = this.noteSearchCache.get(cacheKey);
      if (!cached || cached.sha !== item.bodySha || cached.title !== item.title) {
        const body = await this.noteBody(state, item.id);
        cached = {
          sha: item.bodySha,
          title: item.title,
          body,
          tokens: new Set(tokenizeReferenceText(`${item.title}\n${body}`)),
          titleTokens: new Set(tokenizeReferenceText(item.title)),
        };
        this.noteSearchCache.set(cacheKey, cached);
      }
      let score = 0;
      for (const token of queryTokens) {
        if (cached.tokens.has(token)) score += 1;
        if (cached.titleTokens.has(token)) score += 0.5;
      }
      if (score <= 0) continue;
      hits.push({ item, score, body: cached.body });
    }
    hits.sort((left, right) => right.score - left.score);
    const needle = String(query).trim().split(/\s+/)[0]?.toLocaleLowerCase('ko-KR') ?? '';
    return hits.slice(0, Math.max(1, Math.min(10, limit))).map(({ item, score, body }) => {
      const position = needle ? body.toLocaleLowerCase('ko-KR').indexOf(needle) : -1;
      const start = Math.max(0, position < 0 ? 0 : position - 80);
      return {
        itemId: item.id,
        title: item.title,
        score: Number((score / queryTokens.length).toFixed(4)),
        text: body.slice(start, start + 400),
      };
    });
  }

  // ─── 쓰기 ─────────────────────────────────────────────────

  async #appendActivity(state, entry) {
    const dir = this.#projectDir(state.id);
    const file = path.join(dir, 'activity.jsonl');
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
      state.activityCount = (state.activityCount ?? 0) + 1;
      const info = await fs.stat(file);
      if (state.activityCount >= ACTIVITY_ROTATE_ENTRIES || info.size >= ACTIVITY_ROTATE_BYTES) {
        await fs.rename(file, path.join(dir, 'activity.1.jsonl'));
        state.activityCount = 0;
      }
    } catch (error) {
      // 활동 기록은 되돌리기 보조 자료다 — 쓰지 못해도 이미 저장된 변경은 유지한다.
      this.logger?.(`project activity append failed: ${error?.message ?? error}`);
    }
  }

  #activityEntry(state, actor, summary, groups, extra = {}) {
    state.activitySeq += 1;
    return {
      id: `a${randomBase32(12, this.random)}`,
      seq: state.activitySeq,
      at: this.now(),
      actor,
      summary,
      ops: groups.map((group) => group.op),
      inverse: groups.map((group) => ({ ops: group.inverse, expect: group.expect })),
      ...extra,
    };
  }

  /** 메모 본문에서 [[…]] 를 읽어 origin:'note' 연결을 다시 만든다. 못 찾은 id 는 돌려준다. */
  #regenerateNoteLinks(state, noteId, body) {
    const unresolved = new Set();
    state.links = state.links.filter((link) => !(link.origin === 'note' && link.noteId === noteId));
    if (body === null) return unresolved;
    const seen = new Set();
    for (const parsed of parseWikilinks(body)) {
      const target = resolveItemId(state, parsed.id);
      const exists = target !== noteId && (
        state.members.some((member) => member.nodeId === target)
        || state.items.some((item) => item.id === target)
      );
      if (!exists) {
        if (target !== noteId) unresolved.add(parsed.id);
        continue;
      }
      const anchor = formatWikilinkAnchor(parsed.anchor);
      const key = `${target}#${anchor ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (state.links.length >= this.maxLinks) break;
      state.links.push({
        id: this.newId(state, 'l', 8),
        from: noteId,
        to: target,
        ...(anchor ? { toAnchor: anchor } : {}),
        origin: 'note',
        noteId,
      });
    }
    return unresolved;
  }

  /**
   * 초안에 배치를 적용하고, 성공하면 메모 → project.json → 활동 기록 순으로 저장한다.
   * 어느 연산이든 실패하면 아무것도 바뀌지 않는다.
   */
  async #commitBatch(projectId, { ops, actor, expectedRevision, extraEntry = {}, summaryPrefix = '', precheck = null }) {
    const state = await this.#load(projectId);
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== state.revision) {
      throw projectError('PROJECT_REVISION_MISMATCH', `Project revision is ${state.revision}, not ${expectedRevision}`, { revision: state.revision });
    }
    const draft = structuredClone(state);
    const noteBodies = new Map();
    const applier = new OpApplier(this, draft, actor, { now: this.now(), noteBodies });
    if (precheck) await precheck(applier);
    else {
      for (let index = 0; index < ops.length; index += 1) await applier.apply(ops[index], index);
    }
    const unresolved = new Set();
    for (const noteId of applier.touchedNotes) {
      for (const id of this.#regenerateNoteLinks(draft, noteId, noteBodies.get(noteId))) unresolved.add(id);
    }
    const result = {
      revision: state.revision,
      applied: applier.applied,
      created: applier.created,
      unresolvedLinks: [...unresolved],
      ...(applier.skipped.length > 0 ? { skipped: applier.skipped } : {}),
    };
    if (applier.applied === 0) return { result, entry: null };
    draft.revision = state.revision + 1;
    draft.updatedAt = this.now();
    const entry = this.#activityEntry(
      draft,
      actor,
      `${summaryPrefix}${summarizeOps(applier.groups.map((group) => group.op), draft)}`.slice(0, 160),
      applier.groups,
      extraEntry,
    );
    // 메모 본문을 먼저 쓴다. project.json 저장이 실패하면 이전 본문으로 되돌린다.
    const restore = [];
    try {
      for (const [noteId, body] of noteBodies) {
        const file = this.#notePath(projectId, noteId);
        const previous = await fs.readFile(file, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
        restore.push({ file, previous });
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFileAtomically(file, body ?? '', this.platform);
      }
      await this.#writeProject(draft);
    } catch (error) {
      for (const { file, previous } of restore.reverse()) {
        if (previous === null) await fs.unlink(file).catch(() => undefined);
        else await writeFileAtomically(file, previous, this.platform).catch(() => undefined);
      }
      throw error;
    }
    this.projects.set(projectId, draft);
    await this.#appendActivity(draft, entry);
    result.revision = draft.revision;
    result.activityId = entry.id;
    this.#emitChange(projectId, { revision: draft.revision, reason: 'ops', actor });
    return { result, entry };
  }

  /**
   * 원자 배치 편집 (MCP project_edit 와 HTTP POST /projects/:pid/ops 가 함께 쓴다).
   * @returns {Promise<{revision: number, applied: number, created: Record<number,string>, unresolvedLinks: string[], skipped?: object[], activityId?: string}>}
   */
  async applyOps(projectId, { ops, actor, expectedRevision } = {}) {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_OPS) {
      throw projectError('PROJECT_OP_INVALID', `ops must list 1-${MAX_OPS} operations`);
    }
    const normalizedActor = normalizeActor(actor);
    return this.#withProject(projectId, async () => {
      const { result } = await this.#commitBatch(projectId, { ops, actor: normalizedActor, expectedRevision });
      return result;
    });
  }

  /**
   * 활동 하나를 되돌린다. 역연산은 새 활동으로 쌓이며, 그 뒤에 값이 바뀐 연산은 건너뛰고 알린다.
   */
  async undo(projectId, { activityId, actor = { kind: 'user' } } = {}) {
    if (typeof activityId !== 'string' || !ACTIVITY_ID_PATTERN.test(activityId)) {
      throw projectError('PROJECT_OP_INVALID', 'activityId is invalid');
    }
    const normalizedActor = normalizeActor(actor);
    return this.#withProject(projectId, async () => {
      await this.#load(projectId);
      const entries = await this.#readActivityLines(projectId);
      const target = entries.find((entry) => entry.id === activityId);
      if (!target) throw projectError('PROJECT_ITEM_NOT_FOUND', `Activity ${activityId} was not found`);
      const groups = Array.isArray(target.inverse) ? target.inverse : [];
      const skipped = [];
      const { result } = await this.#commitBatch(projectId, {
        actor: normalizedActor,
        summaryPrefix: '되돌리기: ',
        extraEntry: { undoOf: activityId },
        precheck: async (applier) => {
          for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
            const group = groups[groupIndex];
            const changed = (group.expect ?? []).some((check) => !sameJson(applier.readPath(check.path), check.value));
            if (changed) {
              skipped.push({ index: groupIndex, op: target.ops?.[groupIndex]?.op ?? null, reason: 'changed' });
              continue;
            }
            for (const op of group.ops ?? []) {
              try {
                await applier.apply(op, null);
              } catch (error) {
                skipped.push({ index: groupIndex, op: op.op, reason: error?.code === 'PROJECT_ITEM_NOT_FOUND' ? 'missing' : 'invalid' });
              }
            }
          }
        },
      });
      return { ...result, skipped: [...skipped, ...(result.skipped ?? [])] };
    });
  }

  /**
   * 참고 자료 저장소에 이미 들어간 파일을 항목으로 올린다. 같은 fileId 의 항목이 있으면
   * (휴지통에 있으면 꺼내서) 그 항목을 돌려준다.
   * @returns {Promise<object>} 항목 스냅숏
   */
  async addFileItem(projectId, entry) {
    const [item] = await this.addFileItems(projectId, [entry]);
    return item;
  }

  async addFileItems(projectId, entries, { summary = null } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return this.#withProject(projectId, async () => {
      const state = await this.#load(projectId);
      const draft = structuredClone(state);
      const now = this.now();
      const librarianEnabled = this.settings()?.librarian?.enabled !== false;
      const results = [];
      const groups = [];
      const added = [];
      for (const raw of entries) {
        const scope = raw?.scope === 'global' ? 'global' : 'project';
        const file = this.referenceStore.getFile(raw?.fileId);
        if (!file || file.scope !== scope || (scope === 'project' && file.scopeId !== projectId)) {
          throw projectError('PROJECT_ITEM_NOT_FOUND', `Reference file ${String(raw?.fileId)} is not stored in this project`);
        }
        const existing = draft.items.find((item) => item.kind === 'file' && item.fileId === file.id);
        if (existing) {
          if (existing.trashedAt) {
            delete existing.trashedAt;
            existing.updatedAt = now;
            restoreClipsOf(draft, existing.id, now);
            groups.push({
              op: { op: 'restore', id: existing.id },
              inverse: [{ op: 'trash', id: existing.id }],
              expect: [{ path: `item:${existing.id}:trashed`, value: false }],
            });
          }
          results.push(existing);
          continue;
        }
        if (draft.items.filter((item) => item.kind === 'file').length >= this.maxFileItems) {
          throw projectError('PROJECT_LIMIT', `a project can have up to ${this.maxFileItems} files`);
        }
        const sourceKind = SOURCE_KINDS.has(raw?.source?.kind) ? raw.source.kind : 'upload';
        const source = { kind: sourceKind };
        for (const key of ['url', 'finalUrl', 'homePath', 'threadId']) {
          if (typeof raw?.source?.[key] === 'string' && raw.source[key]) source[key] = raw.source[key].slice(0, 2_000);
        }
        const column = typeof raw?.column === 'string' && draft.columns.some((entry) => entry.id === raw.column)
          ? raw.column
          : draft.columns[0].id;
        const tags = Array.isArray(raw?.tags)
          ? [...new Set(raw.tags.map((tag) => cleanText(tag, MAX_TAG_CHARS)).filter(Boolean))].slice(0, MAX_TAGS_PER_ITEM)
          : [];
        const addedBy = (() => {
          try { return normalizeActor(raw?.addedBy ?? { kind: 'user' }); } catch { return { kind: 'user' }; }
        })();
        const librarianStatus = LIBRARIAN_STATUSES.has(raw?.librarian)
          ? raw.librarian
          : (librarianEnabled && sourceKind !== 'migrated' ? 'queued' : 'skipped');
        const id = this.newId(draft, 'f', 6);
        const order = draft.items.filter((item) => item.column === column).length;
        const item = {
          id,
          kind: 'file',
          title: cleanText(raw?.title, MAX_TITLE_CHARS) ?? file.name,
          column,
          order,
          tags,
          pinned: false,
          summary: '',
          createdAt: now,
          updatedAt: now,
          addedBy,
          fileId: file.id,
          scope,
          originalName: file.name,
          mimeType: file.mimeType,
          size: file.size,
          fileKind: fileKindForName(file.name),
          status: file.status === 'ready' ? 'ready' : 'failed',
          chunkCount: file.chunkCount,
          ...(file.pageCount ? { pageCount: file.pageCount } : {}),
          source,
          librarian: { status: librarianStatus },
          locked: {},
        };
        draft.items.push(item);
        results.push(item);
        added.push(item);
        groups.push({
          op: { op: 'add-file', id },
          inverse: [{ op: 'trash', id }],
          expect: [{ path: `item:${id}:trashed`, value: false }],
        });
      }
      if (groups.length === 0) return results.map(publicItem);
      draft.revision = state.revision + 1;
      draft.updatedAt = now;
      const actor = added[0]?.addedBy ?? { kind: 'user' };
      const label = summary ?? (added.length === 1 ? `파일 추가: ${added[0].title}` : `파일 추가 ${added.length}`);
      const entry = this.#activityEntry(draft, actor, label.slice(0, 160), groups);
      await this.#writeProject(draft);
      this.projects.set(projectId, draft);
      await this.#appendActivity(draft, entry);
      this.#emitChange(projectId, { revision: draft.revision, reason: 'files' });
      this.#emitItemsAdded(projectId, added.filter((item) => item.librarian.status === 'queued').map((item) => item.id));
      return results.map(publicItem);
    });
  }

  /** 정리 도우미 진행 상태. 되돌리기 대상이 아니라 활동 기록에는 남기지 않는다. */
  async setLibrarianStatus(projectId, itemId, status, error = undefined) {
    if (!LIBRARIAN_STATUSES.has(status)) throw projectError('PROJECT_OP_INVALID', `Unknown librarian status ${String(status)}`);
    return this.#withProject(projectId, async () => {
      const next = { status, ...(error ? { error: String(error).slice(0, 300) } : {}) };
      const { outcome, state } = await this.#mutateLocked(projectId, 'librarian', (draft) => {
        const item = draft.items.find((entry) => entry.id === resolveItemId(draft, itemId) && entry.kind === 'file');
        if (!item) throw projectError('PROJECT_ITEM_NOT_FOUND', `Item ${String(itemId)} was not found`);
        if (sameJson(item.librarian, next)) return false;
        item.librarian = next;
        return item;
      });
      return publicItem(outcome ?? state.items.find((entry) => entry.id === resolveItemId(state, itemId)));
    });
  }

  // ─── 프로젝트 만들기·합류·나가기·삭제 ─────────────────────

  async createProject({ name, documentId = null, documentName = null } = {}) {
    const clean = cleanText(name, MAX_PROJECT_NAME_CHARS);
    if (!clean) throw projectError('PROJECT_OP_INVALID', `name must be 1-${MAX_PROJECT_NAME_CHARS} characters`);
    const projectId = await this.#withIndex(async () => {
      const state = await this.#createProjectLocked({ name: clean, implicit: false, nameSource: 'user' });
      await this.#writeIndex();
      return state.id;
    });
    if (documentId) await this.join(projectId, documentId, { name: documentName });
    return this.get(projectId);
  }

  /** 프로젝트 이름 바꾸기 (설정·프로젝트 머리말). 사용자가 바꾼 이름은 문서 이름을 따라가지 않는다. */
  async renameProject(projectId, name) {
    const clean = cleanText(name, MAX_PROJECT_NAME_CHARS);
    if (!clean) throw projectError('PROJECT_OP_INVALID', `name must be 1-${MAX_PROJECT_NAME_CHARS} characters`);
    return this.#withProject(projectId, async () => {
      const { state } = await this.#mutateLocked(projectId, 'rename', (draft) => {
        if (draft.name === clean && draft.nameSource === 'user') return false;
        draft.name = clean;
        draft.nameSource = 'user';
        return true;
      });
      return this.#snapshot(state);
    });
  }

  /**
   * 문서를 프로젝트에 합류시킨다. 문서가 혼자 쓰던 암묵 프로젝트는 대상에 합쳐진다
   * (파일은 project 범위째 옮기고, 겹치는 id 는 별칭으로 남긴다).
   */
  async join(projectId, documentId, { name = null } = {}) {
    if (typeof documentId !== 'string' || !documentId) throw projectError('PROJECT_OP_INVALID', 'documentId is required');
    const displayName = cleanText(name ?? '', MAX_PROJECT_NAME_CHARS) ?? '';
    return this.#withIndex(async () => {
      if (!this.hasProject(projectId)) throw projectError('PROJECT_NOT_FOUND', `Project ${String(projectId)} was not found`);
      const currentId = this.projectIdForDocument(documentId);
      if (currentId === projectId) return { projectId, merged: null };
      let merged = null;
      if (currentId) {
        const current = await this.#load(currentId);
        const remaining = current.members.filter((member) => member.documentId !== documentId);
        if (current.implicit && remaining.length === 0) {
          merged = await this.#mergeInto(currentId, projectId);
        } else {
          await this.#withProject(currentId, () => this.#mutateLocked(currentId, 'members', (draft) => {
            draft.members = draft.members.filter((member) => member.documentId !== documentId);
            return true;
          }));
        }
      }
      await this.#withProject(projectId, () => this.#mutateLocked(projectId, 'members', (draft) => {
        if (draft.members.some((member) => member.documentId === documentId)) return false;
        draft.members.push({ documentId, nodeId: documentNodeId(projectId, documentId), name: displayName });
        return true;
      }));
      this.index.documentProjects[documentId] = projectId;
      await this.#writeIndex();
      return { projectId, merged };
    });
  }

  /** 색인 잠금 안에서 부른다. source 를 target 에 합치고 source 를 지운다. */
  async #mergeInto(sourceId, targetId) {
    const [first, second] = [sourceId, targetId].sort();
    return this.#withProject(first, () => this.#withProject(second, async () => {
      const source = await this.#load(sourceId);
      const target = await this.#load(targetId);
      const draft = structuredClone(target);
      const idMap = new Map();
      const now = this.now();
      // 파일 기록부터 모두 옮긴다. 하나라도 실패하면 옮긴 것을 되돌리고 합치기를 멈춘다.
      const movedFiles = new Map();
      try {
        for (const item of source.items) {
          if (item.kind !== 'file' || item.scope !== 'project') continue;
          const moved = await this.referenceStore.rescope({ fileId: item.fileId, to: { scope: 'project', scopeId: targetId } });
          movedFiles.set(item.id, moved);
        }
      } catch (error) {
        for (const moved of movedFiles.values()) {
          if (moved.aliasedFrom) continue;
          await this.referenceStore.rescope({ fileId: moved.id, to: { scope: 'project', scopeId: sourceId } }).catch(() => undefined);
        }
        throw error;
      }
      const copiedClips = [];
      for (const item of source.items) {
        const fileId = movedFiles.get(item.id)?.id ?? item.fileId;
        const duplicate = item.kind === 'file' ? draft.items.find((entry) => entry.kind === 'file' && entry.fileId === fileId) : null;
        if (duplicate) {
          idMap.set(item.id, duplicate.id);
          continue;
        }
        const id = draft.items.some((entry) => entry.id === item.id) || draft.aliases[item.id] ? this.newId(draft, item.id[0], 6) : item.id;
        idMap.set(item.id, id);
        const column = draft.columns.some((entry) => entry.id === item.column) ? item.column : draft.columns[0].id;
        const copy = { ...structuredClone(item), id, column, order: draft.items.filter((entry) => entry.column === column).length, updatedAt: now };
        if (item.kind === 'file') copy.fileId = fileId;
        if (item.kind === 'clip') copiedClips.push(copy);
        draft.items.push(copy);
        if (item.kind === 'note') {
          const body = await this.noteBody(source, item.id);
          const file = this.#notePath(targetId, id);
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await writeFileAtomically(file, body, this.platform);
        }
      }
      // 영역이 원본보다 먼저 옮겨졌을 수 있어 원본 id 는 다 옮긴 뒤에 맞춘다.
      for (const clip of copiedClips) {
        clip.sourceId = idMap.get(clip.sourceId) ?? clip.sourceId;
        if (clip.trashedWith) clip.trashedWith = idMap.get(clip.trashedWith) ?? clip.trashedWith;
      }
      for (const [from, to] of idMap) if (from !== to) draft.aliases[from] = to;
      for (const [from, to] of Object.entries(source.aliases ?? {})) {
        if (!draft.aliases[from]) draft.aliases[from] = idMap.get(to) ?? to;
      }
      const remap = (id) => idMap.get(id) ?? id;
      for (const link of source.links) {
        if (draft.links.length >= this.maxLinks) break;
        draft.links.push({
          ...link,
          id: draft.links.some((entry) => entry.id === link.id) ? this.newId(draft, 'l', 8) : link.id,
          from: remap(link.from),
          to: remap(link.to),
          ...(link.noteId ? { noteId: remap(link.noteId) } : {}),
        });
      }
      if (!draft.goal && source.goal) draft.goal = source.goal;
      draft.revision += 1;
      draft.updatedAt = now;
      await this.#writeProject(draft);
      this.projects.set(targetId, draft);
      this.#emitChange(targetId, { revision: draft.revision, reason: 'merge' });
      for (const [threadId, mapped] of Object.entries(this.index.threadProjects)) {
        if (mapped === sourceId) this.index.threadProjects[threadId] = targetId;
      }
      await this.#dropProjectLocked(sourceId);
      return { from: sourceId, items: idMap.size };
    }));
  }

  /** 문서를 프로젝트에서 뺀다. 문서는 새 빈 암묵 프로젝트를 받는다. */
  async leave(projectId, documentId) {
    return this.#withIndex(async () => {
      if (!this.hasProject(projectId)) throw projectError('PROJECT_NOT_FOUND', `Project ${String(projectId)} was not found`);
      if (this.projectIdForDocument(documentId) !== projectId) {
        throw projectError('PROJECT_OP_INVALID', 'The document is not a member of this project');
      }
      const state = await this.#load(projectId);
      if (state.implicit) throw projectError('PROJECT_OP_INVALID', 'A document cannot leave its own project');
      const member = state.members.find((entry) => entry.documentId === documentId);
      await this.#withProject(projectId, () => this.#mutateLocked(projectId, 'members', (draft) => {
        draft.members = draft.members.filter((entry) => entry.documentId !== documentId);
        if (member?.nodeId) delete draft.graph.pinned[member.nodeId];
        return true;
      }));
      const fresh = await this.#createProjectLocked({
        name: member?.name ? member.name.replace(/\.(hwpx?|hml)$/i, '') : '문서 자료',
        implicit: true,
        nameSource: member?.name ? 'document' : 'default',
        members: [{ documentId, name: member?.name ?? '' }],
      });
      this.index.documentProjects[documentId] = fresh.id;
      await this.#writeIndex();
      return { projectId: fresh.id };
    });
  }

  /** 프로젝트와 그 범위의 파일을 모두 지운다 (설정의 저장 공간에서 확인을 거친 뒤). */
  async deleteProject(projectId) {
    return this.#withIndex(async () => {
      if (!this.hasProject(projectId)) throw projectError('PROJECT_NOT_FOUND', `Project ${String(projectId)} was not found`);
      const documents = Object.entries(this.index.documentProjects)
        .filter(([, mapped]) => mapped === projectId)
        .map(([documentId]) => documentId);
      // 프로젝트를 먼저 지운다. 읽는 중이라 지금 못 지운 파일 기록은 다음 부팅의 정리가 거둔다.
      this.index.deletedProjects[projectId] = this.now();
      await this.#withProject(projectId, () => this.#dropProjectLocked(projectId));
      if (await this.#removeProjectReferences(projectId) === 0) {
        delete this.index.deletedProjects[projectId];
        await this.#writeIndex();
      }
      this.#emitChange(projectId, { revision: null, reason: 'deleted', documents });
      return { deleted: projectId, documents };
    });
  }

  async #dropProjectLocked(projectId) {
    delete this.index.projects[projectId];
    for (const [documentId, mapped] of Object.entries(this.index.documentProjects)) {
      if (mapped === projectId) delete this.index.documentProjects[documentId];
    }
    for (const [threadId, mapped] of Object.entries(this.index.threadProjects)) {
      if (mapped === projectId) delete this.index.threadProjects[threadId];
    }
    await this.#writeIndex();
    this.projects.delete(projectId);
    for (const key of [...this.noteSearchCache.keys()]) if (key.startsWith(`${projectId}:`)) this.noteSearchCache.delete(key);
    await fs.rm(this.#projectDir(projectId), { recursive: true, force: true });
  }

  async #removeProjectReferences(projectId) {
    let kept = 0;
    for (const file of this.referenceStore.list({ scope: 'project', scopeId: projectId })) {
      try {
        await this.referenceStore.remove({ fileId: file.id, scope: 'project', scopeId: projectId });
      } catch (error) {
        kept += 1;
        if (error?.code !== 'REFERENCE_NOT_FOUND') this.logger?.(`project file ${file.id} kept for later cleanup: ${error?.message ?? error}`);
      }
    }
    return kept;
  }

  /**
   * 부팅 때 프로젝트 파일 저장소와 프로젝트를 맞춘다.
   * - 지운 프로젝트(묘비가 있는)에 남은 기록은 지운다.
   * - 프로젝트 없이 기록만 남은 범위는 같은 id 의 "복구된 자료" 프로젝트로 되살린다.
   * - 항목이 없는 기록(이주가 기록만 쓰고 멈춘 경우)에는 항목을 붙인다.
   * 지우는 일은 묘비가 있을 때만 한다 — 색인이 망가져도 자료는 사라지지 않는다.
   */
  async repairReferences() {
    let repaired = 0;
    for (const scope of this.referenceStore.listScopes('project')) {
      const projectId = scope.scopeId;
      if (this.index.deletedProjects[projectId]) {
        if (await this.#removeProjectReferences(projectId) === 0) {
          await this.#withIndex(async () => {
            delete this.index.deletedProjects[projectId];
            await this.#writeIndex();
          });
        }
        continue;
      }
      if (!this.hasProject(projectId)) {
        await this.#withIndex(async () => {
          if (this.hasProject(projectId)) return;
          await this.#createProjectLocked({ id: projectId, name: '복구된 자료', implicit: false, nameSource: 'user' });
          await this.#writeIndex();
        });
        this.logger?.(`recovered project ${projectId} from its stored files`);
      }
      const project = await this.get(projectId, { trash: true });
      const linked = new Set(project.items.filter((item) => item.kind === 'file').map((item) => item.fileId));
      const missing = this.referenceStore.list({ scope: 'project', scopeId: projectId })
        .filter((file) => !linked.has(file.id));
      if (missing.length === 0) continue;
      await this.addFileItems(projectId, missing.map((file) => ({
        fileId: file.id,
        scope: 'project',
        source: { kind: 'migrated' },
        librarian: 'skipped',
      })), { summary: `자료 복구 ${missing.length}` });
      repaired += missing.length;
    }
    for (const projectId of Object.keys(this.index.deletedProjects)) {
      if (this.referenceStore.list({ scope: 'project', scopeId: projectId }).length > 0) continue;
      await this.#withIndex(async () => {
        delete this.index.deletedProjects[projectId];
        await this.#writeIndex();
      });
    }
    return repaired;
  }

  // ─── 휴지통 ───────────────────────────────────────────────

  async #purge(projectId, select, summary) {
    return this.#withProject(projectId, async () => {
      const state = await this.#load(projectId);
      const doomed = state.items.filter((item) => item.trashedAt && select(item));
      if (doomed.length === 0) return { purged: 0 };
      const purged = new Set();
      for (const item of doomed) {
        try {
          if (item.kind === 'file' && item.scope === 'project'
            && !state.items.some((other) => other !== item && !doomed.includes(other) && other.fileId === item.fileId)) {
            await this.referenceStore.remove({ fileId: item.fileId, scope: 'project', scopeId: projectId }).catch((error) => {
              if (error?.code !== 'REFERENCE_NOT_FOUND') throw error;
            });
          }
          if (item.kind === 'note') await fs.unlink(this.#notePath(projectId, item.id)).catch(() => undefined);
          purged.add(item.id);
        } catch (error) {
          this.logger?.(`project purge kept ${item.id}: ${error?.message ?? error}`);
        }
      }
      // 원본이 지워지면 그 영역도 남기지 않는다.
      for (const item of state.items) {
        if (item.kind === 'clip' && purged.has(item.sourceId)) purged.add(item.id);
      }
      if (purged.size === 0) return { purged: 0 };
      const draft = structuredClone(state);
      draft.items = draft.items.filter((item) => !purged.has(item.id));
      draft.links = draft.links.filter((link) => !purged.has(link.from) && !purged.has(link.to) && !purged.has(link.noteId));
      for (const id of purged) delete draft.graph.pinned[id];
      draft.revision += 1;
      draft.updatedAt = this.now();
      const entry = this.#activityEntry(draft, { kind: 'user' }, `${summary} ${purged.size}`, []);
      await this.#writeProject(draft);
      this.projects.set(projectId, draft);
      await this.#appendActivity(draft, entry);
      this.#emitChange(projectId, { revision: draft.revision, reason: 'purge' });
      return { purged: purged.size };
    });
  }

  async emptyTrash(projectId) {
    return this.#purge(projectId, () => true, '휴지통 비움');
  }

  /** 설정의 보관 기간이 지난 휴지통 항목을 지운다. */
  async purgeExpired() {
    const days = this.settings()?.board?.trashDays ?? DEFAULT_PROJECT_SETTINGS.board.trashDays;
    const cutoff = this.now() - days * DAY_MS;
    let purged = 0;
    for (const projectId of Object.keys(this.index.projects)) {
      try {
        purged += (await this.#purge(projectId, (item) => item.trashedAt <= cutoff, '보관 기간 지난 항목 삭제')).purged;
      } catch (error) {
        this.logger?.(`project trash purge failed for ${projectId}: ${error?.message ?? error}`);
      }
    }
    return purged;
  }

  // ─── 이주·승격 ────────────────────────────────────────────

  /**
   * 참고 자료 기록을 프로젝트 범위로 옮기고 항목으로 올린다. 입력 순서대로 항목을 돌려준다.
   * @param {string} projectId
   * @param {Array<{fileId: string}>} files
   * @param {{source: object, addedBy?: object, librarian?: string}} options
   */
  async adoptReferences(projectId, files, { source, addedBy = { kind: 'user' }, librarian = undefined } = {}) {
    // 이 프로젝트 폴더에 없는 프로젝트로는 옮기지 않는다. 기록을 쓰다 멈춰도 repairReferences 가 항목을 붙인다.
    if (!this.hasProject(projectId)) throw projectError('PROJECT_NOT_FOUND', `Project ${String(projectId)} was not found`);
    const entries = [];
    for (const file of files) {
      const moved = await this.referenceStore.rescope({ fileId: file.id ?? file.fileId, to: { scope: 'project', scopeId: projectId } });
      entries.push({ fileId: moved.id, scope: 'project', source, addedBy, ...(librarian ? { librarian } : {}) });
    }
    if (entries.length === 0) return [];
    return this.addFileItems(projectId, entries);
  }

  /** 부팅 때 한 번: document 범위 참고 자료를 각 문서의 암묵 프로젝트로 옮긴다. */
  async migrateDocumentReferences() {
    let moved = 0;
    for (const scope of this.referenceStore.listScopes('document')) {
      try {
        const projectId = await this.projectForDocument(scope.scopeId);
        const files = this.referenceStore.list({ scope: 'document', scopeId: scope.scopeId });
        const items = await this.adoptReferences(projectId, files, { source: { kind: 'migrated' }, librarian: 'skipped' });
        moved += items.length;
      } catch (error) {
        this.logger?.(`document reference migration failed for ${scope.scopeId}: ${error?.message ?? error}`);
      }
    }
    return moved;
  }

  /** 채팅 시작 때: 그 스레드의 chat 범위 참고 자료를 묶인 프로젝트로 옮긴다. */
  async migrateChatReferences(threadId, projectId) {
    if (typeof threadId !== 'string' || !threadId) return 0;
    let files;
    try {
      files = this.referenceStore.list({ scope: 'chat', scopeId: threadId });
    } catch {
      return 0;
    }
    if (files.length === 0) return 0;
    const items = await this.adoptReferences(projectId, files, {
      source: { kind: 'migrated', threadId },
      librarian: 'skipped',
    });
    return items.length;
  }
}
