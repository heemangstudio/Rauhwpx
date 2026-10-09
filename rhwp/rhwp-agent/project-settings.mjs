import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { replaceFileAtomically } from './harness-update.mjs';

/**
 * 설정 → 프로젝트. 모든 프로젝트에 공통으로 적용되는 전역 기본값이며, 허브의
 * `…/rhwp/projects/settings.json` 에 저장된다. 정리 도우미·가져오기·프롬프트 맥락이
 * 호출할 때마다 get() 으로 읽으므로 바꾼 값은 재시작 없이 적용된다.
 */

export const PROJECT_SETTINGS_VERSION = 1;
export const LIBRARIAN_PROVIDERS = Object.freeze(['chat', 'claude', 'codex', 'pi']);
export const SUMMARY_SIZES = Object.freeze(['small', 'medium', 'large']);
export const TRASH_DAYS = Object.freeze([7, 30, 90]);
const MAX_FILE_TYPES = 64;
const MAX_EXCLUDED_FOLDERS = 64;
const MAX_DEFAULT_COLUMNS = 12;
const MAX_SETTINGS_BYTES = 64 * 1024;

export const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  version: PROJECT_SETTINGS_VERSION,
  librarian: Object.freeze({
    enabled: true,
    provider: 'chat',
    model: null,
    effort: null,
    actions: Object.freeze({ rename: true, classify: true, link: true }),
    concurrency: 2,
  }),
  ingest: Object.freeze({
    homeSearch: true,
    fileTypes: Object.freeze([
      'pdf', 'hwp', 'hwpx', 'hml', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'html', 'htm',
      'png', 'jpg', 'jpeg', 'webp',
    ]),
    excludedFolders: Object.freeze([]),
    maxFileMb: 100,
  }),
  agent: Object.freeze({ chatMayEdit: true, summarySize: 'medium' }),
  board: Object.freeze({ defaultColumns: Object.freeze(['수집함', '검토 중', '핵심', '보류']), trashDays: 30 }),
});

/** 턴마다 붙는 프로젝트 요약의 글자 예산 (요약 / 언급한 항목 / 발췌). */
export const SUMMARY_BUDGETS = Object.freeze({
  small: Object.freeze({ summary: 1_500, mentions: 2_000, excerpts: 4_000 }),
  medium: Object.freeze({ summary: 3_000, mentions: 4_000, excerpts: 8_000 }),
  large: Object.freeze({ summary: 6_000, mentions: 8_000, excerpts: 16_000 }),
});

export function summaryBudgets(settings) {
  return SUMMARY_BUDGETS[settings?.agent?.summarySize] ?? SUMMARY_BUDGETS.medium;
}

export class ProjectSettingsError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ProjectSettingsError';
    this.code = 'PROJECT_SETTINGS_INVALID';
    this.field = field;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanLabel(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text && text.length <= maximum ? text : null;
}

/**
 * 설정 하나를 정규화한다. strict 면 잘못된 값에서 ProjectSettingsError 를 던지고(PUT),
 * 아니면 그 칸만 기본값으로 돌린다(디스크에서 읽을 때 — 손상된 칸 하나가 전체를 막지 않게).
 */
export function normalizeProjectSettings(raw, { strict = false } = {}) {
  const defaults = DEFAULT_PROJECT_SETTINGS;
  const source = isPlainObject(raw) ? raw : {};
  const fail = (field, message) => {
    if (strict) throw new ProjectSettingsError(message, field);
  };
  const pick = (field, value, valid, fallback, message) => {
    if (value === undefined) return fallback;
    if (valid(value)) return value;
    fail(field, message);
    return fallback;
  };
  const section = (name) => {
    const value = source[name];
    if (value === undefined) return {};
    if (isPlainObject(value)) return value;
    fail(name, `${name} must be an object`);
    return {};
  };

  const librarianRaw = section('librarian');
  const actionsRaw = isPlainObject(librarianRaw.actions) ? librarianRaw.actions : {};
  if (librarianRaw.actions !== undefined && !isPlainObject(librarianRaw.actions)) fail('librarian.actions', 'actions must be an object');
  const librarian = {
    enabled: pick('librarian.enabled', librarianRaw.enabled, (v) => typeof v === 'boolean', defaults.librarian.enabled, 'enabled must be a boolean'),
    provider: pick('librarian.provider', librarianRaw.provider, (v) => LIBRARIAN_PROVIDERS.includes(v), defaults.librarian.provider, `provider must be one of ${LIBRARIAN_PROVIDERS.join(', ')}`),
    model: pick('librarian.model', librarianRaw.model, (v) => v === null || cleanLabel(v, 200) === v, defaults.librarian.model, 'model must be null or a short string'),
    effort: pick('librarian.effort', librarianRaw.effort, (v) => v === null || cleanLabel(v, 40) === v, defaults.librarian.effort, 'effort must be null or a short string'),
    actions: {
      rename: pick('librarian.actions.rename', actionsRaw.rename, (v) => typeof v === 'boolean', true, 'rename must be a boolean'),
      classify: pick('librarian.actions.classify', actionsRaw.classify, (v) => typeof v === 'boolean', true, 'classify must be a boolean'),
      link: pick('librarian.actions.link', actionsRaw.link, (v) => typeof v === 'boolean', true, 'link must be a boolean'),
    },
    concurrency: pick('librarian.concurrency', librarianRaw.concurrency, (v) => [1, 2, 3, 4].includes(v), defaults.librarian.concurrency, 'concurrency must be 1-4'),
  };
  // 공급자를 고르면 모델 선택은 그 공급자 것이어야 한다 — 채팅과 같은 공급자면 모델·노력은 비운다.
  if (librarian.provider === 'chat') {
    librarian.model = null;
    librarian.effort = null;
  }

  const ingestRaw = section('ingest');
  const fileTypes = pick('ingest.fileTypes', ingestRaw.fileTypes, (v) => Array.isArray(v)
    && v.length <= MAX_FILE_TYPES
    && v.every((entry) => typeof entry === 'string' && /^[a-z0-9]{1,10}$/.test(entry.toLowerCase().replace(/^\./, ''))),
  defaults.ingest.fileTypes, 'fileTypes must be up to 64 extensions');
  const excludedFolders = pick('ingest.excludedFolders', ingestRaw.excludedFolders, (v) => Array.isArray(v)
    && v.length <= MAX_EXCLUDED_FOLDERS
    && v.every((entry) => typeof entry === 'string' && /^~(?:\/[^/\u0000]+)+\/?$/.test(entry.trim()) && !entry.split('/').includes('..')),
  defaults.ingest.excludedFolders, 'excludedFolders must be ~/… paths');
  const ingest = {
    homeSearch: pick('ingest.homeSearch', ingestRaw.homeSearch, (v) => typeof v === 'boolean', defaults.ingest.homeSearch, 'homeSearch must be a boolean'),
    fileTypes: [...new Set(fileTypes.map((entry) => entry.toLowerCase().replace(/^\./, '')))],
    excludedFolders: [...new Set(excludedFolders.map((entry) => entry.trim().replace(/\/+$/, '')))],
    maxFileMb: pick('ingest.maxFileMb', ingestRaw.maxFileMb, (v) => Number.isSafeInteger(v) && v >= 1 && v <= 100, defaults.ingest.maxFileMb, 'maxFileMb must be 1-100'),
  };

  const agentRaw = section('agent');
  const agent = {
    chatMayEdit: pick('agent.chatMayEdit', agentRaw.chatMayEdit, (v) => typeof v === 'boolean', defaults.agent.chatMayEdit, 'chatMayEdit must be a boolean'),
    summarySize: pick('agent.summarySize', agentRaw.summarySize, (v) => SUMMARY_SIZES.includes(v), defaults.agent.summarySize, `summarySize must be one of ${SUMMARY_SIZES.join(', ')}`),
  };

  const boardRaw = section('board');
  const columns = pick('board.defaultColumns', boardRaw.defaultColumns, (v) => Array.isArray(v)
    && v.length >= 1
    && v.length <= MAX_DEFAULT_COLUMNS
    && v.every((entry) => cleanLabel(entry, 40) !== null)
    && new Set(v.map((entry) => cleanLabel(entry, 40))).size === v.length,
  defaults.board.defaultColumns, 'defaultColumns must be 1-12 unique names');
  const board = {
    defaultColumns: columns.map((entry) => cleanLabel(entry, 40)),
    trashDays: pick('board.trashDays', boardRaw.trashDays, (v) => TRASH_DAYS.includes(v), defaults.board.trashDays, 'trashDays must be 7, 30, or 90'),
  };

  return { version: PROJECT_SETTINGS_VERSION, librarian, ingest, agent, board };
}

async function writeJsonAtomically(file, value, platform) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await replaceFileAtomically(temp, file, { platform });
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/**
 * settings.json 저장소. get() 은 동기이며 언제나 정규화된 사본을 돌려준다.
 */
export class ProjectSettingsStore {
  constructor({ root, platform = process.platform, logger = null } = {}) {
    if (!root) throw new Error('ProjectSettingsStore requires root');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'settings.json');
    this.platform = platform;
    this.logger = logger;
    this.current = normalizeProjectSettings({});
    this.writeQueue = Promise.resolve();
    this.listeners = new Set();
  }

  async load() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) {
        throw new Error('settings.json is not a plain bounded file');
      }
      this.current = normalizeProjectSettings(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.(`project settings unreadable, using defaults: ${error?.message ?? error}`);
      this.current = normalizeProjectSettings({});
    }
    return this.get();
  }

  get() {
    return structuredClone(this.current);
  }

  /** PUT 은 엄격하게 검사한다. 부분 객체는 현재 값 위에 덮어쓴다(섹션 단위). */
  async save(patch) {
    if (!isPlainObject(patch)) throw new ProjectSettingsError('settings must be an object');
    const run = this.writeQueue.then(async () => {
      const merged = { ...this.current };
      for (const key of ['librarian', 'ingest', 'agent', 'board']) {
        if (patch[key] === undefined) continue;
        merged[key] = isPlainObject(patch[key]) ? { ...this.current[key], ...patch[key] } : patch[key];
        if (key === 'librarian' && isPlainObject(patch.librarian?.actions)) {
          merged.librarian.actions = { ...this.current.librarian.actions, ...patch.librarian.actions };
        }
      }
      const next = normalizeProjectSettings(merged, { strict: true });
      await writeJsonAtomically(this.file, next, this.platform);
      this.current = next;
      for (const listener of this.listeners) {
        try { listener(this.get()); } catch {}
      }
      return this.get();
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
