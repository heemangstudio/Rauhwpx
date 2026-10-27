/**
 * 문서 기억 — 문서 하나에 붙는 지속 메모 저장소.
 *
 * 연구 프로젝트와 따로 둔다. 프로젝트는 문서가 함께 쓰는 자료가 합쳐질 수 있지만 문서 기억은 형제
 * 문서로 새지 않는다. 버전 기록이 있는 문서는 repositoryId 로(작업 공간 사본이 기억을 나눈다), 없으면
 * documentId 로 묶는다. 원본 digest·파일 이름이 같은 처음 보는 documentId 는 그 기억을 복사해 새 키로
 * 갈라 낸다 — 같은 바이트의 사본이 한 기억을 나눠 쓰지 않게, 다시 발급된 id 도 기억을 잃지 않게.
 *
 * 파일 (RHWP_DOCUMENT_MEMORY_DIR, 기본은 다른 허브 저장소 옆 `…/rhwp/document-memory`):
 *   index.json      {schemaVersion:1, documents:{[documentId]:key}, repositories:{[repositoryId]:key}, digests:{[digest]:key}}
 *   docs/<key>.json {schemaVersion:1, key, revision, documentIds:[], repositoryId?, fileName?, digest?, entries:[]}
 * 쓰기는 임시 파일 + rename 으로 원자적이고, 모든 변경은 한 큐를 지난다. 색인을 먼저 쓴다 — 그 사이에
 * 멈추면 색인이 가리키는 빈 기억이 남을 뿐, 색인에 없는 기억 파일이 남지 않는다. 기억은 로컬에만 있고
 * HWP/HWPX 에 쓰지 않는다. 기억이 없는 문서는 아무것도 쓰지 않는다 — 첫 항목이 생길 때 묶음을 저장한다.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recoverInterruptedFileReplacement, replaceFileAtomically } from './harness-update.mjs';
import { defaultReferenceRoot } from './reference-store.mjs';

export const DOCUMENT_MEMORY_KINDS = Object.freeze(['decision', 'term', 'protect', 'style', 'fact']);
export const MAX_MEMORY_ENTRIES = 40;
export const MAX_MEMORY_TEXT_CHARS = 8_000;
export const MAX_ENTRY_TEXT_CHARS = 300;
export const MAX_SUBJECT_CHARS = 60;
export const MAX_ANCHOR_QUOTE_CHARS = 120;
/** 프롬프트에 본문까지 싣는 양. 넘으면 주제만 적고 read_document_memory 를 가리킨다. */
export const DOCUMENT_MEMORY_PROMPT_BUDGET = 2_000;

const SCHEMA_VERSION = 1;
const MAX_OPS = MAX_MEMORY_ENTRIES;
const MAX_DOCUMENT_IDS = 32;
const MAX_DIGESTS_PER_KEY = 8;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_DOC_BYTES = 256 * 1024;
const KEY_PATTERN = /^dm_[a-z0-9]{16}$/;
const ENTRY_ID_PATTERN = /^mem_[a-z0-9]{12}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORIGINS = new Set(['explicit', 'learned', 'user']);
const SOURCE_KINDS = new Set(['turn', 'signal', 'history', 'copy']);
const KIND_LABELS = Object.freeze({ decision: '결정', term: '용어', protect: '보호', style: '문체', fact: '사실' });

export class DocumentMemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentMemoryError';
    this.code = code;
  }
}

function memoryError(code, message) {
  return new DocumentMemoryError(code, message);
}

/** 기본 위치는 참고 자료 저장소 옆(`…/rhwp/document-memory`)이다. RHWP_DOCUMENT_MEMORY_DIR 로 바꾼다. */
export function defaultDocumentMemoryRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_DOCUMENT_MEMORY_DIR) return path.resolve(env.RHWP_DOCUMENT_MEMORY_DIR);
  return path.join(path.dirname(defaultReferenceRoot(env, platform, home)), 'document-memory');
}

function base36(length, random) {
  const bytes = random(length);
  let out = '';
  for (let index = 0; index < length; index += 1) out += (bytes[index] % 36).toString(36);
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanLine(value, max, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw memoryError('MEMORY_INVALID', `${label} is required`);
    return null;
  }
  if (typeof value !== 'string') throw memoryError('MEMORY_INVALID', `${label} must be text`);
  // 개조식 한 줄로 둔다 — 줄바꿈·제어 문자는 공백 하나로 접는다.
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) {
    if (required) throw memoryError('MEMORY_INVALID', `${label} is empty`);
    return null;
  }
  if (text.length > max) throw memoryError('MEMORY_INVALID', `${label} may not exceed ${max} characters`);
  return text;
}

/** 주제 비교 키 — 대소문자·전각·공백 차이는 같은 주제다. */
export function canonicalSubject(subject) {
  return String(subject ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 취향 비교 키 — 같은 주제라도 글이 같아야 같은 취향이다(한다체 ≠ 합니다체). 공백·전각·끝 마침표 차이는 같다.
 */
export function preferenceText(text) {
  return String(text ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim().toLowerCase();
}

/**
 * 이 항목의 지금 글이 AGENTS.md 제안에서 확인(promoted)·거절(declined)됐는가. 표시는 그때의 글에만 묶인다 —
 * 글이 바뀌면 새 취향이라 다시 제안할 수 있다. 글 없이 남은 표시는 지금 글의 것으로 본다.
 * @returns {'promoted' | 'declined' | null}
 */
export function promotionState(entry) {
  if (!entry || (entry.promoted !== true && entry.promotionDeclined !== true)) return null;
  if (preferenceText(entry.promotionText ?? entry.text) !== preferenceText(entry.text)) return null;
  return entry.promoted === true ? 'promoted' : 'declined';
}

function deriveSubject(kind, text) {
  return `${KIND_LABELS[kind] ?? kind}.${text}`.slice(0, MAX_SUBJECT_CHARS).trim();
}

/**
 * 매인 글은 Studio 가 엔진에서 그대로 찾는다. 줄바꿈·제어 문자만 빼고 나머지(겹친 공백·탭·U+00A0·U+3000)는
 * 그대로 둔다. 길면 앞부분만 남긴다 — 앞부분도 문서에서 그대로 찾을 수 있다. 서로게이트 쌍은 자르지 않는다.
 */
function cleanQuote(value) {
  if (typeof value !== 'string') throw memoryError('MEMORY_INVALID', 'anchor.quote must be text');
  let quote = value.replace(/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]/g, '');
  if (quote.length > MAX_ANCHOR_QUOTE_CHARS) {
    const cut = /[\ud800-\udbff]/.test(quote[MAX_ANCHOR_QUOTE_CHARS - 1]) ? MAX_ANCHOR_QUOTE_CHARS - 1 : MAX_ANCHOR_QUOTE_CHARS;
    quote = quote.slice(0, cut);
  }
  if (!quote.trim()) throw memoryError('MEMORY_INVALID', 'anchor.quote is empty');
  return quote;
}

function normalizeAnchor(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) throw memoryError('MEMORY_INVALID', 'anchor must be an object');
  const quote = cleanQuote(value.quote);
  const anchor = { quote };
  if (value.paraIdx !== undefined && value.paraIdx !== null) {
    if (!Number.isSafeInteger(value.paraIdx) || value.paraIdx < 0) {
      throw memoryError('MEMORY_INVALID', 'anchor.paraIdx must be a non-negative integer');
    }
    anchor.paraIdx = value.paraIdx;
  }
  return anchor;
}

function normalizeKind(value, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (!DOCUMENT_MEMORY_KINDS.includes(value)) {
    throw memoryError('MEMORY_INVALID', `kind must be one of ${DOCUMENT_MEMORY_KINDS.join(', ')}`);
  }
  return value;
}

function normalizeSource(value) {
  if (!isPlainObject(value)) return undefined;
  const source = {};
  for (const field of ['threadId', 'turnId']) {
    if (typeof value[field] === 'string' && value[field] && value[field].length <= 256) source[field] = value[field];
  }
  if (SOURCE_KINDS.has(value.kind)) source.kind = value.kind;
  return Object.keys(source).length ? source : undefined;
}

function isoOr(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

/** 저장된(또는 되돌리기로 돌아온) 항목 하나를 검증해 정규형으로. 모양이 틀리면 null. */
function readStoredEntry(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !ENTRY_ID_PATTERN.test(value.id)) return null;
  try {
    const entry = {
      id: value.id,
      kind: normalizeKind(value.kind),
      subject: cleanLine(value.subject, MAX_SUBJECT_CHARS, 'subject'),
      text: cleanLine(value.text, MAX_ENTRY_TEXT_CHARS, 'text'),
    };
    const anchor = normalizeAnchor(value.anchor ?? undefined);
    if (anchor) entry.anchor = anchor;
    entry.origin = ORIGINS.has(value.origin) ? value.origin : 'user';
    const source = normalizeSource(value.source);
    if (source) entry.source = source;
    entry.evidence = Number.isSafeInteger(value.evidence) && value.evidence >= 1 ? value.evidence : 1;
    if (value.userCandidate === true) entry.userCandidate = true;
    if (value.promoted === true) entry.promoted = true;
    if (value.promotionDeclined === true) entry.promotionDeclined = true;
    if ((entry.promoted || entry.promotionDeclined) && typeof value.promotionText === 'string'
      && value.promotionText.length <= MAX_ENTRY_TEXT_CHARS) {
      entry.promotionText = value.promotionText;
    }
    const epoch = new Date(0).toISOString();
    entry.createdAt = isoOr(value.createdAt, epoch);
    entry.updatedAt = isoOr(value.updatedAt, entry.createdAt);
    entry.confirmedAt = isoOr(value.confirmedAt, entry.updatedAt);
    return entry;
  } catch {
    return null;
  }
}

function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

/** 키 순서와 무관하게 같은 항목인가 — 둘 다 정규형으로 견준다. */
function sameEntry(a, b) {
  const left = a ? readStoredEntry(a) : null;
  const right = b ? readStoredEntry(b) : null;
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

/** 되돌릴 수 있는 모양의 변경인가 — 항목 id 와 op, 그 op 에 필요한 정규형 항목(entry·prev)이 같은 id 로 있어야 한다. */
function revertableChange(change) {
  if (!isPlainObject(change) || typeof change.entryId !== 'string' || !ENTRY_ID_PATTERN.test(change.entryId)) return false;
  const entry = change.entry === undefined ? null : readStoredEntry(change.entry);
  const prev = change.prev === undefined ? null : readStoredEntry(change.prev);
  if ((change.entry !== undefined && entry?.id !== change.entryId) || (change.prev !== undefined && prev?.id !== change.entryId)) return false;
  if (change.op === 'add') return Boolean(entry);
  if (change.op === 'update') return Boolean(entry && prev);
  if (change.op === 'remove') return Boolean(prev);
  return false;
}

function textChars(entries) {
  return entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

function emptyIndex() {
  return { schemaVersion: SCHEMA_VERSION, documents: {}, repositories: {}, digests: {} };
}

function emptyDoc(key) {
  return { schemaVersion: SCHEMA_VERSION, key, revision: 0, documentIds: [], entries: [] };
}

function normalizeDocumentId(value) {
  if (typeof value !== 'string') throw memoryError('MEMORY_INVALID', 'documentId is required');
  const id = value.normalize('NFKC').trim();
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw memoryError('MEMORY_INVALID', 'documentId is invalid');
  return id;
}

function optionalIdentity(value, max, pattern = null) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (pattern && !pattern.test(text)) return null;
  return text;
}

function snapshotOf(doc) {
  return { key: doc.key, revision: doc.revision, entries: doc.entries.map(cloneEntry) };
}

export class DocumentMemoryStore {
  constructor({
    dir = defaultDocumentMemoryRoot(),
    fsApi = fs,
    now = () => new Date().toISOString(),
    random = crypto.randomBytes,
    platform = process.platform,
  } = {}) {
    this.dir = dir;
    this.docsDir = path.join(dir, 'docs');
    this.indexPath = path.join(dir, 'index.json');
    this.fs = fsApi;
    this.now = now;
    this.random = random;
    this.platform = platform;
    /** @type {ReturnType<typeof emptyIndex> | null} */
    this.index = null;
    /** 기억이 생기기 전까지 저장하지 않은 묶음이 있다. */
    this.indexDirty = false;
    /** key → 문서 기억 (읽은 것만). */
    this.docs = new Map();
    this.queue = Promise.resolve();
  }

  /**
   * 문서의 기억 키. 저장소 → documentId 순으로 찾고 정체성을 그 키에 묶는다.
   * 처음 보는(또는 아직 아무것도 쓰지 않은) documentId 의 digest 가 기억이 있는 키와 맞고 파일 이름도
   * 같으면, 그 키를 나눠 쓰지 않고 항목을 복사한 새 기억으로 갈라 낸다. 빈 기억은 갈라 내지 않는다.
   */
  resolveKey({ documentId, repositoryId, digest, fileName } = {}) {
    return this.#mutate(async () => {
      const id = normalizeDocumentId(documentId);
      const repository = optionalIdentity(repositoryId, 128, REPOSITORY_ID_PATTERN);
      const sourceDigest = optionalIdentity(digest, 200);
      const name = optionalIdentity(fileName, 500);
      const index = await this.#loadIndex();
      let key = (repository && index.repositories[repository]) || null;
      /** 갈라 낼 원본 기억 — documentId 로 찾은 묶음이 없거나 아직 한 번도 쓰지 않았을 때만. */
      let forkFrom = null;
      if (!key) {
        key = index.documents[id] || null;
        const byDigest = sourceDigest ? index.digests[sourceDigest] : null;
        if (byDigest && byDigest !== key && (!key || (await this.#loadDoc(key)).revision === 0)) {
          const candidate = await this.#loadDoc(byDigest);
          const sameName = !candidate.fileName || !name || candidate.fileName === name;
          if (sameName && candidate.entries.length > 0) forkFrom = candidate;
        }
      }
      if (!key) key = this.#newKey();
      const doc = await this.#loadDoc(key);
      let docChanged = false;
      if (forkFrom) {
        // 사본은 따로 자란다 — 항목은 새 id 로 복사하고 출처에 복사본임을 남긴다.
        const entries = [];
        for (const entry of forkFrom.entries) {
          entries.push({ ...cloneEntry(entry), id: this.#newEntryId(entries), source: { ...(entry.source ?? {}), kind: 'copy' } });
        }
        doc.entries = entries;
        doc.revision = Math.max(doc.revision, 1);
        docChanged = true;
      }
      let indexChanged = false;
      if (index.documents[id] !== key) {
        index.documents[id] = key;
        indexChanged = true;
      }
      if (!doc.documentIds.includes(id)) {
        doc.documentIds = [...doc.documentIds, id].slice(-MAX_DOCUMENT_IDS);
        docChanged = true;
      }
      if (repository) {
        if (index.repositories[repository] !== key) {
          index.repositories[repository] = key;
          indexChanged = true;
        }
        if (doc.repositoryId !== repository) {
          doc.repositoryId = repository;
          docChanged = true;
        }
      }
      if (sourceDigest) {
        if (index.digests[sourceDigest] !== key) {
          // 삽입 순서가 최근 순서다 — 같은 키의 오래된 digest 부터 버린다.
          delete index.digests[sourceDigest];
          index.digests[sourceDigest] = key;
          const own = Object.keys(index.digests).filter((known) => index.digests[known] === key);
          for (const stale of own.slice(0, Math.max(0, own.length - MAX_DIGESTS_PER_KEY))) delete index.digests[stale];
          indexChanged = true;
        }
        if (doc.digest !== sourceDigest) {
          doc.digest = sourceDigest;
          docChanged = true;
        }
      }
      if (name && doc.fileName !== name) {
        doc.fileName = name;
        docChanged = true;
      }
      if (indexChanged) this.indexDirty = true;
      // 항목이 있는 기억만 디스크에 둔다. 빈 기억의 묶음은 첫 쓰기가 저장한다. 색인이 먼저다.
      if (doc.entries.length > 0 || doc.revision > 0) {
        if (this.indexDirty) await this.#writeIndex();
        if (docChanged) await this.#writeDoc(doc);
      }
      return key;
    });
  }

  /** @returns {Promise<{key: string, revision: number, entries: object[]}>} */
  read(key) {
    return this.#mutate(async () => snapshotOf(await this.#loadDoc(this.#key(key))));
  }

  /** 이미 읽어 둔 기억 (동기). 아직 읽지 않았으면 null. */
  peek(key) {
    const doc = typeof key === 'string' ? this.docs.get(key) : null;
    return doc ? snapshotOf(doc) : null;
  }

  /**
   * ops 를 한 번에 적용한다 — 하나라도 실패하면 아무것도 바뀌지 않는다.
   * add 의 subject 가 이미 있으면 그 항목을 고치고 evidence 를 1 올린다.
   */
  apply(key, ops, { expectedRevision, origin, source } = {}) {
    return this.#mutate(async () => {
      if (!ORIGINS.has(origin)) throw memoryError('MEMORY_INVALID', 'origin must be explicit, learned or user');
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) {
        throw memoryError('MEMORY_INVALID', `ops must hold 1-${MAX_OPS} operations`);
      }
      const doc = await this.#loadDoc(this.#key(key));
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== doc.revision) {
        throw memoryError(
          'MEMORY_REVISION_CONFLICT',
          `Document memory changed from revision ${expectedRevision} to ${doc.revision}; read it again before writing.`,
        );
      }
      const stamp = this.now();
      const writer = normalizeSource(source);
      const entries = doc.entries.map(cloneEntry);
      const changes = [];
      const at = (index, message) => memoryError('MEMORY_INVALID', `ops[${index}]: ${message}`);
      ops.forEach((raw, index) => {
        if (!isPlainObject(raw)) throw at(index, 'operation must be an object');
        try {
          if (raw.op === 'add') {
            const kind = normalizeKind(raw.kind);
            const text = cleanLine(raw.text, MAX_ENTRY_TEXT_CHARS, 'text');
            const subject = cleanLine(raw.subject, MAX_SUBJECT_CHARS, 'subject', { required: false })
              ?? deriveSubject(kind, text);
            const anchor = normalizeAnchor(raw.anchor);
            const existing = entries.find((entry) => canonicalSubject(entry.subject) === canonicalSubject(subject));
            if (existing) {
              const prev = cloneEntry(existing);
              Object.assign(existing, { kind, subject, text, origin, evidence: existing.evidence + 1, updatedAt: stamp, confirmedAt: stamp });
              if (anchor) existing.anchor = anchor;
              else if (anchor === null) delete existing.anchor;
              if (typeof raw.userCandidate === 'boolean') {
                if (raw.userCandidate) existing.userCandidate = true;
                else delete existing.userCandidate;
              }
              if (writer) existing.source = writer;
              changes.push({ op: 'update', entryId: existing.id, entry: cloneEntry(existing), prev });
              return;
            }
            if (entries.length >= MAX_MEMORY_ENTRIES) {
              throw memoryError('MEMORY_FULL', `This document already has ${MAX_MEMORY_ENTRIES} notes; remove or merge one first.`);
            }
            const entry = {
              id: this.#newEntryId(entries),
              kind,
              subject,
              text,
              ...(anchor ? { anchor } : {}),
              origin,
              ...(writer ? { source: writer } : {}),
              evidence: 1,
              ...(raw.userCandidate === true ? { userCandidate: true } : {}),
              createdAt: stamp,
              updatedAt: stamp,
              confirmedAt: stamp,
            };
            entries.push(entry);
            changes.push({ op: 'add', entryId: entry.id, entry: cloneEntry(entry) });
            return;
          }
          if (raw.op === 'update') {
            const entry = entries.find((candidate) => candidate.id === raw.id);
            if (!entry) throw memoryError('MEMORY_ENTRY_NOT_FOUND', `No note ${String(raw.id)} in this document's memory`);
            const prev = cloneEntry(entry);
            const kind = normalizeKind(raw.kind, { required: false });
            const subject = raw.subject === undefined ? null : cleanLine(raw.subject, MAX_SUBJECT_CHARS, 'subject');
            const text = raw.text === undefined ? null : cleanLine(raw.text, MAX_ENTRY_TEXT_CHARS, 'text');
            const anchor = normalizeAnchor(raw.anchor);
            if (subject && entries.some((other) => other !== entry && canonicalSubject(other.subject) === canonicalSubject(subject))) {
              throw memoryError('MEMORY_SUBJECT_TAKEN', `Another note already uses the subject ${JSON.stringify(subject)}; update that note instead`);
            }
            if (kind) entry.kind = kind;
            if (subject) entry.subject = subject;
            if (text) entry.text = text;
            if (anchor) entry.anchor = anchor;
            else if (anchor === null) delete entry.anchor;
            if (typeof raw.userCandidate === 'boolean') {
              if (raw.userCandidate) entry.userCandidate = true;
              else delete entry.userCandidate;
            }
            if (sameEntry(prev, entry)) return;
            Object.assign(entry, { origin, updatedAt: stamp, confirmedAt: stamp });
            if (writer) entry.source = writer;
            changes.push({ op: 'update', entryId: entry.id, entry: cloneEntry(entry), prev });
            return;
          }
          if (raw.op === 'remove') {
            const position = entries.findIndex((candidate) => candidate.id === raw.id);
            if (position < 0) throw memoryError('MEMORY_ENTRY_NOT_FOUND', `No note ${String(raw.id)} in this document's memory`);
            const [removed] = entries.splice(position, 1);
            changes.push({ op: 'remove', entryId: removed.id, prev: cloneEntry(removed) });
            return;
          }
          throw at(index, 'op must be add, update or remove');
        } catch (error) {
          if (error instanceof DocumentMemoryError && error.code === 'MEMORY_INVALID' && !error.message.startsWith('ops[')) {
            throw at(index, error.message);
          }
          throw error;
        }
      });
      if (textChars(entries) > MAX_MEMORY_TEXT_CHARS) {
        throw memoryError('MEMORY_FULL', `Document memory may hold up to ${MAX_MEMORY_TEXT_CHARS.toLocaleString('en-US')} characters of notes; shorten or remove notes first.`);
      }
      if (changes.length === 0) return { revision: doc.revision, changes };
      await this.#commit(doc, entries);
      return { revision: doc.revision, changes };
    });
  }

  /**
   * 이 변경들을 거꾸로 되돌린다. 그 뒤에 다시 바뀐 항목은 건드리지 않고 skipped 로 돌려준다.
   * @returns {Promise<{revision: number, reverted: string[], skipped: string[]}>}
   */
  revert(key, changes) {
    return this.#mutate(async () => {
      if (!Array.isArray(changes) || changes.length > MAX_OPS * 2) throw memoryError('MEMORY_INVALID', 'changes must be a list');
      // 되돌리기 목록은 Studio 를 거쳐 온다 — 모양이 틀린 변경이 하나라도 있으면 아무것도 하지 않는다.
      for (const change of changes) {
        if (!revertableChange(change)) throw memoryError('MEMORY_INVALID', 'changes hold a malformed change');
      }
      const doc = await this.#loadDoc(this.#key(key));
      const entries = doc.entries.map(cloneEntry);
      const reverted = [];
      const skipped = [];
      for (const change of [...changes].reverse()) {
        const entryId = typeof change?.entryId === 'string' ? change.entryId : '';
        const position = entries.findIndex((entry) => entry.id === entryId);
        const current = position >= 0 ? entries[position] : null;
        const left = readStoredEntry(change?.entry);
        const prev = readStoredEntry(change?.prev);
        if (change?.op === 'add' && current && sameEntry(current, left)) {
          entries.splice(position, 1);
          reverted.push(entryId);
        } else if (change?.op === 'update' && current && prev?.id === entryId && sameEntry(current, left)
          && !entries.some((entry) => entry !== current && canonicalSubject(entry.subject) === canonicalSubject(prev.subject))
          && textChars(entries) - current.text.length + prev.text.length <= MAX_MEMORY_TEXT_CHARS) {
          entries[position] = prev;
          reverted.push(entryId);
        } else if (change?.op === 'remove' && !current && prev?.id === entryId
          && entries.length < MAX_MEMORY_ENTRIES
          && textChars(entries) + prev.text.length <= MAX_MEMORY_TEXT_CHARS
          && !entries.some((entry) => canonicalSubject(entry.subject) === canonicalSubject(prev.subject))) {
          entries.push(prev);
          reverted.push(entryId);
        } else if (entryId) {
          skipped.push(entryId);
        }
      }
      if (reverted.length > 0) await this.#commit(doc, entries);
      return { revision: doc.revision, reverted, skipped };
    });
  }

  /**
   * 사용자 지시로 올린 결과를 항목에 적는다 — promoted 는 확인됨, declined 는 거절됨(다시 제안하지 않는다).
   * 내용이 아닌 표시라 리비전을 올리지 않는다 (에이전트에게 기억을 다시 보내지 않는다).
   * 표시는 제안한 글(text, 없으면 항목의 지금 글)에 묶인다 — 그 글과 다른 항목은 건드리지 않는다.
   * @param {{key: string, entryId: string}[]} refs
   * @param {'promoted' | 'declined'} outcome
   * @param {{ text?: string }} [options]
   * @returns {Promise<string[]>} 표시한 항목 id
   */
  markPromotion(refs, outcome, { text } = {}) {
    return this.#mutate(async () => {
      const field = outcome === 'promoted' ? 'promoted' : outcome === 'declined' ? 'promotionDeclined' : null;
      if (!field) throw memoryError('MEMORY_INVALID', 'outcome must be promoted or declined');
      const line = typeof text === 'string' && text.trim() ? text.normalize('NFC').trim().slice(0, MAX_ENTRY_TEXT_CHARS) : null;
      const byKey = new Map();
      for (const ref of Array.isArray(refs) ? refs : []) {
        if (typeof ref?.key !== 'string' || !KEY_PATTERN.test(ref.key) || typeof ref.entryId !== 'string') continue;
        byKey.set(ref.key, [...(byKey.get(ref.key) ?? []), ref.entryId]);
      }
      const marked = [];
      for (const [key, ids] of byKey) {
        const doc = await this.#loadDoc(key);
        const hits = doc.entries
          .filter((entry) => ids.includes(entry.id) && (!line || preferenceText(line) === preferenceText(entry.text))
            && promotionState(entry) !== outcome)
          .map((entry) => entry.id);
        if (hits.length === 0) continue;
        const withPromotion = (entry) => {
          const copy = cloneEntry(entry);
          delete copy.promoted;
          delete copy.promotionDeclined;
          return { ...copy, [field]: true, promotionText: line ?? entry.text };
        };
        const next = {
          ...doc,
          entries: doc.entries.map((entry) => (hits.includes(entry.id) ? withPromotion(entry) : entry)),
        };
        await this.#writeDoc(next);
        Object.assign(doc, next);
        marked.push(...hits);
      }
      return marked;
    });
  }

  /** 모든 문서에서 같은 주제의 항목 (사용자 단위 취향 승격용). */
  findSubject(subject) {
    return this.#mutate(async () => {
      const wanted = canonicalSubject(subject);
      if (!wanted) return [];
      const hits = [];
      for (const key of await this.#allKeys()) {
        const doc = await this.#loadDoc(key);
        for (const entry of doc.entries) {
          if (canonicalSubject(entry.subject) === wanted) hits.push({ key, entryId: entry.id });
        }
      }
      return hits;
    });
  }

  /**
   * 다른 문서들의 사용자 취향 후보 — 주제와 글. 학습기가 같은 취향에는 같은 주제·글을 쓰게 한다.
   * @returns {Promise<{subject: string, text: string}[]>}
   */
  candidateSubjects({ excludeKey, limit = 30 } = {}) {
    return this.#mutate(async () => {
      const found = new Map();
      for (const key of await this.#allKeys()) {
        if (key === excludeKey) continue;
        const doc = await this.#loadDoc(key).catch(() => null);
        for (const entry of doc?.entries ?? []) {
          const id = `${canonicalSubject(entry.subject)}\n${preferenceText(entry.text)}`;
          if (entry.userCandidate === true && !found.has(id)) found.set(id, { subject: entry.subject, text: entry.text });
        }
      }
      return [...found.values()].slice(0, limit);
    });
  }

  async #allKeys() {
    const keys = new Set(this.docs.keys());
    const files = await this.fs.readdir(this.docsDir).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      const key = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (KEY_PATTERN.test(key)) keys.add(key);
    }
    return keys;
  }

  #mutate(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  #key(key) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw memoryError('MEMORY_INVALID', 'Unknown document memory key');
    return key;
  }

  #newKey() {
    let key;
    do key = `dm_${base36(16, this.random)}`;
    while (this.docs.has(key) || Object.values(this.index?.documents ?? {}).includes(key));
    return key;
  }

  #newEntryId(entries) {
    let id;
    do id = `mem_${base36(12, this.random)}`;
    while (entries.some((entry) => entry.id === id));
    return id;
  }

  async #commit(doc, entries) {
    const next = { ...doc, entries: entries.map(readStoredEntry).filter(Boolean), revision: doc.revision + 1 };
    // 색인이 먼저다 — 문서 파일을 쓰기 전에 멈추면 색인이 가리키는 기억은 빈 것으로 읽힌다.
    if (this.indexDirty) await this.#writeIndex();
    await this.#writeDoc(next);
    Object.assign(doc, next);
  }

  async #readJson(file, maxBytes) {
    await recoverInterruptedFileReplacement(file, { platform: this.platform, fsApi: this.fs });
    let stat;
    try {
      stat = await this.fs.lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw memoryError('MEMORY_CORRUPT', `${path.basename(file)} must be a regular file`);
    if (stat.size > maxBytes) throw memoryError('MEMORY_CORRUPT', `${path.basename(file)} is too large`);
    return JSON.parse(await this.fs.readFile(file, 'utf8'));
  }

  async #loadIndex() {
    if (this.index) return this.index;
    let raw = null;
    try {
      raw = await this.#readJson(this.indexPath, MAX_INDEX_BYTES);
    } catch {
      raw = undefined;
    }
    const valid = raw && raw.schemaVersion === SCHEMA_VERSION
      && isPlainObject(raw.documents) && isPlainObject(raw.repositories) && isPlainObject(raw.digests);
    if (valid) {
      const index = emptyIndex();
      for (const field of ['documents', 'repositories', 'digests']) {
        for (const [id, key] of Object.entries(raw[field])) if (KEY_PATTERN.test(key)) index[field][id] = key;
      }
      this.index = index;
    } else {
      // 없거나 깨진 색인은 문서 파일들의 정체성에서 다시 세운다 — 기억을 잃지 않는다.
      this.index = await this.#rebuildIndex();
      if (raw !== null) this.indexDirty = true;
    }
    return this.index;
  }

  async #rebuildIndex() {
    const index = emptyIndex();
    const files = await this.fs.readdir(this.docsDir).catch(() => []);
    for (const file of files) {
      const key = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!KEY_PATTERN.test(key)) continue;
      const doc = await this.#loadDoc(key).catch(() => null);
      if (!doc) continue;
      for (const id of doc.documentIds) index.documents[id] = key;
      if (doc.repositoryId) index.repositories[doc.repositoryId] = key;
      if (doc.digest) index.digests[doc.digest] = key;
    }
    return index;
  }

  async #loadDoc(key) {
    const cached = this.docs.get(key);
    if (cached) return cached;
    const raw = await this.#readJson(path.join(this.docsDir, `${key}.json`), MAX_DOC_BYTES);
    let doc;
    if (raw === null) {
      doc = emptyDoc(key);
    } else {
      if (!isPlainObject(raw) || raw.schemaVersion !== SCHEMA_VERSION || raw.key !== key
        || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !Array.isArray(raw.entries)) {
        throw memoryError('MEMORY_CORRUPT', 'The document memory file cannot be read');
      }
      const entries = [];
      for (const value of raw.entries) {
        const entry = readStoredEntry(value);
        if (entry && !entries.some((known) => known.id === entry.id)) entries.push(entry);
      }
      doc = {
        schemaVersion: SCHEMA_VERSION,
        key,
        revision: raw.revision,
        documentIds: Array.isArray(raw.documentIds)
          ? raw.documentIds.filter((id) => typeof id === 'string' && id).slice(-MAX_DOCUMENT_IDS)
          : [],
        ...(optionalIdentity(raw.repositoryId, 128, REPOSITORY_ID_PATTERN) ? { repositoryId: raw.repositoryId } : {}),
        ...(optionalIdentity(raw.fileName, 500) ? { fileName: raw.fileName } : {}),
        ...(optionalIdentity(raw.digest, 200) ? { digest: raw.digest } : {}),
        entries: entries.slice(0, MAX_MEMORY_ENTRIES),
      };
    }
    this.docs.set(key, doc);
    return doc;
  }

  async #writeDoc(doc) {
    await this.#writeAtomic(path.join(this.docsDir, `${doc.key}.json`), doc);
  }

  async #writeIndex() {
    await this.#writeAtomic(this.indexPath, this.index);
    this.indexDirty = false;
  }

  async #writeAtomic(target, value) {
    await this.fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      await this.fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, target, { platform: this.platform, fsApi: this.fs });
    } catch (error) {
      await this.fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** 누가 남긴 기억인가 — 사용자가 시트에서 고침 · 사용자 요청으로 에이전트가 기록 · 자동 학습. */
const ORIGIN_TAGS = Object.freeze({ user: '직접', explicit: '요청', learned: '학습' });

function blockText(value) {
  // 기억은 사용자가 고른 글이지만 블록을 닫지 못하게 한다.
  return String(value).replace(/<(\s*)\/(\s*document_memory)/gi, '<$1\\/$2');
}

/**
 * 턴에 싣는 <document_memory> 블록. 비었으면 '' — 단, emptied 면 앞서 보낸 기억이 모두 지워졌음을 알린다.
 * excludeIds 는 매인 글이 문서에서 사라진 항목이다.
 */
export function documentMemoryPromptBlock(memory, { excludeIds = [], emptied = false, budget = DOCUMENT_MEMORY_PROMPT_BUDGET } = {}) {
  const excluded = new Set(excludeIds);
  const all = Array.isArray(memory?.entries) ? memory.entries : [];
  const entries = all.filter((entry) => !excluded.has(entry.id));
  const omitted = all.filter((entry) => excluded.has(entry.id)).map((entry) => entry.id);
  if (entries.length === 0 && omitted.length === 0 && !emptied) return '';
  const lines = [
    `<document_memory revision="${Number(memory?.revision) || 0}">`,
    'Notes on this document, the user\'s preferences unless the current request conflicts. Follow them when you write or edit the document, not in chat replies. Tags: 직접 user-edited, 요청 saved on request, 학습 learned. Replaces any earlier document_memory block.',
  ];
  let used = 0;
  const subjectsOnly = [];
  for (const entry of entries) {
    const anchor = entry.anchor?.quote ? `, anchor "${blockText(entry.anchor.quote)}"` : '';
    const line = `- [${entry.kind}, ${ORIGIN_TAGS[entry.origin] ?? ORIGIN_TAGS.user}] ${blockText(entry.text)}  (${entry.id}${anchor})`;
    if (used + line.length > budget) {
      subjectsOnly.push(`${blockText(entry.subject)} (${entry.id})`);
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  if (subjectsOnly.length) lines.push(`More notes, subjects only (read_document_memory returns their text): ${subjectsOnly.join('; ')}`);
  if (omitted.length) lines.push(`Omitted because their anchored text is no longer in the document: ${omitted.join(', ')}`);
  if (entries.length === 0 && omitted.length === 0) lines.push('No notes are recorded for this document now.');
  lines.push('</document_memory>');
  return lines.join('\n');
}
