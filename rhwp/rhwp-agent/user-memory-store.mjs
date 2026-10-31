/**
 * 기억 — 문서를 넘어 사용자 한 사람에게 붙는 Rau-0.1 규칙 저장소 (계정 단계).
 *
 * 문서 기억(document-memory-store.mjs)이 문서마다의 메모라면, 기억은 여러 문서에서 거듭 보인 사용자의 글 습관이다.
 * 규칙은 문체(style)·용어(term) 두 가지이고 주제마다 하나뿐이며, 강도 1–5 를 갖는다.
 * - 보강: 같은 습관을 다시 배우면 +1 (상한 5). 문체 학습(업로드)은 그 습관을 보인 파일 수만큼.
 * - 감쇄: 규칙이 부른 글을 사용자가 거절·고쳐 쓰기·되돌리면 −1, 분명히 반대하면 −2. 0 이 되면 물러난다.
 * - 기억 승격: 같은 문서 메모가 두 문서 이상에서 보이면 규칙이 되고 문서 메모는 규칙으로 접힌다.
 * - 뒤집힘: 규칙과 다른 습관이 두 문서 이상에서 거듭 보이면 그만큼 감쇄하고, 0 이 되면 그 습관이 자리를 잇는다.
 * - 물러난 규칙은 지우지 않고 최근 30개를 남긴다(되살릴 수 있다). 사용자가 지웠거나 승격을 되돌린 규칙은
 *   스스로 다시 승격하지 않는다.
 * 사용자가 만들거나 고친 규칙(origin user)은 분명한 반대로만 감쇄한다.
 *
 * 파일 (문서 기억 폴더의 user-memory.json): {schemaVersion:1, revision, rules, retired, events, uploads, legacy}
 * 모든 변경은 한 큐를 지나 임시 파일 + rename 으로 원자적으로 쓴다. 변경마다 사건(events)을 남겨 되돌린다.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { canonicalSubject, preferenceText } from './document-memory-store.mjs';
import { recoverInterruptedFileReplacement, replaceFileAtomically } from './harness-update.mjs';

export const USER_MEMORY_KINDS = Object.freeze(['style', 'term']);
export const MAX_USER_RULES = 60;
export const MAX_RETIRED_RULES = 30;
export const MAX_STRENGTH = 5;
export const MAX_RULE_TEXT_CHARS = 300;
export const MAX_RULE_SUBJECT_CHARS = 60;
/** 프롬프트에 본문까지 싣는 양. 넘으면 주제만 적는다. */
export const USER_MEMORY_PROMPT_BUDGET = 2_000;
/** 스튜디오에 보여 주는 최근 변화의 수. 되돌리기는 저장된 사건(MAX_EVENTS) 안에서 된다. */
export const USER_MEMORY_VISIBLE_EVENTS = 20;

const FILE = 'user-memory.json';
const SCHEMA_VERSION = 1;
const MAX_EVENTS = 60;
const MAX_UPLOADS = 10;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DOC_KEYS = 64;
const MAX_UPLOAD_NAMES = 20;
const RULE_ID_PATTERN = /^rule_[a-z0-9]{12}$/;
const EVENT_ID_PATTERN = /^evt_[a-z0-9]{12}$/;
const ORIGINS = new Set(['learned', 'upload', 'user']);
const RETIRE_REASONS = new Set(['dampened', 'flipped', 'evicted', 'deleted', 'undone']);
/** 스스로 다시 승격하지 않는 물러남 — 사용자가 지웠거나 승격을 되돌렸다. */
const BLOCKING_REASONS = new Set(['deleted', 'undone']);
const EVENT_KINDS = new Set(['new', 'reinforced', 'dampened', 'escalated', 'retired', 'restored', 'edited', 'deleted']);
const EVENT_SOURCES = new Set(['chat', 'upload', 'user']);
const KIND_LABELS = Object.freeze({ style: '문체', term: '용어' });

export class UserMemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserMemoryError';
    this.code = code;
  }
}

function memoryError(code, message) {
  return new UserMemoryError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function base36(length, random) {
  const bytes = random(length);
  let out = '';
  for (let index = 0; index < length; index += 1) out += (bytes[index] % 36).toString(36);
  return out;
}

function clampStrength(value) {
  return Math.max(0, Math.min(MAX_STRENGTH, Math.round(Number(value) || 0)));
}

function cleanLine(value, max, label) {
  if (typeof value !== 'string') throw memoryError('USER_MEMORY_INVALID', `${label} must be text`);
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) throw memoryError('USER_MEMORY_INVALID', `${label} is empty`);
  if (text.length > max) throw memoryError('USER_MEMORY_INVALID', `${label} may not exceed ${max} characters`);
  return text;
}

function normalizeKind(value) {
  if (!USER_MEMORY_KINDS.includes(value)) throw memoryError('USER_MEMORY_INVALID', `kind must be one of ${USER_MEMORY_KINDS.join(', ')}`);
  return value;
}

function deriveSubject(kind, text) {
  return `${KIND_LABELS[kind] ?? kind}.${text}`.slice(0, MAX_RULE_SUBJECT_CHARS).trim();
}

function isoOr(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function docKeys(value) {
  return Array.isArray(value) ? [...new Set(value.filter((key) => typeof key === 'string' && /^dm_[a-z0-9]{16}$/.test(key)))].slice(-MAX_DOC_KEYS) : [];
}

/** 저장된 규칙 하나를 정규형으로. 모양이 틀리면 null. */
function readRule(value, { retired = false } = {}) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !RULE_ID_PATTERN.test(value.id)) return null;
  try {
    const kind = normalizeKind(value.kind);
    const text = cleanLine(value.text, MAX_RULE_TEXT_CHARS, 'text');
    const rule = {
      id: value.id,
      kind,
      subject: typeof value.subject === 'string' && value.subject.trim()
        ? cleanLine(value.subject, MAX_RULE_SUBJECT_CHARS, 'subject')
        : deriveSubject(kind, text),
      text,
      strength: clampStrength(value.strength),
      origin: ORIGINS.has(value.origin) ? value.origin : 'learned',
      docKeys: docKeys(value.docKeys),
      uploads: Number.isSafeInteger(value.uploads) && value.uploads > 0 ? value.uploads : 0,
      overrides: {},
      rev: Number.isSafeInteger(value.rev) && value.rev > 0 ? value.rev : 1,
    };
    if (!retired && rule.strength < 1) rule.strength = 1;
    if (isPlainObject(value.overrides)) {
      for (const [pref, override] of Object.entries(value.overrides)) {
        if (!isPlainObject(override) || typeof override.text !== 'string') continue;
        const keys = docKeys(override.keys);
        if (keys.length) rule.overrides[pref] = { text: override.text.slice(0, MAX_RULE_TEXT_CHARS), keys };
      }
    }
    const epoch = new Date(0).toISOString();
    rule.createdAt = isoOr(value.createdAt, epoch);
    rule.updatedAt = isoOr(value.updatedAt, rule.createdAt);
    if (retired) {
      rule.retiredAt = isoOr(value.retiredAt, rule.updatedAt);
      rule.reason = RETIRE_REASONS.has(value.reason) ? value.reason : 'dampened';
    }
    return rule;
  } catch {
    return null;
  }
}

function readEvent(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !EVENT_ID_PATTERN.test(value.id)) return null;
  if (!EVENT_KINDS.has(value.kind) || typeof value.ruleId !== 'string' || !RULE_ID_PATTERN.test(value.ruleId)) return null;
  const state = (raw) => (isPlainObject(raw)
    ? { rule: raw.rule ? readRule(raw.rule) : null, retired: raw.retired ? readRule(raw.retired, { retired: true }) : null }
    : { rule: null, retired: null });
  const event = {
    id: value.id,
    at: isoOr(value.at, new Date(0).toISOString()),
    kind: value.kind,
    ruleId: value.ruleId,
    ruleKind: USER_MEMORY_KINDS.includes(value.ruleKind) ? value.ruleKind : 'style',
    text: typeof value.text === 'string' ? value.text.slice(0, MAX_RULE_TEXT_CHARS) : '',
    source: EVENT_SOURCES.has(value.source) ? value.source : 'chat',
    before: state(value.before),
    after: state(value.after),
  };
  if (typeof value.prevText === 'string' && value.prevText) event.prevText = value.prevText.slice(0, MAX_RULE_TEXT_CHARS);
  if (isPlainObject(value.strength)) event.strength = { from: clampStrength(value.strength.from), to: clampStrength(value.strength.to) };
  if (typeof value.documentName === 'string' && value.documentName) event.documentName = value.documentName.slice(0, 200);
  if (Array.isArray(value.folded)) {
    event.folded = value.folded.filter((item) => isPlainObject(item) && typeof item.key === 'string' && isPlainObject(item.entry)).slice(0, MAX_DOC_KEYS);
  }
  if (value.undone === true) event.undone = true;
  return event;
}

function readUpload(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string') return null;
  const counts = isPlainObject(value.counts) ? value.counts : {};
  const count = (field) => (Number.isSafeInteger(counts[field]) && counts[field] >= 0 ? counts[field] : 0);
  return {
    id: value.id.slice(0, 40),
    at: isoOr(value.at, new Date(0).toISOString()),
    files: Array.isArray(value.files) ? value.files.filter((name) => typeof name === 'string').map((name) => name.slice(0, 512)).slice(0, MAX_UPLOAD_NAMES) : [],
    counts: { new: count('new'), reinforced: count('reinforced'), dampened: count('dampened'), conflicts: count('conflicts') },
  };
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, rules: [], retired: [], events: [], uploads: [], legacy: {} };
}

/** 같은 규칙인가 — 되돌리기는 사건 뒤의 모습이 지금도 그대로일 때만 한다. */
function sameRule(a, b) {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.rev === b.rev && a.text === b.text && a.strength === b.strength;
}

/** 공개 모양 — 내부 칸(docKeys·overrides·rev)을 뺀다. */
function publicRule(rule) {
  const out = {
    id: rule.id,
    kind: rule.kind,
    subject: rule.subject,
    text: rule.text,
    strength: rule.strength,
    origin: rule.origin,
    documents: rule.docKeys.length,
    uploads: rule.uploads,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
  if (rule.retiredAt) Object.assign(out, { retiredAt: rule.retiredAt, reason: rule.reason });
  return out;
}

function byStrength(a, b) {
  return b.strength - a.strength || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

export class UserMemoryStore {
  constructor({ dir, fsApi = fs, now = () => new Date().toISOString(), random = crypto.randomBytes, platform = process.platform } = {}) {
    if (!dir) throw new Error('UserMemoryStore needs a directory');
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.fs = fsApi;
    this.now = now;
    this.random = random;
    this.platform = platform;
    /** @type {ReturnType<typeof emptyState> | null} */
    this.state = null;
    this.queue = Promise.resolve();
  }

  // ── 읽기 ──

  /** 지금 상태의 사본 (내부 칸 포함). */
  read() {
    return this.#mutate(async () => clone(await this.#load()));
  }

  /** 이미 읽어 둔 상태 (동기). 아직 읽지 않았으면 null. */
  peek() {
    return this.state ? clone(this.state) : null;
  }

  /** Studio 에 보내는 모양. */
  snapshot() {
    return this.#mutate(async () => {
      const state = await this.#load();
      return this.#publicSnapshot(state);
    });
  }

  /** 주제가 같은 지금 규칙. */
  activeBySubject(state, subject) {
    const wanted = canonicalSubject(subject);
    return wanted ? state.rules.find((rule) => canonicalSubject(rule.subject) === wanted) ?? null : null;
  }

  // ── 학습 (Rau-0.1) ──

  /**
   * 보강 — 같은 습관을 다시 보았다. docKey 는 그 습관을 보인 문서다(승격 수를 센다).
   * 강도가 이미 상한이면 사건을 남기지 않는다.
   */
  reinforce(ruleId, { by = 1, source = 'chat', documentName, docKeys: keys = [] } = {}) {
    return this.#write((state, txn) => {
      const rule = state.rules.find((candidate) => candidate.id === ruleId);
      if (!rule) return null;
      const before = clone(rule);
      const added = docKeys(keys).filter((key) => !rule.docKeys.includes(key));
      const strength = Math.min(MAX_STRENGTH, rule.strength + Math.max(1, by));
      if (strength === rule.strength && added.length === 0) return null;
      rule.docKeys = docKeys([...rule.docKeys, ...added]);
      if (strength !== rule.strength) {
        rule.strength = strength;
        rule.rev += 1;
        rule.updatedAt = txn.stamp;
        return txn.event({ kind: 'reinforced', rule, before: { rule: before }, after: { rule }, source, documentName });
      }
      // 상한에서는 문서 수만 센다 — 보여 줄 변화가 없다.
      txn.quiet();
      return null;
    });
  }

  /**
   * 감쇄 — 규칙이 부른 글이 거절·고쳐 쓰기·되돌림을 받았거나 사용자가 반대했다. 0 이 되면 물러난다.
   * strong 은 분명한 반대(−2)다. 사용자가 만든 규칙은 strong 일 때만 감쇄한다.
   */
  dampen(ruleId, { strong = false, by, source = 'chat', documentName, reason = 'dampened' } = {}) {
    return this.#write((state, txn) => {
      const rule = state.rules.find((candidate) => candidate.id === ruleId);
      if (!rule) return null;
      if (rule.origin === 'user' && !strong) return null;
      const step = by ?? (strong ? 2 : 1);
      return this.#lower(state, txn, rule, step, { source, documentName, reason });
    });
  }

  /**
   * 기억 승격 — 문서 메모가 여러 문서에서 같은 습관으로 보였다. 같은 주제·같은 습관의 규칙이 있으면 새 문서만큼 보강하고,
   * 없으면 문서 수를 강도로 새 규칙을 만든다. folded 는 규칙으로 접힌 문서 메모({key, entry}) — 되돌리면 되살린다.
   * @returns {Promise<{ event: object, rule: object } | null>}
   */
  escalate({ kind, subject, text, docKeys: keys, documentName, folded = [], source = 'chat' }) {
    return this.#write((state, txn) => {
      const cleanKind = normalizeKind(kind);
      const cleanText = cleanLine(text, MAX_RULE_TEXT_CHARS, 'text');
      const cleanSubject = typeof subject === 'string' && subject.trim() ? cleanLine(subject, MAX_RULE_SUBJECT_CHARS, 'subject') : deriveSubject(cleanKind, cleanText);
      const sources = docKeys(keys);
      const existing = this.activeBySubject(state, cleanSubject);
      if (existing && preferenceText(existing.text) === preferenceText(cleanText)) {
        const before = clone(existing);
        const added = sources.filter((key) => !existing.docKeys.includes(key));
        existing.docKeys = docKeys([...existing.docKeys, ...added]);
        existing.strength = Math.min(MAX_STRENGTH, existing.strength + Math.max(0, added.length));
        existing.rev += 1;
        existing.updatedAt = txn.stamp;
        const event = txn.event({ kind: 'escalated', rule: existing, before: { rule: before }, after: { rule: existing }, source, documentName, folded });
        return { event, rule: clone(existing) };
      }
      if (existing) throw memoryError('USER_MEMORY_SUBJECT_TAKEN', `Another rule already holds ${cleanSubject}`);
      // 같은 습관이 물러나 있었으면 다시 얻은 것이다 — 그 물러남은 지운다. 다른 습관의 물러남은 남긴다.
      const retired = this.#retiredBySubject(state, cleanSubject, cleanText);
      if (retired) state.retired = state.retired.filter((candidate) => candidate !== retired);
      const rule = this.#newRule(state, txn, {
        kind: cleanKind, subject: cleanSubject, text: cleanText, strength: Math.max(1, Math.min(MAX_STRENGTH, sources.length)), origin: 'learned', docKeys: sources,
      });
      const event = txn.event({ kind: 'escalated', rule, before: { rule: null, retired: retired ? clone(retired) : null }, after: { rule }, source, documentName, folded });
      return { event, rule: clone(rule) };
    });
  }

  /**
   * 문서가 규칙과 다른 습관을 보였다(문서 덮어쓰기). 첫 문서는 덮어쓰기일 뿐이고, 같은 습관을 보인 두 번째 문서부터
   * 새 문서마다 −1 이다. 0 이 되면 규칙은 물러나고(뒤집힘) flip 에 이어받을 습관을 돌려준다.
   * 사용자가 만든 규칙은 덮어쓰기로 감쇄하지 않는다.
   * @returns {Promise<{ dampened?: object, flip?: { text: string, kind: string, subject: string, keys: string[] } } | null>}
   */
  recordOverride(ruleId, { text, docKey, documentName }) {
    return this.#write((state, txn) => {
      const rule = state.rules.find((candidate) => candidate.id === ruleId);
      if (!rule || typeof text !== 'string' || !text.trim() || !/^dm_[a-z0-9]{16}$/.test(docKey ?? '')) return null;
      const pref = preferenceText(text);
      if (!pref || pref === preferenceText(rule.text)) return null;
      const override = rule.overrides[pref] ?? { text: text.slice(0, MAX_RULE_TEXT_CHARS), keys: [] };
      if (override.keys.includes(docKey)) return null;
      override.keys = docKeys([...override.keys, docKey]);
      override.text = text.slice(0, MAX_RULE_TEXT_CHARS);
      rule.overrides[pref] = override;
      if (override.keys.length < 2 || rule.origin === 'user') {
        txn.quiet();
        return null;
      }
      const event = this.#lower(state, txn, rule, 1, { source: 'chat', documentName, reason: 'flipped' });
      const flip = rule.strength <= 0 || !state.rules.includes(rule)
        ? { text: override.text, kind: rule.kind, subject: rule.subject, keys: [...override.keys] }
        : null;
      return { dampened: event, ...(flip ? { flip } : {}) };
    });
  }

  /** 스스로 다시 승격하지 않는 습관인가 — 사용자가 지웠거나 승격을 되돌린 같은 주제·같은 습관. */
  blocked(state, subject, text) {
    const wanted = canonicalSubject(subject);
    const pref = preferenceText(text);
    return state.retired.some((rule) => BLOCKING_REASONS.has(rule.reason)
      && canonicalSubject(rule.subject) === wanted && preferenceText(rule.text) === pref);
  }

  /** 같은 주제·같은 습관이 감쇄·뒤집힘·자리 부족으로 물러났으면 그 시각. 승격은 그 뒤의 문서만 센다. */
  retiredAt(state, subject, text) {
    const wanted = canonicalSubject(subject);
    const pref = preferenceText(text);
    const hit = state.retired.find((rule) => !BLOCKING_REASONS.has(rule.reason)
      && canonicalSubject(rule.subject) === wanted && preferenceText(rule.text) === pref);
    return hit ? hit.retiredAt : null;
  }

  // ── 문체 학습 (업로드) ──

  /**
   * 업로드에서 찾은 습관을 합친다. candidates 는 주제마다 하나 — {kind, subject, text, files} (files 는 그 습관을 보인 파일 수).
   * 같은 습관의 규칙은 files 만큼 보강, 다른 습관의 규칙은 files 만큼 감쇄(0 이면 물러나고 새 습관이 잇는다),
   * 사용자가 만든 규칙과 다르면 충돌로 남긴다. 사용자가 지운 습관은 다시 들이지 않는다.
   */
  applyUpload(candidates, { files = [], skippedFiles = [] } = {}) {
    return this.#write((state, txn) => {
      const summary = { new: [], reinforced: [], dampened: [], retired: [], conflicts: [], skippedFiles: [...skippedFiles] };
      const item = (rule, extra = {}) => ({ ruleId: rule.id, kind: rule.kind, subject: rule.subject, text: rule.text, ...extra });
      for (const raw of Array.isArray(candidates) ? candidates : []) {
        let kind;
        let text;
        let subject;
        try {
          kind = normalizeKind(raw.kind);
          text = cleanLine(raw.text, MAX_RULE_TEXT_CHARS, 'text');
          subject = typeof raw.subject === 'string' && raw.subject.trim()
            ? cleanLine(raw.subject.slice(0, MAX_RULE_SUBJECT_CHARS), MAX_RULE_SUBJECT_CHARS, 'subject')
            : deriveSubject(kind, text);
        } catch {
          continue;
        }
        const count = Math.max(1, Math.min(MAX_STRENGTH, Number(raw.files) || 1));
        const existing = this.activeBySubject(state, subject);
        if (existing && preferenceText(existing.text) === preferenceText(text)) {
          const before = clone(existing);
          const from = existing.strength;
          existing.strength = Math.min(MAX_STRENGTH, existing.strength + count);
          existing.uploads += count;
          existing.rev += 1;
          existing.updatedAt = txn.stamp;
          if (existing.strength !== from) {
            txn.event({ kind: 'reinforced', rule: existing, before: { rule: before }, after: { rule: existing }, source: 'upload' });
          }
          summary.reinforced.push(item(existing, { strength: { from, to: existing.strength } }));
          continue;
        }
        if (existing && existing.origin === 'user') {
          summary.conflicts.push({ ruleId: existing.id, kind, subject, text, note: existing.text });
          continue;
        }
        // 사용자가 지운 습관은 다시 들이지 않고, 그것을 근거로 지금 규칙을 깎지도 않는다.
        if (this.blocked(state, subject, text)) {
          summary.conflicts.push({ kind, subject, text, note: 'deleted' });
          continue;
        }
        if (existing) {
          const from = existing.strength;
          const snapshot = clone(existing);
          this.#lower(state, txn, existing, count, { source: 'upload', reason: 'flipped' });
          if (state.rules.includes(existing)) {
            summary.dampened.push(item(existing, { strength: { from, to: existing.strength } }));
            continue;
          }
          summary.retired.push(item(snapshot, { strength: { from, to: 0 } }));
        }
        const retired = this.#retiredBySubject(state, subject, text);
        if (retired) state.retired = state.retired.filter((candidate) => candidate !== retired);
        const rule = this.#newRule(state, txn, { kind, subject, text, strength: count, origin: 'upload', uploads: count });
        txn.event({ kind: 'new', rule, before: { rule: null, retired: retired ? clone(retired) : null }, after: { rule }, source: 'upload' });
        summary.new.push(item(rule, { strength: { from: 0, to: rule.strength } }));
      }
      const record = {
        id: `upl_${base36(12, this.random)}`,
        at: txn.stamp,
        files: files.map((name) => String(name).slice(0, 512)).slice(0, MAX_UPLOAD_NAMES),
        counts: { new: summary.new.length, reinforced: summary.reinforced.length, dampened: summary.dampened.length + summary.retired.length, conflicts: summary.conflicts.length },
      };
      state.uploads = [record, ...state.uploads].slice(0, MAX_UPLOADS);
      txn.touch();
      return summary;
    });
  }

  // ── 사용자 (Rau 탭) ──

  addUserRule({ kind, text, subject } = {}) {
    return this.#write((state, txn) => {
      const cleanKind = normalizeKind(kind);
      const cleanText = cleanLine(text, MAX_RULE_TEXT_CHARS, 'text');
      const cleanSubject = typeof subject === 'string' && subject.trim() ? cleanLine(subject, MAX_RULE_SUBJECT_CHARS, 'subject') : deriveSubject(cleanKind, cleanText);
      if (this.activeBySubject(state, cleanSubject)) throw memoryError('USER_MEMORY_SUBJECT_TAKEN', 'A rule on that subject already exists; edit it instead.');
      const rule = this.#newRule(state, txn, { kind: cleanKind, subject: cleanSubject, text: cleanText, strength: 3, origin: 'user' });
      txn.event({ kind: 'new', rule, before: { rule: null }, after: { rule }, source: 'user' });
      return clone(rule);
    });
  }

  /** 사용자가 글·종류를 고쳤다. 그 뒤로는 사용자의 규칙이다. */
  editRule(id, { text, kind } = {}) {
    return this.#write((state, txn) => {
      const rule = state.rules.find((candidate) => candidate.id === id);
      if (!rule) throw memoryError('USER_MEMORY_NOT_FOUND', 'That rule no longer exists.');
      const before = clone(rule);
      const cleanText = text === undefined ? rule.text : cleanLine(text, MAX_RULE_TEXT_CHARS, 'text');
      const cleanKind = kind === undefined ? rule.kind : normalizeKind(kind);
      if (cleanText === rule.text && cleanKind === rule.kind) return clone(rule);
      Object.assign(rule, { text: cleanText, kind: cleanKind, origin: 'user', overrides: {}, rev: rule.rev + 1, updatedAt: txn.stamp });
      txn.event({ kind: 'edited', rule, before: { rule: before }, after: { rule }, source: 'user', prevText: before.text !== rule.text ? before.text : undefined });
      return clone(rule);
    });
  }

  deleteRule(id) {
    return this.#write((state, txn) => {
      const rule = state.rules.find((candidate) => candidate.id === id);
      if (!rule) throw memoryError('USER_MEMORY_NOT_FOUND', 'That rule no longer exists.');
      const before = clone(rule);
      const retired = this.#retire(state, txn, rule, 'deleted');
      txn.event({ kind: 'deleted', rule: before, before: { rule: before }, after: { rule: null, retired }, source: 'user', strength: { from: before.strength, to: 0 } });
      return clone(retired);
    });
  }

  /** 물러난 규칙을 되살린다. 같은 주제의 규칙이 이미 있으면 되살리지 않는다. */
  restore(id) {
    return this.#write((state, txn) => {
      const retired = state.retired.find((candidate) => candidate.id === id);
      if (!retired) throw memoryError('USER_MEMORY_NOT_FOUND', 'That rule is no longer in the retired list.');
      if (this.activeBySubject(state, retired.subject)) {
        throw memoryError('USER_MEMORY_SUBJECT_TAKEN', 'Another rule now holds that subject; edit or delete it first.');
      }
      const before = clone(retired);
      state.retired = state.retired.filter((candidate) => candidate !== retired);
      const rule = { ...clone(retired), strength: Math.max(1, retired.strength), rev: retired.rev + 1, updatedAt: txn.stamp, overrides: {} };
      delete rule.retiredAt;
      delete rule.reason;
      this.#makeRoom(state, txn);
      state.rules.push(rule);
      txn.event({ kind: 'restored', rule, before: { rule: null, retired: before }, after: { rule }, source: 'user', strength: { from: 0, to: rule.strength } });
      return clone(rule);
    });
  }

  /**
   * 사건 하나를 되돌린다 — 그 뒤 규칙이 다시 바뀌었으면 하지 않는다. 승격을 되돌리면 규칙은 '되돌림'으로 물러나
   * 스스로 다시 승격하지 않고, 접혔던 문서 메모는 돌려준다(호출한 쪽이 문서 기억에 되살린다).
   * @returns {Promise<{ undone: boolean, folded: {key: string, entry: object}[] }>}
   */
  undo(eventId) {
    return this.#write((state, txn) => {
      const event = state.events.find((candidate) => candidate.id === eventId);
      if (!event || event.undone) return { undone: false, folded: [] };
      if (!this.#undoable(state, event)) return { undone: false, folded: [] };
      const current = state.rules.find((rule) => rule.id === event.ruleId) ?? null;
      const currentRetired = state.retired.find((rule) => rule.id === event.ruleId) ?? null;
      if (current) state.rules = state.rules.filter((rule) => rule !== current);
      if (currentRetired) state.retired = state.retired.filter((rule) => rule !== currentRetired);
      if (event.before.rule) {
        // 사건 앞의 모습 그대로 둔다 — 그 앞의 사건도 차례로 되돌릴 수 있게.
        this.#makeRoom(state, txn);
        state.rules.push(clone(event.before.rule));
      } else if (event.before.retired) {
        state.retired.unshift(clone(event.before.retired));
      }
      if (event.kind === 'escalated' && !event.before.rule) {
        // 승격을 되돌렸다 — 같은 습관이 다음 턴에 곧바로 다시 올라오지 않게 '되돌림'으로 남긴다.
        const undone = event.after.rule ?? current;
        if (undone) state.retired.unshift({ ...clone(undone), strength: 0, retiredAt: txn.stamp, reason: 'undone' });
      }
      state.retired = state.retired.slice(0, MAX_RETIRED_RULES);
      event.undone = true;
      txn.touch();
      return { undone: true, folded: event.kind === 'escalated' ? clone(event.folded ?? []) : [] };
    });
  }

  // ── 옛 말투 맞추기 옮기기 표시 ──

  legacyState() {
    return this.#mutate(async () => ({ ...(await this.#load()).legacy }));
  }

  setLegacyState(patch) {
    return this.#write((state, txn) => {
      state.legacy = { ...state.legacy, ...patch };
      txn.touch({ revision: false });
      return { ...state.legacy };
    });
  }

  // ── 내부 ──

  #publicSnapshot(state) {
    const events = state.events.slice(0, USER_MEMORY_VISIBLE_EVENTS).map((event) => {
      const out = {
        id: event.id,
        at: event.at,
        kind: event.kind,
        ruleId: event.ruleId,
        ruleKind: event.ruleKind,
        text: event.text,
        source: event.source,
        undoable: !event.undone && this.#undoable(state, event),
      };
      if (event.prevText) out.prevText = event.prevText;
      if (event.strength) out.strength = { ...event.strength };
      if (event.documentName) out.documentName = event.documentName;
      return out;
    });
    const learned = state.events.find((event) => event.source !== 'user');
    return {
      revision: state.revision,
      rules: [...state.rules].sort(byStrength).map(publicRule),
      retired: state.retired.map(publicRule),
      events,
      uploads: state.uploads.map(clone),
      lastLearnedAt: learned?.at ?? null,
    };
  }

  #undoable(state, event) {
    const current = state.rules.find((rule) => rule.id === event.ruleId) ?? null;
    const currentRetired = state.retired.find((rule) => rule.id === event.ruleId) ?? null;
    if (!sameRule(current, event.after.rule ?? null)) return false;
    if (event.after.retired && !sameRule(currentRetired, event.after.retired)) return false;
    // 되살릴 자리가 남의 것이 됐으면(같은 주제의 다른 규칙) 되돌리지 않는다.
    const restoring = event.before.rule;
    if (restoring && state.rules.some((rule) => rule.id !== restoring.id && canonicalSubject(rule.subject) === canonicalSubject(restoring.subject))) return false;
    return true;
  }

  #retiredBySubject(state, subject, text) {
    const wanted = canonicalSubject(subject);
    const pref = preferenceText(text);
    return state.retired.find((rule) => canonicalSubject(rule.subject) === wanted && preferenceText(rule.text) === pref) ?? null;
  }

  #newRule(state, txn, { kind, subject, text, strength, origin, docKeys: keys = [], uploads = 0 }) {
    this.#makeRoom(state, txn);
    let id;
    do id = `rule_${base36(12, this.random)}`;
    while (state.rules.some((rule) => rule.id === id) || state.retired.some((rule) => rule.id === id));
    const rule = {
      id, kind, subject, text,
      strength: Math.max(1, Math.min(MAX_STRENGTH, strength)),
      origin, docKeys: docKeys(keys), uploads, overrides: {}, rev: 1,
      createdAt: txn.stamp, updatedAt: txn.stamp,
    };
    state.rules.push(rule);
    return rule;
  }

  /** 자리가 없으면 가장 약하고 오래된 규칙을 물린다 — 사용자의 규칙은 마지막에. */
  #makeRoom(state, txn) {
    while (state.rules.length >= MAX_USER_RULES) {
      const pool = state.rules.some((rule) => rule.origin !== 'user') ? state.rules.filter((rule) => rule.origin !== 'user') : state.rules;
      const weakest = [...pool].sort((a, b) => a.strength - b.strength || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
      const before = clone(weakest);
      const retired = this.#retire(state, txn, weakest, 'evicted');
      txn.event({ kind: 'retired', rule: before, before: { rule: before }, after: { rule: null, retired }, source: 'chat', strength: { from: before.strength, to: 0 } });
    }
  }

  #retire(state, txn, rule, reason) {
    state.rules = state.rules.filter((candidate) => candidate !== rule);
    const retired = { ...clone(rule), retiredAt: txn.stamp, reason, rev: rule.rev + 1, updatedAt: txn.stamp };
    state.retired = [retired, ...state.retired.filter((candidate) => candidate.id !== rule.id)].slice(0, MAX_RETIRED_RULES);
    return clone(retired);
  }

  /** 강도를 step 만큼 낮춘다. 0 이 되면 reason 으로 물러난다. 남긴 사건을 돌려준다. */
  #lower(state, txn, rule, step, { source, documentName, reason }) {
    const before = clone(rule);
    const strength = Math.max(0, rule.strength - Math.max(1, step));
    if (strength <= 0) {
      const retired = this.#retire(state, txn, rule, reason === 'flipped' ? 'flipped' : 'dampened');
      return txn.event({ kind: 'retired', rule: before, before: { rule: before }, after: { rule: null, retired }, source, documentName, strength: { from: before.strength, to: 0 } });
    }
    rule.strength = strength;
    rule.rev += 1;
    rule.updatedAt = txn.stamp;
    return txn.event({ kind: 'dampened', rule, before: { rule: before }, after: { rule }, source, documentName });
  }

  /**
   * 한 번의 변경. fn(state, txn) 이 상태를 고치고 txn.event 로 사건을 남긴다. 사건이나 touch 가 있을 때만 쓴다.
   * 실패하면 아무것도 바뀌지 않는다.
   */
  #write(fn) {
    return this.#mutate(async () => {
      const loaded = await this.#load();
      const state = clone(loaded);
      const stamp = this.now();
      let dirty = false;
      let bump = false;
      const txn = {
        stamp,
        touch: ({ revision = true } = {}) => { dirty = true; if (revision) bump = true; },
        quiet: () => { dirty = true; },
        event: ({ kind, rule, before, after, source, documentName, folded, prevText, strength }) => {
          let id;
          do id = `evt_${base36(12, this.random)}`;
          while (state.events.some((event) => event.id === id));
          const event = {
            id,
            at: stamp,
            kind,
            ruleId: rule.id,
            ruleKind: rule.kind,
            text: rule.text,
            source: EVENT_SOURCES.has(source) ? source : 'chat',
            before: { rule: clone(before?.rule ?? null), retired: clone(before?.retired ?? null) },
            after: { rule: clone(after?.rule ?? null), retired: clone(after?.retired ?? null) },
            strength: strength ?? { from: before?.rule?.strength ?? 0, to: after?.rule?.strength ?? 0 },
          };
          if (prevText) event.prevText = prevText;
          if (documentName) event.documentName = String(documentName).slice(0, 200);
          if (folded?.length) event.folded = clone(folded);
          state.events = [event, ...state.events].slice(0, MAX_EVENTS);
          dirty = true;
          bump = true;
          return { id: event.id, kind, ruleId: rule.id, ruleKind: rule.kind, text: rule.text, strength: { ...event.strength } };
        },
      };
      const result = await fn(state, txn);
      if (dirty) {
        if (bump) state.revision += 1;
        await this.#save(state);
        this.state = state;
      }
      return result;
    });
  }

  #mutate(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async #load() {
    if (this.state) return this.state;
    let raw = null;
    try {
      await recoverInterruptedFileReplacement(this.file, { platform: this.platform, fsApi: this.fs });
      const stat = await this.fs.lstat(this.file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES) raw = JSON.parse(await this.fs.readFile(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    const state = emptyState();
    if (isPlainObject(raw) && raw.schemaVersion === SCHEMA_VERSION) {
      state.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
      const seen = new Set();
      for (const value of Array.isArray(raw.rules) ? raw.rules : []) {
        const rule = readRule(value);
        if (!rule || seen.has(rule.id) || state.rules.some((other) => canonicalSubject(other.subject) === canonicalSubject(rule.subject))) continue;
        seen.add(rule.id);
        state.rules.push(rule);
      }
      state.rules = state.rules.slice(0, MAX_USER_RULES);
      for (const value of Array.isArray(raw.retired) ? raw.retired : []) {
        const rule = readRule(value, { retired: true });
        if (rule && !seen.has(rule.id)) {
          seen.add(rule.id);
          state.retired.push(rule);
        }
      }
      state.retired = state.retired.slice(0, MAX_RETIRED_RULES);
      state.events = (Array.isArray(raw.events) ? raw.events : []).map(readEvent).filter(Boolean).slice(0, MAX_EVENTS);
      state.uploads = (Array.isArray(raw.uploads) ? raw.uploads : []).map(readUpload).filter(Boolean).slice(0, MAX_UPLOADS);
      if (isPlainObject(raw.legacy)) {
        for (const [field, value] of Object.entries(raw.legacy)) if (typeof value === 'boolean') state.legacy[field] = value;
      }
    }
    this.state = state;
    return state;
  }

  async #save(state) {
    await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dir, `.${FILE}.tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      await this.fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, this.file, { platform: this.platform, fsApi: this.fs });
    } catch (error) {
      await this.fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function blockText(value) {
  return String(value).replace(/<(\s*)\/(\s*user_memory)/gi, '<$1\\/$2');
}

/**
 * 턴에 싣는 <user_memory> 블록. 규칙이 없으면 '' — 단, emptied 면 앞서 보낸 기억이 이제 없다고 알린다.
 * 강한 규칙부터 싣고 budget 을 넘으면 주제만 적는다.
 */
export function userMemoryPromptBlock(snapshot, { emptied = false, budget = USER_MEMORY_PROMPT_BUDGET } = {}) {
  const rules = Array.isArray(snapshot?.rules) ? [...snapshot.rules].sort(byStrength) : [];
  if (rules.length === 0 && !emptied) return '';
  const lines = [
    `<user_memory revision="${Number(snapshot?.revision) || 0}">`,
    'The user\'s own writing habits, learned across documents by Rau-0.1. Follow them when you write or edit document text, not in chat replies. app_agents_md outranks them, and a document_memory note on the same subject outranks them for that document. Strength runs 1-5: higher is better established. Replaces any earlier user_memory block.',
  ];
  let used = 0;
  const subjectsOnly = [];
  for (const rule of rules) {
    const line = `- [${KIND_LABELS[rule.kind] ?? rule.kind}, 강도 ${rule.strength}] ${blockText(rule.text)}`;
    if (used + line.length > budget) {
      subjectsOnly.push(blockText(rule.subject));
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  if (subjectsOnly.length) lines.push(`More habits, subjects only (read_document_memory returns their text): ${subjectsOnly.join('; ')}`);
  if (rules.length === 0) lines.push('No user habits apply now.');
  lines.push('</user_memory>');
  return lines.join('\n');
}
