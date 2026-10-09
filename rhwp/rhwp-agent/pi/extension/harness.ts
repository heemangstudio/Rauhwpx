/**
 * rhwp pi 확장의 하니스 로직 — 도구 분류, 인자 복구, revision 추적, 마무리 점검, 컨텍스트 정리.
 *
 * 전부 순수 함수다. rhwp.ts 가 Pi 이벤트에 연결하고, tests/pi-harness.test.mjs 가 직접 임포트한다
 * (node 의 타입 스트리핑으로 로드되므로 지울 수 있는 TS 문법만 쓴다).
 */

type JsonSchema = Record<string, any>;

// ─────────────────────────────────────────────────────────────────────────────
// 도구 분류 — 실행 방식, 주석, 로드아웃
// ─────────────────────────────────────────────────────────────────────────────

/** 문서·작업 공간을 바꾸지 않는 허브 도구 분류. 이 분류만 병렬로 돈다. */
export const READ_ONLY_CATEGORIES = Object.freeze([
  'document-read',
  'reference-read',
  'template-read',
  'instruction-read',
]);

export function isReadOnlyCategory(category: string | undefined): boolean {
  return typeof category === 'string' && READ_ONLY_CATEGORIES.includes(category);
}

/**
 * Pi 의 도구 실행 방식. 한 메시지에 sequential 도구가 하나라도 있으면 Pi 는 그 메시지의
 * 호출을 전부 순서대로 돌린다(pi-agent-core executeToolCalls). 그래서 읽기만 모인 메시지는
 * 동시에, 쓰기가 섞인 메시지는 적힌 순서대로 실행된다.
 */
export function toolExecutionModeFor(category: string | undefined): 'parallel' | 'sequential' {
  return isReadOnlyCategory(category) ? 'parallel' : 'sequential';
}

/** MCP 주석과 같은 뜻 (tools.mjs toolAnnotations 와 같은 판정). */
export function toolAnnotationsFor(category: string | undefined): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: isReadOnlyCategory(category),
    destructiveHint: category === 'download-write',
    openWorldHint: category === 'browser' || category === 'download-write',
  };
}

/**
 * RHWP_PI_LOADOUT=core 에서 바로 노출하는 도구. 나머지는 deferred 로 등록되어 Pi 내장
 * tool_search 로 불러온다. 허브는 노출과 무관하게 프로필로 모든 호출을 인가한다.
 */
export const PI_CORE_TOOLS = Object.freeze({
  names: Object.freeze([
    // 문서 읽기
    'get_structure',
    'read_batch',
    'find_text',
    'get_selection',
    'render_page',
    'get_page_geometry',
    'verify_changes',
    // 문서 쓰기
    'apply_edits',
    'replace_all',
    'insert_image',
    'edit_table',
    'create_table',
    'insert_shape',
    'edit_object',
    'commit_version',
  ]),
  /** 프로필에 들어 있으면 늘 바로 노출하는 분류. */
  categories: Object.freeze([
    'user-interaction',
    'planning-control',
    'plan-progress',
    'reference-read',
    'instruction-read',
    'instruction-write',
  ]),
});

export function toolExposureFor(
  def: { name: string; category?: string },
  loadout: string,
): 'direct' | 'deferred' {
  if (loadout !== 'core') return 'direct';
  if (PI_CORE_TOOLS.names.includes(def.name)) return 'direct';
  if (typeof def.category === 'string' && PI_CORE_TOOLS.categories.includes(def.category)) return 'direct';
  return 'deferred';
}

// ─────────────────────────────────────────────────────────────────────────────
// 인자 복구 — 약한 모델의 흔한 실수를 스키마를 근거로만 고친다
// ─────────────────────────────────────────────────────────────────────────────

/** 배치 항목의 tool 에 붙어 오는 provider 접두사. */
export const TOOL_NAME_PREFIXES = Object.freeze(['mcp__rhwp__', 'rhwp__', 'rhwp.']);

export function stripToolPrefix(name: unknown): unknown {
  if (typeof name !== 'string') return name;
  for (const prefix of TOOL_NAME_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  return name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaTypes(schema: JsonSchema | undefined): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const own = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  const union = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]
    .flatMap((member: JsonSchema) => schemaTypes(member));
  const types = [...own, ...union];
  // 타입 없이 properties 만 있는 스키마도 객체로 본다.
  if (types.length === 0 && isPlainObject(schema.properties)) types.push('object');
  return [...new Set(types)];
}

function parseJsonText(value: string): unknown {
  const text = value.trim();
  if (!/^[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NUMERIC_TEXT = /^-?(?:\d+|\d*\.\d+)$/;

/**
 * 값 하나를 스키마 쪽으로 보수적으로 맞춘다.
 * - 배열/객체 자리에 그 모양으로 파싱되는 JSON 문자열 → 파싱한 값
 * - 정수/수 자리에 숫자 문자열 → 수, 불리언 자리에 "true"/"false" → 불리언
 * - 객체 항목 배열 자리에 객체 하나 → 길이 1 배열
 * 스키마가 문자열을 허용하는 자리는 문자열을 그대로 둔다. 값을 지어내지 않는다.
 */
export function coerceToSchema(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const types = schemaTypes(schema);
  let next = value;
  if (typeof next === 'string' && !types.includes('string')) {
    if (types.includes('array') || types.includes('object')) {
      const parsed = parseJsonText(next);
      if (Array.isArray(parsed) && types.includes('array')) next = parsed;
      else if (isPlainObject(parsed) && types.includes('object')) next = parsed;
    }
    if (typeof next === 'string') {
      const text = next.trim();
      if ((types.includes('integer') || types.includes('number')) && NUMERIC_TEXT.test(text)) {
        const number = Number(text);
        if (types.includes('number') || Number.isSafeInteger(number)) next = number;
      } else if (types.includes('boolean') && (text === 'true' || text === 'false')) {
        next = text === 'true';
      }
    }
  }
  if (isPlainObject(next) && types.includes('array') && !types.includes('object')) {
    const items = schema.items ?? (schema.anyOf ?? schema.oneOf ?? []).find((m: JsonSchema) => m?.items)?.items;
    if (schemaTypes(items).includes('object')) next = [next];
  }
  if (Array.isArray(next) && types.includes('array')) {
    const items = schema.items ?? (schema.anyOf ?? schema.oneOf ?? []).find((m: JsonSchema) => m?.items)?.items;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      let changed = false;
      const mapped = next.map((item) => {
        const coerced = coerceToSchema(item, items);
        if (coerced !== item) changed = true;
        return coerced;
      });
      if (changed) next = mapped;
    }
  } else if (isPlainObject(next) && types.includes('object')) {
    const objectSchema = isPlainObject(schema.properties)
      ? schema
      : (schema.anyOf ?? schema.oneOf ?? []).find((m: JsonSchema) => isPlainObject(m?.properties)) ?? schema;
    const properties = isPlainObject(objectSchema.properties) ? objectSchema.properties : {};
    const extra = isPlainObject(objectSchema.additionalProperties) ? objectSchema.additionalProperties : null;
    let copy: Record<string, unknown> | null = null;
    for (const [key, item] of Object.entries(next)) {
      const propertySchema = Object.hasOwn(properties, key) ? properties[key] : extra;
      if (!propertySchema) continue;
      const coerced = coerceToSchema(item, propertySchema);
      if (coerced !== item) {
        copy ??= { ...next };
        copy[key] = coerced;
      }
    }
    if (copy) next = copy;
  }
  return next;
}

/**
 * find 와 같은 글을 가리키는 anchor 를 함께 보내면 도구가 거절한다 ("pass find or anchor, not both").
 * anchor.text 가 find 와 같을 때만 anchor 를 버리고, 그 position/occurrence 는 비어 있는 쪽으로 옮긴다.
 */
export function dropRedundantAnchor(record: Record<string, unknown>): Record<string, unknown> {
  const anchor = record.anchor;
  if (typeof record.find !== 'string' || !isPlainObject(anchor) || anchor.text !== record.find) return record;
  if (anchor.within !== undefined) return record;
  const { anchor: _dropped, ...rest } = record;
  if (rest.position === undefined && anchor.position !== undefined) rest.position = anchor.position;
  if (rest.occurrence === undefined && anchor.occurrence !== undefined) rest.occurrence = anchor.occurrence;
  return rest;
}

/** 텍스트 범위를 가리키는 키 — 있으면 insert_text 인지 replace_range 인지 가를 수 없다. */
const RANGE_KEYS = Object.freeze(['find', 'anchor', 'startParaIdx', 'endParaIdx', 'startCharOffset', 'endCharOffset']);

/**
 * tool 이 빠진 배치 항목의 도구를 모호하지 않을 때만 정한다.
 * - op 값을 enum 으로 가진 도구가 하나뿐이면 그 도구 (edit_table 의 insert_row 등)
 * - 범위 키 없이 text 만 있으면 insert_text
 * - {insert_text:{…}} 처럼 도구 이름 하나로 감싼 꼴은 펼친다
 * 정할 수 없으면 null — 도구가 빠진 채로 보내 스키마 오류가 모델에게 돌아간다.
 */
export function inferEditItem(
  record: Record<string, unknown>,
  schemas: ReadonlyMap<string, JsonSchema>,
): Record<string, unknown> | null {
  const keys = Object.keys(record);
  if (keys.length === 1 && schemas.has(String(stripToolPrefix(keys[0]))) && isPlainObject(record[keys[0]])) {
    return { ...(record[keys[0]] as Record<string, unknown>), tool: stripToolPrefix(keys[0]) };
  }
  if (typeof record.op === 'string') {
    const owners = [...schemas].filter(([, schema]) => {
      const values = schema?.properties?.op?.enum;
      return Array.isArray(values) && values.includes(record.op);
    });
    return owners.length === 1 ? { ...record, tool: owners[0][0] } : null;
  }
  if (typeof record.text === 'string' && schemas.has('insert_text')
    && !RANGE_KEYS.some((key) => record[key] !== undefined)) {
    return { ...record, tool: 'insert_text' };
  }
  return null;
}

/**
 * apply_edits 항목을 평평한 {tool, …인자} 로 만든다. 옛 {tool, args:{…}} 꼴은 펼치고,
 * 둘 다 있으면 평평한 키가 이긴다. 대상 도구의 스키마로 값도 맞춘다.
 */
function repairEditItem(item: unknown, schemas: ReadonlyMap<string, JsonSchema>): unknown {
  let record = typeof item === 'string' ? parseJsonText(item) : item;
  if (!isPlainObject(record)) return item;
  if (record.tool === undefined) record = inferEditItem(record, schemas) ?? record;
  record = dropRedundantAnchor(record as Record<string, unknown>);
  const tool = stripToolPrefix(record.tool);
  const { args: rawArgs, ...flat } = record;
  let nested: unknown = rawArgs;
  if (typeof nested === 'string') nested = parseJsonText(nested);
  let out: Record<string, unknown> = isPlainObject(nested) && rawArgs !== undefined
    ? { ...nested, ...flat, tool }
    : { ...record, tool };
  const schema = typeof tool === 'string' ? schemas.get(tool) : undefined;
  if (schema) {
    // 항목에는 expectedRevision 이 없다 — 최상위 값 하나가 배치 전체를 덮는다.
    out = coerceToSchema(out, schema) as Record<string, unknown>;
  }
  return out;
}

/** read_batch 항목은 {tool, args} 가 정식 꼴이다. 접두사와 args 값만 고친다. */
function repairReadItem(item: unknown, schemas: ReadonlyMap<string, JsonSchema>): unknown {
  const record = typeof item === 'string' ? parseJsonText(item) : item;
  if (!isPlainObject(record)) return item;
  const tool = stripToolPrefix(record.tool);
  const out: Record<string, unknown> = { ...record, tool };
  const schema = typeof tool === 'string' ? schemas.get(tool) : undefined;
  if (out.args !== undefined) {
    const args = typeof out.args === 'string' ? parseJsonText(out.args) : out.args;
    if (isPlainObject(args)) out.args = schema ? coerceToSchema(args, schema) : args;
  }
  return out;
}

/**
 * Pi prepareArguments 에서 부르는 인자 복구. 스키마에 맞는 쪽으로만 바꾸고, 바꿀 것이 없으면
 * 받은 값을 그대로 돌려준다.
 *
 * @param toolName 등록된 도구 이름
 * @param args 모델이 보낸 원시 인자
 * @param schema 이 도구의 JSON Schema
 * @param schemas 이름 → 스키마 (배치 항목의 대상 도구용)
 */
export function repairToolArguments(
  toolName: string,
  args: unknown,
  schema: JsonSchema | undefined,
  schemas: ReadonlyMap<string, JsonSchema> = new Map(),
): unknown {
  let next: unknown = args;
  if (typeof next === 'string') {
    const parsed = parseJsonText(next);
    if (isPlainObject(parsed)) next = parsed;
  }
  if (!isPlainObject(next)) return args;
  let repaired = dropRedundantAnchor(coerceToSchema(next, schema) as Record<string, unknown>);
  if (toolName === 'apply_edits' && Array.isArray(repaired.edits)) {
    repaired = { ...repaired, edits: repaired.edits.map((item) => repairEditItem(item, schemas)) };
  } else if (toolName === 'read_batch' && Array.isArray(repaired.reads)) {
    repaired = { ...repaired, reads: repaired.reads.map((item) => repairReadItem(item, schemas)) };
  }
  return JSON.stringify(repaired) === JSON.stringify(args) ? args : repaired;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revision — 추적, 채우기, 안전한 재시도
// ─────────────────────────────────────────────────────────────────────────────

/** expectedRevision 정수 인자를 받는 쓰기 도구인지 (스키마로 판정). */
export function schemaTakesExpectedRevision(schema: JsonSchema | undefined): boolean {
  const property = schema?.properties?.expectedRevision;
  return schemaTypes(property).includes('integer');
}

function asRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 허브 도구 결과의 최상위 revision (read_batch 와 apply_edits 도 최상위에 하나만 싣는다). */
export function revisionFromResult(result: unknown): number | null {
  return isPlainObject(result) ? asRevision(result.revision) : null;
}

/**
 * 사용자 메시지의 live_document 블록 revision. 허브는 문서 본문 앞에 여는 태그를 둔다
 * (reference-session.mjs liveDocumentBlock) — 본문이 흉내 낸 태그보다 앞서는 첫 매치를 쓴다.
 */
export function revisionFromPrompt(prompt: unknown): number | null {
  if (typeof prompt !== 'string') return null;
  const match = /<live_document revision="(\d{1,15})"(?: trust="untrusted-data">| unchanged="true"\/>)/
    .exec(prompt);
  return match ? asRevision(Number(match[1])) : null;
}

/** REVISION_MISMATCH 메시지의 현재 revision ("Document is now at revision N"). */
export function currentRevisionFromMismatch(message: unknown): number | null {
  if (typeof message !== 'string') return null;
  const match = /Document is now at revision (\d{1,15})/.exec(message);
  return match ? asRevision(Number(match[1])) : null;
}

/**
 * expectedRevision 이 빠졌거나 정수가 아니면 마지막으로 본 revision 으로 채운다.
 * 아는 revision 이 없으면 그대로 둔다 — 허브의 INVALID_ARGS 가 모델에게 알린다.
 */
export function fillExpectedRevision(
  args: unknown,
  latest: number | null,
): { args: unknown; filled: number | null } {
  if (!isPlainObject(args) || latest === null) return { args, filled: null };
  if (asRevision(args.expectedRevision) !== null) return { args, filled: null };
  return { args: { ...args, expectedRevision: latest }, filled: latest };
}

/** find/anchor 를 받는 텍스트 쓰기 도구 (RHWP TOOL RULES 의 Anchors). */
export const ANCHORABLE_WRITE_TOOLS = Object.freeze([
  'insert_text',
  'delete_range',
  'replace_range',
  'apply_char_format',
  'apply_para_format',
]);

/** 좌표로 대상을 고르는 인자. 하나라도 있으면 텍스트 앵커 쓰기가 아니다. */
const COORDINATE_KEYS = Object.freeze([
  'charOffset',
  'startCharOffset',
  'endCharOffset',
  'startParaIdx',
  'endParaIdx',
  'paras',
]);

/** 앵커 검색 범위를 문단 번호로 좁히는 인자. */
const SCOPE_KEYS = Object.freeze(['paraIdx', 'sectionIdx', 'cell', 'cellPath']);

/**
 * 쓰기 대상 하나가 텍스트 앵커인지. 'unscoped' = 실행 시점의 텍스트만으로 찾는다,
 * 'scoped' = 문단 번호·셀로 범위를 좁힌다, false = 좌표 쓰기이거나 앵커가 없다.
 */
export function textAnchorKind(tool: unknown, args: unknown): 'unscoped' | 'scoped' | false {
  if (typeof tool !== 'string' || !ANCHORABLE_WRITE_TOOLS.includes(tool) || !isPlainObject(args)) return false;
  if (COORDINATE_KEYS.some((key) => args[key] !== undefined && args[key] !== null)) return false;
  const find = typeof args.find === 'string' && args.find.length > 0;
  const anchor = isPlainObject(args.anchor) && typeof args.anchor.text === 'string' && args.anchor.text.length > 0;
  if (!find && !anchor) return false;
  const within = anchor && isPlainObject((args.anchor as Record<string, unknown>).within)
    ? (args.anchor as Record<string, any>).within
    : null;
  const scoped = SCOPE_KEYS.some((key) => args[key] !== undefined && args[key] !== null)
    || Boolean(within && (within.paraRange !== undefined || within.cell !== undefined));
  return scoped ? 'scoped' : 'unscoped';
}

/**
 * REVISION_MISMATCH 를 받은 쓰기를 현재 revision 으로 한 번 다시 보내도 되는지.
 *
 * 조건:
 * - 현재 revision 이 이 에이전트 자신의 마지막 성공한 쓰기가 돌려준 값이다(그 뒤로 아무도
 *   문서를 바꾸지 않았다).
 * - 호출의 모든 대상(apply_edits 는 모든 항목)이 텍스트 앵커다. 앵커는 실행 시점의 텍스트로
 *   다시 풀리므로 좌표가 밀릴 일이 없다.
 * - 문단 번호로 범위를 좁힌 앵커는 모델이 현재보다 앞선 revision 을 지어낸 경우(expected >
 *   current)에만 받는다. expected < current 이면 그 사이의 저널 밖 변경(자기 쓰기 포함)이 문단
 *   번호를 옮겼을 수 있어, 리베이스 없이 다시 보내면 엉뚱한 문단을 고칠 수 있다.
 */
export function shouldRetryStaleWrite(input: {
  tool: string;
  args: unknown;
  expected: number | null;
  current: number | null;
  lastOwnWriteRevision: number | null;
}): boolean {
  const { tool, args, expected, current, lastOwnWriteRevision } = input;
  if (current === null || lastOwnWriteRevision === null || current !== lastOwnWriteRevision) return false;
  if (expected === null || expected === current) return false;
  const targets: Array<[unknown, unknown]> = tool === 'apply_edits'
    ? (isPlainObject(args) && Array.isArray(args.edits)
      ? args.edits.map((item) => [isPlainObject(item) ? item.tool : null, item] as [unknown, unknown])
      : [])
    : [[tool, args]];
  if (targets.length === 0) return false;
  return targets.every(([itemTool, itemArgs]) => {
    const kind = textAnchorKind(itemTool, itemArgs);
    return kind === 'unscoped' || (kind === 'scoped' && expected > current);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 마무리 점검 — agent_before_settle 에서 한 번 더 일하게 할지
// ─────────────────────────────────────────────────────────────────────────────

/** 숨김 custom_message 의 customType. */
export const SETTLE_CHECK_CUSTOM_TYPE = 'rhwp-settle-check';
/** 사용자 턴 하나에서 이어 가기를 요청하는 최대 횟수. */
export const SETTLE_CHECK_MAX_CONTINUATIONS = 2;

/** 점검 메모 문구 — 고치기 쉽게 한곳에 둔다. */
export const SETTLE_NOTES = Object.freeze({
  header: 'Harness check before this turn ends:',
  failedWrite: (tool: string, message: string) =>
    `- The last document write (${tool}) failed and no later write succeeded: ${message}`,
  warnings: (tool: string, warnings: string[]) =>
    `- The last successful write (${tool}) reported layout warnings: ${warnings.join(' | ')}`,
  noSummary: '- You changed the document, but no reply was written for the user.',
  footer: 'Fix what one more call can fix, then reply to the user; if it cannot be fixed, say what is left in your reply.',
});

export interface TurnWriteState {
  /** 이번 사용자 턴의 문서 쓰기 호출 수. */
  writes: number;
  /** 마지막 문서 쓰기 호출의 결과. */
  lastWrite: { tool: string; ok: boolean; message?: string } | null;
  /** 마지막으로 성공한 문서 쓰기와 그 after.warnings. */
  lastSuccessfulWrite: { tool: string; warnings: string[] } | null;
  /** 마지막 assistant 메시지에 사용자에게 보이는 글이 있는지. */
  finalHasText: boolean;
  continuations: number;
  writesAtLastContinuation: number;
}

export function createTurnWriteState(): TurnWriteState {
  return {
    writes: 0,
    lastWrite: null,
    lastSuccessfulWrite: null,
    finalHasText: false,
    continuations: 0,
    writesAtLastContinuation: 0,
  };
}

/**
 * 쪽 이동 알림 (studio write-report.ts movedRunWarnings). 문단을 넣거나 지우면 뒤 문단이
 * 다음 쪽으로 밀리는 것이 정상이라 결함이 아니다 — 마무리 점검이 이것으로 다시 돌면
 * 모델이 쓸데없이 간격을 고치고 사용자에게 두 번째 답을 쓴다 (실측).
 */
const REFLOW_NOTICE = /moved from page \d+ to \d+$|more paragraph\(s\) after the edit changed page$/;

/** 쓰기 결과의 after.warnings 중 결함만 (표 넘침 등). 쪽 이동 알림과 문자열이 아닌 항목은 버린다. */
export function afterWarnings(result: unknown): string[] {
  const after = isPlainObject(result) ? result.after : null;
  const warnings = isPlainObject(after) ? after.warnings : null;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string'
      && warning.trim().length > 0 && !REFLOW_NOTICE.test(warning.trim()))
    : [];
}

export function recordWriteOutcome(
  state: TurnWriteState,
  outcome: { tool: string; ok: boolean; result?: unknown; message?: string },
): void {
  state.writes += 1;
  state.lastWrite = { tool: outcome.tool, ok: outcome.ok, ...(outcome.message ? { message: outcome.message } : {}) };
  if (outcome.ok) state.lastSuccessfulWrite = { tool: outcome.tool, warnings: afterWarnings(outcome.result) };
}

/** assistant 메시지 content 에 비어 있지 않은 text 블록이 있는지. */
export function assistantHasText(message: unknown): boolean {
  if (!isPlainObject(message) || message.role !== 'assistant') return false;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => isPlainObject(block)
    && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0);
}

/**
 * 턴을 끝내기 전에 모델에게 보여줄 메모. 이어 갈 이유가 없으면 null.
 *
 * - 성공한 실행(completed)에서만, 이어 가기는 턴당 최대 SETTLE_CHECK_MAX_CONTINUATIONS 번.
 * - 문서 쓰기가 있었던 턴에서만: 마지막 쓰기가 실패한 채 끝남 / 마지막 성공 쓰기에 경고 /
 *   쓰기 뒤 사용자에게 남긴 글이 없음.
 * - 한 번 이어 간 뒤에는 새 쓰기가 있었거나 여전히 글이 없을 때만 다시 묻는다 — 모델이 글로
 *   답했으면(예: 할 수 없는 이유를 설명) 같은 메모를 되풀이하지 않는다.
 */
export function settleNoteFor(
  state: TurnWriteState,
  context: { outcome: string; enabled: boolean },
): string | null {
  if (!context.enabled || context.outcome !== 'completed') return null;
  if (state.continuations >= SETTLE_CHECK_MAX_CONTINUATIONS || state.writes === 0) return null;
  if (state.continuations > 0 && state.writes === state.writesAtLastContinuation && state.finalHasText) {
    return null;
  }
  const lines: string[] = [];
  if (state.lastWrite && !state.lastWrite.ok) {
    lines.push(SETTLE_NOTES.failedWrite(state.lastWrite.tool, state.lastWrite.message ?? 'unknown error'));
  }
  if (state.lastSuccessfulWrite && state.lastSuccessfulWrite.warnings.length > 0) {
    lines.push(SETTLE_NOTES.warnings(state.lastSuccessfulWrite.tool, state.lastSuccessfulWrite.warnings));
  }
  if (!state.finalHasText) lines.push(SETTLE_NOTES.noSummary);
  return lines.length > 0 ? [SETTLE_NOTES.header, ...lines, SETTLE_NOTES.footer].join('\n') : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 컨텍스트 정리 — 이미 본 도구 결과 이미지를 다음 요청에서 뺀다
// ─────────────────────────────────────────────────────────────────────────────

export function omittedImageText(toolName: string): string {
  return `[image from ${toolName} omitted; call it again to see it]`;
}

/**
 * 마지막 assistant 메시지보다 앞선 toolResult 의 image 블록을 짧은 글로 바꾼다. 메시지 수와
 * 순서, toolCallId 는 그대로라 tool_call/tool_result 짝이 깨지지 않는다. 바꿀 것이 없으면 null.
 */
export function stripStaleToolImages<T>(messages: readonly T[]): T[] | null {
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (isPlainObject(message) && message.role === 'assistant') lastAssistant = index;
  });
  if (lastAssistant <= 0) return null;
  let changed = false;
  const next = messages.map((message, index) => {
    if (index >= lastAssistant || !isPlainObject(message) || message.role !== 'toolResult') return message;
    const content = message.content;
    if (!Array.isArray(content) || !content.some((block) => isPlainObject(block) && block.type === 'image')) {
      return message;
    }
    changed = true;
    const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool';
    return {
      ...message,
      content: content.map((block) => (isPlainObject(block) && block.type === 'image'
        ? { type: 'text', text: omittedImageText(toolName) }
        : block)),
    } as T;
  });
  return changed ? next : null;
}
