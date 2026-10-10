import type * as T from '../agent/types.ts';
import type { ChatThread, PendingUserQuestionDraftSnapshot } from '../agent/threads.ts';
import { defaultModelForAgent, labelForModel } from '../agent/models.ts';

export type BrowserbaseFixtureState = 'connected' | 'setup' | 'error';

export function createBrowserbaseFixture(state: BrowserbaseFixtureState): T.BrowserbaseStatus {
  const configured = state === 'connected';
  return {
    configured,
    missing: configured ? [] : ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
    keySource: configured ? 'env' : null,
    keyTail: configured ? 'demo' : null,
    projectId: configured ? 'preview-browser-project' : null,
    projectSource: configured ? 'env' : null,
    geminiSource: configured ? 'env' : null,
    browsers: configured ? [{ id: 'main', connected: true }, { id: 'preview-research', connected: false }] : [],
  };
}

export const agents: T.AgentName[] = [
  'claude',
  'codex',
  'pi',
  'grok',
  'cursor',
  'opencode',
];
export const timestamp = new Date().toISOString();
export function agentMap<TValue>(
  make: (agent: T.AgentName) => TValue,
): Record<T.AgentName, TValue> {
  return Object.fromEntries(
    agents.map((agent) => [agent, make(agent)]),
  ) as Record<T.AgentName, TValue>;
}
export function createFixtures() {
  const providers: T.ProviderStatusMap = agentMap(() => ({
    available: true,
    version: 'preview',
    error: null,
    checkedAt: Date.parse(timestamp),
  }));
  const setups: T.AgentSetupStatusMap = agentMap((agent) => ({
    agent,
    available: true,
    connected: true,
    installed: true,
    installing: false,
    version: 'preview',
    authenticated: true,
    authMethod: 'oauth',
    keyTail: null,
    authenticating: false,
    setupComplete: true,
    latestVersion: 'preview',
    updateRequired: false,
    error: null,
  }));
  const window: T.UsageWindow = {
    turns: 12,
    inputTokens: 18400,
    outputTokens: 3200,
    cacheReadTokens: 8400,
    cacheCreationTokens: 0,
    weightedTokens: 21600,
    percent: 24,
  };
  const usage: T.UsageSummary = {
    plans: agentMap((agent) =>
      agent === 'codex' ? 'plus' : agent === 'claude' ? 'pro' : 'api',
    ),
    providers: agentMap(() => ({
      session: { ...window },
      day: { ...window },
      week: { ...window, percent: 42 },
      byModel: {},
      limit: { session5h: 90000, week: 500000 },
      updatedAt: Date.parse(timestamp),
    })),
  };
  const quotaScenario = new URLSearchParams(location.search).get('quota');
  const now = Date.now();
  usage.limits = {
    claude: {
      status: 'ok', session: { percent: 24, resetsAt: now + 3600000 },
      week: { percent: 72, resetsAt: now + 86400000 }, updatedAt: now,
      error: null, accountKey: 'preview-claude', planType: 'Pro', resetCredits: null,
    },
    codex: {
      status: 'ok', session: { percent: 92, resetsAt: now + 7200000 },
      week: { percent: 42, resetsAt: now + 172800000 }, updatedAt: now,
      error: null, accountKey: 'preview-codex', planType: 'Plus',
      resetCredits: { availableCount: 2, nextExpiresAt: now + 604800000 },
    },
  };
  if (quotaScenario === 'error') {
    usage.limits.claude.status = 'error';
    usage.limits.claude.error = '제공자가 응답하지 않아요.';
    usage.limits.claude.updatedAt = now - 600000;
    usage.limits.codex.status = 'unavailable';
    usage.limits.codex.session.percent = null;
    usage.limits.codex.week.percent = null;
    usage.limits.codex.resetCredits = null;
  }
  if (quotaScenario === 'empty') usage.limits.codex.resetCredits!.availableCount = 0;
  if (quotaScenario === 'pro') usage.limits.codex.planType = 'Pro';
  const pi: T.PiStatus = {
    installed: true,
    installing: false,
    version: 'preview',
    keyConfigured: true,
    keyTail: 'demo',
    models: [],
    defaultModelId: null,
    setupComplete: true,
    latestVersion: 'preview',
    updateRequired: false,
    error: null,
  };
  pi.models = [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      reasoning: true,
      supportsImages: true,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      contextLength: 200000,
      pricing: { prompt: 0.000003, completion: 0.000015 },
    },
  ];
  pi.defaultModelId = pi.models[0].id;
  setups.cursor.models = ['auto', 'sonnet-4.6', 'gpt-5.4'];
  setups.opencode.models = ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4'];
  usage.openrouter = {
    balanceUsd: 18.5,
    totalCreditsUsd: 20,
    totalUsageUsd: 1.5,
    checkedAt: Date.parse(timestamp),
    error: null,
  };
  usage.balances = {
    openrouter: { status: 'ok', balanceUsd: 18.5, totalCreditsUsd: 20, totalUsageUsd: 1.5, updatedAt: now, source: '샘플', error: null },
    grok: { status: 'ok', balanceUsd: 4.25, totalCreditsUsd: null, totalUsageUsd: null, updatedAt: now, source: '샘플', error: null },
    opencode: { status: 'unavailable', balanceUsd: null, totalCreditsUsd: null, totalUsageUsd: null, updatedAt: null, source: '샘플', error: '연결된 계정의 잔액 정보를 사용할 수 없어요.' },
  };
  const templates: T.TemplateCatalog = {
    revision: 1,
    templates: ['사업 제안서', '회의록'].map((name, i) => ({
      id: `template-${i}`,
      name,
      originalName: `${name}.hwpx`,
      format: 'hwpx',
      size: 24576,
      pageCount: i ? 2 : 5,
      sectionCount: 1,
      contentHash: `preview-${i}`,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  };
  const skills: T.SkillCatalog = {
    rows: [...[
      ['proofread-korean', '한국어 문서의 맞춤법과 문장을 다듬습니다.'],
      ['summarize-document', '문서의 핵심 내용을 요약합니다.'],
      ['draft-document', '요청에 맞는 새 문서의 초안을 작성합니다.'],
    ].map(([name, description]) => ({
      kind: 'skill' as const,
      name,
      description,
      origin: 'user' as const,
      icon: 'pencil' as const,
      enabled: true,
      digest: 'a'.repeat(64),
      editable: true,
    })),
      {
        kind: 'skill',
        name: 'imported-style-guide',
        description: '외부에서 가져온 읽기 전용 스킬입니다.',
        origin: 'bundled',
        icon: 'system',
        enabled: true,
        digest: 'b'.repeat(64),
        editable: false,
      },
    ],
  };
  const writing: T.WritingStyleStatus = {
    active: false,
    language: 'ko',
    updatedAt: null,
    sourceCount: 0,
    pageEstimate: 0,
    summary: '',
    additionalInstruction: '',
  };
  const writingCatalog: T.WritingStyleCatalog = {
    providers: agents.map((id) => ({
      id,
      name: id,
      available: true,
      error: null,
      models:
        id === 'pi'
          ? pi.models
          : [
              {
                id: defaultModelForAgent(id),
                name: labelForModel(id, defaultModelForAgent(id)),
                efforts: ['medium'],
                defaultEffort: 'medium',
              },
            ],
    })),
    defaultSelection: { agent: 'codex', model: defaultModelForAgent('codex') },
  };
  const instructions: T.AgentInstructionsStatus = {
    fileName: 'AGENTS.md',
    content: '한국어 문서를 간결하고 자연스럽게 작성합니다.',
    revision: 1,
    updatedAt: timestamp,
    maxChars: 20000,
    scope: 'rauhwpx-app',
  };
  return {
    providers,
    setups,
    usage,
    pi,
    templates,
    skills,
    writing,
    writingCatalog,
    instructions,
  };
}

export function samplePlan(revision = 1, previousPlanId?: string): T.StructuredPlan {
  return {
    planId: crypto.randomUUID(),
    title: '사업 제안서 개선 계획',
    goal: '제안의 핵심과 실행 일정을 명확히 전달합니다.',
    summary: revision > 1
      ? '피드백을 반영해 일정 검토를 먼저 하고 문서 구조를 정리합니다.'
      : '문서 구조를 정리하고 문장을 다듬습니다.',
    revision,
    ...(previousPlanId ? {
      previousPlanId,
      changeSummary: '일정 검토를 첫 단계로 옮기고 검증 기준을 구체화했습니다.',
    } : {}),
    documentRevision: 0,
    assumptions: ['기존 목차를 유지합니다.'],
    decisions: ['핵심 내용을 첫 문단에 배치합니다.'],
    steps: (revision > 1 ? [
      { id: 'step-1', title: '추진 일정 표의 날짜와 담당자를 확인' },
      { id: 'step-2', title: '사업 개요 첫 문단을 목적 중심으로 다시 쓰기' },
      { id: 'step-3', title: '일정 표를 한 쪽에 맞게 정리' },
      { id: 'step-4', title: 'get_page_geometry 로 표가 한 쪽에 들어가는지 확인' },
    ] : [
      { id: 'step-1', title: '사업 개요 첫 문단을 목적 중심으로 다시 쓰기' },
      { id: 'step-2', title: '기대 효과를 세 줄 목록으로 정리' },
      { id: 'step-3', title: '추진 일정 표의 날짜와 담당자를 확인' },
      { id: 'step-4', title: 'get_page_geometry 로 표가 한 쪽에 들어가는지 확인' },
    ]),
    files: ['사업 제안서.hwpx'],
    validation: [],
    sources: [
      { title: '사업 제안서.hwpx', fileId: 'preview-proposal', note: '사업 개요와 추진 일정' },
      { title: '브랜드 가이드.pdf', fileId: 'reference-sample', note: '용어와 문체' },
    ],
    risks: [],
    exclusions: [],
    createdAt: timestamp,
    epoch: 1,
  };
}

export interface SampleDocument {
  documentId: string;
  fileName: string;
  sourceFormat: string;
  openedAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Recent documents for the open-document palette, newest first. */
export function sampleRecentDocuments(now: number): SampleDocument[] {
  return [
    { documentId: 'preview-proposal', fileName: '사업 제안서.hwpx', sourceFormat: 'hwpx', openedAt: now - MINUTE },
    { documentId: 'preview-notes', fileName: '회의록.hwpx', sourceFormat: 'hwpx', openedAt: now - 40 * MINUTE },
    { documentId: 'preview-budget', fileName: '2027 예산 계획.hwp', sourceFormat: 'hwp', openedAt: now - 3 * HOUR },
    { documentId: 'preview-contract', fileName: '용역 계약서.hwp', sourceFormat: 'hwp', openedAt: now - 2 * DAY },
    { documentId: 'preview-report', fileName: '연간 활동 보고서.hwpx', sourceFormat: 'hwpx', openedAt: now - 9 * DAY },
  ];
}

/** Seeded chat that `chats=sample` shows as running. */
export const SAMPLE_WORKING_CHAT_ID = 'preview-chat-schedule';
/** Seeded chat that `chats=sample` shows as finished but unread. */
export const SAMPLE_FINISHED_CHAT_ID = 'preview-chat-minutes';
/** Seeded chat that `chats=sample` shows as 검토 대기 (staged edits awaiting review). */
export const SAMPLE_REVIEW_CHAT_ID = 'preview-chat-totals';
/**
 * Seeded chat that `chats=sample` shows as cut off (`중단됨`): the app restarted during its turn
 * (S3 interruption row with 이어서 진행).
 */
export const SAMPLE_INTERRUPTED_CHAT_ID = 'preview-chat-interrupted';
/** The preview page's window session, as the editor passes it to the sidebar (interruptionScope). */
export const PREVIEW_WINDOW_SESSION_ID = 'preview-window';

type SampleMessage = ChatThread['messages'][number];

function sampleTool(callId: string, tool: string, args: Record<string, unknown>, resultPreview: string) {
  return {
    callId,
    tool: `mcp__rhwp__${tool}`,
    argsJson: JSON.stringify(args),
    status: 'completed' as const,
    resultPreview,
    elapsedMs: 420,
  };
}

/**
 * Sample turn markers and recorded work, so `chats=sample` shows settled turns folded:
 * a completed edit (`작업 2분 31초 · 문단 2개 수정 · 표 1개 읽음`) and an interrupted
 * one (`중단됨 · 1분 12초 · 표 1개 추가`). The turn ends when the chat last moved.
 */
function sampleTurnWork(id: string, agent: T.AgentName, activityAt: number): SampleMessage[] {
  if (id === 'preview-chat-overview') {
    const startedAt = activityAt - 151_000;
    return [
      {
        role: 'system', kind: 'turn', messageId: `${id}-turn-1`, startedAt, endedAt: activityAt,
        outcome: 'completed', text: '작업 2분 31초 · 문단 2개 수정 · 표 1개 읽음',
      },
      { role: 'assistant', kind: 'progress', agent, text: '사업 개요 첫 문단과 추진 일정 표를 먼저 확인하겠습니다.' },
      {
        role: 'assistant', kind: 'activity', agent, activityId: `${id}-activity-1`, text: '도구 호출',
        status: 'completed', startedAt: startedAt + 4_000, completedAt: activityAt - 9_000,
        tools: [
          sampleTool(`${id}-1`, 'get_structure', {}, '구역 1개 · 문단 42개 · 표 3개'),
          sampleTool(`${id}-2`, 'replace_range', { sectionIdx: 0, paraIdx: 0, find: '본 사업은', text: '이 사업의 목적은' }, '{"revision":8}'),
          sampleTool(`${id}-3`, 'replace_range', { sectionIdx: 0, paraIdx: 1, find: '배경', text: '추진 배경' }, '{"revision":9}'),
          sampleTool(`${id}-4`, 'apply_para_format', { sectionIdx: 0, paraIdx: 1, alignment: 'justify' }, '{"revision":10}'),
          sampleTool(`${id}-5`, 'get_table_properties', { sectionIdx: 0, paraIdx: 12, controlIdx: 0 }, '{"rows":5,"cols":4}'),
        ],
      },
    ];
  }
  if (id === 'preview-chat-attendees') {
    const startedAt = activityAt - 72_000;
    return [
      {
        role: 'system', kind: 'turn', messageId: `${id}-turn-1`, startedAt, endedAt: activityAt,
        outcome: 'interrupted', text: '중단됨 · 1분 12초 · 표 1개 추가',
      },
      {
        role: 'assistant', kind: 'activity', agent, activityId: `${id}-activity-1`, text: '도구 호출',
        status: 'completed', startedAt: startedAt + 3_000, completedAt: startedAt + 41_000,
        tools: [
          sampleTool(`${id}-1`, 'create_table', { sectionIdx: 0, paraIdx: 4, charOffset: 0, rows: 6, cols: 3 }, '{"paraIdx":4,"controlIdx":0}'),
        ],
      },
    ];
  }
  return [];
}

/** A stored question card the cut-off turn left unanswered (sample data). */
function sampleExpiredQuestion(threadId: string, turnId: string): SampleMessage {
  const interaction: T.UserQuestionInteraction = {
    interactionId: `${threadId}-question`,
    providerRequestId: `${threadId}-question-request`,
    threadId,
    turnId,
    agent: 'claude',
    source: 'native',
    createdAt: timestamp,
    updatedAt: timestamp,
    questions: [{
      id: 'range',
      header: '범위',
      question: '어느 기간의 일정을 분기별로 나눌까요?',
      mode: 'single',
      allowOther: false,
      options: [
        { id: 'all', label: '전체 일정', description: '착수부터 종료까지 모두 나눕니다.' },
        { id: 'next-year', label: '내년 일정만', description: '2027년 일정만 분기로 묶습니다.' },
      ],
    }],
  };
  return {
    role: 'assistant',
    kind: 'user-question',
    text: '어느 기간의 일정을 분기별로 나눌까요?\n요청 만료',
    agent: 'claude',
    interaction,
    outcome: { status: 'expired', reason: 'request-invalidated' },
  };
}

/**
 * `chats=sample`: a 사업 제안서 chat whose turn was cut off when the app restarted (sample data).
 * The turn read the document and asked a question; the stored marker carries the S3 interruption,
 * so the chat opens with the interruption row, 이어서 진행, the expired question card labelled
 * 만료됨 · 앱 재시작, and one follow-up held with that reason.
 */
export function interruptedSampleChat(now: number): ChatThread {
  const id = SAMPLE_INTERRUPTED_CHAT_ID;
  const activityAt = now - 30 * MINUTE;
  const startedAt = activityAt - 72_000;
  return {
    id,
    title: '추진 일정 분기별로 나누기',
    titleRequested: true,
    createdAt: startedAt - MINUTE,
    updatedAt: activityAt,
    lastActivityAt: activityAt,
    agent: 'claude',
    model: defaultModelForAgent('claude'),
    effort: 'medium',
    serviceTier: 'standard',
    workflow: 'direct',
    documentId: 'preview-proposal',
    docKey: '사업 제안서.hwpx',
    activeTemplateId: null,
    followUps: {
      items: [{ id: `${id}-follow-up`, text: '표 머리글도 굵게 해 주세요.', createdAt: activityAt - 20_000 }],
      hold: { reason: 'interrupted', detail: '앱 재시작', at: activityAt + 5_000 },
    },
    messages: [
      { role: 'user', text: '추진 일정 표를 분기별로 다시 나눠 주세요.' },
      {
        role: 'system', kind: 'turn', messageId: `${id}-turn-1`, startedAt, endedAt: activityAt,
        outcome: 'interrupted', text: '중단됨 · 1분 12초 · 표 1개 읽음 · 문서 읽음',
        owner: { window: PREVIEW_WINDOW_SESSION_ID, app: 'preview-app-run-1', hub: 'preview-hub-0' },
        hubTurnId: `${id}-hub-turn`,
        reason: 'app-restart',
        interruption: { reason: 'app-restart', at: activityAt + 5_000 },
      },
      { role: 'assistant', kind: 'progress', agent: 'claude', text: '추진 일정 표를 읽고 분기별로 묶겠습니다.' },
      {
        role: 'assistant', kind: 'activity', agent: 'claude', activityId: `${id}-activity-1`, text: '도구 호출',
        status: 'completed', startedAt: startedAt + 3_000, completedAt: startedAt + 21_000,
        tools: [
          sampleTool(`${id}-1`, 'get_structure', {}, '구역 1개 · 문단 42개 · 표 3개'),
          sampleTool(`${id}-2`, 'get_table_properties', { sectionIdx: 0, paraIdx: 21, controlIdx: 0 }, '{"rows":6,"cols":4}'),
        ],
      },
      sampleExpiredQuestion(id, `${id}-hub-turn`),
    ],
  };
}

/**
 * `chats=sample&reload=lost`: what the old page stored for the working chat's turn before a reload
 * that the hub did not survive for this chat — an open marker this window started (sample data).
 * The sidebar's startup settles it as cut off by the reload.
 */
export function sampleLostTurnWork(agent: T.AgentName, now: number): SampleMessage[] {
  const id = SAMPLE_WORKING_CHAT_ID;
  const startedAt = now - 40_000;
  return [
    {
      role: 'system', kind: 'turn', messageId: `${id}-turn-lost`, startedAt, endedAt: null, outcome: null, text: '',
      owner: { window: PREVIEW_WINDOW_SESSION_ID, app: null, hub: 'preview-hub-1' },
      hubTurnId: 'preview-lost-turn',
    },
    {
      role: 'assistant', kind: 'activity', agent, activityId: `${id}-activity-lost`, text: '도구 호출',
      status: 'completed', startedAt: startedAt + 3_000, completedAt: startedAt + 21_000,
      tools: [
        sampleTool(`${id}-lost-1`, 'get_table_properties', { sectionIdx: 0, paraIdx: 21, controlIdx: 0 }, '{"rows":6,"cols":4}'),
      ],
    },
  ];
}

/**
 * `reload=running|question`: what the old page stored for the working chat's running turn before
 * the reload — its open turn marker and the work done so far (sample data). The re-adopted turn's
 * real end settles the marker and folds this work.
 */
export function sampleRunningTurnWork(agent: T.AgentName, now: number): SampleMessage[] {
  const id = SAMPLE_WORKING_CHAT_ID;
  const startedAt = now - 40_000;
  return [
    { role: 'system', kind: 'turn', messageId: `${id}-turn-1`, startedAt, endedAt: null, outcome: null, text: '' },
    { role: 'assistant', kind: 'progress', agent, text: '추진 일정 표를 읽고 분기별로 묶겠습니다.' },
    {
      role: 'assistant', kind: 'activity', agent, activityId: `${id}-activity-1`, text: '도구 호출',
      status: 'completed', startedAt: startedAt + 3_000, completedAt: startedAt + 21_000,
      tools: [
        sampleTool(`${id}-1`, 'get_table_properties', { sectionIdx: 0, paraIdx: 21, controlIdx: 0 }, '{"rows":6,"cols":4}'),
        sampleTool(`${id}-2`, 'edit_table', { sectionIdx: 0, paraIdx: 21, controlIdx: 0, op: 'insert_row', rowIdx: 1 }, '{"rowCount":7}'),
      ],
    },
  ];
}

/**
 * Chats across several documents and providers for the activity-ordered list.
 * Timestamps are relative to `now`, so the list always shows fresh, varied ages.
 */
export function sampleChats(now: number): ChatThread[] {
  const proposal = { documentId: 'preview-proposal', docKey: '사업 제안서.hwpx' };
  const notes = { documentId: 'preview-notes', docKey: '회의록.hwpx' };
  const budget = { documentId: 'preview-budget', docKey: '2027 예산 계획.hwp' };
  const none = { documentId: null, docKey: null };
  const rows: Array<[string, string, T.AgentName, typeof proposal | typeof none, number, string, string | null]> = [
    [SAMPLE_WORKING_CHAT_ID, '추진 일정 표 정리', 'claude', proposal, 2 * MINUTE,
      '추진 일정 표의 날짜를 분기별로 정리해 주세요.', null],
    [SAMPLE_FINISHED_CHAT_ID, '회의 결정 사항 요약', 'codex', notes, 14 * MINUTE,
      '오늘 회의에서 정한 사항만 다섯 줄로 요약해 주세요.', '결정 사항 다섯 가지를 문서 첫머리에 요약했습니다.'],
    ['preview-chat-overview', '사업 개요 첫 문단 다듬기', 'claude', proposal, HOUR,
      '사업 개요 첫 문단을 목적이 먼저 보이게 고쳐 주세요.', '첫 문장에 사업 목적을 두고 배경 설명은 뒤로 옮겼습니다.'],
    ['preview-chat-totals', '분기별 예산 표 합계 확인', 'pi', budget, 3 * HOUR,
      '분기별 예산 표의 합계가 맞는지 확인해 주세요.', '3분기 소계가 120만 원 적게 계산되어 있었습니다. 표를 고쳤습니다.'],
    ['preview-chat-press', '보도자료 초안 아이디어', 'codex', none, 26 * HOUR,
      '신제품 출시 보도자료 제목 후보를 몇 개 제안해 주세요.', '제목 후보 다섯 개와 부제를 정리했습니다.'],
    ['preview-chat-attendees', '참석자 명단 표 만들기', 'pi', notes, 3 * DAY,
      '참석자 명단을 소속별 표로 만들어 주세요.', '소속, 이름, 직책 세 열로 표를 만들었습니다.'],
    ['preview-chat-wording', '예산 항목 설명 문장 통일', 'claude', budget, 8 * DAY,
      '예산 항목 설명을 같은 문체로 맞춰 주세요.', '모든 항목 설명을 "~합니다" 문체로 통일했습니다.'],
  ];
  const chats = rows.map(([id, title, agent, document, age, request, reply]): ChatThread => {
    const activityAt = now - age;
    const messages: ChatThread['messages'] = [{ role: 'user', text: request }];
    messages.push(...sampleTurnWork(id, agent, activityAt));
    if (reply) messages.push({ role: 'assistant', text: reply, agent });
    return {
      id,
      title,
      titleRequested: true,
      createdAt: activityAt - 5 * MINUTE,
      updatedAt: activityAt,
      lastActivityAt: activityAt,
      agent,
      model: agent === 'pi' ? 'anthropic/claude-sonnet-4.6' : defaultModelForAgent(agent),
      effort: 'medium',
      serviceTier: 'standard',
      workflow: 'direct',
      ...document,
      activeTemplateId: null,
      messages,
    };
  });
  return [...chats, interruptedSampleChat(now)];
}

/** Seeded chat that `chats=engine-trap` restores: its turn was stopped by an engine trap. */
export const SAMPLE_ENGINE_TRAP_CHAT_ID = 'preview-chat-engine-trap';

/**
 * The newest chat of the shown document, interrupted when the document engine stopped and the
 * editor reloaded to reopen every document (its last turn carries the engine-trap interruption,
 * as markThreadInterrupted leaves it). The sidebar restores it on load.
 */
export function engineTrapInterruptedChat(now: number): ChatThread {
  const activityAt = now - 20_000;
  return {
    id: SAMPLE_ENGINE_TRAP_CHAT_ID,
    title: '추진 일정 표 서식 맞추기',
    titleRequested: true,
    createdAt: activityAt - 3 * MINUTE,
    updatedAt: activityAt,
    lastActivityAt: activityAt,
    agent: 'claude',
    model: defaultModelForAgent('claude'),
    effort: 'medium',
    serviceTier: 'standard',
    workflow: 'direct',
    documentId: 'preview-proposal',
    docKey: '사업 제안서.hwpx',
    activeTemplateId: null,
    messages: [
      { role: 'user', text: '추진 일정 표의 글꼴과 칸 너비를 본문과 맞춰 주세요.' },
      {
        role: 'system', kind: 'turn', messageId: `${SAMPLE_ENGINE_TRAP_CHAT_ID}-turn-1`,
        startedAt: activityAt - 34_000, endedAt: activityAt, outcome: 'interrupted', text: '중단됨 · 34초',
        reason: 'engine-trap', interruption: { reason: 'engine-trap', at: activityAt + 2_000 },
      },
      { role: 'assistant', text: '일정 표의 칸 너비를 확인하고 있습니다.', agent: 'claude', kind: 'progress' },
    ],
  };
}

/**
 * `reload=question`: the question the reloaded chat's running turn is blocked on (sample data).
 * The second card accepts typed text, which the reload must bring back with its step.
 */
export function sampleReloadQuestion(): T.UserQuestionInteraction {
  return {
    interactionId: 'preview-reload-question',
    providerRequestId: 'preview-reload-request',
    threadId: SAMPLE_WORKING_CHAT_ID,
    turnId: 'preview-turn',
    agent: 'claude',
    source: 'native',
    createdAt: timestamp,
    updatedAt: timestamp,
    questions: [
      {
        id: 'range',
        header: '범위',
        question: '어느 기간의 일정을 분기별로 나눌까요?',
        mode: 'single',
        allowOther: false,
        options: [
          { id: 'all', label: '전체 일정', description: '착수부터 종료까지 모두 나눕니다.' },
          { id: 'next-year', label: '내년 일정만', description: '2027년 일정만 분기로 묶습니다.' },
        ],
      },
      {
        id: 'confirm',
        header: '확인',
        question: '표를 고치기 전에 확인할 내용이 있나요?',
        mode: 'single',
        allowOther: true,
        options: [
          { id: 'owner', label: '담당자 확인', description: '일정마다 담당자를 표에 함께 적습니다.' },
          { id: 'none', label: '바로 진행', description: '지금 날짜로 표를 정리합니다.' },
        ],
      },
    ],
  };
}

/** Typed `직접 입력` answer that the stored draft of `sampleReloadQuestion` holds (sample data). */
export const SAMPLE_RELOAD_OTHER_TEXT = '현장 인터뷰 일정\n다시 확인';

/** The draft the page saved before the reload: the first card answered, the second one typed. */
export function sampleReloadQuestionDraft(now: number): PendingUserQuestionDraftSnapshot {
  return {
    interaction: sampleReloadQuestion(),
    selectedOptionIdsByQuestionId: { range: ['all'] },
    otherTextByQuestionId: { confirm: SAMPLE_RELOAD_OTHER_TEXT },
    activeQuestionIndex: 1,
    updatedAt: now,
  };
}
