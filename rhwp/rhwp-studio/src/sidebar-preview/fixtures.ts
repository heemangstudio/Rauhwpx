import type * as T from '../agent/types.ts';
import type { ChatThread, PendingUserQuestionDraftSnapshot } from '../agent/threads.ts';
import { defaultModelForAgent, labelForModel } from '../agent/models.ts';

export const agents: T.AgentName[] = [
  'claude',
  'codex',
  'pi',
  'rau',
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
      week: { percent: 72, resetsAt: now + 86400000 }, month: { percent: null, resetsAt: null }, updatedAt: now,
      error: null, accountKey: 'preview-claude', planType: 'Pro', resetCredits: null,
    },
    codex: {
      status: 'ok', session: { percent: 92, resetsAt: now + 7200000 },
      week: { percent: 42, resetsAt: now + 172800000 }, month: { percent: null, resetsAt: null }, updatedAt: now,
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
  if (quotaScenario === 'free') {
    Object.assign(usage.limits.codex, {
      planType: 'free', session: { percent: null, resetsAt: null }, week: { percent: null, resetsAt: null },
      month: { percent: 5, resetsAt: now + 29 * 86400000 }, resetCredits: { availableCount: 0, nextExpiresAt: null },
    });
  }
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
    // 허브 기본 AGENTS.md(rhwp-agent/agent-instructions.mjs)와 같은 글.
    content: `# 앱 에이전트 지시

이 지속 지시는 HamaEditor 안에서만 적용됩니다. 앱은 이 AGENTS.md를 프로젝트 및 제공자 지시 파일과 분리해 보관하므로 다른 에이전트 실행 환경에서는 불러오지 않습니다.

## 이 파일 관리

- 모든 HamaEditor 채팅에서 이 지시를 읽고 따르세요.
- 사용자가 이 지시를 바꿔 달라고 요청하면 앱의 지시 도구를 통해 전체 수정본을 제출하세요. HamaEditor는 사용자에게 변경안을 보여 주고, 사용자가 승인한 뒤에만 저장합니다.
- 사용자가 같은 선호를 반복해서 말하거나 에이전트의 행동을 바로잡은 경우에는 지속해서 적용할 것이 명확한 선호를 선제적으로 제안할 수 있습니다. 변경은 작고 구체적으로 유지하고, 무엇을 제안했는지 사용자에게 알리세요.
- 일회성 작업 세부 정보, 비밀, 인증 정보 또는 추론한 민감한 사실은 저장하지 마세요. 범위가 넓거나 모호한 변경을 하기 전에는 사용자에게 확인하세요.
`,
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
/** 설정의 보관함에만 보이는 샘플 채팅. */
export const SAMPLE_ARCHIVED_CHAT_ID = 'preview-chat-archived';

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
    [SAMPLE_ARCHIVED_CHAT_ID, '작년 회의록 서식 옮기기', 'codex', notes, 20 * DAY,
      '작년 회의록 서식을 이번 문서에 맞춰 주세요.', '제목, 참석자, 안건 순서를 작년 서식과 맞췄습니다.'],
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
      ...(id === SAMPLE_ARCHIVED_CHAT_ID ? { archivedAt: activityAt + DAY } : {}),
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

/** Seeded chat that `chats=long` opens: a long 사업 제안서 conversation for the focus-mode turn rail. */
export const SAMPLE_LONG_CHAT_ID = 'preview-chat-long';

/** 18 turns of document editing (sample data). Each reply has two or three paragraphs. */
const LONG_CHAT_TURNS: ReadonlyArray<readonly [request: string, reply: string]> = [
  ['문서 전체 구조를 먼저 요약해 주세요.',
    '이 제안서는 구역 하나에 문단 42개, 표 3개로 되어 있습니다. 사업 개요, 추진 배경, 추진 일정, 예산, 기대 효과 순서입니다.\n\n표는 추진 일정(6행 4열), 분기별 예산(5행 4열), 담당 조직(4행 3열) 세 개입니다. 각 장의 제목은 같은 개요 수준 스타일을 씁니다.'],
  ['사업 개요 첫 문단을 목적이 먼저 보이게 고쳐 주세요.',
    '첫 문장에 사업 목적을 두고 배경 설명은 두 번째 문장으로 옮겼습니다.\n\n"이 사업의 목적은 지역 소상공인의 문서 업무를 디지털로 전환하는 것입니다."로 시작합니다. 원래 첫 문장이던 시장 현황은 추진 배경 장으로 옮겼습니다.'],
  ['추진 배경에 최근 통계를 한 문장 넣을 자리를 잡아 주세요.',
    '추진 배경 두 번째 문단 끝에 통계 문장이 들어갈 자리를 표시했습니다.\n\n자리표시 문장은 "[통계: 출처와 연도를 함께 적습니다]"이고, 노란 형광펜으로 눈에 띄게 해 두었습니다. 출처를 알려 주시면 문장으로 바꿔 넣겠습니다.'],
  ['추진 일정 표의 날짜를 분기별로 정리해 주세요.',
    '추진 일정 표의 날짜 열을 2027년 1분기부터 4분기까지 네 칸으로 바꿨어요.\n\n착수 회의와 요구 분석은 1분기, 시범 운영은 3분기, 결과 보고는 4분기로 묶었습니다. 월 단위로 적혀 있던 기존 날짜는 비고 열로 옮겨 남겨 두었습니다.\n\n표 너비는 본문 폭에 맞췄고, 머리글 행은 반복되도록 설정했습니다.'],
  ['표 머리글을 굵게 하고 가운데 정렬해 주세요.',
    '추진 일정 표와 분기별 예산 표의 머리글 행을 굵게 하고 가운데 정렬했습니다.\n\n담당 조직 표는 머리글이 세로로 놓여 있어 첫 열만 굵게 했습니다. 셀 배경색은 바꾸지 않았습니다.'],
  ['분기별 예산 표의 합계가 맞는지 확인해 주세요.',
    '3분기 소계가 120만 원 적게 계산되어 있었습니다. 인건비 칸이 합계 수식에서 빠져 있었습니다.\n\n소계와 총계를 다시 계산해 고쳤습니다. 총액은 4억 2,380만 원으로, 사업 개요에 적힌 금액과 이제 같습니다.'],
  ['예산 항목 설명을 같은 문체로 맞춰 주세요.',
    '모든 항목 설명을 "~합니다" 문체로 통일했습니다.\n\n"장비 구입", "외부 용역" 처럼 명사로 끝나던 설명 일곱 개를 문장으로 바꿨어요. 금액과 단위 표기는 그대로 두었습니다.'],
  ['기대 효과를 정량 지표 세 가지로 다시 써 주세요.',
    '기대 효과 장을 지표 세 개의 목록으로 바꿨어요.\n\n1. 문서 처리 시간 30% 단축\n2. 종이 출력량 연 1만 2천 장 감소\n3. 참여 소상공인 만족도 4.2점 이상\n\n각 지표 아래에 측정 방법을 한 줄씩 붙였습니다.'],
  ['담당 조직 표에 연락처 열을 추가해 주세요.',
    '담당 조직 표 오른쪽에 연락처 열을 추가했습니다. 칸은 비워 두었습니다.\n\n표가 본문 폭을 넘지 않도록 역할 열을 조금 좁혔습니다. 열 너비 비율은 3:3:2:2입니다.'],
  ['제목 글꼴을 본문과 어울리게 바꿔 주세요.',
    '장 제목 다섯 개의 글꼴을 본문과 같은 계열의 굵은 글꼴로 바꿨어요.\n\n크기는 16pt로 맞추고, 제목 위 간격은 12pt, 아래 간격은 6pt로 정리했습니다. 개요 번호 스타일은 그대로 유지됩니다.'],
  ['문단 간격이 들쭉날쭉한 곳을 찾아 정리해 주세요.',
    '본문 문단 중 아홉 곳의 문단 뒤 간격이 0pt, 4pt, 10pt로 섞여 있었습니다. 모두 6pt로 맞췄습니다.\n\n표 바로 앞뒤 문단은 표와 붙어 보이지 않도록 8pt를 남겼습니다. 줄 간격은 160%로 이미 일정했습니다.'],
  ['맞춤법과 띄어쓰기를 한 번 검토해 주세요.',
    '띄어쓰기 열네 곳과 맞춤법 세 곳을 고쳤습니다.\n\n"추진할수 있도록"을 "추진할 수 있도록"으로, "되요"를 "돼요"로 바꾸는 등의 수정입니다. 고유명사와 사업명은 원문 표기를 그대로 두었습니다.\n\n바뀐 곳은 변경 검토에서 하나씩 확인하실 수 있습니다.'],
  ['사업 개요 끝에 한 줄 요약 상자를 넣어 주세요.',
    '사업 개요 마지막 문단 뒤에 테두리가 있는 한 줄 표를 넣고 요약 문장을 적었습니다.\n\n"소상공인 문서 업무를 1년 안에 디지털로 전환하고, 그 효과를 세 가지 지표로 확인합니다." 배경은 옅은 회색으로 두었습니다.'],
  ['쪽 번호를 아래 가운데에 넣어 주세요.',
    '모든 쪽 아래 가운데에 쪽 번호를 넣었습니다. 표지 쪽에는 번호가 보이지 않습니다.\n\n번호 형식은 "- 1 -"이고, 본문보다 1pt 작은 글자로 설정했습니다.'],
  ['표지에 제출 기관과 날짜를 넣어 주세요.',
    '표지 제목 아래에 제출 기관과 제출 날짜를 두 줄로 넣었습니다.\n\n제출 기관은 "희망스튜디오", 날짜는 "2027년 3월"로 적었습니다. 정확한 제출일이 정해지면 알려 주세요.'],
  ['추진 일정 표 아래에 범례를 달아 주세요.',
    '추진 일정 표 바로 아래에 범례 문단을 넣었습니다.\n\n색이 칠해진 칸은 진행 기간, 굵은 테두리 칸은 중간 점검 시점을 뜻합니다. 범례 글자는 본문보다 작게 했습니다.'],
  ['전체 분량이 몇 쪽인지 확인하고 10쪽 안으로 줄일 수 있을지 봐 주세요.',
    '지금 문서는 11쪽입니다. 추진 배경의 중복 문단 두 개를 합치고 표 여백을 줄이면 10쪽 안에 들어갑니다.\n\n내용을 빼지 않고 줄이는 방법이라 의미는 바뀌지 않습니다. 진행해도 될지 알려 주세요.'],
  ['그렇게 줄여 주세요. 마지막으로 전체를 한 번 훑어봐 주세요.',
    '중복 문단을 합치고 표 여백을 줄여 문서를 10쪽으로 맞췄습니다.\n\n마지막으로 훑어본 결과 제목 번호, 표 머리글, 쪽 번호, 문체가 모두 일정합니다. 남은 일은 추진 배경의 통계 문장과 담당 조직 표의 연락처 칸입니다.'],
];

export function longSampleChat(now: number): ChatThread {
  const activityAt = now - 30_000;
  const messages: ChatThread['messages'] = LONG_CHAT_TURNS.flatMap(([request, reply]) => [
    { role: 'user' as const, text: request },
    { role: 'assistant' as const, text: reply, agent: 'claude' as const },
  ]);
  return {
    id: SAMPLE_LONG_CHAT_ID,
    title: '사업 제안서 전체 다듬기',
    titleRequested: true,
    createdAt: activityAt - 2 * HOUR,
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
    messages,
  };
}

/** Seeded chat that `taste=sample` opens: one turn and its Rau-0.1 divider. */
export const SAMPLE_TASTE_CHAT_ID = 'preview-chat-taste';
/** The hub turn id of that chat's turn — a live `taste-learned` for it lands after the turn. */
export const SAMPLE_TASTE_TURN_ID = 'preview-taste-turn';

/**
 * `taste=sample`: a 사업 제안서 chat whose turn taught four notes (sample data) — two added
 * (one already reverted), one changed that has since been edited again (no longer revertible)
 * and one removed. The run also drafted an AGENTS.md line (`preview-taste-draft`).
 */
export function sampleTasteChat(now: number): ChatThread {
  const activityAt = now - 20_000;
  const startedAt = activityAt - 48_000;
  const items: T.TasteLearnItem[] = [
    { op: 'add', entryId: 'mem_taste000001', text: '본문은 한다체 사용', origin: 'learned' },
    { op: 'add', entryId: 'mem_taste000002', text: '표 제목 칸은 굵게', origin: 'learned' },
    { op: 'update', entryId: 'mem_taste000003', text: "'고객' 대신 '이용자'로 통일", prevText: "'고객' 대신 '사용자'로 통일", origin: 'learned' },
    { op: 'remove', entryId: 'mem_taste000004', text: '예산표는 월별로 나눔', origin: 'explicit' },
  ];
  return {
    id: SAMPLE_TASTE_CHAT_ID,
    title: '추진 배경 문체 맞추기',
    titleRequested: true,
    createdAt: startedAt - 60_000,
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
      { role: 'user', text: '추진 배경을 한다체로 바꾸고 예산표는 분기별로 나눠 주세요.', agent: 'claude' },
      {
        role: 'system', kind: 'turn', messageId: `${SAMPLE_TASTE_CHAT_ID}-turn-1`, startedAt, endedAt: activityAt,
        outcome: 'completed', hubTurnId: SAMPLE_TASTE_TURN_ID, text: '작업 48초, 문단 3개 수정',
      },
      {
        role: 'assistant', kind: 'activity', agent: 'claude', activityId: `${SAMPLE_TASTE_CHAT_ID}-activity-1`, text: '도구 호출',
        status: 'completed', startedAt: startedAt + 3_000, completedAt: activityAt - 4_000,
        tools: [
          sampleTool(`${SAMPLE_TASTE_CHAT_ID}-1`, 'replace_range', { sectionIdx: 0, paraIdx: 3, find: '합니다', text: '한다' }, '{"revision":4}'),
          sampleTool(`${SAMPLE_TASTE_CHAT_ID}-2`, 'replace_range', { sectionIdx: 0, paraIdx: 4, find: '됩니다', text: '된다' }, '{"revision":5}'),
        ],
      },
      { role: 'assistant', text: '추진 배경 세 문단을 한다체로 바꿨어요. 예산표는 분기별 네 칸으로 나눴습니다.', agent: 'claude' },
      {
        role: 'system', kind: 'marker', marker: 'taste', learnId: 'learn_preview1', turnId: SAMPLE_TASTE_TURN_ID,
        documentId: 'preview-proposal', key: 'mem-preview-proposal', items,
        changes: items.map((item) => ({ op: item.op, entryId: item.entryId })),
        undone: ['mem_taste000002'], stale: ['mem_taste000003'], proposalDraftId: 'preview-taste-draft', text: '',
      },
    ],
  };
}
