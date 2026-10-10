/**
 * 정착한 턴 접기.
 *
 * 턴이 끝나면 그 턴의 진행 이정표·도구 묶음·정착한 서브에이전트 카드를 한 줄 머리
 * 아래로 접는다. 머리는 문서 쪽 말로 쓴다 — “작업 2분 31초 · 문단 5개 수정 · 표 1개 읽음”.
 * 최종 답변·질문·계획·시스템 줄(오류 포함)은 흐름에 남는다. 오류로 끝난 턴과 아직 끝을
 * 듣지 못한 턴은 접지 않는다 — 무엇이 일어났는지 그대로 보여야 한다.
 *
 * 위쪽은 DOM 없는 순수 함수(작업 요약·접힘 계획)이고 단위 테스트가 직접 부른다.
 * 아래쪽 createTurnFoldRow 가 접힘 줄을 그린다. 대화 흐름에서 노드를 고르고 옮기는
 * 일과 스크롤은 사이드바(index.ts)가 맡는다.
 */
import { batchItemArgs } from '../../agent/batch-item.ts';
import type { ThreadMessage, ThreadToolRecord, ThreadTurnMessage } from '../../agent/threads.ts';
import type { TurnOutcome } from '../../agent/turn-outcome.ts';
import { createChevron } from '../chevron.ts';
import { createIcon, type SidebarIconName } from './icons.ts';
import { parseCssTimeMs } from './motion-model.ts';
import { formatFleetClock, isSpawnToolName } from './subagent-fleet.ts';
import { baseToolName } from './tool-presentation.ts';

// ─── 작업 요약 ─────────────────────────────────────────

export interface TurnWorkTool {
  callId: string;
  tool: string;
  argsJson: string;
  status: ThreadToolRecord['status'];
}

export interface TurnWorkTask {
  taskKind: 'agent' | 'workflow';
  status: string;
  /** 이 서브에이전트가 부른 도구의 callId — 실패한 서브에이전트의 실패한 도구는 그 실패 하나로 센다. */
  toolCallIds?: readonly string[];
}

export interface TurnWork {
  tools: TurnWorkTool[];
  tasks: TurnWorkTask[];
}

export interface TurnWorkSummary {
  /** 머리에 보이는 분류 — 많아야 두 개 */
  parts: string[];
  /** 순위대로 늘어놓은 모든 분류 */
  allParts: string[];
  /** 실패한 호출과 실패한 서브에이전트 수. 실패는 한 번도 “했다”로 세지 않는다. */
  errors: number;
}

/** 머리에 보이는 분류 수. 나머지는 펼친 본문에서 읽는다. */
const VISIBLE_PARTS = 2;
/** 문단 범위 한 번이 셀 수 있는 문단 수 상한. */
const MAX_PARAS_PER_CALL = 1000;

type WorkGroup = 'edit' | 'subagent' | 'check' | 'read' | 'search' | 'other';
const GROUP_ORDER: readonly WorkGroup[] = ['edit', 'subagent', 'check', 'read', 'search', 'other'];

interface CategoryDef {
  group: WorkGroup;
  /** 서로 다른 대상 수를 센다. 세지 않는 분류는 수 없이 한 문구로 보인다. */
  counted: boolean;
  text: (count: number) => string;
}

const counted = (group: WorkGroup, text: (count: number) => string): CategoryDef => ({ group, counted: true, text });
const plain = (group: WorkGroup, text: string): CategoryDef => ({ group, counted: false, text: () => text });

/** 분류 표 — 같은 묶음 안에서 수가 같으면 이 순서를 따른다. */
const CATEGORIES = {
  paraEdit: counted('edit', (n) => `문단 ${n}개 수정`),
  tableEdit: counted('edit', (n) => `표 ${n}개 수정`),
  tableAdd: counted('edit', (n) => `표 ${n}개 추가`),
  tableDelete: counted('edit', (n) => `표 ${n}개 삭제`),
  imageAdd: counted('edit', (n) => `그림 ${n}개 추가`),
  equationAdd: counted('edit', (n) => `수식 ${n}개 추가`),
  chartAdd: counted('edit', (n) => `차트 ${n}개 추가`),
  shapeAdd: counted('edit', (n) => `도형 ${n}개 추가`),
  objectEdit: counted('edit', (n) => `개체 ${n}개 수정`),
  footnoteAdd: counted('edit', (n) => `각주 ${n}개 추가`),
  footnoteEdit: counted('edit', (n) => `각주 ${n}개 수정`),
  fieldSet: counted('edit', (n) => `필드 ${n}개 입력`),
  bookmarkEdit: counted('edit', (n) => `책갈피 ${n}개 수정`),
  headerFooter: plain('edit', '머리말·꼬리말 수정'),
  pageSetup: plain('edit', '쪽 설정 변경'),
  templateInsert: counted('edit', (n) => `서식 틀 내용 ${n}곳 가져옴`),
  replaceAll: plain('edit', '텍스트 모두 바꿈'),
  engineEdit: counted('edit', (n) => `엔진 편집 ${n}개`),
  subagent: counted('subagent', (n) => `서브에이전트 ${n}개`),
  workflow: counted('subagent', (n) => `워크플로 ${n}개`),
  pageCheck: counted('check', (n) => `쪽 ${n}개 확인`),
  verify: plain('check', '변경 확인'),
  equationCheck: plain('check', '수식 확인'),
  paraRead: counted('read', (n) => `문단 ${n}개 읽음`),
  tableRead: counted('read', (n) => `표 ${n}개 읽음`),
  pageRead: counted('read', (n) => `쪽 ${n}개 읽음`),
  documentRead: plain('read', '문서 읽음'),
  templateRead: plain('read', '서식 틀 읽음'),
  referenceRead: plain('read', '참고 자료 읽음'),
  search: counted('search', (n) => `검색 ${n}번`),
  version: plain('other', '버전 저장'),
  fileExport: counted('other', (n) => `파일 ${n}개 내보냄`),
  fileDownload: counted('other', (n) => `파일 ${n}개 내려받음`),
  web: plain('other', '웹 탐색'),
  copyLayout: plain('other', '레이아웃 복제'),
  instructions: plain('other', '지시 변경 제안'),
  skill: plain('other', '스킬 변경'),
  foreign: counted('other', (n) => `도구 ${n}번`),
} satisfies Record<string, CategoryDef>;

type CategoryId = keyof typeof CATEGORIES;
const CATEGORY_ORDER = Object.keys(CATEGORIES) as CategoryId[];

/**
 * 요약에 넣지 않는 도구 — 카드가 따로 보이거나(질문·계획·서브에이전트 스폰) 문서와
 * 상관없는 준비·확인 호출이다. 계약 테스트가 허브의 도구 목록과 맞춰 본다.
 */
export const TURN_SUMMARY_IGNORED_TOOLS: ReadonlySet<string> = new Set([
  'ask_user_question',
  'present_implementation_plan',
  'update_todos',
  'get_selection',
  'get_active_template',
  'get_engine_edit_capabilities',
  'prepare_engine_edit_session',
  'materialize_document_snapshot',
  'read_agent_instructions',
  'read_product_skill',
  'list_harness_skills',
  // CLI 의 할 일 도구 — update_todos 와 같은 일이다.
  'TodoWrite',
  'todowrite',
  'update_plan',
]);

const DOCUMENT_READ_TOOLS = new Set([
  'get_document_info', 'get_outline', 'get_fields', 'list_styles', 'list_numberings', 'list_footnotes', 'list_bookmarks',
]);
const REFERENCE_READ_TOOLS = new Set(['list_reference_files', 'read_reference_chunk', 'read_reference_image']);
const COPY_LAYOUT_TOOLS = new Set([
  'delegate_copy_layout', 'update_copy_layout_job', 'run_copy_layout_helper', 'complete_copy_layout_job',
  'register_copy_layout_template',
]);
const PARA_TEXT_TOOLS = new Set([
  'insert_text', 'delete_range', 'replace_range', 'apply_char_format', 'apply_para_format', 'apply_style',
  'apply_list', 'insert_page_break', 'template_apply_paragraph_format',
]);
const TABLE_EDIT_TOOLS = new Set(['edit_table', 'set_table_props', 'set_cell_props', 'set_zone_borders']);
const INSERT_TOOLS: Readonly<Record<string, CategoryId>> = {
  create_table: 'tableAdd',
  insert_image: 'imageAdd',
  insert_equation: 'equationAdd',
  insert_chart: 'chartAdd',
  insert_shape: 'shapeAdd',
  insert_footnote: 'footnoteAdd',
  template_insert_block: 'templateInsert',
  publish_artifact: 'fileExport',
  download_file: 'fileDownload',
  find_text: 'search',
  search_reference_files: 'search',
};
const ONCE_TOOLS: Readonly<Record<string, CategoryId>> = {
  edit_header_footer: 'headerFooter',
  set_page_layout: 'pageSetup',
  template_apply_section_layout: 'pageSetup',
  replace_all: 'replaceAll',
  verify_changes: 'verify',
  preview_equation: 'equationCheck',
  commit_version: 'version',
  update_agent_instructions: 'instructions',
  commit_product_skill: 'skill',
};

type Args = Record<string, unknown>;

interface Hit {
  category: CategoryId;
  keys: string[];
}

function rec(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 0 이상의 정수 좌표 — 아니면 null. */
function index(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseArgs(argsJson: string): Args {
  try {
    return rec(JSON.parse(argsJson));
  } catch {
    return {};
  }
}

function sectionOf(a: Args): number {
  return index(a['sectionIdx']) ?? 0;
}

/** 표 하나의 키 — 같은 표를 여러 번 건드려도 한 번 센다. 주소가 없으면 호출마다 따로다. */
function tableKey(a: Args, unique: string): string {
  const p = index(a['paraIdx']);
  const c = index(a['controlIdx']);
  return p !== null && c !== null ? `${sectionOf(a)}|${p}|${c}` : `${unique}:table`;
}

/** 셀 안을 가리키면 그 셀이 든 표의 키, 아니면 null. 셀 안 편집은 표 편집으로 센다. */
function cellTableKey(a: Args, unique: string): string | null {
  if (a['cell'] !== undefined && a['cell'] !== null) {
    const cell = rec(a['cell']);
    const p = index(cell['paraIdx']);
    const c = index(cell['controlIdx']);
    return p !== null && c !== null ? `${sectionOf(a)}|${p}|${c}` : `${unique}:cell`;
  }
  return Array.isArray(a['cellPath']) && a['cellPath'].length > 0 ? `${unique}:cell` : null;
}

/**
 * 호출 하나가 건드린 문단 키 — paras, targets, paraIdx, startParaIdx..endParaIdx 순으로 본다.
 * 문단 번호 없이 찾는 글(find·anchor)만 있으면 호출마다 한 문단으로 센다(위로 잡은 수).
 */
function paragraphKeys(a: Args, unique: string): string[] {
  const keys: string[] = [];
  const section = sectionOf(a);
  const push = (s: number, p: number) => {
    if (keys.length < MAX_PARAS_PER_CALL) keys.push(`${s}|${p}`);
  };
  const span = (s: number, first: number, last: number) => {
    for (let p = first; p <= last && keys.length < MAX_PARAS_PER_CALL; p += 1) push(s, p);
  };
  const paras = a['paras'];
  const targets = a['targets'];
  const paraIdx = index(a['paraIdx']);
  const start = index(a['startParaIdx']);
  if (Array.isArray(paras) && paras.length > 0) {
    for (const entry of paras) {
      if (Array.isArray(entry)) {
        const first = index(entry[0]);
        const last = index(entry[1]);
        if (first !== null && last !== null && last >= first) span(section, first, last);
      } else {
        const p = index(entry);
        if (p !== null) push(section, p);
      }
    }
  } else if (Array.isArray(targets) && targets.length > 0) {
    for (const target of targets) {
      const t = rec(target);
      const p = index(t['paraIdx']);
      if (p !== null) push(index(t['sectionIdx']) ?? section, p);
    }
  } else if (paraIdx !== null) {
    push(section, paraIdx);
  } else if (start !== null) {
    const end = index(a['endParaIdx']) ?? start;
    span(section, start, Math.max(start, end));
  }
  return keys.length > 0 ? keys : [`${unique}:anchor`];
}

function batchHits(list: unknown, unique: string): Hit[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item, i) => {
    const entry = rec(item);
    return classifyCall(baseToolName(str(entry['tool'])), batchItemArgs(entry) ?? {}, `${unique}#${i}`, false);
  });
}

/** 성공한 호출 하나가 어느 분류에 무엇을 더하는지. 모르는 도구는 “도구 N번”이다. */
function classifyCall(name: string, a: Args, unique: string, expandBatch = true): Hit[] {
  if (expandBatch && name === 'apply_edits') return batchHits(a['edits'], unique);
  if (expandBatch && name === 'read_batch') return batchHits(a['reads'], unique);
  if (PARA_TEXT_TOOLS.has(name)) {
    const table = cellTableKey(a, unique);
    return table !== null
      ? [{ category: 'tableEdit', keys: [table] }]
      : [{ category: 'paraEdit', keys: paragraphKeys(a, unique) }];
  }
  if (TABLE_EDIT_TOOLS.has(name)) return [{ category: 'tableEdit', keys: [tableKey(a, unique)] }];
  const insert = INSERT_TOOLS[name];
  if (insert) return [{ category: insert, keys: [unique] }];
  const once = ONCE_TOOLS[name];
  if (once) return [{ category: once, keys: ['*'] }];
  switch (name) {
    case 'delete_table':
      return [{ category: 'tableDelete', keys: [tableKey(a, unique)] }];
    case 'edit_object': {
      const p = index(a['paraIdx']);
      const c = index(a['controlIdx']);
      const where = cellTableKey(a, unique) ?? '';
      return [{ category: 'objectEdit', keys: [p !== null && c !== null ? `${sectionOf(a)}|${where}|${p}|${c}` : unique] }];
    }
    case 'edit_footnote':
      return [{ category: 'footnoteEdit', keys: [tableKey(a, unique)] }];
    case 'set_field_value':
      return [{ category: 'fieldSet', keys: [str(a['name']) || unique] }];
    case 'set_bookmark':
      return [{ category: 'bookmarkEdit', keys: [str(a['name']) || unique] }];
    case 'apply_engine_edits': {
      const operations = Array.isArray(a['operations']) ? a['operations'].length : 0;
      return [{ category: 'engineEdit', keys: Array.from({ length: Math.max(1, operations) }, (_, i) => `${unique}:${i}`) }];
    }
    case 'render_page':
    case 'template_render_page': {
      const page = index(a['pageIndex']);
      const space = name === 'render_page' ? 'doc' : 'template';
      return [{ category: 'pageCheck', keys: [page !== null ? `${space}|${page}` : unique] }];
    }
    case 'get_text_range':
    case 'get_para_format':
    case 'get_char_format': {
      const table = cellTableKey(a, unique);
      return table !== null
        ? [{ category: 'tableRead', keys: [table] }]
        : [{ category: 'paraRead', keys: paragraphKeys(a, unique) }];
    }
    case 'get_structure': {
      const range = rec(a['range']);
      const from = index(range['fromPara']);
      if (from === null) return [{ category: 'documentRead', keys: ['*'] }];
      return [{
        category: 'paraRead',
        keys: paragraphKeys({ sectionIdx: range['sectionIdx'], startParaIdx: from, endParaIdx: range['toPara'] }, unique),
      }];
    }
    case 'get_table_properties':
    case 'get_table_layout':
      return [{ category: 'tableRead', keys: [tableKey(a, unique)] }];
    case 'get_page_geometry': {
      const page = index(a['pageIndex']);
      return [{ category: 'pageRead', keys: [page !== null ? `${page}` : unique] }];
    }
  }
  if (DOCUMENT_READ_TOOLS.has(name)) return [{ category: 'documentRead', keys: ['*'] }];
  if (REFERENCE_READ_TOOLS.has(name)) return [{ category: 'referenceRead', keys: ['*'] }];
  if (name.startsWith('template_get_') || name === 'template_list_styles') return [{ category: 'templateRead', keys: ['*'] }];
  if (name.startsWith('browserbase_')) return [{ category: 'web', keys: ['*'] }];
  if (COPY_LAYOUT_TOOLS.has(name)) return [{ category: 'copyLayout', keys: ['*'] }];
  if (TURN_SUMMARY_IGNORED_TOOLS.has(name) || isSpawnToolName(name) || !name) return [];
  return [{ category: 'foreign', keys: [unique] }];
}

/**
 * 한 턴의 작업을 문서 쪽 말로 요약한다.
 * 성공한 호출만 분류에 들어가고, 실패한 호출(되돌린 묶음 편집은 한 번)과 실패한
 * 서브에이전트는 오류로만 센다. 실패한 서브에이전트 안에서 실패한 도구는 그 서브에이전트의
 * 실패 하나에 든다. 멈춘 호출과 도는 호출은 어디에도 세지 않는다.
 */
export function summarizeTurnWork(work: TurnWork): TurnWorkSummary {
  const tally = new Map<CategoryId, Set<string>>();
  const add = (hit: Hit) => {
    let keys = tally.get(hit.category);
    if (!keys) tally.set(hit.category, keys = new Set());
    for (const key of hit.keys) keys.add(key);
  };
  let errors = 0;
  const seen = new Set<string>();
  const insideFailedTask = new Set(work.tasks
    .filter((task) => task.status === 'failed')
    .flatMap((task) => task.toolCallIds ?? []));
  work.tools.forEach((tool, position) => {
    if (tool.callId) {
      if (seen.has(tool.callId)) return;
      seen.add(tool.callId);
    }
    if (tool.status === 'failed') {
      if (!tool.callId || !insideFailedTask.has(tool.callId)) errors += 1;
      return;
    }
    if (tool.status !== 'completed') return;
    const unique = tool.callId || `call-${position}`;
    for (const hit of classifyCall(baseToolName(tool.tool), parseArgs(tool.argsJson), unique)) add(hit);
  });
  work.tasks.forEach((task, position) => {
    if (task.status === 'failed') {
      errors += 1;
      return;
    }
    if (task.status !== 'completed') return;
    add({ category: task.taskKind === 'workflow' ? 'workflow' : 'subagent', keys: [`task-${position}`] });
  });
  const ranked = [...tally.entries()]
    .filter(([, keys]) => keys.size > 0)
    .map(([id, keys]) => {
      const def: CategoryDef = CATEGORIES[id];
      return { def, count: def.counted ? keys.size : 0, group: GROUP_ORDER.indexOf(def.group), order: CATEGORY_ORDER.indexOf(id), size: keys.size };
    })
    .sort((a, b) => a.group - b.group || b.count - a.count || a.order - b.order);
  const allParts = ranked.map((entry) => entry.def.text(entry.size));
  return { parts: allParts.slice(0, VISIBLE_PARTS), allParts, errors };
}

/** 12초 · 2분 31초 · 1시간 5분 — 한 시간 안은 서브에이전트 시계와 같은 꼴이다. */
export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 3600) return formatFleetClock(total * 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

/** 'legacy' = 표식이 없던 시절의 턴 — 사용자 메시지 경계로만 묶고 시간은 모른다. */
export type TurnFoldOutcome = TurnOutcome | 'legacy';

export interface TurnFoldFacts {
  outcome: TurnFoldOutcome;
  durationMs: number | null;
  parts: string[];
  errors: number;
}

export interface TurnFoldSummaryView {
  outcome: TurnFoldOutcome;
  /** 오류 수를 뺀 머리 */
  label: string;
  /** “· 오류 1” — 없으면 빈 문자열 */
  errorsText: string;
  /** 접근성 이름과 툴팁 — 머리 전체 */
  title: string;
  /** 펼칠 작업이 있는가. 없으면 쉐브론 없는 한 줄이다. */
  expandable: boolean;
}

function turnFoldHead(fold: TurnFoldFacts): string {
  if (fold.outcome === 'legacy') return '작업 내역';
  if (fold.outcome === 'interrupted') {
    // 1초도 안 돼 멈췄거나 끝 시각을 모르면 시간은 붙이지 않는다.
    return fold.durationMs !== null && fold.durationMs >= 1000
      ? `중단됨 · ${formatTurnDuration(fold.durationMs)}`
      : '중단됨';
  }
  return fold.durationMs !== null ? `작업 ${formatTurnDuration(fold.durationMs)}` : '작업';
}

/** 접힘 머리 전체 — “작업 48초 · 표 1개 추가 · 오류 1”. */
export function turnFoldLabel(fold: TurnFoldFacts): string {
  const view = turnFoldSummaryView(fold, true);
  return view.title;
}

export function turnFoldSummaryView(fold: TurnFoldFacts, expandable: boolean): TurnFoldSummaryView {
  const label = [turnFoldHead(fold), ...fold.parts].join(' · ');
  const errorsText = fold.errors > 0 ? `· 오류 ${fold.errors}` : '';
  return {
    outcome: fold.outcome,
    label,
    errorsText,
    title: errorsText ? `${label} ${errorsText}` : label,
    expandable,
  };
}

// ─── 접힘 계획 ─────────────────────────────────────────

/** 접힘 본문으로 들어가는 기록 — 진행 이정표, 도구 묶음, 서브에이전트 묶음. */
export function isTurnWorkMessage(message: ThreadMessage): boolean {
  return message.role === 'assistant'
    && (message.kind === 'progress' || message.kind === 'activity' || message.kind === 'tasks');
}

function isMarker(message: ThreadMessage): message is ThreadTurnMessage {
  return message.kind === 'turn';
}

function collectWork(messages: readonly ThreadMessage[]): TurnWork {
  const work: TurnWork = { tools: [], tasks: [] };
  for (const message of messages) {
    if (message.kind === 'activity') {
      for (const tool of message.tools) work.tools.push(tool);
    } else if (message.kind === 'tasks') {
      for (const task of message.tasks) {
        work.tasks.push({
          taskKind: task.taskKind,
          status: task.status,
          toolCallIds: task.tools.map((tool) => tool.callId).filter(Boolean),
        });
        for (const tool of task.tools) work.tools.push(tool);
      }
    }
  }
  return work;
}

/** 표식 뒤부터 다음 사용자 메시지·표식 전까지의 기록 순번. 정착과 복원이 같이 쓴다. */
function turnMessageIndexes(messages: readonly ThreadMessage[], marker: ThreadTurnMessage): number[] {
  let start = messages.indexOf(marker);
  if (start < 0) start = messages.findIndex((message) => isMarker(message) && message.messageId === marker.messageId);
  if (start < 0) return [];
  const indexes: number[] = [];
  for (let i = start + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'user' || isMarker(message)) break;
    indexes.push(i);
  }
  return indexes;
}

/** 표식 뒤부터 다음 사용자 메시지·표식 전까지의 도구·작업 기록 — 정착과 복원이 같이 쓴다. */
export function turnWorkFor(messages: readonly ThreadMessage[], marker: ThreadTurnMessage): TurnWork {
  return collectWork(turnMessageIndexes(messages, marker).map((i) => messages[i]));
}

/** 편집 턴이 답변 없이 끝나면 사이드바가 덧붙이는 안내. 모델이 쓴 답이 아니라 최종 답변으로 치지 않는다. */
export const TURN_CHECK_DOCUMENT_TEXT = '작업 완료 · 문서 확인';

/** 모델이 쓴 최종 답변인가 — 진행 이정표·카드·안내가 아닌 어시스턴트 글. */
function isAnswerMessage(message: ThreadMessage): boolean {
  if (message.role !== 'assistant' || message.kind !== undefined) return false;
  const text = message.text.trim();
  return text !== '' && text !== TURN_CHECK_DOCUMENT_TEXT;
}

/**
 * 흐름에 남길 마지막 이정표의 순번. 보고를 쓴 뒤 할 일 정리·버전 저장·변경 확인 같은 도구를
 * 부르고 끝난 턴에는 최종 답변 말풍선이 없다 — 그 턴의 마지막 글(마지막 이정표)이 곧 답이라
 * 접지 않는다. 답을 내지 못한 중단된 턴은 그대로 접는다. span 은 그 턴 메시지의 순번이다.
 */
function finalMilestoneIndex(
  messages: readonly ThreadMessage[],
  span: readonly number[],
  outcome: TurnFoldOutcome,
): number | null {
  if (outcome !== 'completed' && outcome !== 'legacy') return null;
  for (let k = span.length - 1; k >= 0; k -= 1) {
    const message = messages[span[k]];
    if (isAnswerMessage(message)) return null;
    if (message.role === 'assistant' && message.kind === 'progress') return span[k];
  }
  return null;
}

/** 턴 메시지 가운데 접힘 본문으로 들어가는 작업 메시지의 순번 — 답이 된 마지막 이정표는 빠진다. */
function foldMembers(messages: readonly ThreadMessage[], span: readonly number[], outcome: TurnFoldOutcome): number[] {
  const kept = finalMilestoneIndex(messages, span, outcome);
  return span.filter((i) => i !== kept && isTurnWorkMessage(messages[i]));
}

/**
 * 정착한 턴이 마지막 이정표를 흐름에 남기는가 — 최종 답변 없이 끝난 완료 턴이다. 턴 끝에서
 * 화면의 작업을 접을 때 복원(planTurnFolds)과 같은 규칙으로 고른다.
 */
export function keepsFinalMilestone(messages: readonly ThreadMessage[], marker: ThreadTurnMessage): boolean {
  if (marker.endedAt === null || marker.outcome === null) return false;
  return finalMilestoneIndex(messages, turnMessageIndexes(messages, marker), marker.outcome) !== null;
}

/** 정착한 표식의 접힘 머리 — 턴 끝에서 화면의 줄을 채울 때 쓴다. 정착 전이면 null. */
export function settledTurnView(
  messages: readonly ThreadMessage[],
  marker: ThreadTurnMessage,
  expandable: boolean,
): TurnFoldSummaryView | null {
  if (marker.endedAt === null || marker.outcome === null) return null;
  const summary = summarizeTurnWork(turnWorkFor(messages, marker));
  return turnFoldSummaryView({
    outcome: marker.outcome,
    durationMs: Math.max(0, marker.endedAt - marker.startedAt),
    parts: summary.parts,
    errors: summary.errors,
  }, expandable);
}

/**
 * 정착하는 표식에 남길 접힘 제목 — 옛 빌드가 한 줄 안내로 보인다. 접지 않는 턴(오류로
 * 끝났거나 작업 없이 끝난 턴)은 빈 문자열이다.
 */
export function settledTurnText(
  messages: readonly ThreadMessage[],
  marker: ThreadTurnMessage,
  outcome: TurnOutcome,
  endedAt: number,
): string {
  if (outcome === 'failed') return '';
  const indexes = turnMessageIndexes(messages, marker);
  if (outcome === 'completed' && foldMembers(messages, indexes, outcome).length === 0) return '';
  const summary = summarizeTurnWork(collectWork(indexes.map((i) => messages[i])));
  return turnFoldLabel({
    outcome,
    durationMs: Math.max(0, endedAt - marker.startedAt),
    parts: summary.parts,
    errors: summary.errors,
  });
}

export interface TurnFoldEntry {
  /** 표식 id. 표식 없는 옛 턴은 'legacy-<첫 작업 메시지 순번>' */
  id: string;
  /** 접힘 줄이 놓이는 메시지 순번 — 표식, 옛 턴은 첫 작업 메시지 */
  anchorIndex: number;
  outcome: TurnFoldOutcome;
  durationMs: number | null;
  /** 접힘 본문으로 들어가는 작업 메시지 순번 */
  members: number[];
  summary: TurnWorkSummary;
  view: TurnFoldSummaryView;
}

export interface TurnFoldPlan {
  folds: TurnFoldEntry[];
  /** 메시지마다 들어갈 접힘(folds 의 순번) — null 이면 흐름에 그린다 */
  placement: Array<number | null>;
  /** 접힘 줄 자리(anchorIndex) → folds 의 순번 */
  anchors: Map<number, number>;
  /** 아직 정착하지 않은 표식의 메시지 순번 — 접지 않고 숨은 자리표시만 둔다 */
  unsettled: number[];
}

/**
 * 저장된 대화를 턴별로 접는 계획.
 *
 * - 사용자 메시지는 열린 턴을 닫는다. 표식은 열린 턴을 닫고 새 턴을 연다.
 * - 열린 턴 없이 작업 메시지가 오면 표식 없는 옛 턴을 그 자리에서 연다.
 * - 오류로 끝난 턴과 아직 정착하지 않은 턴은 접지 않는다. 작업 없이 끝난 턴도 줄이 없다.
 *   중단된 턴은 작업이 없어도 펼칠 것 없는 한 줄을 남긴다.
 * - 작업 메시지만 접힘으로 들어간다. 답변·질문·계획·시스템 줄은 흐름에 남는다. 최종 답변
 *   없이 끝난 턴은 마지막 이정표가 그 턴의 답이라 흐름에 남는다.
 */
export function planTurnFolds(messages: readonly ThreadMessage[]): TurnFoldPlan {
  interface Draft {
    id: string;
    anchorIndex: number;
    marker: ThreadTurnMessage | null;
    /** 이 턴의 메시지 순번(표식 제외) — 다음 사용자 메시지·표식 전까지 */
    span: number[];
  }
  const drafts: Draft[] = [];
  const unsettled: number[] = [];
  let open: Draft | null = null;
  messages.forEach((message, i) => {
    if (message.role === 'user') {
      open = null;
      return;
    }
    if (isMarker(message)) {
      open = { id: message.messageId, anchorIndex: i, marker: message, span: [] };
      drafts.push(open);
      if (message.endedAt === null) unsettled.push(i);
      return;
    }
    if (!open) {
      if (!isTurnWorkMessage(message)) return;
      open = { id: `legacy-${i}`, anchorIndex: i, marker: null, span: [] };
      drafts.push(open);
    }
    open.span.push(i);
  });

  const folds: TurnFoldEntry[] = [];
  const placement: Array<number | null> = messages.map(() => null);
  const anchors = new Map<number, number>();
  for (const draft of drafts) {
    const marker = draft.marker;
    let outcome: TurnFoldOutcome;
    let durationMs: number | null = null;
    if (!marker) {
      outcome = 'legacy';
    } else {
      if (marker.endedAt === null || marker.outcome === null || marker.outcome === 'failed') continue;
      outcome = marker.outcome;
      durationMs = Math.max(0, marker.endedAt - marker.startedAt);
    }
    const members = foldMembers(messages, draft.span, outcome);
    if (members.length === 0 && outcome !== 'interrupted') continue;
    const summary = summarizeTurnWork(collectWork(members.map((i) => messages[i])));
    const foldIndex = folds.length;
    folds.push({
      id: draft.id,
      anchorIndex: draft.anchorIndex,
      outcome,
      durationMs,
      members,
      summary,
      view: turnFoldSummaryView({ outcome, durationMs, parts: summary.parts, errors: summary.errors }, members.length > 0),
    });
    anchors.set(draft.anchorIndex, foldIndex);
    for (const member of members) placement[member] = foldIndex;
  }
  return { folds, placement, anchors, unsettled };
}

// ─── 접힘 줄 ───────────────────────────────────────────

/**
 * 대화 흐름에서 접힘으로 옮길 작업 노드인가 — 진행 이정표(도구만 있는 단계 포함),
 * 정착한 서브에이전트 카드 슬롯, 복원한 서브에이전트 묶음. 숨은 편대 슬롯은 아직
 * 백그라운드로 도는 카드가 나중에 내려앉을 자리라 흐름에 남는다. 모르는 노드도 남는다.
 */
export function isTurnWorkNode(node: Element): boolean {
  if (node.classList.contains('ag-fleet-slot')) return !(node as HTMLElement).hidden;
  return node.classList.contains('ag-progress-step') || node.classList.contains('ag-restored-task-group');
}

/** 이정표 글이 든 진행 단계인가 — 도구만 있는 단계는 아니다. */
function isMilestoneStep(node: Element): boolean {
  return node.classList.contains('ag-progress-step')
    && [...node.children].some((child) => child.classList.contains('ag-progress-milestone'));
}

/** 노드를 순서대로 target 끝으로 옮긴다. 옮기면 처음으로 돌아가는 스크롤 위치와 초점을 지킨다. */
function moveNodes(target: HTMLElement, nodes: readonly HTMLElement[]): void {
  const doc = target.ownerDocument;
  const focused = doc.activeElement;
  const scrolled: Array<{ element: Element; top: number; left: number }> = [];
  for (const node of nodes) {
    for (const element of [node, ...node.querySelectorAll('*')]) {
      if (element.scrollTop > 0 || element.scrollLeft > 0) {
        scrolled.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
    }
  }
  target.append(...nodes);
  for (const entry of scrolled) {
    entry.element.scrollTop = entry.top;
    entry.element.scrollLeft = entry.left;
  }
  if (focused instanceof HTMLElement && focused !== doc.activeElement
    && nodes.some((node) => node.contains(focused))) {
    focused.focus({ preventScroll: true });
  }
}

/**
 * 최종 답변 없이 끝난 턴의 마지막 이정표를 흐름에 남긴다(keepsFinalMilestone). 작업 노드에서
 * 마지막 이정표 단계를 빼고, 그 단계에 붙은 도구 묶음·카드 슬롯은 바로 뒤의 새 도구 단계로
 * 갈라 접힘에 넣는다 — 복원한 대화와 같은 모양이다. 접힘에 넣을 작업 노드를 돌려준다.
 */
export function releaseFinalMilestone(nodes: readonly HTMLElement[]): HTMLElement[] {
  const work = [...nodes];
  let at = work.length - 1;
  while (at >= 0 && !isMilestoneStep(work[at])) at -= 1;
  if (at < 0) return work;
  const step = work[at];
  const tail = [...step.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement && !child.classList.contains('ag-progress-milestone'));
  if (tail.length === 0) {
    work.splice(at, 1);
    return work;
  }
  const tools = step.ownerDocument.createElement('div');
  tools.className = 'ag-progress-step ag-progress-step-tools-only';
  step.after(tools);
  moveNodes(tools, tail);
  work.splice(at, 1, tools);
  return work;
}

export interface TurnFoldRowOptions {
  /** 사용자가 머리를 눌러 펼치거나(false) 접기(true) 직전에 부른다. */
  onUserToggle?: (collapsed: boolean) => void;
}

export interface TurnFoldRow {
  root: HTMLElement;
  /** 접힌 작업이 들어가는 본문 */
  body: HTMLElement;
  setSummary(view: TurnFoldSummaryView): void;
  /** animate:false 면 전환 없이 바로 바꾼다(복원·가려진 사이드바). */
  setCollapsed(collapsed: boolean, opts?: { animate?: boolean }): void;
  /**
   * 턴 끝에서 접는다 — 작업이 차지하던 자리(접힌 머리 아래로 남는 높이)에서 출발해 그
   * 자리만 닫는다. 아래 답변이 먼저 밀려 내려갔다 올라오지 않고 제자리에서 올라붙는다.
   */
  collapseFrom(heightPx: number): void;
  isCollapsed(): boolean;
  /** 작업 노드를 순서대로 본문에 옮긴다. 스크롤 위치·초점을 지키고 다시 도는 등장 애니메이션은 끝낸다. */
  adopt(nodes: readonly HTMLElement[]): void;
}

const OUTCOME_ICON: Record<TurnFoldOutcome, SidebarIconName> = {
  completed: 'check',
  interrupted: 'close',
  failed: 'close',
  legacy: 'terminal',
};

let foldRowSeq = 0;

function finishReplayedAnimations(node: HTMLElement): void {
  if (typeof node.getAnimations !== 'function') return;
  for (const animation of node.getAnimations({ subtree: true })) {
    const cssDriven = (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation)
      || (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition);
    if (!cssDriven) continue;
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) animation.finish();
  }
}

/**
 * 접힘 줄 — 도구 활동 묶음과 같은 집안의 한 줄 머리(아이콘·제목·오류·쉐브론)와 그 아래
 * 접히는 본문. 접힌 본문은 inert 라 초점과 클릭을 받지 않는다. 처음에는 접힌 채다.
 */
export function createTurnFoldRow(turnId: string, opts: TurnFoldRowOptions = {}): TurnFoldRow {
  const doc = document;
  const bodyId = `ag-turn-fold-${++foldRowSeq}`;
  const root = doc.createElement('div');
  root.className = 'ag-turn-fold ag-turn-fold-collapsed';
  root.dataset.turnId = turnId;
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ag-turn-fold-toggle';
  let icon: SVGSVGElement = createIcon('check', 'ag-turn-fold-icon');
  const label = doc.createElement('span');
  label.className = 'ag-turn-fold-label';
  const errors = doc.createElement('span');
  errors.className = 'ag-turn-fold-errors';
  errors.hidden = true;
  const chevron = createChevron('ag-turn-fold-chevron');
  toggle.append(icon, label, errors, chevron);
  const collapse = doc.createElement('div');
  collapse.className = 'ag-turn-fold-collapse';
  const body = doc.createElement('div');
  body.className = 'ag-turn-fold-body';
  body.id = bodyId;
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', '이 턴의 작업 내역');
  body.inert = true;
  collapse.appendChild(body);
  root.append(toggle, collapse);

  let expandable = true;
  /** 턴 끝에서 비는 자리를 닫는 전환 — 그 사이에 사용자가 펼치면 멈춘다. */
  let closing: Animation | null = null;
  const isCollapsed = () => root.classList.contains('ag-turn-fold-collapsed');

  function syncExpandedState(): void {
    if (expandable) {
      toggle.removeAttribute('aria-disabled');
      toggle.setAttribute('aria-controls', bodyId);
      toggle.setAttribute('aria-expanded', isCollapsed() ? 'false' : 'true');
    } else {
      toggle.setAttribute('aria-disabled', 'true');
      toggle.removeAttribute('aria-controls');
      toggle.removeAttribute('aria-expanded');
    }
  }

  function setCollapsed(collapsed: boolean, options: { animate?: boolean } = {}): void {
    const instant = options.animate === false;
    const focusInside = collapsed && body.contains(doc.activeElement);
    closing?.cancel();
    closing = null;
    if (instant) collapse.style.transition = 'none';
    root.classList.toggle('ag-turn-fold-collapsed', collapsed);
    body.inert = collapsed;
    syncExpandedState();
    // 접히며 초점이 본문 안에 갇히지 않게 머리로 옮긴다.
    if (focusInside) toggle.focus({ preventScroll: true });
    if (instant) {
      void root.offsetHeight;
      collapse.style.transition = '';
    }
  }

  toggle.addEventListener('click', () => {
    if (!expandable) return;
    const collapsed = !isCollapsed();
    opts.onUserToggle?.(collapsed);
    setCollapsed(collapsed);
  });
  syncExpandedState();

  return {
    root,
    body,
    setSummary(view: TurnFoldSummaryView): void {
      root.dataset.outcome = view.outcome;
      const nextIcon = createIcon(OUTCOME_ICON[view.outcome], 'ag-turn-fold-icon');
      icon.replaceWith(nextIcon);
      icon = nextIcon;
      label.textContent = view.label;
      errors.textContent = view.errorsText;
      errors.hidden = !view.errorsText;
      toggle.setAttribute('aria-label', view.title);
      toggle.title = view.title;
      expandable = view.expandable;
      root.classList.toggle('ag-turn-fold-static', !expandable);
      chevron.style.display = expandable ? '' : 'none';
      if (!expandable && !isCollapsed()) setCollapsed(true, { animate: false });
      syncExpandedState();
    },
    setCollapsed,
    collapseFrom(heightPx: number): void {
      setCollapsed(true, { animate: false });
      if (!(heightPx >= 1) || typeof collapse.animate !== 'function') return;
      const duration = parseCssTimeMs(getComputedStyle(root).getPropertyValue('--ag-dur-exit'), 180);
      // 접힌 작업은 바로 감추고, 비는 자리만 닫는다 — 머리 아래로 밀린 작업이 비치지 않는다.
      closing = collapse.animate([
        { gridTemplateRows: `${Math.round(heightPx)}px`, opacity: 0 },
        { gridTemplateRows: '0px', opacity: 0 },
      ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    },
    isCollapsed,
    adopt(nodes: readonly HTMLElement[]): void {
      if (nodes.length === 0) return;
      moveNodes(body, nodes);
      for (const node of nodes) finishReplayedAnimations(node);
    },
  };
}
