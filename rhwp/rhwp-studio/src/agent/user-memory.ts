/**
 * 계정의 기억(Rau-0.1)과 문체 학습 — 허브 프레임 읽기와 올리기 한도.
 *
 * 정본은 허브(호스팅 Rau)에 있다. 허브는 기억이 바뀔 때마다 모든 창에 user-memory 를 보내고,
 * 문체 학습의 진행·결과·오류도 모든 창에 보낸다(다른 창에서 올린 학습도 이 창의 Rau 탭과 칩에 보인다).
 * 모양이 틀린 칸은 버린다 — 규칙 하나가 틀려도 나머지는 그린다.
 * node --test 가 그대로 읽도록 타입 import 만 쓴다.
 */
import type {
  AccountRule,
  AccountRuleKind,
  MemoryEvent,
  MemoryEventKind,
  RetireReason,
  RetiredRule,
  StyleLearnError,
  StyleLearnFound,
  StyleLearnJob,
  StyleLearnProgress,
  StyleLearnResult,
  StyleLearnStage,
  StyleLearnSummary,
  StyleLearnSummaryItem,
  StyleUploadRecord,
  UserMemoryAvailability,
  UserMemoryResult,
  UserMemorySnapshot,
} from './types.ts';

/** 문체 학습에 한 번에 올릴 수 있는 파일. 예전 말투 맞추기와 같은 한도다. */
export const STYLE_LEARN_MAX_FILES = 20;
export const STYLE_LEARN_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const STYLE_LEARN_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const STYLE_LEARN_EXTENSIONS = ['txt', 'md', 'pdf', 'docx', 'rtf', 'html', 'htm', 'csv', 'hwp', 'hwpx'] as const;
/** 규칙 한 줄의 글자 수 상한 — 허브와 같다. */
export const ACCOUNT_RULE_TEXT_MAX = 300;
export const STRENGTH_MAX = 5;

const RULE_KINDS: readonly AccountRuleKind[] = ['style', 'term'];
const EVENT_KINDS: readonly MemoryEventKind[] = ['new', 'reinforced', 'dampened', 'escalated', 'retired', 'restored', 'edited', 'deleted'];
const RETIRE_REASONS: readonly RetireReason[] = ['dampened', 'flipped', 'evicted', 'deleted', 'undone'];
const AVAILABILITY: readonly UserMemoryAvailability[] = ['active', 'not_eligible', 'exhausted', 'unavailable'];
const STAGES: readonly StyleLearnStage[] = ['reading', 'extracting', 'merging'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 세기는 0..5 정수로 맞춘다. */
export function clampStrength(value: unknown, fallback = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(STRENGTH_MAX, Math.round(value)));
}

function readStrengthChange(value: unknown): { from: number; to: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.from !== 'number' || typeof value.to !== 'number') return undefined;
  return { from: clampStrength(value.from, 0), to: clampStrength(value.to, 0) };
}

function readKind(value: unknown): AccountRuleKind | null {
  return RULE_KINDS.includes(value as AccountRuleKind) ? value as AccountRuleKind : null;
}

function readRule(value: unknown): AccountRule | null {
  if (!isRecord(value)) return null;
  const kind = readKind(value.kind);
  const id = str(value.id);
  const text = str(value.text);
  if (!kind || !id || !text) return null;
  const origin = value.origin === 'upload' || value.origin === 'user' ? value.origin : 'learned';
  return {
    id,
    kind,
    subject: str(value.subject),
    text,
    strength: Math.max(1, clampStrength(value.strength)),
    origin,
    documents: count(value.documents),
    uploads: count(value.uploads),
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt),
  };
}

function readRetired(value: unknown): RetiredRule | null {
  const rule = readRule(value);
  if (!rule || !isRecord(value)) return null;
  const reason = RETIRE_REASONS.includes(value.reason as RetireReason) ? value.reason as RetireReason : 'dampened';
  return { ...rule, retiredAt: str(value.retiredAt), reason };
}

function readEvent(value: unknown): MemoryEvent | null {
  if (!isRecord(value)) return null;
  const kind = EVENT_KINDS.includes(value.kind as MemoryEventKind) ? value.kind as MemoryEventKind : null;
  const ruleKind = readKind(value.ruleKind);
  const id = str(value.id);
  if (!kind || !ruleKind || !id) return null;
  const strength = readStrengthChange(value.strength);
  const source = value.source === 'upload' || value.source === 'user' ? value.source : 'chat';
  return {
    id,
    at: str(value.at),
    kind,
    ruleId: str(value.ruleId),
    ruleKind,
    text: str(value.text),
    ...(typeof value.prevText === 'string' && value.prevText ? { prevText: value.prevText } : {}),
    ...(strength ? { strength } : {}),
    source,
    ...(typeof value.documentName === 'string' && value.documentName ? { documentName: value.documentName } : {}),
    undoable: value.undoable === true,
  };
}

function readUpload(value: unknown): StyleUploadRecord | null {
  if (!isRecord(value) || !str(value.id)) return null;
  const counts = isRecord(value.counts) ? value.counts : {};
  return {
    id: str(value.id),
    at: str(value.at),
    files: Array.isArray(value.files) ? value.files.filter((name): name is string => typeof name === 'string' && name.length > 0) : [],
    counts: {
      new: count(counts.new),
      reinforced: count(counts.reinforced),
      dampened: count(counts.dampened),
      conflicts: count(counts.conflicts),
    },
  };
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(read).filter((item): item is T => item !== null) : [];
}

/** user-memory 스냅숏. 모양이 틀리면 null — 그때는 지난 스냅숏을 그대로 둔다. */
export function readUserMemorySnapshot(value: unknown): UserMemorySnapshot | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision)) return null;
  const availability = AVAILABILITY.includes(value.availability as UserMemoryAvailability)
    ? value.availability as UserMemoryAvailability
    : 'unavailable';
  const legacy = isRecord(value.legacy) && count(value.legacy.files) > 0 ? { files: count(value.legacy.files) } : null;
  return {
    revision: value.revision as number,
    rules: list(value.rules, readRule),
    retired: list(value.retired, readRetired),
    events: list(value.events, readEvent),
    uploads: list(value.uploads, readUpload),
    lastLearnedAt: typeof value.lastLearnedAt === 'string' && value.lastLearnedAt ? value.lastLearnedAt : null,
    available: value.available === true,
    availability,
    legacy,
  };
}

function readError(value: unknown, fallback: string): { code: string; message: string } {
  const src = isRecord(value) ? value : {};
  return { code: str(src.code) || fallback, message: str(src.message) };
}

/** user-memory-result 프레임. */
export function readUserMemoryResult(msg: Record<string, unknown>): UserMemoryResult {
  const memory = readUserMemorySnapshot(msg.memory);
  return {
    ok: msg.ok === true,
    ...(memory ? { memory } : {}),
    ...(msg.ok === true ? {} : { error: readError(msg.error, 'USER_MEMORY_FAILED') }),
  };
}

function readFound(value: unknown): StyleLearnFound | null {
  if (!isRecord(value)) return null;
  const kind = readKind(value.kind);
  const text = str(value.text);
  return kind && text ? { kind, subject: str(value.subject), text } : null;
}

function readStage(value: unknown): StyleLearnStage | null {
  return STAGES.includes(value as StyleLearnStage) ? value as StyleLearnStage : null;
}

export function readStyleLearnProgress(msg: Record<string, unknown>): StyleLearnProgress | null {
  const stage = readStage(msg.stage);
  const jobId = str(msg.jobId);
  if (!stage || !jobId) return null;
  const file = isRecord(msg.file) && typeof msg.file.name === 'string'
    ? { index: count(msg.file.index), name: msg.file.name }
    : undefined;
  const found = list(msg.found, readFound);
  return {
    requestId: str(msg.requestId),
    jobId,
    stage,
    completed: count(msg.completed),
    total: count(msg.total),
    ...(file ? { file } : {}),
    ...(found.length ? { found } : {}),
  };
}

function readSummaryItem(value: unknown): StyleLearnSummaryItem | null {
  const found = readFound(value);
  if (!found || !isRecord(value)) return null;
  const strength = readStrengthChange(value.strength);
  return {
    ...(typeof value.ruleId === 'string' && value.ruleId ? { ruleId: value.ruleId } : {}),
    ...found,
    ...(strength ? { strength } : {}),
    ...(typeof value.note === 'string' && value.note ? { note: value.note } : {}),
  };
}

export function readStyleLearnSummary(value: unknown): StyleLearnSummary {
  const src = isRecord(value) ? value : {};
  return {
    new: list(src.new, readSummaryItem),
    reinforced: list(src.reinforced, readSummaryItem),
    dampened: list(src.dampened, readSummaryItem),
    retired: list(src.retired, readSummaryItem),
    conflicts: list(src.conflicts, readSummaryItem),
    skippedFiles: Array.isArray(src.skippedFiles) ? src.skippedFiles.filter((name): name is string => typeof name === 'string') : [],
  };
}

export function readStyleLearnResult(msg: Record<string, unknown>): StyleLearnResult | null {
  const memory = readUserMemorySnapshot(msg.memory);
  const jobId = str(msg.jobId);
  if (!memory || !jobId) return null;
  return { requestId: str(msg.requestId), jobId, summary: readStyleLearnSummary(msg.summary), memory };
}

export function readStyleLearnError(msg: Record<string, unknown>): StyleLearnError {
  return {
    requestId: str(msg.requestId),
    ...(str(msg.jobId) ? { jobId: str(msg.jobId) } : {}),
    code: str(msg.code) || 'STYLE_LEARN_FAILED',
    message: str(msg.message),
  };
}

export function readStyleLearnJob(value: unknown): StyleLearnJob | null {
  if (!isRecord(value)) return null;
  const stage = readStage(value.stage);
  const jobId = str(value.jobId);
  if (!stage || !jobId) return null;
  return {
    jobId,
    stage,
    completed: count(value.completed),
    total: count(value.total),
    startedAt: str(value.startedAt),
    files: Array.isArray(value.files) ? value.files.filter((name): name is string => typeof name === 'string') : [],
    found: list(value.found, readFound),
  };
}

/** 올리려는 파일의 확장자를 받을 수 있는가. */
export function styleLearnAccepts(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return (STYLE_LEARN_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

export type StyleLearnPickProblem = 'too-many' | 'file-too-large' | 'total-too-large' | 'unsupported' | 'empty';

/**
 * 고른 파일을 한도로 거른다. 받을 수 없는 형식과 빈 파일은 빼고 알린다(나머지는 올린다). 허브는 빈 파일
 * 하나에도 올린 묶음 전체를 INVALID_FILES 로 거절하므로 여기서 미리 뺀다. 개수·크기를 넘으면
 * 하나도 올리지 않는다 — 허브도 같은 한도로 막으므로 미리 알린다.
 */
export function checkStyleLearnFiles(files: ReadonlyArray<{ name: string; size: number }>): {
  accepted: number[];
  unsupported: string[];
  /** 0바이트라 뺀 파일. */
  empty: string[];
  problem: StyleLearnPickProblem | null;
} {
  const accepted: number[] = [];
  const unsupported: string[] = [];
  const empty: string[] = [];
  files.forEach((file, index) => {
    if (!styleLearnAccepts(file.name)) unsupported.push(file.name);
    else if (file.size <= 0) empty.push(file.name);
    else accepted.push(index);
  });
  if (!accepted.length) {
    return { accepted, unsupported, empty, problem: unsupported.length && !empty.length ? 'unsupported' : 'empty' };
  }
  if (accepted.length > STYLE_LEARN_MAX_FILES) return { accepted: [], unsupported, empty, problem: 'too-many' };
  if (accepted.some((index) => files[index]!.size > STYLE_LEARN_MAX_FILE_BYTES)) return { accepted: [], unsupported, empty, problem: 'file-too-large' };
  const total = accepted.reduce((sum, index) => sum + files[index]!.size, 0);
  if (total > STYLE_LEARN_MAX_TOTAL_BYTES) return { accepted: [], unsupported, empty, problem: 'total-too-large' };
  return { accepted, unsupported, empty, problem: null };
}
