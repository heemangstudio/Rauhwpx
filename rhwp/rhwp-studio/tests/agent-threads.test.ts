import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addCompactionMarker,
  addHandoffMarker,
  archivePendingUserQuestion,
  captureTurnWatermark,
  clearPendingUserQuestion,
  createPendingUserQuestionDraftSnapshot,
  createEmptyThread,
  createUserQuestionHistoryMessage,
  expirePendingUserQuestion,
  fallbackTitle,
  forgetDocumentThreads,
  getThread,
  explorerGroupIsCurrent,
  listThreads,
  listThreadsByDocument,
  forgetProviderSession,
  pendingUserQuestionMatchesInteraction,
  providerStartContext,
  recordDocumentOpened,
  rememberProviderSession,
  serializeThreadMessagesForProviderHistory,
  setThreadTitle,
  setTurnOutcome,
  subscribeThreadChanges,
  threadMatchesDocument,
  upsertThread,
} from '../src/agent/threads.ts';
import type { ChatThread, ThreadMessage, ThreadToolRecord } from '../src/agent/threads.ts';
import type {
  AgentName,
  StructuredPlan,
  UserQuestionInteraction,
  UserQuestionOutcome,
} from '../src/agent/types.ts';

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
});

function userQuestionInteraction(overrides: Partial<UserQuestionInteraction> = {}): UserQuestionInteraction {
  return {
    interactionId: 'interaction-1',
    providerRequestId: 'provider-request-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    agent: 'codex',
    source: 'native',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    questions: [
      {
        id: 'format',
        header: 'Format',
        question: 'Which format should I use?',
        mode: 'multiple',
        options: [
          { id: 'table', label: 'Table', description: 'Use a compact table.' },
          { id: 'list', label: 'List', description: 'Use a short list.' },
        ],
        allowOther: true,
      },
    ],
    ...overrides,
  };
}

test('empty threads are not listed until they have messages', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  upsertThread(t);
  assert.equal(listThreads().length, 0);
  t.messages.push({ role: 'user', text: '표 제목을 고쳐줘' });
  upsertThread(t);
  assert.equal(listThreads().length, 1);
  assert.equal(listThreads()[0]!.id, t.id);
});

test('thread persistence notifies the current window without changing the synchronous API', () => {
  mem.clear();
  let changes = 0;
  const unsubscribe = subscribeThreadChanges(() => {
    changes += 1;
  });
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  thread.messages.push({ role: 'user', text: 'notify' });
  upsertThread(thread);
  unsubscribe();

  assert.equal(changes, 1);
  assert.equal(listThreads()[0]?.id, thread.id);
});

test('fallbackTitle uses the first user message', () => {
  assert.equal(
    fallbackTitle([{ role: 'user', text: '  안녕하세요 문서 요약  ' }]),
    '안녕하세요 문서 요약',
  );
});

test('fallbackTitle preserves a structured skill-only invocation', () => {
  assert.equal(
    fallbackTitle([{ role: 'user', text: '', skillName: 'summarize-document' }]),
    '/summarize-document',
  );
  assert.equal(
    fallbackTitle([{ role: 'user', text: '표만 대상으로', skillName: 'summarize-document' }]),
    '/summarize-document 표만 대상으로',
  );
});

test('skill invocation icon survives thread persistence', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  t.messages.push({
    role: 'user',
    text: '',
    skillName: 'my-skill',
    skillIcon: 'pencil',
  });
  upsertThread(t);
  assert.equal(getThread(t.id)?.messages[0]?.skillIcon, 'pencil');

  const raw = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
  const messages = raw[0]?.messages as Array<Record<string, unknown>>;
  messages[0]!.skillIcon = 'invalid';
  mem.set('rhwp-agent-threads', JSON.stringify(raw));
  assert.equal(getThread(t.id)?.messages[0]?.skillIcon, undefined);
});

test('mixed document selection context survives thread persistence', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' });
  const items = [
    {
      kind: 'table' as const,
      address: { sectionIdx: 0, paraIdx: 2, controlIdx: 1 },
      rowCount: 2,
      colCount: 2,
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, text: '표 셀' }],
      truncated: false,
    },
    {
      kind: 'equation' as const,
      address: {
        sectionIdx: 0,
        paraIdx: 2,
        controlIdx: 1,
        cellPath: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }],
        innerControlIdx: 3,
      },
      script: 'x^2',
      attachmentName: 'equation.png',
    },
    {
      kind: 'object' as const,
      objectType: 'image',
      address: { sectionIdx: 0, paraIdx: 4, controlIdx: 0 },
      description: '도표',
      width: 320,
      height: 180,
      attachmentName: 'image.png',
    },
  ];
  t.messages.push({
    role: 'user',
    text: '이 요소들을 정리해줘',
    selection: {
      label: '표 1개 · 수식 1개 · 이미지 1개',
      excerpt: '표 셀 · x^2 · 도표',
      items,
      documentId: 'doc-1',
      revision: 7,
    },
  });
  upsertThread(t);

  assert.deepEqual(getThread(t.id)?.messages[0]?.selection, t.messages[0]?.selection);
});

test('setThreadTitle updates a persisted thread', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  t.messages.push({ role: 'user', text: 'hello' });
  upsertThread(t);
  setThreadTitle(t.id, '"문서 요약 요청"');
  assert.equal(getThread(t.id)?.title, '문서 요약 요청');
});

test('progress milestones survive thread persistence', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  t.messages.push(
    { role: 'user', text: '문서를 정리해줘' },
    { role: 'assistant', text: '문서 구조를 확인했습니다. 이제 표를 정리합니다.', agent: 'claude', kind: 'progress' },
  );
  upsertThread(t);
  assert.equal(getThread(t.id)?.messages[1]?.kind, 'progress');
});

test('clickable plan presentations keep their plan identity in thread history', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan' });
  t.messages.push(
    { role: 'user', text: '계획을 세워줘' },
    { role: 'assistant', text: '문서 정리 계획', agent: 'codex', kind: 'plan', planId: 'plan-1' },
  );
  upsertThread(t);
  assert.equal(getThread(t.id)?.messages[1]?.kind, 'plan');
  assert.equal(getThread(t.id)?.messages[1]?.planId, 'plan-1');
});

test('pending user-question drafts persist selections, custom text, position, and update time', () => {
  mem.clear();
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  thread.messages.push({ role: 'user', text: 'Choose the output format.' });
  const interaction = userQuestionInteraction({ threadId: thread.id });
  const pending = createPendingUserQuestionDraftSnapshot(interaction, 1234);
  pending.selectedOptionIdsByQuestionId.format = ['list', 'table'];
  pending.otherTextByQuestionId.format = 'Keep it compact.';
  pending.activeQuestionIndex = 0;
  thread.pendingUserQuestion = pending;
  upsertThread(thread);

  const restored = getThread(thread.id)?.pendingUserQuestion;
  assert.deepEqual(restored?.selectedOptionIdsByQuestionId.format, ['table', 'list']);
  assert.equal(restored?.otherTextByQuestionId.format, 'Keep it compact.');
  assert.equal(restored?.activeQuestionIndex, 0);
  assert.equal(restored?.updatedAt, 1234);
  assert.deepEqual(restored?.interaction, interaction);
});

test('stored user-question drafts normalize legacy fields and discard mismatched or archived requests', () => {
  mem.clear();
  const interaction = userQuestionInteraction({ threadId: 'legacy-question-thread' });
  const history = createUserQuestionHistoryMessage(interaction, {
    status: 'expired',
    reason: 'hub-restarted',
  });
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy-question-thread',
    title: 'Question history',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    messages: [{ role: 'user', text: 'Choose.' }, history],
    pendingUserQuestion: {
      interaction,
      selectedOptionIdsByQuestionId: { format: ['unknown', 'list', 'table'] },
      otherTextByQuestionId: { format: 'Draft' },
      activeQuestionIndex: 99,
      updatedAt: 5,
    },
  }, {
    id: 'mismatched-question-thread',
    title: 'Mismatched question',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    messages: [{ role: 'user', text: 'Choose.' }],
    pendingUserQuestion: {
      interaction,
      selectedOptionIdsByQuestionId: {},
      otherTextByQuestionId: {},
      activeQuestionIndex: 0,
      updatedAt: 5,
    },
  }, {
    id: 'legacy-draft-thread',
    title: 'Legacy question draft',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    messages: [{ role: 'user', text: 'Choose.' }],
    pendingUserQuestion: {
      interaction: {
        ...interaction,
        threadId: 'legacy-draft-thread',
        questions: [{
          id: 'legacy-format',
          question: 'Choose legacy formats.',
          multiSelect: true,
          options: [
            { label: 'Table', description: 'A table.' },
            { label: 'List', description: 'A list.' },
          ],
        }],
      },
      selectedOptionIdsByQuestionId: { 'legacy-format': ['unknown', 'List', 'Table'] },
      otherTextByQuestionId: { 'legacy-format': 'Legacy custom answer.' },
      activeQuestionIndex: 99,
      updatedAt: 6,
    },
  }]));

  assert.equal(getThread('legacy-question-thread')?.pendingUserQuestion, undefined);
  assert.equal(getThread('mismatched-question-thread')?.pendingUserQuestion, undefined);
  const legacyDraft = getThread('legacy-draft-thread')?.pendingUserQuestion;
  assert.equal(legacyDraft?.interaction.questions[0]?.header, 'Question 1');
  assert.equal(legacyDraft?.interaction.questions[0]?.mode, 'multiple');
  assert.equal(legacyDraft?.interaction.questions[0]?.allowOther, true);
  assert.deepEqual(legacyDraft?.interaction.questions[0]?.options.map((option) => option.id), [
    'Table',
    'List',
  ]);
  assert.deepEqual(legacyDraft?.selectedOptionIdsByQuestionId['legacy-format'], ['Table', 'List']);
  assert.equal(legacyDraft?.otherTextByQuestionId['legacy-format'], 'Legacy custom answer.');
  assert.equal(legacyDraft?.activeQuestionIndex, 0);
});

test('completed user-question history owns an immutable copy of its request and answers', () => {
  mem.clear();
  const interaction = userQuestionInteraction();
  const outcome: UserQuestionOutcome = {
    status: 'answered',
    answers: {
      format: { selectedOptionIds: ['table'], otherText: 'Use narrow columns.' },
    },
  };
  const message = createUserQuestionHistoryMessage(interaction, outcome);
  interaction.questions[0]!.question = 'Mutated question';
  if (outcome.status === 'answered') outcome.answers.format!.otherText = 'Mutated answer';

  assert.equal(message.interaction.questions[0]?.question, 'Which format should I use?');
  assert.equal(
    message.outcome.status === 'answered' ? message.outcome.answers.format?.otherText : undefined,
    'Use narrow columns.',
  );
  assert.doesNotMatch(message.text, /Use narrow columns/);

  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  thread.id = interaction.threadId;
  thread.messages.push({ role: 'user', text: 'Choose.' }, message);
  upsertThread(thread);
  const restored = getThread(thread.id)?.messages.at(-1);
  assert.equal(restored?.kind, 'user-question');
  assert.equal(
    restored?.kind === 'user-question' && restored.outcome.status === 'answered'
      ? restored.outcome.answers.format?.otherText
      : undefined,
    'Use narrow columns.',
  );
});

test('pending user-question completion is interaction-scoped and archives expiry once', () => {
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const interaction = userQuestionInteraction({ threadId: thread.id });
  thread.pendingUserQuestion = createPendingUserQuestionDraftSnapshot(interaction, 1);

  assert.equal(pendingUserQuestionMatchesInteraction(thread.pendingUserQuestion, interaction), true);
  assert.equal(pendingUserQuestionMatchesInteraction(
    thread.pendingUserQuestion,
    { ...interaction, providerRequestId: 'replacement-request' },
  ), false);
  assert.equal(archivePendingUserQuestion(
    thread,
    'stale-interaction',
    { status: 'cancelled', reason: 'user-stop' },
  ), null);
  assert.equal(thread.pendingUserQuestion?.interaction.interactionId, interaction.interactionId);
  const archived = expirePendingUserQuestion(thread, 'provider-disconnected');
  assert.equal(archived?.outcome.status, 'expired');
  assert.equal(thread.pendingUserQuestion, undefined);
  assert.equal(thread.messages.at(-1), archived);
  assert.equal(expirePendingUserQuestion(thread, 'provider-disconnected'), null);

  thread.pendingUserQuestion = createPendingUserQuestionDraftSnapshot(interaction, 2);
  assert.equal(clearPendingUserQuestion(thread, 'stale-interaction'), null);
  assert.equal(clearPendingUserQuestion(thread, interaction.interactionId)?.updatedAt, 2);
  assert.equal(thread.pendingUserQuestion, undefined);
});

test('user-question provider history is deterministic and follows question option order', () => {
  const interaction = userQuestionInteraction();
  const message = createUserQuestionHistoryMessage(interaction, {
    status: 'answered',
    answers: {
      format: { selectedOptionIds: ['list', 'table'], otherText: 'Keep captions.' },
    },
  });
  const messages = [
    { role: 'user' as const, text: 'Prepare the report.', skillName: 'report-format' },
    { role: 'assistant' as const, text: 'Checking.', kind: 'progress' as const },
    message,
  ];
  const first = serializeThreadMessagesForProviderHistory(messages);
  const second = serializeThreadMessagesForProviderHistory(messages);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((entry) => [entry.role, entry.kind]), [
    ['user', 'message'], ['assistant', 'progress'], ['assistant', 'question'], ['user', 'answer'],
  ]);
  assert.equal(first[0]?.text, '/report-format Prepare the report.');
  assert.match(first[2]?.text ?? '', /^<user_question_request>/);
  assert.match(first[3]?.text ?? '', /^<user_question_response>/);
  assert.deepEqual([first[3]?.agent, first[3]?.id], ['codex', interaction.interactionId]);
  assert.ok((first[3]?.text ?? '').indexOf('"id":"table"')
    < (first[3]?.text ?? '').indexOf('"id":"list"'));
  assert.match(first[3]?.text ?? '', /Keep captions\./);
});

test('user-question history counts toward the existing 200-message persistence cap', () => {
  mem.clear();
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  for (let index = 0; index < 200; index += 1) {
    thread.messages.push({ role: 'user', text: `message-${index}` });
  }
  const interaction = userQuestionInteraction({ threadId: thread.id });
  thread.messages.push(createUserQuestionHistoryMessage(interaction, {
    status: 'cancelled',
    reason: 'user-stop',
  }));
  upsertThread(thread);

  const restored = getThread(thread.id);
  assert.equal(restored?.messages.length, 200);
  assert.equal(restored?.messages[0]?.text, 'message-1');
  assert.equal(restored?.messages.at(-1)?.kind, 'user-question');
});

test('persisted Pi chats remain available after reload', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'pi-thread',
    title: 'Pi 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'pi',
    model: 'openrouter/test-model',
    effort: 'medium',
    messages: [{ role: 'user', text: '기존 Pi 메시지' }],
  }]));
  assert.equal(getThread('pi-thread')?.agent, 'pi');
});

test('persisted OpenCode chats are dropped because opencode is not a live agent', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'opencode-thread',
    title: 'OpenCode 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'opencode',
    model: 'anthropic/claude-sonnet-4-5',
    effort: '',
    messages: [{ role: 'assistant', text: 'OpenCode 답변', agent: 'opencode' }],
  }]));
  assert.equal(getThread('opencode-thread'), null);
});

test('legacy threads default to the standard service tier', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy-fast',
    title: '이전 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    messages: [{ role: 'user', text: '안녕' }],
  }]));
  assert.equal(getThread('legacy-fast')?.serviceTier, 'standard');
});

test('Codex Fast service tier survives thread persistence', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium', serviceTier: 'fast',
  });
  t.messages.push({ role: 'user', text: '빠르게' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.serviceTier, 'fast');
});

test('legacy threads migrate to direct workflow', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy',
    title: '이전 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'claude',
    model: 'sonnet',
    effort: 'high',
    messages: [{ role: 'user', text: '기존 메시지' }],
  }]));
  assert.equal(getThread('legacy')?.workflow, 'direct');
});

test('past chats match their active document by stable ID with a legacy filename fallback', () => {
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'old-name.hwpx' },
    'doc-a',
    'new-name.hwpx',
  ), true);
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    'doc-b',
    'report.hwpx',
  ), false);
  assert.equal(threadMatchesDocument(
    { documentId: null, docKey: '보고서.HWPX' },
    'doc-a',
    '보고서.hwpx',
  ), true);
  assert.equal(threadMatchesDocument(
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    null,
    'report.hwpx',
  ), false);
});

test('explorer current badge does not follow a unique filename when the group is identified', () => {
  const groups = [
    { documentId: 'doc-a', docKey: 'report.hwpx' },
    { documentId: 'doc-b', docKey: 'other.hwpx' },
  ];
  assert.equal(
    explorerGroupIsCurrent(groups[0]!, 'fresh-id', 'report.hwpx', groups),
    false,
  );
  assert.equal(
    explorerGroupIsCurrent(groups[1]!, 'fresh-id', 'report.hwpx', groups),
    false,
  );
  assert.equal(
    explorerGroupIsCurrent(groups[0]!, 'doc-a', 'renamed.hwpx', groups),
    true,
  );
});

test('legacy explorer groups still use the unique filename bridge', () => {
  const legacy = [{ documentId: null, docKey: 'report.hwpx' }];
  assert.equal(
    explorerGroupIsCurrent(legacy[0]!, 'fresh-id', 'report.hwpx', legacy),
    true,
  );
});

test('threads keep their document key and legacy threads fall back to null', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwpx',
  });
  t.messages.push({ role: 'user', text: '표 정리해줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.docKey, '보고서.hwpx');

  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'legacy',
    title: '이전 대화',
    titleRequested: false,
    createdAt: 1,
    updatedAt: 2,
    agent: 'claude',
    model: 'sonnet',
    effort: 'high',
    messages: [{ role: 'user', text: '기존 메시지' }],
  }]));
  assert.equal(getThread('legacy')?.docKey, null);
});

test('threads persist only stable document reference identity, never reference blobs', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    docKey: '보고서.hwpx',
    documentId: 'doc-stable-1',
  });
  t.messages.push({ role: 'user', text: '첨부한 자료로 고쳐줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.documentId, 'doc-stable-1');
  const raw = mem.get('rhwp-agent-threads') ?? '';
  assert.doesNotMatch(raw, /base64|arrayBuffer|blob:/i);

  const stored = JSON.parse(raw) as Array<Record<string, unknown>>;
  delete stored[0]!.documentId;
  mem.set('rhwp-agent-threads', JSON.stringify(stored));
  assert.equal(getThread(t.id)?.documentId, null);
});

test('user message attachment metadata persists without file bytes', () => {
  mem.clear();
  const t = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  t.messages.push({
    role: 'user',
    text: '이 파일을 참고해줘',
    messageId: 'message-1',
    attachments: [{
      stageId: 'stage-1',
      fileId: 'file-1',
      name: '보고서.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      status: 'ready',
    }],
  });
  upsertThread(t);
  const message = getThread(t.id)?.messages[0];
  assert.equal(message?.messageId, 'message-1');
  assert.deepEqual(message?.attachments?.[0], {
    stageId: 'stage-1',
    fileId: 'file-1',
    name: '보고서.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    status: 'ready',
  });
  assert.doesNotMatch(mem.get('rhwp-agent-threads') ?? '', /data:application\/pdf|base64/i);
});

test('threads persist only the active template stable id', () => {
  mem.clear();
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', activeTemplateId: 'template-stable-id',
  });
  t.messages.push({ role: 'user', text: '이 템플릿으로 정리해줘' });
  upsertThread(t);
  assert.equal(getThread(t.id)?.activeTemplateId, 'template-stable-id');
  const raw = mem.get('rhwp-agent-threads') ?? '';
  assert.doesNotMatch(raw, /contentHash|arrayBuffer|base64|blob:/i);
});

test('listThreadsByDocument groups by document, groups ordered by recent activity', () => {
  mem.clear();
  const mk = (docKey: string | null, text: string, updatedAt: number) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    // upsertThread 가 updatedAt 을 지금으로 찍으므로 저장본을 직접 되감는다.
    const stored = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
    stored.find((s) => s.id === t.id)!.updatedAt = updatedAt;
    mem.set('rhwp-agent-threads', JSON.stringify(stored));
    return t;
  };
  mk('a.hwpx', 'a 첫 채팅', 10);
  mk('b.hwpx', 'b 채팅', 30);
  mk('a.hwpx', 'a 최근 채팅', 20);
  mk(null, '문서 없는 채팅', 5);

  const groups = listThreadsByDocument();
  assert.deepEqual(groups.map((g) => g.docKey), ['b.hwpx', 'a.hwpx', null]);
  assert.deepEqual(
    groups[1]!.threads.map((t) => t.messages[0]!.text),
    ['a 최근 채팅', 'a 첫 채팅'],
  );
});

test('document groups hold last-opened order; only reopening a document moves it up', () => {
  mem.clear();
  const mk = (docKey: string, documentId: string, text: string) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey, documentId });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    return t;
  };
  // a → b 순서로 문서를 열었다: b 가 위.
  recordDocumentOpened('doc-a', 'a.hwpx');
  recordDocumentOpened('doc-b', 'b.hwpx');
  const staleA = mk('a.hwpx', 'doc-a', 'a 채팅');
  mk('b.hwpx', 'doc-b', 'b 채팅');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['b.hwpx', 'a.hwpx']);

  // a 의 옛 채팅이 다시 움직여도(updatedAt 갱신) 그룹 순서는 그대로다.
  upsertThread(staleA);
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['b.hwpx', 'a.hwpx']);

  // a 문서를 다시 열어야만 맨 위로 올라온다.
  recordDocumentOpened('doc-a', 'a.hwpx');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['a.hwpx', 'b.hwpx']);

  // 기록이 없는 문서(레거시)는 기록된 그룹 뒤에 최근 활동 순서로 남는다.
  mk('c.hwpx', 'doc-c', 'c 채팅');
  assert.deepEqual(listThreadsByDocument().map((g) => g.docKey), ['a.hwpx', 'b.hwpx', 'c.hwpx']);
});

test('listThreadsByDocument splits same filenames when documentId differs', () => {
  mem.clear();
  const left = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwp', documentId: 'doc-a',
  });
  left.messages.push({ role: 'user', text: '왼쪽' });
  upsertThread(left);
  const right = createEmptyThread({
    agent: 'claude', model: 'sonnet', effort: 'high', docKey: '보고서.hwp', documentId: 'doc-b',
  });
  right.messages.push({ role: 'user', text: '오른쪽' });
  upsertThread(right);

  const groups = listThreadsByDocument();
  assert.equal(groups.length, 2);
  assert.deepEqual(new Set(groups.map((g) => g.documentId)), new Set(['doc-a', 'doc-b']));
  assert.ok(groups.every((g) => g.docKey === '보고서.hwp'));
});

test('forgetDocumentThreads removes only that document group and its open-order record', () => {
  mem.clear();
  const mk = (docKey: string | null, documentId: string | null, text: string) => {
    const t = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', docKey, documentId });
    t.messages.push({ role: 'user', text });
    upsertThread(t);
    return t;
  };
  recordDocumentOpened('doc-a', 'a.hwpx');
  recordDocumentOpened('doc-b', 'b.hwpx');
  const gone = mk('a.hwpx', 'doc-a', 'a 채팅 1');
  mk('a.hwpx', 'doc-a', 'a 채팅 2');
  const legacy = mk('a.hwpx', null, '레거시 a 채팅');
  const kept = mk('b.hwpx', 'doc-b', 'b 채팅');

  // ID 그룹만 지운다 — 같은 파일명의 레거시 그룹과 다른 문서는 남는다.
  const removed = forgetDocumentThreads('doc-a', 'a.hwpx');
  assert.equal(removed.length, 2);
  assert.ok(removed.includes(gone.id));
  assert.equal(getThread(gone.id), null);
  assert.deepEqual(new Set(listThreads().map((t) => t.id)), new Set([legacy.id, kept.id]));
  const orderAfterId = JSON.parse(mem.get('rhwp-agent-doc-order') ?? '[]') as string[];
  assert.ok(!orderAfterId.includes('id:doc-a'));
  assert.ok(orderAfterId.includes('name:a.hwpx'));

  // 레거시(파일명뿐인) 그룹을 지우면 이름 기록도 함께 사라진다.
  forgetDocumentThreads(null, 'a.hwpx');
  assert.equal(getThread(legacy.id), null);
  assert.deepEqual(listThreads().map((t) => t.id), [kept.id]);
  const orderAfterName = JSON.parse(mem.get('rhwp-agent-doc-order') ?? '[]') as string[];
  assert.ok(!orderAfterName.includes('name:a.hwpx'));
  assert.ok(orderAfterName.includes('id:doc-b'));
});

test('workflow and every presented plan persist as history without approval authority', () => {
  mem.clear();
  const plan: StructuredPlan = {
    planId: 'plan-1',
    title: '문서 정리',
    goal: '문서 구조 개선',
    summary: '제목과 본문을 정리한다.',
    assumptions: ['원문 의미 유지'],
    decisions: ['제목 체계 통일'],
    steps: [{ title: '제목 수정', details: '제목 스타일을 통일한다.', files: ['report.hwpx'] }],
    files: ['report.hwpx'],
    validation: ['렌더 확인'],
    risks: ['페이지 재배치'],
    exclusions: ['내용 재작성'],
    createdAt: '2026-08-07T00:00:00.000Z',
    epoch: 7,
  };
  const previousPlan: StructuredPlan = { ...plan, planId: 'plan-0', title: '이전 문서 정리' };
  const t = createEmptyThread({
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', workflow: 'plan',
  });
  t.latestPlan = plan;
  t.plans = [previousPlan, plan];
  t.messages.push(
    { role: 'user', text: '계획을 세워줘' },
    { role: 'assistant', text: previousPlan.title, kind: 'plan', planId: previousPlan.planId },
    { role: 'assistant', text: plan.title, kind: 'plan', planId: plan.planId, planState: 'executed' },
  );
  upsertThread(t);

  const restored = getThread(t.id);
  assert.equal(restored?.workflow, 'plan');
  assert.deepEqual(restored?.latestPlan, plan);
  assert.deepEqual(restored?.plans, [previousPlan, plan]);
  assert.equal(restored?.messages[2]?.kind, 'plan');
  assert.equal(restored?.messages[2]?.kind === 'plan' ? restored.messages[2].planState : undefined, 'executed');
  const stored = JSON.parse(mem.get('rhwp-agent-threads') ?? '[]') as Array<Record<string, unknown>>;
  assert.equal('phase' in stored[0]!, false);
  assert.equal('capabilityEpoch' in stored[0]!, false);
  assert.equal('approved' in stored[0]!, false);
});


test('same-millisecond thread updates keep the later state newer', (t) => {
  mem.clear();
  t.mock.method(Date, 'now', () => 2000);
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', docKey: 'report.hwpx' });
  thread.messages.push({ role: 'user', text: 'Continue the edit.' });
  thread.title = '첫 제목';
  upsertThread(thread);
  const first = getThread(thread.id)!;
  thread.title = '바뀐 제목';
  upsertThread(thread);
  const second = getThread(thread.id)!;
  assert.ok(second.updatedAt > first.updatedAt);
  assert.equal(second.title, '바뀐 제목');
});

// ─── 프로바이더 넘겨받기 · 압축 ─────────────────────────

function mixedProviderThread() {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.messages.push(
    { role: 'user', text: '표를 정리해줘', agent: 'claude' },
    { role: 'assistant', text: '표를 정리했습니다.', agent: 'claude' },
  );
  addHandoffMarker(thread, 'codex');
  thread.messages.push(
    { role: 'user', text: '제목을 다듬어줘', agent: 'codex' },
    { role: 'system', text: 'MCP 서버 연결 실패: timeout', agent: 'codex' },
    { role: 'assistant', text: '제목을 다듬었습니다.', agent: 'codex' },
  );
  return thread;
}

test('a legacy cursor without a watermark resumes after the provider\'s own last message', () => {
  const thread = mixedProviderThread();
  rememberProviderSession(thread, 'claude', 'claude-native-1', 10);
  const context = providerStartContext(thread, 'claude');
  assert.equal(context.providerSessionId, 'claude-native-1');
  assert.deepEqual(context.handoffHistory, [
    { role: 'user', kind: 'message', text: '제목을 다듬어줘', agent: 'codex' },
    { role: 'assistant', kind: 'message', text: '제목을 다듬었습니다.', agent: 'codex' },
  ]);
  // 재개에 실패하면 허브가 쓰는 전체 대화 — 구분선과 시스템 줄은 프로바이더에게 가지 않는다.
  assert.deepEqual(context.history.map((entry) => entry.text),
    ['표를 정리해줘', '표를 정리했습니다.', '제목을 다듬어줘', '제목을 다듬었습니다.']);
});

test('a provider without a cursor, or whose messages are gone, gets the full transcript only', () => {
  const thread = mixedProviderThread();
  assert.deepEqual(Object.keys(providerStartContext(thread, 'codex')), ['history']);
  // 커서는 있지만 이 대화에 Pi 의 메시지가 없다 — 다른 채팅의 세션일 수 있으므로 보내지 않는다.
  rememberProviderSession(thread, 'pi', 'pi-native');
  assert.deepEqual(Object.keys(providerStartContext(thread, 'pi')), ['history']);
  rememberProviderSession(thread, 'codex', 'codex-native');
  assert.deepEqual(providerStartContext(thread, 'codex').handoffHistory, []);
  forgetProviderSession(thread, 'codex');
  assert.equal(providerStartContext(thread, 'codex').providerSessionId, undefined);
});

test('undelivered messages are left out of the start context so the queued send is not duplicated', () => {
  const thread = mixedProviderThread();
  rememberProviderSession(thread, 'codex', 'codex-native');
  const queued = { role: 'user' as const, text: '다음 쪽도', agent: 'codex' as const };
  thread.messages.push(queued);
  const context = providerStartContext(thread, 'codex', new Set([queued]));
  assert.deepEqual(context.handoffHistory, []);
  assert.equal(context.history.at(-1)?.text, '제목을 다듬었습니다.');
});

test('handoff markers appear only when the next message goes to a different provider', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  assert.equal(addHandoffMarker(thread, 'codex'), null, '빈 채팅에는 남기지 않는다');
  thread.messages.push({ role: 'user', text: 'a', agent: 'claude' }, { role: 'system', text: '알림', agent: 'codex' });
  assert.equal(addHandoffMarker(thread, 'claude'), null, '시스템 줄은 프로바이더 참여로 치지 않는다');
  const marker = addHandoffMarker(thread, 'codex');
  assert.deepEqual(marker && { from: marker.marker === 'handoff' && marker.from, to: marker.marker === 'handoff' && marker.to },
    { from: 'claude', to: 'codex' });
});

test('compaction markers are idempotent by compaction id', () => {
  const thread = mixedProviderThread();
  const first = addCompactionMarker(thread, { compactionId: 'c-1', trigger: 'auto', beforeTokens: 182_000, afterTokens: 41_000 });
  assert.ok(first);
  assert.equal(addCompactionMarker(thread, { compactionId: 'c-1', trigger: 'auto' }), null);
  assert.ok(addCompactionMarker(thread, { compactionId: 'c-2', trigger: 'manual' }));
  assert.equal(thread.messages.filter((message) => message.kind === 'marker' && message.marker === 'compaction').length, 2);
});

test('markers, provider cursors, and context usage survive persistence and the message cap', () => {
  mem.clear();
  const thread = mixedProviderThread();
  for (let index = 0; index < 195; index += 1) thread.messages.push({ role: 'user', text: `m-${index}`, agent: 'codex' });
  addCompactionMarker(thread, { compactionId: 'c-9', trigger: 'manual', beforeTokens: 150_000, afterTokens: 30_000 });
  rememberProviderSession(thread, 'claude', 'claude-native', 5);
  thread.contextUsage = { agent: 'codex', usedTokens: 30_000, maxTokens: 258_000, updatedAt: 6 };
  upsertThread(thread);
  const restored = getThread(thread.id)!;
  assert.equal(restored.messages.length, 200);
  assert.deepEqual(restored.messages.at(-1), {
    role: 'system', kind: 'marker', marker: 'compaction', compactionId: 'c-9', trigger: 'manual',
    text: '', beforeTokens: 150_000, afterTokens: 30_000,
  });
  assert.deepEqual(restored.providerSessions, { claude: { sessionId: 'claude-native', updatedAt: 5 } });
  assert.deepEqual(restored.contextUsage, { agent: 'codex', usedTokens: 30_000, maxTokens: 258_000, updatedAt: 6 });
  // 앞쪽 Claude 메시지는 잘려 나갔다 — 커서가 남아 있어도 전체 대화로 시작한다.
  assert.equal(providerStartContext(restored, 'claude').providerSessionId, undefined);
});

test('malformed stored markers and cursors are dropped instead of crashing the thread', () => {
  mem.clear();
  storage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'stored-markers', title: 't', titleRequested: true, createdAt: 1, updatedAt: 2,
    agent: 'claude', model: 'sonnet', effort: 'high',
    providerSessions: { claude: { sessionId: '' }, codex: { sessionId: 'ok', updatedAt: 3 }, nope: { sessionId: 'x' } },
    contextUsage: { agent: 'claude', usedTokens: -1 },
    messages: [
      { role: 'user', text: 'hi', agent: 'claude' },
      { role: 'system', kind: 'marker', marker: 'handoff', from: 'claude', to: 'opencode', text: '' },
      { role: 'assistant', kind: 'marker', marker: 'compaction', compactionId: 'x', trigger: 'auto', text: '' },
      { role: 'system', kind: 'marker', marker: 'handoff', from: 'claude', to: 'codex', text: '' },
    ],
  }]));
  const restored = getThread('stored-markers')!;
  assert.deepEqual(restored.messages.map((message) => message.kind ?? message.role), ['user', 'marker']);
  assert.deepEqual(restored.providerSessions, { codex: { sessionId: 'ok', updatedAt: 3 } });
  assert.equal(restored.contextUsage, undefined);
});

// ─── 워터마크 넘겨받기 · 풍부한 대화 항목 ───────────────

/** 사이드바 흐름 그대로: 메시지 기록 → turn-start 워터마크 → 출력 → turn-end. */
function runTurn(
  thread: ChatThread,
  agent: AgentName,
  userText: string,
  output: ThreadMessage[],
  end: { sessionId: string } | { outcome: 'interrupted' | 'failed' },
) {
  thread.messages.push({ role: 'user', text: userText, agent, messageId: `msg-${thread.messages.length}` });
  const captured = captureTurnWatermark(thread, agent);
  thread.messages.push(...output);
  if ('sessionId' in end) {
    setTurnOutcome(thread, captured!.messageId, null);
    rememberProviderSession(thread, agent, end.sessionId, 1, captured?.messageId);
  } else {
    setTurnOutcome(thread, captured!.messageId, end.outcome);
  }
}

test('claude → codex → claude: the resumed provider gets only what it missed, without its own output', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  runTurn(thread, 'claude', '표를 정리해줘', [
    { role: 'assistant', kind: 'progress', text: '표를 읽습니다.', agent: 'claude' },
    { role: 'assistant', kind: 'activity', activityId: 'a-1', status: 'completed', startedAt: 0, completedAt: 1, tools: [], agent: 'claude' },
    { role: 'assistant', text: '표를 정리했습니다.', agent: 'claude' },
  ], { sessionId: 'claude-1' });
  addHandoffMarker(thread, 'codex');
  runTurn(thread, 'codex', '제목을 다듬어줘', [
    { role: 'assistant', text: '제목을 다듬었습니다.', agent: 'codex' },
  ], { sessionId: 'codex-1' });
  addHandoffMarker(thread, 'claude');

  const back = providerStartContext(thread, 'claude');
  assert.equal(back.providerSessionId, 'claude-1');
  assert.deepEqual(back.handoffHistory?.map((entry) => [entry.role, entry.agent, entry.text]), [
    ['user', 'codex', '제목을 다듬어줘'],
    ['assistant', 'codex', '제목을 다듬었습니다.'],
  ]);
  // Codex 는 자기 답 뒤로 넘어온 것이 없다 — 구분선은 건너뛴다.
  assert.deepEqual(providerStartContext(thread, 'codex').handoffHistory, []);
});

test('a failed turn leaves the watermark behind, so its message and partial output are sent again', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  runTurn(thread, 'claude', '첫 요청', [{ role: 'assistant', text: '첫 답', agent: 'claude' }], { sessionId: 'claude-1' });
  runTurn(thread, 'claude', '둘째 요청', [
    { role: 'assistant', kind: 'progress', text: '둘째를 읽는 중', agent: 'claude' },
    { role: 'system', text: '오류: overloaded', agent: 'claude', severity: 'error' },
    { role: 'system', text: '모드를 바꿨습니다', agent: 'claude' },
  ], { outcome: 'failed' });
  assert.equal(thread.providerSessions?.claude?.seenThroughMessageId, 'msg-0');

  const context = providerStartContext(thread, 'claude');
  assert.equal(context.providerSessionId, 'claude-1');
  assert.deepEqual(context.handoffHistory?.map((entry) => [entry.kind, entry.text]), [
    ['message', '둘째 요청'],
    ['progress', '둘째를 읽는 중'],
    ['error', '오류: overloaded'],
    ['interrupted', 'Turn failed before completion.'],
  ]);

  // 다시 보내 성공하면 표시가 지워지고 워터마크가 그 메시지로 옮겨 간다.
  const retried = captureTurnWatermark(thread, 'claude')!;
  assert.equal(retried.messageId, 'msg-2');
  setTurnOutcome(thread, retried.messageId, null);
  rememberProviderSession(thread, 'claude', 'claude-1', 2, retried.messageId);
  thread.messages.push({ role: 'assistant', text: '둘째 답', agent: 'claude' });
  assert.deepEqual(providerStartContext(thread, 'claude').handoffHistory, []);
  assert.equal(providerStartContext(thread, 'codex').history.some((entry) => entry.kind === 'interrupted'), false);
});

test('an interrupted turn is reported after that turn, before the next request', () => {
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  runTurn(thread, 'codex', 'a', [{ role: 'assistant', kind: 'progress', text: '진행', agent: 'codex' }], { outcome: 'interrupted' });
  runTurn(thread, 'codex', 'b', [{ role: 'assistant', text: '답', agent: 'codex' }], { sessionId: 'codex-1' });
  assert.deepEqual(providerStartContext(thread, 'claude').history.map((entry) => entry.kind), [
    'message', 'progress', 'interrupted', 'message', 'message',
  ]);
});

test('turn-start capture skips queued messages and other providers, and ids legacy messages', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  const legacy: ThreadMessage = { role: 'user', text: '예전 메시지', agent: 'claude' };
  const queued: ThreadMessage = { role: 'user', text: '대기 중', agent: 'claude', messageId: 'msg-queued' };
  thread.messages.push(legacy, { role: 'user', text: 'Codex 에게', agent: 'codex', messageId: 'msg-codex' }, queued);
  const captured = captureTurnWatermark(thread, 'claude', new Set([queued]));
  assert.equal(captured?.assigned, true);
  assert.match(captured?.messageId ?? '', /^msg-/);
  assert.equal(legacy.messageId, captured?.messageId);
  assert.equal(captureTurnWatermark(thread, 'pi'), null);
});

test('a turn without a captured message keeps the watermark only on the same native session', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  runTurn(thread, 'claude', '요청', [{ role: 'assistant', text: '답', agent: 'claude' }], { sessionId: 'claude-1' });
  // 수동 압축 턴: 같은 세션, 워터마크 없음 → 그대로.
  rememberProviderSession(thread, 'claude', 'claude-1', 2);
  assert.equal(thread.providerSessions?.claude?.seenThroughMessageId, 'msg-0');
  // 다른 세션이 생겼는데 어떤 메시지까지 봤는지 모른다 → 예전 규칙(자기 마지막 메시지 뒤)으로.
  rememberProviderSession(thread, 'claude', 'claude-2', 3);
  assert.equal(thread.providerSessions?.claude?.seenThroughMessageId, undefined);
  assert.equal(providerStartContext(thread, 'claude').providerSessionId, 'claude-2');
});

test('the start context carries the provider window and, with a cursor, the resumed session usage', () => {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.contextUsage = { agent: 'claude', usedTokens: 90_000, maxTokens: 200_000, updatedAt: 1 };
  assert.deepEqual(providerStartContext(thread, 'claude').providerContextUsage, { maxTokens: 200_000 });
  assert.equal(providerStartContext(thread, 'codex').providerContextUsage, undefined);
  runTurn(thread, 'claude', '요청', [{ role: 'assistant', text: '답', agent: 'claude' }], { sessionId: 'claude-1' });
  assert.deepEqual(providerStartContext(thread, 'claude').providerContextUsage, { usedTokens: 90_000, maxTokens: 200_000 });
  // 다른 프로바이더의 사용량은 이 세션의 사용량이 아니다 — 창 크기만 커서에서 이어 간다.
  thread.contextUsage = { agent: 'codex', usedTokens: 10_000, maxTokens: 258_400, updatedAt: 2 };
  rememberProviderSession(thread, 'claude', 'claude-1', 3, 'msg-0');
  assert.deepEqual(providerStartContext(thread, 'claude').providerContextUsage, { maxTokens: 200_000 });
});

test('tools, tasks, plans and errors become bounded labeled entries; notices and markers do not', () => {
  const plan: StructuredPlan = {
    planId: 'plan-9', title: '보고서 정리', goal: '읽기 쉬운 보고서', summary: '제목을 맞춘다.',
    assumptions: [], decisions: [], steps: [{ title: '제목 통일' }], files: [], validation: [],
    risks: [], exclusions: [], createdAt: '2026-10-09T00:00:00.000Z', epoch: 1,
  };
  const tool = (index: number, overrides: Partial<ThreadToolRecord> = {}): ThreadToolRecord => ({
    callId: `call-${index}`, tool: 'mcp__rhwp__replace_text', argsJson: '{}', status: 'completed',
    resultPreview: `원본 결과 ${index} ${'가'.repeat(400)}`, elapsedMs: 5, ...overrides,
  });
  const thread = createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  thread.plans = [plan];
  thread.messages.push(
    { role: 'user', text: '정리해줘', agent: 'codex', messageId: 'msg-1' },
    { role: 'assistant', kind: 'plan', planId: 'plan-9', text: '보고서 정리', agent: 'codex' },
    {
      role: 'assistant', kind: 'activity', activityId: 'act-1', status: 'stopped', startedAt: 0, completedAt: 1, agent: 'codex',
      tools: [
        tool(0, { outcome: { ok: true, text: '3곳 바꿈', notices: [] } }),
        tool(1, { status: 'failed', resultPreview: 'REVISION_MISMATCH' }),
        ...Array.from({ length: 18 }, (_, index) => tool(index + 2)),
      ],
    },
    {
      role: 'assistant', kind: 'tasks', taskGroupId: 'tg-1', status: 'completed', agent: 'codex',
      tasks: [{
        taskId: 't-1', taskKind: 'agent', title: '표 검토', role: 'reviewer', workflowName: '', status: 'completed',
        activity: '', summary: '표 3개 확인', totalTokens: null, toolUses: null, durationMs: null, tools: [],
      }],
    },
    { role: 'system', text: '계획 카드를 만드는 중', agent: 'codex' },
    { role: 'system', text: '오류 (AGENT_SPAWN_FAILED): codex', agent: 'codex', severity: 'error' },
  );
  addCompactionMarker(thread, { compactionId: 'c-1', trigger: 'auto' });

  const entries = providerStartContext(thread, 'claude').history;
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.id]), [
    ['message', 'msg-1'], ['plan', 'plan-9'], ['tools', 'act-1'], ['tasks', 'tg-1'], ['error', undefined],
  ]);
  assert.match(entries[1]!.text, /^# 보고서 정리\n\n읽기 쉬운 보고서\n\n[\s\S]*제목 통일/);

  const lines = entries[2]!.text.split('\n');
  assert.ok(entries[2]!.text.length <= 2_000);
  assert.equal(lines[0], 'replace_text · ok · 3곳 바꿈', '저장된 결과 줄이 미리보기보다 앞선다');
  assert.equal(lines[1], 'replace_text · failed · REVISION_MISMATCH');
  const shown = lines.filter((line) => line.startsWith('replace_text'));
  assert.ok(shown.length <= 12);
  assert.ok(shown.every((line) => line.length <= 'replace_text · ok · '.length + 160));
  assert.equal(lines.at(-2), `(+${20 - shown.length} more)`);
  assert.equal(lines.at(-1), 'interrupted');
  assert.equal(entries[3]!.text, '표 검토 · completed · 표 3개 확인');
});

test('watermarks, turn outcomes and error tags survive persistence; a trimmed watermark falls back to full history', () => {
  mem.clear();
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.contextUsage = { agent: 'claude', usedTokens: 50_000, maxTokens: 200_000, updatedAt: 1 };
  runTurn(thread, 'claude', '처음', [{ role: 'assistant', text: '답', agent: 'claude' }], { sessionId: 'claude-1' });
  runTurn(thread, 'claude', '두 번째', [{ role: 'system', text: 'boom', agent: 'claude', severity: 'error' }], { outcome: 'interrupted' });
  upsertThread(thread);
  const restored = getThread(thread.id)!;
  assert.deepEqual(restored.providerSessions?.claude, {
    sessionId: 'claude-1', updatedAt: 1, seenThroughMessageId: 'msg-0', usedTokens: 50_000, maxTokens: 200_000,
  });
  assert.equal(restored.messages[2]?.turnOutcome, 'interrupted');
  assert.equal(restored.messages[3]?.severity, 'error');
  assert.deepEqual(providerStartContext(restored, 'claude').handoffHistory?.map((entry) => entry.kind),
    ['message', 'error', 'interrupted']);

  // 200개 상한이 워터마크 메시지를 잘라 내면 커서를 쓰지 않는다.
  for (let index = 0; index < 200; index += 1) restored.messages.push({ role: 'user', text: `m-${index}`, agent: 'codex' });
  upsertThread(restored);
  const trimmed = getThread(thread.id)!;
  const context = providerStartContext(trimmed, 'claude');
  assert.equal(context.providerSessionId, undefined);
  assert.equal(context.handoffHistory, undefined);
  assert.equal(context.history.length, 200);
  assert.deepEqual(context.providerContextUsage, { maxTokens: 200_000 });
});
