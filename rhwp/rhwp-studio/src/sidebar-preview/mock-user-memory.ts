/**
 * 미리보기의 계정 기억(Rau-0.1)과 문체 학습 — 허브 user-memory-hub·user-memory-store·style-learning 을 흉내 낸다.
 *
 * 기억은 페이지에 하나다. 모든 모의 브리지가 나누고, 바뀌면 허브처럼 붙은 모든 브리지에 user-memory 를 보낸다.
 * 규칙은 세기 1–5 로 보강·감쇄되고, 0 이 되면 물러난다(되살릴 수 있다). 사건마다 앞뒤 모습을 들고 있어
 * 허브처럼 그 뒤 규칙이 다시 바뀌었으면 되돌리지 않는다(USER_MEMORY_UNDO_STALE).
 *
 * URL:
 * - `userMemory=sample|empty|legacy` — 표본 기억 / 빈 기억 / 빈 기억과 예전 말투 맞추기 원고 3개. `taste=sample` 이면 sample.
 * - `availability=active|exhausted|unavailable|not_eligible` — 허브의 쓸 수 있음을 고정한다. 없으면 요금제를 따른다
 *   (rau → active, hama·free → not_eligible, 요금제 API 없음 → unavailable, 웹 Studio 의 허브처럼).
 * - `styleLearn=hold` — 학습이 규칙 찾기의 첫 파일 뒤에 멈춘다(`sidebarPreview.userMemory.releaseStyleLearn()` 로 잇는다).
 * - `styleLearn=fail` (`&styleLearnError=CODE`) — 규칙 찾기 중에 그 코드(기본 RAU_UNAVAILABLE)로 실패한다. NO_TEXT 는 글 꺼내기 뒤에.
 * - `styleLearn=run` — 그대로 끝나는 표본 학습(결과 카드).
 *   세 값 모두 페이지를 열면 표본 원고로 학습 하나를 곧바로 시작한다(main.ts 가 startSampleStyleLearn 을 부른다).
 *
 * 학습 흉내: 이름에 '스캔'·'scan' 이 든 파일은 글이 없어 건너뛰고, 읽은 파일이 셋 이상이면 마지막 파일은
 * 답이 맞지 않아 건너뛴다. 나머지 파일은 차례로 표본 규칙 세 개씩을 찾는다 — 표본 기억에 대면 보강·새로·충돌·
 * 감쇄·물러남이 모두 나온다.
 */
import type { SidebarBridge } from '../agent/bridge.ts';
import type * as T from '../agent/types.ts';
import type { PlanTier } from '../ui/plan/plan-types.ts';
import {
  ACCOUNT_RULE_TEXT_MAX,
  STRENGTH_MAX,
  STYLE_LEARN_EXTENSIONS,
  STYLE_LEARN_MAX_FILE_BYTES,
  STYLE_LEARN_MAX_FILES,
  STYLE_LEARN_MAX_TOTAL_BYTES,
} from '../agent/user-memory.ts';

const MAX_RULES = 60;
const MAX_RETIRED = 30;
const VISIBLE_EVENTS = 20;
const MAX_EVENTS = 200;
const MAX_UPLOADS = 10;
const MAX_SUBJECT = 60;
const KIND_SUBJECT: Record<T.AccountRuleKind, string> = { style: '문체', term: '용어' };

const READ_MS = 260;
const EXTRACT_MS = 650;
const MERGE_MS = 450;

type Rule = T.AccountRule & { rev: number };
type Retired = T.RetiredRule & { rev: number };
interface Side { rule: Rule | null; retired?: Retired | null }
interface StoredEvent {
  pub: Omit<T.MemoryEvent, 'undoable'>;
  before: Side;
  after: Side;
  undone: boolean;
}
interface State {
  revision: number;
  rules: Rule[];
  retired: Retired[];
  /** 최근 것부터 */
  events: StoredEvent[];
  uploads: T.StyleUploadRecord[];
  legacy: { files: number } | null;
}

class MemoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const params = new URLSearchParams(location.search);
const AVAILABILITIES: readonly T.UserMemoryAvailability[] = ['active', 'exhausted', 'unavailable', 'not_eligible'];
const pinnedAvailability = AVAILABILITIES.includes(params.get('availability') as T.UserMemoryAvailability)
  ? params.get('availability') as T.UserMemoryAvailability
  : null;
const memoryMode = params.get('taste') === 'sample' ? 'sample' : params.get('userMemory');
const learnMode = params.get('styleLearn');

let sequence = 0;
function newId(prefix: 'rule' | 'evt' | 'upl' | 'style'): string {
  sequence += 1;
  return `${prefix}_${(Date.now().toString(36) + sequence.toString(36)).slice(-12).padStart(12, '0')}`;
}

const clone = <V>(value: V): V => structuredClone(value);
const canonical = (subject: string) => subject.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const preference = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim().toLowerCase();
const sameRule = (left: Rule | Retired | null | undefined, right: Rule | Retired | null | undefined) =>
  (!left && !right) || Boolean(left && right && left.id === right.id && left.rev === right.rev);
const byStrength = (left: Rule, right: Rule) =>
  right.strength - left.strength || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function cleanLine(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new MemoryError('USER_MEMORY_INVALID', `${label} must be a string`);
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) throw new MemoryError('USER_MEMORY_INVALID', `${label} is empty`);
  if (text.length > max) throw new MemoryError('USER_MEMORY_INVALID', `${label} may not exceed ${max} characters`);
  return text;
}

function cleanKind(value: unknown): T.AccountRuleKind {
  if (value !== 'style' && value !== 'term') throw new MemoryError('USER_MEMORY_INVALID', 'kind must be one of style, term');
  return value;
}

/* ── 표본 ─────────────────────────────────────────────── */

function sampleState(): State {
  const rule = (
    n: number, kind: T.AccountRuleKind, subject: string, text: string, strength: number,
    origin: T.AccountRule['origin'], documents: number, uploads: number, minutes: number,
  ): Rule => ({
    id: `rule_sample${String(n).padStart(6, '0')}`, kind, subject, text, strength, origin, documents, uploads,
    createdAt: ago(minutes + 60 * 24 * 9), updatedAt: ago(minutes), rev: 2,
  });
  const retire = (base: Rule, reason: T.RetireReason, minutes: number): Retired =>
    ({ ...base, retiredAt: ago(minutes), reason, rev: base.rev + 1 });
  const rules = [
    rule(1, 'style', '문체.종결', '본문 종결은 한다체로 쓴다', 4, 'learned', 3, 2, 12),
    rule(2, 'style', '문체.문장 길이', '한 문장은 두 줄을 넘기지 않는다', 5, 'upload', 1, 5, 60 * 26),
    rule(3, 'style', '문체.문장 끊기', '긴 문장은 짧게 끊어 쓴다', 2, 'learned', 2, 0, 40),
    rule(4, 'term', '용어.고객', "'고객' 대신 '이용자'로 쓴다", 3, 'user', 0, 0, 60 * 50),
    rule(5, 'term', '용어.예산', "'예산' 대신 '사업비'로 쓴다", 1, 'upload', 0, 1, 60 * 27),
    rule(6, 'style', '문체.개조식', '보고서 요약은 개조식으로 쓴다', 3, 'learned', 3, 0, 60 * 30),
    rule(7, 'style', '문체.숫자', '금액은 천 단위 쉼표를 찍고 원 단위를 붙인다', 2, 'upload', 0, 2, 60 * 26),
    rule(8, 'term', '용어.협력', "'협업' 대신 '협력'으로 쓴다", 1, 'learned', 1, 0, 60 * 70),
    rule(9, 'style', '문체.끝인사', "공문 끝인사는 '감사합니다.'로 맺는다", 3, 'user', 0, 0, 60 * 48),
  ];
  const [r1, r2, r3, r4, r5, , r7, , r9] = rules;
  const gone10 = retire(rule(10, 'style', '문체.종결', '본문은 합니다체로 쓴다', 1, 'learned', 2, 0, 60 * 90), 'flipped', 60 * 20);
  const gone11 = retire(rule(11, 'term', '용어.고객사', "'고객사' 대신 '수요기관'으로 쓴다", 2, 'upload', 0, 2, 60 * 80), 'deleted', 60 * 45);
  const gone12 = retire(rule(12, 'style', '문체.괄호', '부연 설명은 괄호 대신 쉼표로 잇는다', 1, 'learned', 1, 0, 60 * 120), 'dampened', 60 * 72);
  const gone13 = retire(rule(13, 'term', '용어.과업', "'업무' 대신 '과업'으로 쓴다", 1, 'learned', 1, 0, 60 * 200), 'evicted', 60 * 150);
  const gone14 = retire(rule(14, 'term', '용어.고객', "'고객' 대신 '사용자'로 쓴다", 2, 'learned', 2, 0, 60 * 300), 'flipped', 60 * 260);
  const weaker = (base: Rule, strength: number): Rule => ({ ...base, strength, rev: base.rev - 1 });
  const at = (n: number) => `evt_sample${String(n).padStart(6, '0')}`;
  const stored = (
    n: number, kind: T.MemoryEventKind, base: Rule | Retired, before: Side, after: Side,
    source: T.MemoryEvent['source'], minutes: number, extra: Partial<T.MemoryEvent> = {},
  ): StoredEvent => ({
    pub: {
      id: at(n), at: ago(minutes), kind, ruleId: base.id, ruleKind: base.kind, text: base.text, source,
      strength: { from: before.rule?.strength ?? 0, to: after.rule?.strength ?? 0 }, ...extra,
    },
    before, after, undone: false,
  });
  const events = [
    stored(1, 'reinforced', r1, { rule: weaker(r1, 3) }, { rule: r1 }, 'chat', 12, { documentName: '사업 제안서' }),
    stored(2, 'escalated', r3, { rule: null }, { rule: r3 }, 'chat', 40, { documentName: '사업 제안서 외 1개' }),
    stored(3, 'retired', gone10, { rule: { ...gone10, rev: gone10.rev - 1 } }, { rule: null, retired: gone10 }, 'chat', 60 * 20,
      { documentName: '주간 보고' }),
    stored(4, 'reinforced', r2, { rule: weaker(r2, 3) }, { rule: r2 }, 'upload', 60 * 26),
    stored(5, 'new', r7, { rule: null }, { rule: r7 }, 'upload', 60 * 26),
    stored(6, 'dampened', r5, { rule: weaker(r5, 2) }, { rule: r5 }, 'upload', 60 * 27),
    stored(7, 'deleted', gone11, { rule: { ...gone11, rev: gone11.rev - 1 } }, { rule: null, retired: gone11 }, 'user', 60 * 45),
    stored(8, 'new', r9, { rule: null }, { rule: r9 }, 'user', 60 * 48),
    stored(9, 'edited', r4, { rule: { ...r4, text: "'고객' 대신 '이용자'로 통일", rev: r4.rev - 1 } }, { rule: r4 }, 'user', 60 * 50,
      { prevText: "'고객' 대신 '이용자'로 통일" }),
    stored(10, 'retired', gone12, { rule: { ...gone12, rev: gone12.rev - 1 } }, { rule: null, retired: gone12 }, 'chat', 60 * 72),
  ];
  return {
    revision: 14,
    rules,
    retired: [gone10, gone11, gone12, gone13, gone14],
    events,
    uploads: [
      {
        id: 'upl_sample000001', at: ago(60 * 26),
        files: ['2025 사업계획서.hwpx', '주간 보고 모음.docx', '칼럼 초고.md'],
        counts: { new: 4, reinforced: 2, dampened: 1, conflicts: 1 },
      },
      { id: 'upl_sample000002', at: ago(60 * 24 * 6), files: ['보도자료_최종.pdf'], counts: { new: 2, reinforced: 0, dampened: 0, conflicts: 0 } },
    ],
    legacy: null,
  };
}

function initialState(): State {
  if (memoryMode === 'sample') return sampleState();
  return {
    revision: 0, rules: [], retired: [], events: [], uploads: [],
    legacy: memoryMode === 'legacy' ? { files: 3 } : null,
  };
}

/** 표본 원고에서 찾는 규칙. 앞의 여섯 개가 표본 기억에 대면 보강·새로·감쇄·물러남과 충돌 둘(사용자 규칙, 지운 습관)이 나온다. */
const FOUND_POOL: readonly T.StyleLearnFound[] = [
  { kind: 'style', subject: '문체.종결', text: '본문 종결은 한다체로 쓴다' },
  { kind: 'style', subject: '문체.소제목', text: '소제목은 명사형으로 끝낸다' },
  { kind: 'term', subject: '용어.고객', text: "'고객' 대신 '수요자'로 쓴다" },
  { kind: 'style', subject: '문체.개조식', text: '보고서 요약은 서술형 문단으로 쓴다' },
  { kind: 'term', subject: '용어.협력', text: "'협력' 대신 '협업'으로 쓴다" },
  { kind: 'term', subject: '용어.고객사', text: "'고객사' 대신 '수요기관'으로 쓴다" },
  { kind: 'term', subject: '용어.예산', text: "'예산' 대신 '사업비'로 쓴다" },
  { kind: 'style', subject: '문체.강조', text: '강조는 따옴표 대신 굵게 쓴다' },
  { kind: 'term', subject: '용어.추진', text: "'진행' 대신 '추진'으로 쓴다" },
  { kind: 'style', subject: '문체.쉼표', text: '접속 부사 뒤에는 쉼표를 찍는다' },
];

const LEGACY_FILES = ['보도자료 초안.docx', '칼럼 원고.hwp', '주간 보고.txt', '연설문.md', '회의 메모.txt'];
const SAMPLE_UPLOADS = ['2025 사업계획서.hwpx', '주간 보고 모음.docx', '스캔본 회의록.pdf', '칼럼 초고.md'];

/* ── 저장소 ───────────────────────────────────────────── */

let state = initialState();
let availability: T.UserMemoryAvailability = pinnedAvailability ?? 'unavailable';
const sinks = new Set<(event: T.SidebarEvent) => void>();

function broadcast(event: T.SidebarEvent): void {
  setTimeout(() => sinks.forEach((sink) => sink(event)), 0);
}

function publicRule<R extends Rule | Retired>(rule: R): Omit<R, 'rev'> {
  const { rev: _rev, ...rest } = rule;
  return clone(rest);
}

function undoable(event: StoredEvent): boolean {
  const current = state.rules.find((rule) => rule.id === event.pub.ruleId) ?? null;
  const currentRetired = state.retired.find((rule) => rule.id === event.pub.ruleId) ?? null;
  if (!sameRule(current, event.after.rule)) return false;
  if (event.after.retired && !sameRule(currentRetired, event.after.retired)) return false;
  const restoring = event.before.rule;
  if (restoring && state.rules.some((rule) => rule.id !== restoring.id && canonical(rule.subject) === canonical(restoring.subject))) return false;
  return true;
}

function snapshot(): T.UserMemorySnapshot {
  const learned = state.events.find((event) => event.pub.source !== 'user');
  return {
    revision: state.revision,
    rules: [...state.rules].sort(byStrength).map(publicRule),
    retired: state.retired.slice(0, MAX_RETIRED).map(publicRule),
    events: state.events.slice(0, VISIBLE_EVENTS).map((event) => ({ ...clone(event.pub), undoable: !event.undone && undoable(event) })),
    uploads: clone(state.uploads.slice(0, MAX_UPLOADS)),
    lastLearnedAt: learned?.pub.at ?? null,
    available: availability === 'active' || availability === 'exhausted',
    availability,
    legacy: state.legacy ? { ...state.legacy } : null,
  };
}

function publish(): void {
  broadcast({ type: 'user-memory', memory: snapshot() });
}

/** 한 번의 변경 — 실패하면 아무것도 바뀌지 않는다. 바뀌었으면 리비전을 올리고 모든 창에 알린다. */
function write<V>(fn: () => V): V {
  const saved = clone(state);
  try {
    const value = fn();
    state.revision += 1;
    state.events = state.events.slice(0, MAX_EVENTS);
    state.retired = state.retired.slice(0, MAX_RETIRED);
    publish();
    return value;
  } catch (error) {
    state = saved;
    throw error;
  }
}

function record(
  kind: T.MemoryEventKind,
  rule: Rule | Retired,
  before: Side,
  after: Side,
  source: T.MemoryEvent['source'],
  extra: Partial<T.MemoryEvent> = {},
): StoredEvent {
  const event: StoredEvent = {
    pub: {
      id: newId('evt'), at: new Date().toISOString(), kind, ruleId: rule.id, ruleKind: rule.kind, text: rule.text, source,
      strength: { from: before.rule?.strength ?? 0, to: after.rule?.strength ?? 0 }, ...extra,
    },
    before: clone(before),
    after: clone(after),
    undone: false,
  };
  state.events.unshift(event);
  return event;
}

function activeBySubject(subject: string): Rule | null {
  const wanted = canonical(subject);
  return state.rules.find((rule) => canonical(rule.subject) === wanted) ?? null;
}

function retireRule(rule: Rule, reason: T.RetireReason): Retired {
  state.rules = state.rules.filter((candidate) => candidate !== rule);
  const retired: Retired = { ...clone(rule), retiredAt: new Date().toISOString(), reason, rev: rule.rev + 1, updatedAt: new Date().toISOString() };
  state.retired.unshift(retired);
  return retired;
}

/** 자리가 없으면 가장 약한 배운 규칙을 물러나게 한다. */
function makeRoom(): void {
  while (state.rules.length >= MAX_RULES) {
    const pool = state.rules.some((rule) => rule.origin !== 'user') ? state.rules.filter((rule) => rule.origin !== 'user') : state.rules;
    const weakest = [...pool].sort((a, b) => a.strength - b.strength || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0]!;
    const before = clone(weakest);
    const retired = retireRule(weakest, 'evicted');
    record('retired', before, { rule: before }, { rule: null, retired }, 'chat');
  }
}

function newRule(input: Pick<T.AccountRule, 'kind' | 'subject' | 'text' | 'strength' | 'origin'> & Partial<Pick<T.AccountRule, 'documents' | 'uploads'>>): Rule {
  makeRoom();
  const stamp = new Date().toISOString();
  const rule: Rule = {
    id: newId('rule'), kind: input.kind, subject: input.subject, text: input.text,
    strength: Math.max(1, Math.min(STRENGTH_MAX, input.strength)), origin: input.origin,
    documents: input.documents ?? 0, uploads: input.uploads ?? 0, createdAt: stamp, updatedAt: stamp, rev: 1,
  };
  state.rules.push(rule);
  return rule;
}

/** 세기를 깎는다. 0 이면 물러난다. */
function lower(rule: Rule, step: number, source: T.MemoryEvent['source'], reason: T.RetireReason, documentName?: string): StoredEvent {
  const before = clone(rule);
  const strength = Math.max(0, rule.strength - Math.max(1, step));
  const extra = documentName ? { documentName } : {};
  if (strength <= 0) {
    const retired = retireRule(rule, reason);
    return record('retired', before, { rule: before }, { rule: null, retired }, source, extra);
  }
  Object.assign(rule, { strength, rev: rule.rev + 1, updatedAt: new Date().toISOString() });
  return record('dampened', rule, { rule: before }, { rule }, source, extra);
}

function raise(rule: Rule, step: number, source: T.MemoryEvent['source'], kind: 'reinforced' | 'escalated', extra: Partial<T.MemoryEvent> = {}): StoredEvent | null {
  const before = clone(rule);
  const strength = Math.min(STRENGTH_MAX, rule.strength + step);
  if (strength === rule.strength) return null;
  Object.assign(rule, { strength, rev: rule.rev + 1, updatedAt: new Date().toISOString() });
  return record(kind, rule, { rule: before }, { rule }, source, extra);
}

function deriveSubject(kind: T.AccountRuleKind, text: string): string {
  return `${KIND_SUBJECT[kind]}.${text}`.slice(0, MAX_SUBJECT).trim();
}

/** user-memory-request — 허브 studioRequest 의 답 몸통. */
function studioRequest(op: T.UserMemoryOp): T.UserMemoryResult {
  try {
    switch (op.op) {
      case 'list':
        return { ok: true, memory: snapshot() };
      case 'add':
        write(() => {
          const kind = cleanKind(op.rule?.kind);
          const text = cleanLine(op.rule?.text, ACCOUNT_RULE_TEXT_MAX, 'text');
          const subject = deriveSubject(kind, text);
          if (activeBySubject(subject)) throw new MemoryError('USER_MEMORY_SUBJECT_TAKEN', 'A rule on that subject already exists.');
          const rule = newRule({ kind, subject, text, strength: 3, origin: 'user' });
          record('new', rule, { rule: null }, { rule }, 'user');
        });
        break;
      case 'delete':
        write(() => {
          const rule = state.rules.find((candidate) => candidate.id === op.id);
          if (!rule) throw new MemoryError('USER_MEMORY_NOT_FOUND', 'That rule no longer exists.');
          const before = clone(rule);
          const retired = retireRule(rule, 'deleted');
          record('deleted', before, { rule: before }, { rule: null, retired }, 'user');
        });
        break;
      case 'restore':
        write(() => {
          const retired = state.retired.find((candidate) => candidate.id === op.id);
          if (!retired) throw new MemoryError('USER_MEMORY_NOT_FOUND', 'That rule is no longer in the retired list.');
          if (activeBySubject(retired.subject)) {
            throw new MemoryError('USER_MEMORY_SUBJECT_TAKEN', 'Another rule now holds that subject; delete it first.');
          }
          const beforeRetired = clone(retired);
          state.retired = state.retired.filter((candidate) => candidate !== retired);
          const { retiredAt: _at, reason: _reason, ...rest } = clone(retired);
          makeRoom();
          const rule: Rule = { ...rest, strength: Math.max(1, retired.strength), rev: retired.rev + 1, updatedAt: new Date().toISOString() };
          state.rules.push(rule);
          record('restored', rule, { rule: null, retired: beforeRetired }, { rule }, 'user');
        });
        break;
      case 'undo':
        if (!undoEvent(op.eventId)) throw new MemoryError('USER_MEMORY_UNDO_STALE', 'That change can no longer be undone.');
        break;
      default:
        throw new MemoryError('USER_MEMORY_INVALID', 'op must be list, add, edit, delete, restore or undo');
    }
    return { ok: true, memory: snapshot() };
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : 'USER_MEMORY_FAILED';
    return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
}

/** 사건 하나를 되돌린다 — 허브 store.undo. 그 뒤 규칙이 다시 바뀌었으면 false. */
function undoEvent(eventId: string): boolean {
  const event = state.events.find((candidate) => candidate.pub.id === eventId);
  if (!event || event.undone || !undoable(event)) return false;
  write(() => {
    const current = state.rules.find((rule) => rule.id === event.pub.ruleId) ?? null;
    const currentRetired = state.retired.find((rule) => rule.id === event.pub.ruleId) ?? null;
    if (current) state.rules = state.rules.filter((rule) => rule !== current);
    if (currentRetired) state.retired = state.retired.filter((rule) => rule !== currentRetired);
    if (event.before.rule) {
      makeRoom();
      state.rules.push(clone(event.before.rule));
    } else if (event.before.retired) {
      state.retired.unshift(clone(event.before.retired));
    }
    if (event.pub.kind === 'escalated' && !event.before.rule) {
      // 승격을 되돌렸다 — 같은 습관이 곧바로 다시 올라오지 않게 '되돌림'으로 남긴다.
      const undone = event.after.rule ?? current;
      if (undone) state.retired.unshift({ ...clone(undone), strength: 0, retiredAt: new Date().toISOString(), reason: 'undone', rev: undone.rev + 1 });
    }
    event.undone = true;
  });
  return true;
}

/* ── 문체 학습 ────────────────────────────────────────── */

interface FoundRule extends T.StyleLearnFound { files: number }

interface Job {
  requestId: string;
  jobId: string;
  stage: T.StyleLearnStage;
  completed: number;
  total: number;
  startedAt: string;
  files: string[];
  found: FoundRule[];
  cancelled: boolean;
  wake: (() => void) | null;
}

let job: Job | null = null;
let holdNext = learnMode === 'hold';

class LearnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function jobStatus(): T.StyleLearnJob | null {
  if (!job) return null;
  return {
    jobId: job.jobId, stage: job.stage, completed: job.completed, total: job.total, startedAt: job.startedAt,
    files: [...job.files], found: job.found.map(({ kind, subject, text }) => ({ kind, subject, text })),
  };
}

function progress(current: Job, file?: { index: number; name: string }): void {
  broadcast({
    type: 'style-learn-progress', requestId: current.requestId, jobId: current.jobId, stage: current.stage,
    completed: current.completed, total: current.total, ...(file ? { file } : {}),
    // 허브처럼 지금까지 찾은 규칙 전부(누적)를 싣는다.
    ...(current.found.length ? { found: current.found.map(({ kind, subject, text }) => ({ kind, subject, text })) } : {}),
  });
}

/** 기다린다. 멈추면 CANCELLED 로 던진다. ms 가 null 이면 releaseStyleLearn 까지 기다린다. */
function pause(current: Job, ms: number | null): Promise<void> {
  if (current.cancelled) return Promise.reject(new LearnError('CANCELLED', 'Style learning was cancelled.'));
  return new Promise((resolve, reject) => {
    const timer = ms === null ? null : setTimeout(done, ms);
    function done() {
      if (timer !== null) clearTimeout(timer);
      current.wake = null;
      if (current.cancelled) reject(new LearnError('CANCELLED', 'Style learning was cancelled.'));
      else resolve();
    }
    current.wake = done;
  });
}

/** 허브 validateStyleUploads 와 같은 검사. */
function validate(files: T.StyleLearnUpload[]): void {
  if (!Array.isArray(files) || files.length === 0 || files.length > STYLE_LEARN_MAX_FILES) {
    throw new LearnError('INVALID_FILES', `Upload 1-${STYLE_LEARN_MAX_FILES} files of your own writing.`);
  }
  let total = 0;
  for (const [index, file] of files.entries()) {
    const name = typeof file?.name === 'string' ? file.name : '';
    const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    if (!(STYLE_LEARN_EXTENSIONS as readonly string[]).includes(extension)) {
      throw new LearnError('UNSUPPORTED_FILE', `${name || `File ${index + 1}`} is not a supported file type.`);
    }
    const size = Number(file.size) || 0;
    if (size === 0) throw new LearnError('INVALID_FILES', `${name} is empty.`);
    if (size > STYLE_LEARN_MAX_FILE_BYTES) throw new LearnError('FILE_TOO_LARGE', `${name} exceeds 20 MB.`);
    total += size;
    if (total > STYLE_LEARN_MAX_TOTAL_BYTES) throw new LearnError('FILES_TOO_LARGE', 'The files exceed 50 MB in total.');
  }
}

/** 찾은 규칙을 기억에 합친다 — 허브 store.applyUpload. */
function applyUpload(found: FoundRule[], files: string[], skippedFiles: string[]): T.StyleLearnSummary {
  return write(() => {
    const summary: T.StyleLearnSummary = { new: [], reinforced: [], dampened: [], retired: [], conflicts: [], skippedFiles: [...skippedFiles] };
    const item = (rule: Rule, extra: Partial<T.StyleLearnSummaryItem> = {}): T.StyleLearnSummaryItem =>
      ({ ruleId: rule.id, kind: rule.kind, subject: rule.subject, text: rule.text, ...extra });
    for (const candidate of found) {
      const count = Math.max(1, Math.min(STRENGTH_MAX, candidate.files));
      const existing = activeBySubject(candidate.subject);
      if (existing && preference(existing.text) === preference(candidate.text)) {
        const from = existing.strength;
        existing.uploads += count;
        raise(existing, count, 'upload', 'reinforced');
        summary.reinforced.push(item(existing, { strength: { from, to: existing.strength } }));
        continue;
      }
      if (existing && existing.origin === 'user') {
        summary.conflicts.push({ ruleId: existing.id, kind: candidate.kind, subject: candidate.subject, text: candidate.text, note: existing.text });
        continue;
      }
      // 사용자가 지운 습관은 다시 들이지 않는다.
      const deleted = state.retired.find((rule) => rule.reason === 'deleted'
        && canonical(rule.subject) === canonical(candidate.subject) && preference(rule.text) === preference(candidate.text));
      if (deleted) {
        summary.conflicts.push({ kind: candidate.kind, subject: candidate.subject, text: candidate.text, note: 'deleted' });
        continue;
      }
      if (existing) {
        const from = existing.strength;
        const snapshotRule = clone(existing);
        lower(existing, count, 'upload', 'flipped');
        if (state.rules.includes(existing)) {
          summary.dampened.push(item(existing, { strength: { from, to: existing.strength } }));
          continue;
        }
        summary.retired.push(item(snapshotRule, { strength: { from, to: 0 } }));
      }
      const retired = state.retired.find((rule) => canonical(rule.subject) === canonical(candidate.subject)
        && preference(rule.text) === preference(candidate.text)) ?? null;
      if (retired) state.retired = state.retired.filter((rule) => rule !== retired);
      const rule = newRule({ kind: candidate.kind, subject: candidate.subject, text: candidate.text, strength: count, origin: 'upload', uploads: count });
      record('new', rule, { rule: null, retired }, { rule }, 'upload');
      summary.new.push(item(rule, { strength: { from: 0, to: rule.strength } }));
    }
    state.uploads = [{
      id: newId('upl'), at: new Date().toISOString(), files: files.slice(0, 20),
      counts: {
        new: summary.new.length, reinforced: summary.reinforced.length,
        dampened: summary.dampened.length + summary.retired.length, conflicts: summary.conflicts.length,
      },
    }, ...state.uploads].slice(0, MAX_UPLOADS);
    return summary;
  });
}

async function run(current: Job, names: string[], onSuccess?: () => void): Promise<T.StyleLearnSummary> {
  const skipped = new Set<string>();
  // 1. 글 꺼내기
  const texts: Array<{ index: number; name: string }> = [];
  for (const [index, name] of names.entries()) {
    current.stage = 'reading';
    current.completed = index;
    progress(current, { index, name });
    await pause(current, READ_MS);
    if (/스캔|scan/i.test(name)) skipped.add(name);
    else texts.push({ index, name });
  }
  const failCode = learnMode === 'fail' ? params.get('styleLearnError') || 'RAU_UNAVAILABLE' : null;
  if (texts.length === 0 || failCode === 'NO_TEXT') throw new LearnError('NO_TEXT', 'No readable text was found in these files.');
  // 2. 규칙 찾기 — 읽은 파일이 셋 이상이면 마지막 파일의 답은 맞지 않아 건너뛴다.
  current.stage = 'extracting';
  current.completed = 0;
  current.total = texts.length;
  progress(current);
  const answered = texts.length >= 3 ? texts.slice(0, -1) : texts;
  for (const [position, file] of texts.entries()) {
    await pause(current, EXTRACT_MS);
    if (failCode && position === Math.min(1, texts.length - 1)) throw new LearnError(failCode, failCode === 'RAU_CREDITS_EXHAUSTED'
      ? 'This month\'s Rau credits are used up.' : 'Rau is not available right now. Try again later.');
    if (answered.includes(file)) {
      for (let offset = 0; offset < 3; offset += 1) {
        const pick = FOUND_POOL[(position * 3 + offset) % FOUND_POOL.length]!;
        const known = current.found.find((rule) => canonical(rule.subject) === canonical(pick.subject) && preference(rule.text) === preference(pick.text));
        if (known) known.files += 1;
        else current.found.push({ ...pick, files: 1 });
      }
    } else {
      skipped.add(file.name);
    }
    current.completed += 1;
    progress(current, { index: file.index, name: file.name });
    if (holdNext && position === 0) {
      holdNext = false;
      await pause(current, null);
    }
  }
  // 3. 합치기
  current.stage = 'merging';
  current.completed = 0;
  current.total = 1;
  progress(current);
  await pause(current, MERGE_MS);
  const summary = applyUpload(current.found, names, names.filter((name) => skipped.has(name)));
  current.completed = 1;
  onSuccess?.();
  return summary;
}

function startJob(
  reply: (event: T.SidebarEvent) => void,
  requestId: string,
  files: T.StyleLearnUpload[],
  options: { onSuccess?: () => void } = {},
): void {
  try {
    if (job) throw new LearnError('LEARN_BUSY', 'Style learning is already running.');
    validate(files);
    if (availability === 'unavailable') throw new LearnError('RAU_UNAVAILABLE', 'Rau is not available right now. Try again later.');
    if (availability === 'not_eligible') throw new LearnError('RAU_PLAN_REQUIRED', 'Style learning needs the Rau plan or the Rau trial.');
    if (availability === 'exhausted') throw new LearnError('RAU_CREDITS_EXHAUSTED', 'This month\'s Rau credits are used up.');
  } catch (error) {
    // 허브처럼 검사에 걸린 오류는 보낸 창에만 간다.
    const { code, message } = error as LearnError;
    setTimeout(() => reply({ type: 'style-learn-error', requestId, code, message }), 30);
    return;
  }
  const current: Job = {
    requestId, jobId: newId('style'), stage: 'reading', completed: 0, total: files.length,
    startedAt: new Date().toISOString(), files: files.map((file) => file.name), found: [], cancelled: false, wake: null,
  };
  job = current;
  broadcast({ type: 'style-learn-status', job: jobStatus() });
  void run(current, current.files, options.onSuccess)
    .then((summary) => {
      broadcast({ type: 'style-learn-result', requestId, jobId: current.jobId, summary, memory: snapshot() });
      publish();
    })
    .catch((error: unknown) => {
      const code = error instanceof LearnError ? error.code : 'STYLE_LEARN_FAILED';
      broadcast({ type: 'style-learn-error', requestId, jobId: current.jobId, code, message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (job === current) job = null;
      broadcast({ type: 'style-learn-status', job: jobStatus() });
    });
}

/* ── 대화에서 배우기 (계정 단계) ─────────────────────── */

const ESCALATION: T.StyleLearnFound = { kind: 'term', subject: '용어.착수', text: "'시작' 대신 '착수'로 쓴다" };

function itemFor(event: StoredEvent, change: T.TasteLearnChange): T.TasteLearnItem {
  const created = change === 'new' || (change === 'escalated' && !event.before.rule);
  return {
    op: change === 'retired' ? 'remove' : created ? 'add' : 'update',
    entryId: event.pub.ruleId,
    text: event.pub.text,
    ...(event.pub.prevText ? { prevText: event.pub.prevText } : {}),
    origin: 'learned',
    change,
    tier: 'account',
    kind: event.pub.ruleKind,
    ...(event.pub.strength ? { strength: { ...event.pub.strength } } : {}),
    eventIds: [event.pub.id],
  };
}

/**
 * 한 턴의 학습이 계정 기억을 바꾼 것처럼 — 용어 하나를 기억으로 올리고(없으면 새로, 있으면 보강),
 * 가장 센 문체 규칙 하나를 보강하고, 약한 배운 규칙 하나를 감쇄한다(1 이면 물러난다). taste-learned 의 account 항목을 돌려준다.
 */
function learnFromChat(documentName: string): T.TasteLearnItem[] {
  return write(() => {
    const items: T.TasteLearnItem[] = [];
    const touched = new Set<string>();
    const existing = activeBySubject(ESCALATION.subject);
    if (!existing) {
      const rule = newRule({ ...ESCALATION, strength: 2, origin: 'learned', documents: 2 });
      touched.add(rule.id);
      items.push(itemFor(record('escalated', rule, { rule: null }, { rule }, 'chat', { documentName: `${documentName} 외 1개` }), 'escalated'));
    } else {
      touched.add(existing.id);
      existing.documents += 1;
      const event = raise(existing, 1, 'chat', 'reinforced', { documentName });
      if (event) items.push(itemFor(event, 'reinforced'));
    }
    const strong = [...state.rules].sort(byStrength).find((rule) => rule.kind === 'style' && rule.strength < STRENGTH_MAX && !touched.has(rule.id));
    if (strong) {
      touched.add(strong.id);
      const event = raise(strong, 1, 'chat', 'reinforced', { documentName });
      if (event) items.push(itemFor(event, 'reinforced'));
    }
    const weak = [...state.rules].sort((a, b) => a.strength - b.strength)
      .find((rule) => rule.origin !== 'user' && rule.strength <= 2 && !touched.has(rule.id));
    if (weak) {
      const event = lower(weak, 1, 'chat', 'dampened', documentName);
      items.push(itemFor(event, event.pub.kind === 'retired' ? 'retired' : 'dampened'));
    }
    return items;
  });
}

/* ── 브리지 ───────────────────────────────────────────── */

export type MockUserMemory = Pick<
  SidebarBridge,
  'requestUserMemory' | 'startStyleLearn' | 'cancelStyleLearn' | 'requestStyleLearnStatus' | 'answerStyleLearnLegacy'
> & {
  /** 허브가 붙을 때 보내는 user-memory 와 style-learn-status. */
  welcome(): void;
  dispose(): void;
};

/** 모의 브리지 하나의 기억 메서드. emit 은 이 브리지에만, 바뀐 기억은 모든 브리지에 간다. */
export function createMockUserMemory(emit: (event: T.SidebarEvent) => void, connected: () => boolean): MockUserMemory {
  sinks.add(emit);
  const settle = <V>(value: V) => new Promise<V>((done) => setTimeout(() => done(value), 30));
  const requestId = () => `style-learn-${Date.now().toString(36)}-${(sequence += 1)}`;
  return {
    welcome() {
      emit({ type: 'user-memory', memory: snapshot() });
      emit({ type: 'style-learn-status', job: jobStatus() });
    },
    dispose() {
      sinks.delete(emit);
    },
    requestUserMemory: (op) => (connected() ? settle(studioRequest(op)) : Promise.resolve(null)),
    startStyleLearn(files) {
      if (!connected()) return null;
      const id = requestId();
      startJob(emit, id, files);
      return id;
    },
    cancelStyleLearn(jobId) {
      if (!connected() || !job || (jobId && job.jobId !== jobId)) return;
      job.cancelled = true;
      job.wake?.();
    },
    requestStyleLearnStatus() {
      if (!connected()) return null;
      const id = requestId();
      setTimeout(() => emit({ type: 'style-learn-status', requestId: id, job: jobStatus() }), 30);
      return id;
    },
    answerStyleLearnLegacy(accept) {
      if (!connected()) return null;
      const id = requestId();
      const legacy = state.legacy;
      if (!legacy) {
        setTimeout(() => emit({ type: 'style-learn-error', requestId: id, code: 'INVALID_FILES', message: 'There are no earlier writing samples to learn from.' }), 30);
        return id;
      }
      const forget = () => {
        // 허브는 옛 원고 폴더를 지운다 — 리비전은 그대로다.
        state.legacy = null;
        publish();
      };
      if (!accept) {
        forget();
        return id;
      }
      const files = Array.from({ length: legacy.files }, (_, index) => {
        const name = LEGACY_FILES[index % LEGACY_FILES.length]!;
        return { name: index < LEGACY_FILES.length ? name : `${index + 1} ${name}`, type: '', size: 12_000 + index * 3_100, content: '' };
      });
      startJob(emit, id, files, { onSuccess: forget });
      return id;
    },
  };
}

/* ── 미리보기 조작 ────────────────────────────────────── */

/** 요금제가 바뀌면 허브의 자격 답이 바뀐다. `availability=` 로 고정했으면 따르지 않는다. */
export function syncUserMemoryPlan(tier: PlanTier | null): void {
  if (pinnedAvailability) return;
  setUserMemoryAvailability(tier === 'rau' ? 'active' : tier ? 'not_eligible' : 'unavailable');
}

export function setUserMemoryAvailability(next: T.UserMemoryAvailability): void {
  if (availability === next) return;
  availability = next;
  publish();
}

/** 미리보기 확인과 조작 — `sidebarPreview.userMemory`. */
export const userMemoryControls = {
  snapshot,
  availability: () => availability,
  setAvailability: setUserMemoryAvailability,
  /** 지금 도는 학습 — 없으면 null. */
  job: jobStatus,
  /** `styleLearn=hold` 로 멈춘 학습을 잇는다. */
  releaseStyleLearn: () => job?.wake?.(),
  /** 다음 학습도 첫 파일 뒤에 멈춘다. */
  holdNextStyleLearn: () => { holdNext = true; },
  /**
   * 다른 창에서 올린 것처럼 표본 원고 네 개로 학습을 시작한다(`styleLearn=run|hold|fail` 이 페이지를 열 때 부른다).
   * '스캔본 회의록.pdf' 는 글이 없어 건너뛰고, 읽은 세 파일 중 마지막은 답이 맞지 않아 건너뛴다.
   */
  startSampleStyleLearn(): string {
    const id = `preview-style-learn-${(sequence += 1)}`;
    const files = SAMPLE_UPLOADS.map((name, index) => ({ name, type: '', size: 48_000 + index * 21_000, content: '' }));
    startJob(broadcast, id, files);
    return id;
  },
  /** 예전 말투 맞추기 원고를 둔다(0 이면 없앤다). */
  setLegacy: (files: number) => {
    state.legacy = files > 0 ? { files } : null;
    publish();
  },
  learnFromChat,
  /** taste-undo 의 기억 사건 — 나중 사건부터 되돌린다. 되돌린 규칙 id 와 건너뛴 규칙 id. */
  undoEvents(eventIds: readonly string[]): { reverted: string[]; skipped: string[] } {
    const reverted: string[] = [];
    const skipped: string[] = [];
    for (const id of [...eventIds].reverse()) {
      const ruleId = state.events.find((event) => event.pub.id === id)?.pub.ruleId ?? null;
      if (undoEvent(id)) { if (ruleId) reverted.push(ruleId); } else if (ruleId) skipped.push(ruleId);
    }
    return { reverted, skipped: skipped.filter((id) => !reverted.includes(id)) };
  },
};
