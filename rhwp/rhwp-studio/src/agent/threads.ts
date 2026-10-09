import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
} from '../core/idb-open.ts';
import { isAgentWorkflow, isStructuredPlan } from './types.ts';
import type {
  AgentName,
  AgentWorkflow,
  ProductSkillIcon,
  ServiceTier,
  StructuredPlan,
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionOutcome,
} from './types.ts';
import type { InlineObjectAddress, InlinePromptItem } from './inline-prompt-context.ts';

const STORAGE_KEY = 'rhwp-agent-threads';
const NOTIFY_KEY = 'rhwp-agent-threads-notify';
const DB_NAME = 'rhwpAgentThreads';
const DB_VERSION = 1;
const THREADS_STORE = 'threads';
const CHANNEL_NAME = 'rhwp-agent-threads';
const MAX_THREADS = 40;
const MAX_MESSAGES_PER_THREAD = 200;

interface ThreadMessageBase {
  text: string;
  agent?: AgentName;
  /** 사용자가 명시적으로 호출한 product skill. 본문과 분리해 chip으로 표시한다. */
  skillName?: string;
  /** 호출 당시 선택된 아이콘. 이후 skill 설정이 바뀌어도 기록 모양을 유지한다. */
  skillIcon?: ProductSkillIcon;
  messageId?: string;
  attachments?: ThreadAttachment[];
  /** 인라인 프롬프트로 보낸 메시지에 붙는 문서 선택 컨텍스트 (표시용). */
  selection?: {
    label: string;
    excerpt: string;
    items?: InlinePromptItem[];
    documentId?: string | null;
    revision?: number;
  };
}

export interface ThreadToolRecord {
  callId: string;
  tool: string;
  argsJson: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  resultPreview: string;
  elapsedMs: number | null;
  /**
   * 스튜디오 실행기의 잘리지 않은 결과로 만든 결과 줄. 미리보기(2000자)로는 다시 만들 수
   * 없는 항목별 결과와 줄인 그림을 보존한다. 없으면 미리보기에서 다시 읽는다.
   */
  outcome?: ThreadToolOutcome;
}

/** 도구 행 결과 줄 — ui/agent-sidebar/tool-presentation.ts 의 ToolOutcomeView 와 같은 모양. */
export interface ThreadToolOutcome {
  ok: boolean;
  text: string;
  detail?: string;
  notices: string[];
  items?: Array<{ ok: boolean; text: string }>;
  /** 줄인 결과 그림 (data URL) */
  image?: string;
  label?: string;
}

/** 저장하는 결과 그림 상한 — 대화 기록이 그림으로 불어나지 않게 한다. */
export const THREAD_TOOL_IMAGE_MAX_CHARS = 200_000;

export interface ThreadTaskRecord {
  taskId: string;
  taskKind: 'agent' | 'workflow';
  title: string;
  role: string;
  workflowName: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  activity: string;
  summary: string;
  totalTokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  tools: ThreadToolRecord[];
}

export interface PendingUserQuestionDraftSnapshot {
  interaction: UserQuestionInteraction;
  selectedOptionIdsByQuestionId: Record<string, string[]>;
  otherTextByQuestionId: Record<string, string>;
  activeQuestionIndex: number;
  updatedAt: number;
}

export interface UserQuestionHistoryMessage extends ThreadMessageBase {
  readonly role: 'assistant';
  readonly kind: 'user-question';
  readonly interaction: UserQuestionInteraction;
  readonly outcome: UserQuestionOutcome;
}

export interface ThreadProviderHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

export type ThreadMessage =
  | UserQuestionHistoryMessage
  | (ThreadMessageBase & {
      role: 'assistant';
      kind: 'plan';
      /** Structured plan opened by this presentation message. */
      planId: string;
      /** The plan has left the approval surface and started execution. */
      planState?: 'executed';
    })
  | (ThreadMessageBase & {
      role: 'assistant';
      kind: 'activity';
      activityId: string;
      status: 'running' | 'completed' | 'failed' | 'stopped';
      startedAt: number;
      completedAt: number | null;
      tools: ThreadToolRecord[];
      planId?: never;
    })
  | (ThreadMessageBase & {
      role: 'assistant';
      kind: 'tasks';
      taskGroupId: string;
      status: 'running' | 'completed' | 'failed' | 'stopped';
      tasks: ThreadTaskRecord[];
      planId?: never;
    })
  | (ThreadMessageBase & {
      role: 'user' | 'assistant' | 'system';
      /** Concise in-turn milestone, rendered separately from the final answer. */
      kind?: 'progress';
      planId?: never;
    });

export interface ThreadAttachment {
  stageId: string;
  fileId?: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'processing' | 'ready' | 'error' | 'deleted';
  error?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  /** Luna 제목 요청을 이미 보냈는지 */
  titleRequested: boolean;
  /** 사용자가 직접 붙인 이름 — 이후 자동 제목이 덮어쓰지 않는다 */
  titlePinned?: boolean;
  /** 목록 맨 위 고정 구역에서의 자리 — 작을수록 위. 없으면 고정하지 않은 채팅이다. */
  pinOrder?: number;
  /** 아래 목록에 끌어 놓은 자리. 대화 활동 시각과 같은 축이라 끌지 않은 채팅과 함께
   *  정렬되고, 새 대화가 와도 그대로 남는다. 없으면 마지막 대화 활동 자리다. */
  listOrder?: number;
  createdAt: number;
  /** 저장 시계 — 탭 사이 충돌 판정에 쓰여 저장할 때마다 앞으로 간다. */
  updatedAt: number;
  /** 대화가 마지막으로 움직인 시각 — 목록 순서. 채팅을 열고 닫기만 해서는 바뀌지 않는다.
   *  이 필드가 생기기 전에 저장된 채팅은 updatedAt 을 쓴다. */
  lastActivityAt?: number;
  agent: AgentName;
  model: string;
  effort: string;
  /** Codex Fast 서비스 티어. 레거시 채팅과 다른 프로바이더는 standard. */
  serviceTier: ServiceTier;
  workflow: AgentWorkflow;
  /** 이 채팅이 속한 문서(파일 이름). null = 문서 없이 시작한 채팅. */
  docKey: string | null;
  /** 서버의 문서별 참고자료 범위에 쓰는 안정적인 논리 문서 ID. */
  documentId: string | null;
  /** 이 채팅에 고정된 기기 템플릿. 원본은 채팅에 내장하지 않는다. */
  activeTemplateId: string | null;
  /** Historical display data only. Phase/approval/capability authority is never persisted. */
  latestPlan?: StructuredPlan;
  /** Plan snapshots referenced by clickable chat presentations. */
  plans?: StructuredPlan[];
  /** Draft state only. Provider authority remains in the live hub session. */
  pendingUserQuestion?: PendingUserQuestionDraftSnapshot;
  messages: ThreadMessage[];
}

export interface ThreadDraft {
  agent: AgentName;
  model: string;
  effort: string;
  serviceTier?: ServiceTier;
  workflow?: AgentWorkflow;
  docKey?: string | null;
  documentId?: string | null;
  activeTemplateId?: string | null;
}

function normalizedDocumentName(value: string | null): string | null {
  const normalized = value?.trim().normalize('NFC').toLocaleLowerCase() ?? '';
  return normalized || null;
}

/** 안정 ID가 기준이다. 파일명은 ID 도입 전에 만들어진 레거시 채팅을 잇는 다리다. */
export function threadMatchesDocument(
  thread: Pick<ChatThread, 'documentId' | 'docKey'>,
  documentId: string | null,
  docKey: string | null,
): boolean {
  if (thread.documentId) return Boolean(documentId && thread.documentId === documentId);
  const threadName = normalizedDocumentName(thread.docKey);
  const activeName = normalizedDocumentName(docKey);
  if (threadName && activeName) return threadName === activeName;
  return !thread.documentId && !documentId && threadName === null && activeName === null;
}

type StoredChatThread = Omit<ChatThread, 'workflow' | 'latestPlan' | 'plans' | 'docKey' | 'documentId' | 'activeTemplateId' | 'pendingUserQuestion' | 'pinOrder' | 'listOrder'> & {
  workflow?: unknown;
  latestPlan?: unknown;
  plans?: unknown;
  docKey?: unknown;
  documentId?: unknown;
  activeTemplateId?: unknown;
  pendingUserQuestion?: unknown;
  pinOrder?: unknown;
  listOrder?: unknown;
};

type ThreadPersistenceChange =
  | { type: 'upsert'; thread: ChatThread }
  | { type: 'remove'; id: string }
  | { type: 'reload' };

type ThreadPersistenceMessage = ThreadPersistenceChange & {
  source: string;
  nonce: string;
};

const cache = new Map<string, ChatThread>();
const deletedBeforeHydration = new Set<string>();
const listeners = new Set<() => void>();
const sourceId = createPersistenceId();
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;
let mutationQueue = Promise.resolve();
let channel: BroadcastChannel | null = null;

function createPersistenceId() {
  return globalThis.crypto?.randomUUID?.() ?? `threads-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function canUseStorage() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

function readLegacyThreads() {
  if (!canUseStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredChatThread).map(normalizeStoredThread);
  } catch {
    return [];
  }
}

/** 한도를 넘을 때 남길 순서 — 고정한 채팅이 먼저, 그다음 최근에 저장한 채팅. */
function retentionOrder(
  a: { updatedAt: number; pinOrder?: unknown },
  b: { updatedAt: number; pinOrder?: unknown },
): number {
  return Number(b.pinOrder !== undefined) - Number(a.pinOrder !== undefined) || b.updatedAt - a.updatedAt;
}

function saveLegacyThreads(threads: ChatThread[]) {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...threads].sort(retentionOrder).slice(0, MAX_THREADS)));
  } catch (err) {
    console.warn('[threads] localStorage 저장 실패:', err);
  }
}

function isStoredChatThread(v: unknown): v is StoredChatThread {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string'
    && typeof t.title === 'string'
    && typeof t.createdAt === 'number'
    && typeof t.updatedAt === 'number'
    && (t.agent === 'claude' || t.agent === 'codex' || t.agent === 'pi')
    && typeof t.model === 'string'
    && typeof t.effort === 'string'
    && Array.isArray(t.messages)
  );
}

function parseAgentName(value: unknown): AgentName | undefined {
  return isAgentName(value) ? value : undefined;
}

function parseTimelineStatus(value: unknown): 'running' | 'completed' | 'failed' | 'stopped' {
  return value === 'completed' || value === 'failed' || value === 'stopped' ? value : 'running';
}

function parseFiniteNonNegative(value: unknown): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseThreadTool(value: unknown): ThreadToolRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tool = value as Record<string, unknown>;
  if (typeof tool.callId !== 'string' || !tool.callId
    || typeof tool.tool !== 'string' || !tool.tool
    || typeof tool.argsJson !== 'string') return null;
  return {
    callId: tool.callId,
    tool: tool.tool,
    argsJson: tool.argsJson,
    status: parseTimelineStatus(tool.status),
    resultPreview: typeof tool.resultPreview === 'string' ? tool.resultPreview : '',
    elapsedMs: parseFiniteNonNegative(tool.elapsedMs),
    ...parseToolOutcomeField(tool.outcome),
  };
}

function parseToolOutcomeField(value: unknown): { outcome?: ThreadToolOutcome } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean' || typeof raw.text !== 'string') return {};
  const strings = (list: unknown): string[] => Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string').slice(0, 32)
    : [];
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return typeof entry.ok === 'boolean' && typeof entry.text === 'string' ? [{ ok: entry.ok, text: entry.text }] : [];
    }).slice(0, 64)
    : null;
  const image = typeof raw.image === 'string' && raw.image.startsWith('data:image/')
    && raw.image.length <= THREAD_TOOL_IMAGE_MAX_CHARS ? raw.image : null;
  return {
    outcome: {
      ok: raw.ok,
      text: raw.text,
      notices: strings(raw.notices),
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      ...(items ? { items } : {}),
      ...(image ? { image } : {}),
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    },
  };
}

function parseThreadTask(value: unknown): ThreadTaskRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (typeof task.taskId !== 'string' || !task.taskId
    || (task.taskKind !== 'agent' && task.taskKind !== 'workflow')
    || typeof task.title !== 'string') return null;
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    title: task.title,
    role: typeof task.role === 'string' ? task.role : '',
    workflowName: typeof task.workflowName === 'string' ? task.workflowName : '',
    status: parseTimelineStatus(task.status),
    activity: typeof task.activity === 'string' ? task.activity : '',
    summary: typeof task.summary === 'string' ? task.summary : '',
    totalTokens: parseFiniteNonNegative(task.totalTokens),
    toolUses: parseFiniteNonNegative(task.toolUses),
    durationMs: parseFiniteNonNegative(task.durationMs),
    tools: Array.isArray(task.tools) ? task.tools.flatMap((tool) => {
      const parsed = parseThreadTool(tool);
      return parsed ? [parsed] : [];
    }) : [],
  };
}

function isAgentName(value: unknown): value is AgentName {
  return value === 'claude' || value === 'codex' || value === 'pi';
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeUserQuestion(value: unknown, questionIndex: number): UserQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = nonEmptyString(raw.id);
  const question = nonEmptyString(raw.question);
  if (!id || !question || !Array.isArray(raw.options)) return null;
  const optionIds = new Set<string>();
  const options = raw.options.flatMap((value): UserQuestion['options'] => {
    if (!value || typeof value !== 'object') return [];
    const option = value as Record<string, unknown>;
    const label = nonEmptyString(option.label);
    const optionId = nonEmptyString(option.id) ?? label;
    if (!optionId || !label || optionIds.has(optionId)) return [];
    optionIds.add(optionId);
    return [{
      id: optionId,
      label,
      description: typeof option.description === 'string' ? option.description : '',
    }];
  });
  if (options.length === 0) return null;
  return {
    id,
    header: nonEmptyString(raw.header) ?? `Question ${questionIndex + 1}`,
    question,
    mode: raw.mode === 'multiple' || raw.multiSelect === true ? 'multiple' : 'single',
    options,
    allowOther: raw.allowOther !== false,
  };
}

function normalizeUserQuestionInteraction(value: unknown): UserQuestionInteraction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const interactionId = nonEmptyString(raw.interactionId);
  const providerRequestId = nonEmptyString(raw.providerRequestId);
  const threadId = nonEmptyString(raw.threadId);
  const turnId = nonEmptyString(raw.turnId);
  const createdAt = nonEmptyString(raw.createdAt);
  const updatedAt = nonEmptyString(raw.updatedAt) ?? createdAt;
  if (!interactionId || !providerRequestId || !threadId || !turnId || !createdAt || !updatedAt
    || !isAgentName(raw.agent) || (raw.source !== 'native' && raw.source !== 'mcp')
    || !Array.isArray(raw.questions)) return null;
  const questionIds = new Set<string>();
  const questions = raw.questions.flatMap((question, index): UserQuestion[] => {
    const normalized = normalizeUserQuestion(question, index);
    if (!normalized || questionIds.has(normalized.id)) return [];
    questionIds.add(normalized.id);
    return [normalized];
  });
  if (questions.length === 0) return null;
  return {
    interactionId,
    providerRequestId,
    threadId,
    turnId,
    agent: raw.agent,
    source: raw.source,
    createdAt,
    updatedAt,
    questions,
  };
}

function normalizeSelectedOptionIds(question: UserQuestion, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((id): id is string => typeof id === 'string'));
  const normalized = question.options.filter((option) => selected.has(option.id)).map((option) => option.id);
  return question.mode === 'multiple' ? normalized : normalized.slice(0, 1);
}

function normalizeUserQuestionAnswer(
  question: UserQuestion,
  value: unknown,
): UserQuestionAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const selectedOptionIds = normalizeSelectedOptionIds(question, raw.selectedOptionIds);
  const otherText = question.allowOther && typeof raw.otherText === 'string'
    ? raw.otherText
    : '';
  if (selectedOptionIds.length === 0 && !otherText.trim()) return null;
  return {
    selectedOptionIds,
    ...(otherText.trim() ? { otherText } : {}),
  };
}

function normalizeUserQuestionOutcome(
  value: unknown,
  interaction: UserQuestionInteraction,
): UserQuestionOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.status === 'cancelled' && raw.reason === 'user-stop') {
    return { status: 'cancelled', reason: 'user-stop' };
  }
  if (raw.status === 'expired'
    && (raw.reason === 'provider-disconnected' || raw.reason === 'hub-restarted'
      || raw.reason === 'request-invalidated')) {
    return { status: 'expired', reason: raw.reason };
  }
  if (raw.status !== 'answered' || !raw.answers || typeof raw.answers !== 'object') return null;
  const rawAnswers = raw.answers as Record<string, unknown>;
  const answers: Record<string, UserQuestionAnswer> = {};
  for (const question of interaction.questions) {
    const answer = normalizeUserQuestionAnswer(question, rawAnswers[question.id]);
    if (!answer) return null;
    answers[question.id] = answer;
  }
  return { status: 'answered', answers };
}

function normalizePendingUserQuestionDraft(
  value: unknown,
  expectedThreadId: string,
  expectedAgent: AgentName,
): PendingUserQuestionDraftSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const interaction = normalizeUserQuestionInteraction(raw.interaction);
  if (!interaction || interaction.threadId !== expectedThreadId || interaction.agent !== expectedAgent) {
    return null;
  }
  const rawSelections = raw.selectedOptionIdsByQuestionId;
  const rawOtherText = raw.otherTextByQuestionId;
  const selectionRecord = rawSelections && typeof rawSelections === 'object'
    ? rawSelections as Record<string, unknown>
    : {};
  const otherTextRecord = rawOtherText && typeof rawOtherText === 'object'
    ? rawOtherText as Record<string, unknown>
    : {};
  const selectedOptionIdsByQuestionId: Record<string, string[]> = {};
  const otherTextByQuestionId: Record<string, string> = {};
  for (const question of interaction.questions) {
    const selected = normalizeSelectedOptionIds(question, selectionRecord[question.id]);
    if (selected.length > 0) selectedOptionIdsByQuestionId[question.id] = selected;
    if (question.allowOther && typeof otherTextRecord[question.id] === 'string') {
      otherTextByQuestionId[question.id] = otherTextRecord[question.id] as string;
    }
  }
  const requestedIndex = Number.isInteger(raw.activeQuestionIndex)
    ? Number(raw.activeQuestionIndex)
    : 0;
  return {
    interaction,
    selectedOptionIdsByQuestionId,
    otherTextByQuestionId,
    activeQuestionIndex: Math.max(0, Math.min(requestedIndex, interaction.questions.length - 1)),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      && raw.updatedAt >= 0
      ? raw.updatedAt
      : Date.now(),
  };
}

function storedInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function storedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function normalizeInlineAddress(value: unknown): InlineObjectAddress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const sectionIdx = storedInteger(raw.sectionIdx);
  const paraIdx = storedInteger(raw.paraIdx);
  const controlIdx = storedInteger(raw.controlIdx);
  if (sectionIdx === undefined || paraIdx === undefined || controlIdx === undefined) return undefined;
  const cellPath = Array.isArray(raw.cellPath)
    ? raw.cellPath.slice(0, 16).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const path = entry as Record<string, unknown>;
      const controlIndex = storedInteger(path.controlIndex);
      const cellIndex = storedInteger(path.cellIndex);
      const cellParaIndex = storedInteger(path.cellParaIndex);
      return controlIndex === undefined || cellIndex === undefined || cellParaIndex === undefined
        ? []
        : [{ controlIndex, cellIndex, cellParaIndex }];
    })
    : undefined;
  const optionalNumber = (key: string) => storedInteger(raw[key]);
  return {
    sectionIdx,
    paraIdx,
    controlIdx,
    ...(cellPath?.length ? { cellPath } : {}),
    ...(optionalNumber('cellIdx') !== undefined ? { cellIdx: optionalNumber('cellIdx') } : {}),
    ...(optionalNumber('cellParaIdx') !== undefined ? { cellParaIdx: optionalNumber('cellParaIdx') } : {}),
    ...(optionalNumber('endCellParaIdx') !== undefined ? { endCellParaIdx: optionalNumber('endCellParaIdx') } : {}),
    ...(optionalNumber('innerControlIdx') !== undefined ? { innerControlIdx: optionalNumber('innerControlIdx') } : {}),
    ...(optionalNumber('logicalOffset') !== undefined ? { logicalOffset: optionalNumber('logicalOffset') } : {}),
  };
}

function normalizeSelectionPoint(value: unknown): { sectionIdx: number; paraIdx: number; charOffset: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const sectionIdx = storedInteger(raw.sectionIdx);
  const paraIdx = storedInteger(raw.paraIdx);
  const charOffset = storedInteger(raw.charOffset);
  return sectionIdx === undefined || paraIdx === undefined || charOffset === undefined
    ? undefined
    : { sectionIdx, paraIdx, charOffset };
}

function normalizeStoredInlineItem(value: unknown): InlinePromptItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'text') {
    const selection = raw.selection as Record<string, unknown> | undefined;
    const start = normalizeSelectionPoint(selection?.start);
    const end = normalizeSelectionPoint(selection?.end);
    const text = storedString(selection?.text, 4000);
    if (!start || !end || text === undefined) return undefined;
    const address = normalizeInlineAddress(raw.address);
    return {
      kind: 'text',
      selection: { start, end, text, truncated: selection?.truncated === true },
      ...(address ? { address } : {}),
      ...(raw.offsetConvention === 'logical' || raw.offsetConvention === 'text'
        ? { offsetConvention: raw.offsetConvention }
        : {}),
    };
  }
  const address = normalizeInlineAddress(raw.address);
  if (!address) return undefined;
  if (raw.kind === 'table') {
    const rowCount = storedInteger(raw.rowCount);
    const colCount = storedInteger(raw.colCount);
    if (rowCount === undefined || colCount === undefined || !Array.isArray(raw.cells)) return undefined;
    const cells = raw.cells.slice(0, 512).flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const cell = value as Record<string, unknown>;
      const row = storedInteger(cell.row);
      const col = storedInteger(cell.col);
      const rowSpan = storedInteger(cell.rowSpan);
      const colSpan = storedInteger(cell.colSpan);
      const text = storedString(cell.text, 4000);
      return row === undefined || col === undefined || rowSpan === undefined || colSpan === undefined || text === undefined
        ? []
        : [{ row, col, rowSpan, colSpan, text }];
    });
    const range = raw.selectedRange as Record<string, unknown> | undefined;
    const selectedRange = range ? {
      startRow: storedInteger(range.startRow), startCol: storedInteger(range.startCol),
      endRow: storedInteger(range.endRow), endCol: storedInteger(range.endCol),
    } : undefined;
    const validRange = selectedRange && Object.values(selectedRange).every(value => value !== undefined)
      ? selectedRange as { startRow: number; startCol: number; endRow: number; endCol: number }
      : undefined;
    return { kind: 'table', address, rowCount, colCount, cells, truncated: raw.truncated === true,
      ...(validRange ? { selectedRange: validRange } : {}) };
  }
  if (raw.kind === 'equation') {
    const script = storedString(raw.script, 16384);
    if (script === undefined) return undefined;
    return { kind: 'equation', address, script,
      ...(storedString(raw.fontName, 200) !== undefined ? { fontName: storedString(raw.fontName, 200) } : {}),
      ...(storedInteger(raw.fontSize) !== undefined ? { fontSize: storedInteger(raw.fontSize) } : {}),
      ...(storedString(raw.description, 1000) !== undefined ? { description: storedString(raw.description, 1000) } : {}),
      ...(storedString(raw.attachmentName, 500) !== undefined ? { attachmentName: storedString(raw.attachmentName, 500) } : {}) };
  }
  if (raw.kind === 'object') {
    const objectType = storedString(raw.objectType, 50);
    if (!objectType) return undefined;
    const number = (key: string) => typeof raw[key] === 'number' && Number.isFinite(raw[key])
      ? raw[key] as number : undefined;
    return { kind: 'object', objectType, address,
      ...(storedString(raw.description, 1000) !== undefined ? { description: storedString(raw.description, 1000) } : {}),
      ...(number('width') !== undefined ? { width: number('width') } : {}),
      ...(number('height') !== undefined ? { height: number('height') } : {}),
      ...(storedString(raw.attachmentName, 500) !== undefined ? { attachmentName: storedString(raw.attachmentName, 500) } : {}) };
  }
  return undefined;
}

function normalizeStoredSelection(value: unknown): ThreadMessageBase['selection'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const label = storedString(raw.label, 200);
  const excerpt = storedString(raw.excerpt, 500);
  if (label === undefined || excerpt === undefined) return undefined;
  const items = Array.isArray(raw.items)
    ? raw.items.slice(0, 32).flatMap(item => {
      const normalized = normalizeStoredInlineItem(item);
      return normalized ? [normalized] : [];
    })
    : undefined;
  return {
    label,
    excerpt,
    ...(items?.length ? { items } : {}),
    ...(raw.documentId === null || typeof raw.documentId === 'string'
      ? { documentId: raw.documentId as string | null }
      : {}),
    ...(storedInteger(raw.revision) !== undefined ? { revision: storedInteger(raw.revision) } : {}),
  };
}

function normalizeStoredThread(thread: StoredChatThread): ChatThread {
  const latestPlan = isStructuredPlan(thread.latestPlan) ? thread.latestPlan : undefined;
  const plans = Array.isArray(thread.plans) ? thread.plans.filter(isStructuredPlan) : [];
  const {
    workflow: _storedWorkflow,
    latestPlan: _storedPlan,
    plans: _storedPlans,
    docKey: storedDocKey,
    documentId: storedDocumentId,
    activeTemplateId: storedActiveTemplateId,
    pendingUserQuestion: storedPendingUserQuestion,
    pinOrder: storedPinOrder,
    listOrder: storedListOrder,
    ...rest
  } = thread;
  const messages = rest.messages.flatMap((raw): ThreadMessage[] => {
    if (!raw || typeof raw !== 'object') return [];
    const message = raw as unknown as Record<string, unknown>;
    if ((message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system')
      || typeof message.text !== 'string') return [];
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.flatMap((item): ThreadAttachment[] => {
        if (!item || typeof item !== 'object') return [];
        const attachment = item as Record<string, unknown>;
        if (typeof attachment.stageId !== 'string' || typeof attachment.name !== 'string'
          || typeof attachment.mimeType !== 'string' || !Number.isFinite(Number(attachment.size))
          || (attachment.status !== 'processing' && attachment.status !== 'ready'
            && attachment.status !== 'error' && attachment.status !== 'deleted')) return [];
        return [{
          stageId: attachment.stageId,
          ...(typeof attachment.fileId === 'string' ? { fileId: attachment.fileId } : {}),
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: Math.max(0, Number(attachment.size)),
          status: attachment.status,
          ...(typeof attachment.error === 'string' ? { error: attachment.error } : {}),
        }];
      })
      : undefined;
    const agent = parseAgentName(message.agent);
    const skillIcon: ProductSkillIcon | undefined = message.skillIcon === 'pencil'
      || message.skillIcon === 'bot' || message.skillIcon === 'system'
      ? message.skillIcon
      : undefined;
    const selection = normalizeStoredSelection(message.selection);
    const metadata = {
      ...(agent ? { agent } : {}),
      ...(typeof message.skillName === 'string' && /^[a-z0-9-]+$/.test(message.skillName)
        ? { skillName: message.skillName }
        : {}),
      ...(skillIcon ? { skillIcon } : {}),
      ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(selection ? { selection } : {}),
    };
    if (message.kind === 'user-question') {
      if (message.role !== 'assistant') return [];
      const interaction = normalizeUserQuestionInteraction(message.interaction);
      if (!interaction || interaction.threadId !== thread.id) return [];
      const outcome = normalizeUserQuestionOutcome(message.outcome, interaction);
      if (!outcome) return [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'user-question',
        interaction,
        outcome,
        ...metadata,
        agent: interaction.agent,
      }];
    }
    if (message.kind === 'plan') {
      if (message.role !== 'assistant' || typeof message.planId !== 'string' || !message.planId) return [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'plan',
        planId: message.planId,
        ...(message.planState === 'executed' ? { planState: 'executed' as const } : {}),
        ...metadata,
      }];
    }
    if (message.kind === 'activity') {
      if (message.role !== 'assistant' || typeof message.activityId !== 'string' || !message.activityId) return [];
      const tools = Array.isArray(message.tools) ? message.tools.flatMap((tool) => {
        const parsed = parseThreadTool(tool);
        return parsed ? [parsed] : [];
      }) : [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'activity',
        activityId: message.activityId,
        status: parseTimelineStatus(message.status),
        startedAt: parseFiniteNonNegative(message.startedAt) ?? 0,
        completedAt: parseFiniteNonNegative(message.completedAt),
        tools,
        ...metadata,
      }];
    }
    if (message.kind === 'tasks') {
      if (message.role !== 'assistant' || typeof message.taskGroupId !== 'string' || !message.taskGroupId) return [];
      const tasks = Array.isArray(message.tasks) ? message.tasks.flatMap((task) => {
        const parsed = parseThreadTask(task);
        return parsed ? [parsed] : [];
      }) : [];
      return [{
        role: 'assistant',
        text: message.text,
        kind: 'tasks',
        taskGroupId: message.taskGroupId,
        status: parseTimelineStatus(message.status),
        tasks,
        ...metadata,
      }];
    }
    return [{
      role: message.role,
      text: message.text,
      ...(message.kind === 'progress' ? { kind: 'progress' as const } : {}),
      ...metadata,
    }];
  });
  const pendingUserQuestion = normalizePendingUserQuestionDraft(
    storedPendingUserQuestion,
    thread.id,
    thread.agent,
  );
  const pendingAlreadyArchived = pendingUserQuestion
    ? messages.some((message) => message.kind === 'user-question'
      && message.interaction.interactionId === pendingUserQuestion.interaction.interactionId)
    : false;
  return {
    ...rest,
    messages,
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    serviceTier: thread.serviceTier === 'fast' ? 'fast' : 'standard',
    docKey: typeof storedDocKey === 'string' && storedDocKey ? storedDocKey : null,
    documentId: typeof storedDocumentId === 'string' && storedDocumentId ? storedDocumentId : null,
    activeTemplateId: typeof storedActiveTemplateId === 'string' && storedActiveTemplateId ? storedActiveTemplateId : null,
    ...(typeof storedPinOrder === 'number' && Number.isFinite(storedPinOrder) ? { pinOrder: storedPinOrder } : {}),
    ...(typeof storedListOrder === 'number' && Number.isFinite(storedListOrder) ? { listOrder: storedListOrder } : {}),
    ...(latestPlan ? { latestPlan } : {}),
    ...(plans.length ? { plans } : {}),
    ...(pendingUserQuestion && !pendingAlreadyArchived ? { pendingUserQuestion } : {}),
  };
}

function cloneThread(thread: ChatThread) {
  return structuredClone(thread);
}

function openDb() {
  return openIndexedDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(THREADS_STORE)) {
      db.createObjectStore(THREADS_STORE, { keyPath: 'id' });
    }
  });
}

function runWithDb<T>(operation: (db: IDBDatabase) => Promise<T>) {
  return withDatabase(openDb, DB_NAME, operation, (error) =>
    Promise.reject(error ?? new Error(`${DB_NAME} unavailable`)));
}

function emitChanged() {
  for (const listener of listeners) listener();
}

function applyRemoteMessage(message: ThreadPersistenceMessage) {
  if (message.source === sourceId) return;
  if (message.type === 'upsert') {
    const current = cache.get(message.thread.id);
    if (!current || current.updatedAt <= message.thread.updatedAt) {
      cache.set(message.thread.id, cloneThread(message.thread));
      deletedBeforeHydration.delete(message.thread.id);
    }
  } else if (message.type === 'remove') {
    cache.delete(message.id);
    deletedBeforeHydration.add(message.id);
  } else {
    void hydrateFromIndexedDb(true);
  }
  emitChanged();
}

function parsePersistenceMessage(value: unknown): ThreadPersistenceMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Partial<ThreadPersistenceMessage>;
  if (typeof message.source !== 'string' || typeof message.nonce !== 'string') return null;
  if (message.type === 'upsert' && message.thread && isStoredChatThread(message.thread)) {
    return { ...message, thread: normalizeStoredThread(message.thread) } as ThreadPersistenceMessage;
  }
  if (message.type === 'remove' && typeof message.id === 'string') return message as ThreadPersistenceMessage;
  if (message.type === 'reload') return message as ThreadPersistenceMessage;
  return null;
}

function publish(message: ThreadPersistenceChange) {
  const payload = {
    ...message,
    source: sourceId,
    nonce: createPersistenceId(),
  } as ThreadPersistenceMessage;
  channel?.postMessage(payload);
  if (!channel && canUseStorage()) {
    try {
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(payload));
    } catch {
      /* storage notification is best-effort */
    }
  }
  emitChanged();
}

async function hydrateFromIndexedDb(force = false) {
  if (!idbAvailable()) return;
  if (hydrationPromise && !force) return hydrationPromise;
  const run = (async () => {
    const legacy = readLegacyThreads();
    for (const thread of legacy) {
      const current = cache.get(thread.id);
      if (!current || current.updatedAt <= thread.updatedAt) cache.set(thread.id, thread);
    }

    try {
      const rows = await runWithDb(async (db) => {
        const tx = db.transaction(THREADS_STORE, legacy.length ? 'readwrite' : 'readonly');
        const store = tx.objectStore(THREADS_STORE);
        const existing = await requestResult(store.getAll() as IDBRequest<StoredChatThread[]>);
        const merged = new Map(
          existing.filter(isStoredChatThread).map((thread) => [thread.id, thread]),
        );
        for (const thread of legacy) {
          const current = merged.get(thread.id);
          if (!current || current.updatedAt < thread.updatedAt) {
            store.put(cloneThread(thread));
            merged.set(thread.id, thread);
          }
        }
        await transactionDone(tx);
        return [...merged.values()];
      });
      for (const row of rows) {
        if (!isStoredChatThread(row) || deletedBeforeHydration.has(row.id)) continue;
        const thread = normalizeStoredThread(row);
        const current = cache.get(thread.id);
        if (!current || current.updatedAt <= thread.updatedAt) cache.set(thread.id, thread);
      }
      if (legacy.length && canUseStorage()) localStorage.removeItem(STORAGE_KEY);
      hydrated = true;
      emitChanged();
    } catch (error) {
      console.warn('[threads] IndexedDB 초기화 실패, localStorage 폴백 유지:', error);
    }
  })();
  const pending = run.finally(() => {
    if (hydrationPromise === pending) hydrationPromise = null;
  });
  hydrationPromise = pending;
  return hydrationPromise;
}

function queueMutation(operation: () => Promise<string[]>, fallback: () => void) {
  mutationQueue = mutationQueue.then(async () => {
    try {
      await hydrateFromIndexedDb();
      const removed = await operation();
      for (const id of removed) {
        cache.delete(id);
        publish({ type: 'remove', id });
      }
    } catch (error) {
      fallback();
      console.warn('[threads] IndexedDB 저장 실패, localStorage 폴백:', error);
    }
  });
}

function trimCache() {
  const sorted = [...cache.values()].sort(retentionOrder);
  for (const thread of sorted.slice(MAX_THREADS)) cache.delete(thread.id);
}

function persistUpsert(thread: ChatThread) {
  queueMutation(() => runWithDb(async (db) => {
    const tx = db.transaction(THREADS_STORE, 'readwrite');
    const store = tx.objectStore(THREADS_STORE);
    const existing = await requestResult(store.get(thread.id) as IDBRequest<StoredChatThread | undefined>);
    if (!existing || !isStoredChatThread(existing) || existing.updatedAt <= thread.updatedAt) {
      store.put(cloneThread(thread));
    }
    // 한도를 넘는 건 새 스레드가 한도에서 추가된 직후뿐이다 — 메시지마다 전체 스레드를
    // 역직렬화하지 않도록 개수부터 본다.
    const total = await requestResult(store.count());
    let removed: string[] = [];
    if (total > MAX_THREADS) {
      const rows = await requestResult(store.getAll() as IDBRequest<StoredChatThread[]>);
      removed = rows
        .filter(isStoredChatThread)
        .sort(retentionOrder)
        .slice(MAX_THREADS)
        .map((row) => row.id);
      for (const id of removed) store.delete(id);
    }
    await transactionDone(tx);
    return removed;
  }), () => {
    const all = readLegacyThreads().filter((item) => item.id !== thread.id);
    all.unshift(thread);
    saveLegacyThreads(all);
  });
}

function persistRemove(id: string) {
  queueMutation(() => runWithDb(async (db) => {
    const tx = db.transaction(THREADS_STORE, 'readwrite');
    tx.objectStore(THREADS_STORE).delete(id);
    await transactionDone(tx);
    return [];
  }), () => {
    saveLegacyThreads(readLegacyThreads().filter((thread) => thread.id !== id));
  });
}

function loadAll() {
  if (!idbAvailable()) return readLegacyThreads();
  if (!hydrated) void hydrateFromIndexedDb();
  return [...cache.values()].map(cloneThread);
}

function saveFallbackMutation(threads: ChatThread[]) {
  saveLegacyThreads(threads);
  emitChanged();
}

if (idbAvailable()) {
  for (const thread of readLegacyThreads()) cache.set(thread.id, thread);
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = parsePersistenceMessage(event.data);
      if (message) applyRemoteMessage(message);
    });
  } else if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== NOTIFY_KEY || !event.newValue) return;
      try {
        const message = parsePersistenceMessage(JSON.parse(event.newValue));
        if (message) applyRemoteMessage(message);
      } catch {
        /* malformed cross-window notification */
      }
    });
  }
  void hydrateFromIndexedDb();
}

export function subscribeThreadChanges(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** IndexedDB hydration completion for startup coordination and focused tests. */
export async function waitForThreadsPersistence() {
  await hydrateFromIndexedDb();
  await mutationQueue;
}

export function createThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function fallbackTitle(messages: ThreadMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && (m.text.trim() || m.skillName));
  if (!first) return '새 채팅';
  const text = [first.skillName ? `/${first.skillName}` : '', first.text.trim()]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

export function createPendingUserQuestionDraftSnapshot(
  interaction: UserQuestionInteraction,
  updatedAt = Date.now(),
): PendingUserQuestionDraftSnapshot {
  return {
    interaction: structuredClone(interaction),
    selectedOptionIdsByQuestionId: {},
    otherTextByQuestionId: {},
    activeQuestionIndex: 0,
    updatedAt,
  };
}

export function pendingUserQuestionMatchesInteraction(
  pending: PendingUserQuestionDraftSnapshot,
  interaction: UserQuestionInteraction,
): boolean {
  return pending.interaction.interactionId === interaction.interactionId
    && pending.interaction.providerRequestId === interaction.providerRequestId
    && pending.interaction.threadId === interaction.threadId
    && pending.interaction.turnId === interaction.turnId
    && pending.interaction.agent === interaction.agent
    && pending.interaction.source === interaction.source;
}

function userQuestionHistoryText(
  interaction: UserQuestionInteraction,
  outcome: UserQuestionOutcome,
): string {
  const status = outcome.status === 'answered'
    ? '답변 완료'
    : outcome.status === 'cancelled'
      ? '사용자 중단'
      : '요청 만료';
  return `${interaction.questions.map((question) => question.question).join('\n')}\n${status}`;
}

export function createUserQuestionHistoryMessage(
  interaction: UserQuestionInteraction,
  outcome: UserQuestionOutcome,
): UserQuestionHistoryMessage {
  const interactionSnapshot = structuredClone(interaction);
  const outcomeSnapshot = structuredClone(outcome);
  return {
    role: 'assistant',
    kind: 'user-question',
    text: userQuestionHistoryText(interactionSnapshot, outcomeSnapshot),
    agent: interactionSnapshot.agent,
    interaction: interactionSnapshot,
    outcome: outcomeSnapshot,
  };
}

export function archivePendingUserQuestion(
  thread: ChatThread,
  interactionId: string,
  outcome: UserQuestionOutcome,
): UserQuestionHistoryMessage | null {
  const pending = thread.pendingUserQuestion;
  if (!pending || pending.interaction.interactionId !== interactionId) return null;
  const message = createUserQuestionHistoryMessage(pending.interaction, outcome);
  thread.messages.push(message);
  delete thread.pendingUserQuestion;
  return message;
}

export function expirePendingUserQuestion(
  thread: ChatThread,
  reason: Extract<UserQuestionOutcome, { status: 'expired' }>['reason'],
  interactionId = thread.pendingUserQuestion?.interaction.interactionId,
): UserQuestionHistoryMessage | null {
  if (!interactionId) return null;
  return archivePendingUserQuestion(thread, interactionId, { status: 'expired', reason });
}

export function clearPendingUserQuestion(
  thread: ChatThread,
  interactionId: string,
): PendingUserQuestionDraftSnapshot | null {
  const pending = thread.pendingUserQuestion;
  if (!pending || pending.interaction.interactionId !== interactionId) return null;
  delete thread.pendingUserQuestion;
  return pending;
}

function serializeUserQuestionHistoryMessage(
  message: UserQuestionHistoryMessage,
): ThreadProviderHistoryEntry[] {
  const request = {
    questions: message.interaction.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      mode: question.mode,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
      allowOther: question.allowOther,
    })),
  };
  const response = message.outcome.status === 'answered'
    ? {
        status: 'answered' as const,
        answers: message.interaction.questions.map((question) => {
          const answer = message.outcome.status === 'answered'
            ? message.outcome.answers[question.id]
            : undefined;
          const selected = new Set(answer?.selectedOptionIds ?? []);
          return {
            questionId: question.id,
            selectedOptions: question.options
              .filter((option) => selected.has(option.id))
              .map((option) => ({ id: option.id, label: option.label })),
            ...(answer?.otherText ? { otherText: answer.otherText } : {}),
          };
        }),
      }
    : { status: message.outcome.status, reason: message.outcome.reason };
  return [
    {
      role: 'assistant',
      text: `<user_question_request>\n${JSON.stringify(request)}\n</user_question_request>`,
    },
    {
      role: 'user',
      text: `<user_question_response>\n${JSON.stringify(response)}\n</user_question_response>`,
    },
  ];
}

export function serializeThreadMessagesForProviderHistory(
  messages: readonly ThreadMessage[],
): ThreadProviderHistoryEntry[] {
  return messages.flatMap((message): ThreadProviderHistoryEntry[] => {
    if (message.kind === 'user-question') {
      return serializeUserQuestionHistoryMessage(message);
    }
    if ((message.role !== 'user' && message.role !== 'assistant')
      || message.kind === 'progress'
      || message.kind === 'plan'
      || message.kind === 'activity'
      || message.kind === 'tasks'
      || (!message.text.trim() && !(message.role === 'user' && message.skillName))) return [];
    return [{
      role: message.role,
      text: message.role === 'user' && message.skillName
        ? `/${message.skillName}${message.text.trim() ? ` ${message.text}` : ''}`
        : message.text,
    }];
  });
}

export function createEmptyThread(draft: ThreadDraft): ChatThread {
  const now = Date.now();
  return {
    id: createThreadId(),
    title: '새 채팅',
    titleRequested: false,
    createdAt: now,
    updatedAt: now,
    agent: draft.agent,
    model: draft.model,
    effort: draft.effort,
    serviceTier: draft.serviceTier === 'fast' ? 'fast' : 'standard',
    workflow: draft.workflow ?? 'direct',
    docKey: draft.docKey ?? null,
    documentId: draft.documentId ?? null,
    activeTemplateId: draft.activeTemplateId ?? null,
    messages: [],
  };
}

/** 목록 순서의 기준 시각 — 마지막 대화 활동. */
export function threadActivityAt(thread: Pick<ChatThread, 'updatedAt' | 'lastActivityAt'>): number {
  return thread.lastActivityAt ?? thread.updatedAt;
}

/** 대화 내용이 움직였는지 가늠하는 지문 — 메시지 수와 마지막 메시지의 진행 상태. */
function activityStamp(thread: ChatThread): string {
  const last = thread.messages.at(-1);
  if (!last) return '0';
  const status = 'status' in last ? last.status : '';
  const items = 'tools' in last ? last.tools.length : 'tasks' in last ? last.tasks.length : 0;
  return `${thread.messages.length}|${last.role}|${last.kind ?? ''}|${last.text.length}|${status}|${items}`;
}

/** 메시지가 있는 스레드만 마지막 대화 활동 순으로. */
export function listThreads(): ChatThread[] {
  return loadAll()
    .filter((t) => t.messages.length > 0)
    .sort((a, b) => threadActivityAt(b) - threadActivityAt(a));
}

/** 문서 묶음 키 — ID가 있으면 ID로, 없으면 파일명으로 묶인 레거시 채팅이다. */
export function documentGroupKey(thread: Pick<ChatThread, 'documentId' | 'docKey'>): string {
  return thread.documentId ? `id:${thread.documentId}` : `name:${thread.docKey ?? ''}`;
}

export function getThread(id: string): ChatThread | null {
  return loadAll().find((t) => t.id === id) ?? null;
}

/** 메시지가 있을 때만 저장한다. 빈 스레드는 목록에 올리지 않는다. */
export function upsertThread(thread: ChatThread): void {
  if (thread.messages.length === 0) {
    removeThread(thread.id);
    return;
  }
  const previous = idbAvailable()
    ? cache.get(thread.id)
    : readLegacyThreads().find((item) => item.id === thread.id);
  const previousUpdatedAt = previous?.updatedAt ?? 0;
  const updatedAt = Math.max(Date.now(), thread.updatedAt + 1, previousUpdatedAt + 1);
  // 채팅을 열거나 떠날 때도 저장은 일어난다 — 대화가 움직였을 때만 목록에서 위로 올린다.
  const messages = thread.messages.slice(-MAX_MESSAGES_PER_THREAD);
  const lastActivityAt = previous && activityStamp(previous) === activityStamp({ ...thread, messages })
    ? threadActivityAt(previous)
    : updatedAt;
  // 목록 자리(고정·끌어 놓은 자리)는 저장소가 쥔다 — 열어 둔 채팅의 낡은 사본이
  // 저장되면서 사용자가 옮긴 자리를 되돌리지 않는다.
  const { pinOrder: _callerPinOrder, listOrder: _callerListOrder, ...rest } = thread;
  const placement = previous ?? thread;
  const capped: ChatThread = {
    ...rest,
    ...(placement.pinOrder !== undefined ? { pinOrder: placement.pinOrder } : {}),
    ...(placement.listOrder !== undefined ? { listOrder: placement.listOrder } : {}),
    messages,
    updatedAt,
    lastActivityAt,
    title: thread.title.trim() || fallbackTitle(thread.messages),
    titleRequested: Boolean(thread.titleRequested),
    workflow: isAgentWorkflow(thread.workflow) ? thread.workflow : 'direct',
    ...(isStructuredPlan(thread.latestPlan) ? { latestPlan: thread.latestPlan } : { latestPlan: undefined }),
  };

  if (!idbAvailable()) {
    const all = readLegacyThreads().filter((item) => item.id !== capped.id);
    all.unshift(capped);
    saveFallbackMutation(all);
    return;
  }

  cache.set(capped.id, cloneThread(capped));
  deletedBeforeHydration.delete(capped.id);
  trimCache();
  publish({ type: 'upsert', thread: cloneThread(capped) });
  persistUpsert(capped);
}

export function removeThread(id: string): void {
  if (!idbAvailable()) {
    saveFallbackMutation(readLegacyThreads().filter((thread) => thread.id !== id));
    return;
  }
  cache.delete(id);
  deletedBeforeHydration.add(id);
  publish({ type: 'remove', id });
  persistRemove(id);
}

/**
 * 채팅 기록 삭제 — 문서 파일은 그대로 두고, 그 문서에 속한 채팅을 모두
 * 지운다. keep 이 참인 채팅(다른 세션에서 아직 일하는 채팅 등)은 남긴다.
 * 지운 채팅 ID 목록을 돌려준다.
 */
export function forgetDocumentThreads(
  documentId: string | null,
  docKey: string | null,
  keep?: (thread: ChatThread) => boolean,
): string[] {
  // 소속 판정은 documentGroupKey 와 같은 규칙이다 — ID가 있으면 ID로,
  // 없으면 파일명으로만 묶인 레거시 채팅을 지운다.
  const removed = loadAll()
    .filter((thread) => (documentId
      ? thread.documentId === documentId
      : !thread.documentId && (thread.docKey ?? '') === (docKey ?? '')))
    .filter((thread) => !keep?.(thread))
    .map((thread) => thread.id);
  for (const id of removed) removeThread(id);
  return removed;
}

/** 자동 제목(에이전트/폴백) — 사용자가 고정한 이름은 건드리지 않는다. */
export function setThreadTitle(id: string, title: string): ChatThread | null {
  const current = getThread(id);
  if (!current || current.titlePinned) return current;
  const cleaned = title.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (!cleaned) return current;
  const next = { ...current, title: cleaned.slice(0, 48), updatedAt: Date.now() };
  upsertThread(next);
  return next;
}

/**
 * 사용자가 직접 이름을 바꾼다. 자동 제목과 달리 titlePinned 를 세워
 * 이후 에이전트 제목이 덮어쓰지 못하게 한다. 빈 이름은 무시한다.
 * updatedAt 은 건드리지 않는다 — 이름 바꾸기는 대화 활동이 아니라서
 * 목록 순서가 튀면 안 된다.
 */
export function renameThread(id: string, title: string): ChatThread | null {
  const current = getThread(id);
  if (!current) return null;
  const cleaned = title.trim().replace(/\s+/g, ' ');
  if (!cleaned) return current;
  const next = { ...current, title: cleaned.slice(0, 48), titlePinned: true };
  replaceStoredThread(next);
  return next;
}

/** 문서 이름이 바뀌면 그 문서의 채팅들에 보이는 문서 이름도 바꾼다. 목록 자리는 그대로다. */
export function renameThreadsDocument(documentId: string, docKey: string): void {
  for (const thread of listThreads()) {
    if (thread.documentId !== documentId || thread.docKey === docKey) continue;
    replaceStoredThread({ ...thread, docKey });
  }
}

/** 고정한 채팅만 고정 구역의 순서대로. 같은 자리는 최근 대화가 먼저다. */
export function orderPinnedThreads<T extends Pick<ChatThread, 'pinOrder' | 'updatedAt' | 'lastActivityAt'>>(
  threads: readonly T[],
): T[] {
  return threads
    .filter((thread) => thread.pinOrder !== undefined)
    .sort((a, b) => a.pinOrder! - b.pinOrder! || threadActivityAt(b) - threadActivityAt(a));
}

/** 고정 구역을 정확히 이 순서로 만든다. 자리가 바뀐 채팅만 다시 저장한다. */
function setPinnedOrder(ids: readonly string[]): void {
  const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
  const now = Date.now();
  for (const thread of loadAll()) {
    const pinOrder = order.get(thread.id);
    if (thread.pinOrder === pinOrder) continue;
    const { pinOrder: _previous, ...rest } = thread;
    // 고정은 대화 활동이 아니다 — 활동 시각은 두고, 탭 사이에서 이기도록 저장 시계만 앞으로 보낸다.
    replaceStoredThread({
      ...rest,
      updatedAt: Math.max(now, thread.updatedAt + 1),
      lastActivityAt: threadActivityAt(thread),
      ...(pinOrder !== undefined ? { pinOrder } : {}),
    });
  }
}

/**
 * 채팅을 고정 구역의 한 자리에 놓는다 — before 앞, 없으면 after 뒤,
 * 둘 다 없으면 맨 위. 이미 고정한 채팅이면 자리만 옮긴다.
 */
export function pinThread(id: string, place: { before?: string | null; after?: string | null } = {}): void {
  const order = orderPinnedThreads(loadAll()).map((thread) => thread.id).filter((pinned) => pinned !== id);
  const before = place.before ? order.indexOf(place.before) : -1;
  const after = place.after ? order.indexOf(place.after) : -1;
  order.splice(before >= 0 ? before : after >= 0 ? after + 1 : 0, 0, id);
  setPinnedOrder(order);
}

export function unpinThread(id: string): void {
  setPinnedOrder(orderPinnedThreads(loadAll()).map((thread) => thread.id).filter((pinned) => pinned !== id));
}

/** 아래 목록의 순서 기준 — 큰 값이 위. 끌어 놓은 자리가 있으면 그 자리다. */
export function threadListKey(thread: Pick<ChatThread, 'listOrder' | 'updatedAt' | 'lastActivityAt'>): number {
  return thread.listOrder ?? threadActivityAt(thread);
}

/**
 * 채팅을 아래 목록의 두 이웃 사이에 놓는다 — after 는 바로 위, before 는 바로 아래 채팅.
 * 고정한 채팅이면 고정을 풀고 그 자리에 놓는다. 맨 위에 놓으면 지금 대화한 채팅과 같다.
 */
export function placeThread(id: string, place: { before?: string | null; after?: string | null }): void {
  const all = loadAll();
  const thread = all.find((item) => item.id === id);
  if (!thread) return;
  const key = (neighborId: string | null | undefined) => {
    const neighbor = neighborId ? all.find((item) => item.id === neighborId) : undefined;
    return neighbor ? threadListKey(neighbor) : null;
  };
  const above = key(place.after);
  const below = key(place.before);
  const current = threadListKey(thread);
  const listOrder = above !== null && below !== null
    ? (above + below) / 2
    : below !== null
      ? Math.max(Date.now(), below + 1)
      : above !== null
        ? above - 60_000
        : current;
  if (thread.pinOrder === undefined && thread.listOrder === listOrder) return;
  const { pinOrder: _pinned, ...rest } = thread;
  replaceStoredThread({
    ...rest,
    updatedAt: Math.max(Date.now(), thread.updatedAt + 1),
    lastActivityAt: threadActivityAt(thread),
    listOrder,
  });
}

/** 대화 내용이 아닌 속성(이름·고정)만 바뀐 채팅을 그대로 저장한다. */
function replaceStoredThread(next: ChatThread): void {
  if (idbAvailable()) {
    cache.set(next.id, cloneThread(next));
    publish({ type: 'upsert', thread: cloneThread(next) });
    persistUpsert(next);
    return;
  }
  const all = readLegacyThreads();
  const index = all.findIndex((thread) => thread.id === next.id);
  if (index >= 0) {
    all[index] = next;
    saveFallbackMutation(all);
  }
}
