import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadMessage, ThreadToolRecord, ThreadTurnMessage } from '../src/agent/threads.ts';
import { turnOutcomeFor } from '../src/agent/turn-outcome.ts';
import { formatFleetClock } from '../src/ui/agent-sidebar/subagent-fleet.ts';
import { PRESENTED_TOOL_NAMES } from '../src/ui/agent-sidebar/tool-presentation.ts';
import {
  TURN_CHECK_DOCUMENT_TEXT,
  TURN_SUMMARY_IGNORED_TOOLS,
  formatTurnDuration,
  keepsFinalMilestone,
  planTurnFolds,
  settledTurnText,
  summarizeTurnWork,
  turnFoldLabel,
  turnWorkFor,
  type TurnWorkTool,
} from '../src/ui/agent-sidebar/turn-fold.ts';

const { TOOL_DEFINITIONS } = await import('../../rhwp-agent/tools.mjs') as { TOOL_DEFINITIONS: Array<{ name: string }> };

let callSeq = 0;
function call(tool: string, args: Record<string, unknown>, status: TurnWorkTool['status'] = 'completed'): TurnWorkTool {
  callSeq += 1;
  return { callId: `call-${callSeq}`, tool: `mcp__rhwp__${tool}`, argsJson: JSON.stringify(args), status };
}

function record(tool: string, args: Record<string, unknown>, status: ThreadToolRecord['status'] = 'completed'): ThreadToolRecord {
  const { callId, tool: name, argsJson } = call(tool, args, status);
  return { callId, tool: name, argsJson, status, resultPreview: '', elapsedMs: 10 };
}

function summary(tools: TurnWorkTool[], tasks: Array<{ taskKind: 'agent' | 'workflow'; status: string }> = []) {
  return summarizeTurnWork({ tools, tasks });
}

function marker(id: string, startedAt: number, endedAt: number | null, outcome: ThreadTurnMessage['outcome']): ThreadTurnMessage {
  return { role: 'system', kind: 'turn', messageId: id, startedAt, endedAt, outcome, text: '' };
}

function activity(id: string, tools: ThreadToolRecord[]): ThreadMessage {
  return {
    role: 'assistant',
    kind: 'activity',
    activityId: id,
    text: '도구 호출',
    status: tools.some((tool) => tool.status === 'failed') ? 'failed' : 'completed',
    startedAt: 1_000,
    completedAt: 2_000,
    tools,
  };
}

const user = (text: string): ThreadMessage => ({ role: 'user', text });
const answer = (text: string): ThreadMessage => ({ role: 'assistant', text });
const progress = (text: string): ThreadMessage => ({ role: 'assistant', text, kind: 'progress' });
const systemLine = (text: string): ThreadMessage => ({ role: 'system', text });

/** 계획 결과를 읽기 좋게: 메시지 순번 → 'flow' 또는 접힘 id. */
function placements(messages: ThreadMessage[]) {
  const plan = planTurnFolds(messages);
  return {
    plan,
    where: plan.placement.map((fold) => (fold === null ? 'flow' : plan.folds[fold].id)),
  };
}

test('같은 문단을 여러 번 고쳐도 한 문단으로 센다', () => {
  const result = summary([
    call('replace_range', { sectionIdx: 0, paraIdx: 3, find: '가', text: '나' }),
    call('replace_range', { sectionIdx: 0, paraIdx: 3, find: '다', text: '라' }),
    call('replace_range', { sectionIdx: 0, paraIdx: 7, find: '마', text: '바' }),
  ]);
  assert.deepEqual(result.parts, ['문단 2개 수정']);
  assert.equal(result.errors, 0);
});

test('실패한 호출은 한 일로 세지 않고 오류로만, 멈춘 호출은 어디에도 세지 않는다', () => {
  const result = summary([
    call('create_table', { sectionIdx: 0, paraIdx: 2, charOffset: 0, rows: 2, cols: 2 }, 'failed'),
    call('insert_image', { sectionIdx: 0, paraIdx: 4, charOffset: 0 }, 'stopped'),
    call('get_document_info', {}),
  ]);
  assert.deepEqual(result.allParts, ['문서 읽음']);
  assert.equal(result.errors, 1);
});

test('분류가 많아도 머리에는 두 개만, 편집이 읽기보다 앞선다', () => {
  const result = summary([
    call('get_page_geometry', { pageIndex: 0 }),
    call('get_page_geometry', { pageIndex: 1 }),
    call('get_page_geometry', { pageIndex: 2 }),
    call('find_text', { query: '일정' }),
    call('render_page', { pageIndex: 0 }),
    call('commit_version', { message: '저장' }),
    call('apply_para_format', { sectionIdx: 0, paraIdx: 1, alignment: 'center' }),
  ]);
  assert.equal(result.parts.length, 2);
  assert.deepEqual(result.parts, ['문단 1개 수정', '쪽 1개 확인']);
  assert.ok(result.allParts.indexOf('문단 1개 수정') < result.allParts.indexOf('쪽 3개 읽음'));
  assert.equal(result.allParts.length, 5);
});

test('서브에이전트의 편집도 문서 분류에 들어가고 서브에이전트 수가 붙는다', () => {
  const messages: ThreadMessage[] = [
    user('표를 고쳐 주세요'),
    marker('turn-1', 0, 30_000, 'completed'),
    {
      role: 'assistant',
      kind: 'tasks',
      taskGroupId: 'tasks-1',
      text: '서브에이전트와 워크플로',
      status: 'completed',
      tasks: [
        {
          taskId: 't1', taskKind: 'agent', title: '표 정리', role: '', workflowName: '', status: 'completed',
          activity: '', summary: '', totalTokens: null, toolUses: null, durationMs: null,
          tools: [record('edit_table', { sectionIdx: 0, paraIdx: 5, controlIdx: 0, op: 'insert_row', rowIdx: 1 })],
        },
        {
          taskId: 't2', taskKind: 'agent', title: '문장 검토', role: '', workflowName: '', status: 'completed',
          activity: '', summary: '', totalTokens: null, toolUses: null, durationMs: null,
          tools: [],
        },
      ],
    },
    answer('표에 행을 추가했습니다.'),
  ];
  const work = turnWorkFor(messages, messages[1] as ThreadTurnMessage);
  assert.deepEqual(summarizeTurnWork(work).parts, ['표 1개 수정', '서브에이전트 2개']);
});

test('셀 안의 글 편집은 그 표의 편집으로 센다', () => {
  const result = summary([
    call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '가', cell: { paraIdx: 9, controlIdx: 0, cellIdx: 2 } }),
    call('replace_range', { sectionIdx: 0, paraIdx: 1, find: '나', text: '다', cell: { paraIdx: 9, controlIdx: 0, cellIdx: 5 } }),
    call('set_cell_props', { sectionIdx: 0, paraIdx: 9, controlIdx: 0, cellIdx: 1, cellProps: { fillColor: '#fff' } }),
  ]);
  assert.deepEqual(result.parts, ['표 1개 수정']);
});

test('묶음 편집은 항목별로 세고, 실패한 묶음은 통째로 오류 하나다', () => {
  const batch = {
    expectedRevision: 3,
    edits: [
      { tool: 'replace_range', paraIdx: 1, find: '가', text: '나' },
      { tool: 'apply_char_format', args: { paras: [[4, 6]], bold: true } },
      { tool: 'insert_footnote', sectionIdx: 0, paraIdx: 2, charOffset: 0, text: '주석' },
    ],
  };
  const ok = summary([call('apply_edits', batch)]);
  assert.deepEqual(ok.parts, ['문단 4개 수정', '각주 1개 추가']);
  assert.equal(ok.errors, 0);
  const failed = summary([call('apply_edits', batch, 'failed')]);
  assert.deepEqual(failed.parts, []);
  assert.equal(failed.errors, 1);
  const reads = summary([call('read_batch', {
    reads: [
      { tool: 'get_structure', args: { range: { sectionIdx: 0, fromPara: 0, toPara: 9 } } },
      { tool: 'get_table_properties', args: { sectionIdx: 0, paraIdx: 3, controlIdx: 0 } },
    ],
  })]);
  assert.deepEqual(reads.parts, ['문단 10개 읽음', '표 1개 읽음']);
});

test('문단 범위는 펼쳐 세되 호출 하나에 천 문단을 넘지 않는다', () => {
  assert.deepEqual(summary([call('apply_list', { sectionIdx: 0, startParaIdx: 2, endParaIdx: 4, format: '1.' })]).parts, ['문단 3개 수정']);
  assert.deepEqual(summary([call('apply_style', { sectionIdx: 0, paras: [1, [3, 4], 4], styleId: 2 })]).parts, ['문단 3개 수정']);
  assert.deepEqual(summary([call('template_apply_paragraph_format', {
    templateRevision: 1, source: { sectionIdx: 0, paraIdx: 0 }, targets: [{ sectionIdx: 0, paraIdx: 8 }, { sectionIdx: 1, paraIdx: 8 }],
  })]).parts, ['문단 2개 수정']);
  assert.deepEqual(summary([call('get_structure', { range: { sectionIdx: 0, fromPara: 0, toPara: 50_000 } })]).parts, ['문단 1000개 읽음']);
  // 찾는 글만 준 편집은 호출마다 한 문단(위로 잡은 수)이다.
  assert.deepEqual(summary([
    call('replace_range', { find: '가', text: '나' }),
    call('insert_text', { anchor: { text: '다' }, text: '라' }),
  ]).parts, ['문단 2개 수정']);
});

test('허브의 모든 도구는 요약 분류가 있거나 일부러 빠진다 — “도구 N번”으로 새지 않는다', () => {
  const names = [...new Set([...TOOL_DEFINITIONS.map((tool) => tool.name), ...PRESENTED_TOOL_NAMES])];
  for (const name of names) {
    const result = summary([call(name, {})]);
    if (TURN_SUMMARY_IGNORED_TOOLS.has(name)) {
      assert.deepEqual(result.allParts, [], `${name} 은 요약에서 빠진다`);
      continue;
    }
    if (name === 'apply_edits' || name === 'read_batch') continue;
    assert.equal(result.allParts.length, 1, `${name} 은 요약 분류가 있다`);
    assert.doesNotMatch(result.allParts[0], /^도구 /, `${name} 은 문서 쪽 말로 요약된다`);
  }
  assert.deepEqual(summary([{ callId: 'x', tool: 'Bash', argsJson: '{"command":"ls"}', status: 'completed' }]).parts, ['도구 1번']);
});

test('접힘 계획: 작업만 접히고 답변·질문·계획·시스템 줄은 흐름에 남는다', () => {
  const messages: ThreadMessage[] = [
    user('문서를 고쳐 주세요'),
    marker('turn-1', 10_000, 161_000, 'completed'),
    progress('구조를 확인합니다.'),
    activity('a1', [record('get_structure', {}), record('replace_range', { sectionIdx: 0, paraIdx: 0, find: '가', text: '나' })]),
    {
      role: 'assistant', kind: 'user-question', text: '질문',
      interaction: {} as never, outcome: {} as never,
    } as ThreadMessage,
    activity('a2', [record('replace_range', { sectionIdx: 0, paraIdx: 1, find: '다', text: '라' })]),
    systemLine('계획 카드를 만드는 중'),
    { role: 'assistant', kind: 'plan', text: '계획', planId: 'p1' },
    answer('두 문단을 고쳤습니다.'),
  ];
  const { plan, where } = placements(messages);
  assert.deepEqual(where, ['flow', 'flow', 'turn-1', 'turn-1', 'flow', 'turn-1', 'flow', 'flow', 'flow']);
  assert.equal(plan.folds.length, 1);
  assert.equal(plan.folds[0].anchorIndex, 1);
  assert.equal(plan.folds[0].view.title, '작업 2분 31초 · 문단 2개 수정 · 문서 읽음');
  assert.equal(plan.folds[0].view.expandable, true);
});

test('접힘 계획: 사용자 메시지 없이 시작한 계획 승인 턴도 따로 접힌다', () => {
  const messages: ThreadMessage[] = [
    user('계획을 세워 주세요'),
    marker('research', 0, 20_000, 'completed'),
    activity('a1', [record('get_document_info', {})]),
    { role: 'assistant', kind: 'plan', text: '계획', planId: 'p1' },
    marker('implement', 30_000, 90_000, 'completed'),
    activity('a2', [record('create_table', { sectionIdx: 0, paraIdx: 1, charOffset: 0, rows: 2, cols: 2 })]),
    answer('표를 만들었습니다.'),
  ];
  const { plan, where } = placements(messages);
  assert.deepEqual(where, ['flow', 'flow', 'research', 'flow', 'flow', 'implement', 'flow']);
  assert.deepEqual(plan.folds.map((fold) => fold.view.title), ['작업 20초 · 문서 읽음', '작업 1분 · 표 1개 추가']);
});

test('접힘 계획: 표식 없는 옛 대화는 사용자 메시지 경계로 시간 없이 접힌다', () => {
  const messages: ThreadMessage[] = [
    user('첫 요청'),
    progress('확인합니다.'),
    activity('a1', [record('get_table_properties', { sectionIdx: 0, paraIdx: 2, controlIdx: 0 })]),
    answer('첫 답'),
    user('둘째 요청'),
    activity('a2', [record('delete_table', { sectionIdx: 0, paraIdx: 2, controlIdx: 0 })]),
    answer('둘째 답'),
  ];
  const { plan, where } = placements(messages);
  assert.deepEqual(where, ['flow', 'legacy-1', 'legacy-1', 'flow', 'flow', 'legacy-5', 'flow']);
  assert.deepEqual(plan.folds.map((fold) => fold.view.title), ['작업 내역 · 표 1개 읽음', '작업 내역 · 표 1개 삭제']);
  assert.deepEqual(plan.folds.map((fold) => fold.durationMs), [null, null]);
});

test('접힘 계획: 오류로 끝난 턴과 정착 전 턴은 접지 않고, 작업 없는 완료 턴은 줄이 없다', () => {
  const messages: ThreadMessage[] = [
    user('하나'),
    marker('failed', 0, 5_000, 'failed'),
    activity('a1', [record('replace_range', { paraIdx: 0, find: '가', text: '나' })]),
    systemLine('네트워크 오류'),
    user('둘'),
    marker('quiet', 6_000, 7_000, 'completed'),
    answer('작업 없이 답했습니다.'),
    user('셋'),
    marker('running', 8_000, null, null),
    progress('진행 중'),
    activity('a2', [record('get_document_info', {}, 'running')]),
  ];
  const { plan, where } = placements(messages);
  assert.equal(plan.folds.length, 0);
  assert.ok(where.every((entry) => entry === 'flow'));
  assert.deepEqual(plan.unsettled, [8]);
});

test('접힘 계획: 중단된 턴은 작업이 없어도 펼칠 것 없는 한 줄을 남긴다', () => {
  const messages: ThreadMessage[] = [
    user('하나'),
    marker('stopped-empty', 0, 400, 'interrupted'),
    user('둘'),
    marker('stopped', 1_000, 73_000, 'interrupted'),
    activity('a1', [record('create_table', { sectionIdx: 0, paraIdx: 0, charOffset: 0, rows: 3, cols: 3 })]),
  ];
  const { plan } = placements(messages);
  assert.deepEqual(plan.folds.map((fold) => [fold.view.title, fold.view.expandable]), [
    ['중단됨', false],
    ['중단됨 · 1분 12초 · 표 1개 추가', true],
  ]);
});

test('접힘 계획: 보고를 쓰고 도구를 부른 뒤 끝난 턴은 그 보고(마지막 이정표)를 흐름에 남긴다', () => {
  const report = '전체 요약입니다. 세 절을 확인했고 일정표가 비어 있습니다.';
  const turn = marker('turn-1', 0, 40_000, 'completed');
  const messages: ThreadMessage[] = [
    user('문서를 요약해 주세요'),
    turn,
    progress('본문을 읽습니다.'),
    activity('a1', [record('get_text_range', { sectionIdx: 0, startParaIdx: 0, endParaIdx: 2 })]),
    progress(report),
    activity('a2', [record('update_todos', { todos: [] })]),
  ];
  const { plan, where } = placements(messages);
  assert.deepEqual(where, ['flow', 'flow', 'turn-1', 'turn-1', 'flow', 'turn-1']);
  assert.equal(plan.folds[0].view.title, '작업 40초 · 문단 3개 읽음');
  assert.equal(keepsFinalMilestone(messages, turn), true);

  // 편집 턴 끝의 “작업 완료 · 문서 확인” 안내는 답이 아니다 — 보고는 그대로 흐름에 남는다.
  const withNote = [...messages, answer(TURN_CHECK_DOCUMENT_TEXT)];
  assert.deepEqual(placements(withNote).where, ['flow', 'flow', 'turn-1', 'turn-1', 'flow', 'turn-1', 'flow']);

  // 도구 뒤에 최종 답변이 있으면 이정표는 작업 노트라 접힌다.
  const answered = [...messages, answer('요약을 마쳤습니다.')];
  assert.deepEqual(placements(answered).where, ['flow', 'flow', 'turn-1', 'turn-1', 'turn-1', 'turn-1', 'flow']);
  assert.equal(keepsFinalMilestone(answered, turn), false);

  // 표식 없는 옛 대화도 같다.
  const legacy = [messages[0], ...messages.slice(2)];
  assert.deepEqual(placements(legacy).where, ['flow', 'legacy-1', 'legacy-1', 'flow', 'legacy-1']);
});

test('접힘 계획: 보고 하나만 쓰고 끝난 턴은 줄이 없고, 중단된 턴의 이정표는 그대로 접힌다', () => {
  const only = marker('only', 0, 9_000, 'completed');
  const reportOnly: ThreadMessage[] = [user('요약'), only, progress('요약입니다.'), activity('a1', [record('update_todos', { todos: [] })])];
  // 보고 뒤에 할 일 정리만 있었다 — 접힘은 그 도구 하나다.
  assert.deepEqual(placements(reportOnly).where, ['flow', 'flow', 'flow', 'only']);
  const bare: ThreadMessage[] = [user('요약'), only, progress('요약입니다.')];
  assert.deepEqual(placements(bare).plan.folds, []);
  assert.equal(settledTurnText(bare, only, 'completed', 9_000), '');

  const stopped = marker('stopped', 0, 9_000, 'interrupted');
  const interrupted: ThreadMessage[] = [user('요약'), stopped, progress('본문을 읽습니다.'), activity('a1', [record('get_document_info', {})])];
  assert.deepEqual(placements(interrupted).where, ['flow', 'flow', 'stopped', 'stopped']);
  assert.equal(keepsFinalMilestone(interrupted, stopped), false);
});

test('실패한 서브에이전트와 그 안에서 실패한 도구는 오류 하나로 센다', () => {
  const task = (id: string, status: 'completed' | 'failed', tools: ThreadToolRecord[]) => ({
    taskId: id, taskKind: 'agent' as const, title: id, role: '', workflowName: '', status,
    activity: '', summary: '', totalTokens: null, toolUses: null, durationMs: null, tools,
  });
  const tasksMessage = (tasks: ReturnType<typeof task>[]): ThreadMessage => ({
    role: 'assistant', kind: 'tasks', taskGroupId: 'tasks-1', text: '서브에이전트와 워크플로', status: 'failed', tasks,
  });
  const turn = marker('turn-1', 0, 10_000, 'completed');
  const errorsOf = (tasks: ReturnType<typeof task>[]) =>
    summarizeTurnWork(turnWorkFor([user('검토'), turn, tasksMessage(tasks)], turn)).errors;

  assert.equal(errorsOf([task('t1', 'failed', [record('get_text_range', { paraIdx: 0 }, 'failed')])]), 1);
  assert.equal(errorsOf([task('t1', 'failed', [
    record('get_text_range', { paraIdx: 0 }, 'failed'),
    record('find_text', { query: '일정' }, 'failed'),
  ])]), 1);
  // 실패한 도구를 딛고 끝까지 마친 서브에이전트의 실패한 호출은 따로 센다.
  assert.equal(errorsOf([
    task('t1', 'failed', [record('get_text_range', { paraIdx: 0 }, 'failed')]),
    task('t2', 'completed', [record('get_text_range', { paraIdx: 1 }, 'failed')]),
    task('t3', 'failed', []),
  ]), 3);
});

test('정착 때 남기는 제목은 기록에서 같은 규칙으로 만든다', () => {
  const turn = marker('turn-1', 0, null, null);
  const messages: ThreadMessage[] = [
    user('표를 만들어 주세요'),
    turn,
    activity('a1', [record('create_table', { sectionIdx: 0, paraIdx: 0, charOffset: 0, rows: 2, cols: 2 }), record('set_table_props', { sectionIdx: 0, paraIdx: 0, controlIdx: 0, tableProps: {} }, 'failed')]),
    answer('만들었습니다.'),
  ];
  assert.equal(settledTurnText(messages, turn, 'completed', 48_000), '작업 48초 · 표 1개 추가 · 오류 1');
  assert.equal(settledTurnText(messages, turn, 'failed', 48_000), '');
  assert.equal(settledTurnText([user('a'), turn, answer('b')], turn, 'completed', 1_000), '');
});

test('시간은 한 시간 안에서 서브에이전트 시계와 같고, 넘으면 시간 단위로 보인다', () => {
  assert.equal(formatTurnDuration(151_000), formatFleetClock(151_000));
  assert.equal(formatTurnDuration(12_000), '12초');
  assert.equal(formatTurnDuration(3_900_000), '1시간 5분');
  assert.equal(formatTurnDuration(7_200_000), '2시간');
  assert.equal(formatTurnDuration(-5_000), '0초');
  assert.equal(turnFoldLabel({ outcome: 'interrupted', durationMs: 72_000, parts: ['문단 2개 수정'], errors: 0 }), '중단됨 · 1분 12초 · 문단 2개 수정');
});

test('턴 결과: 사용자 중단과 바깥이 끊은 턴은 중단, 오류·비정상 종료는 실패, 모르는 종료는 완료', () => {
  assert.equal(turnOutcomeFor({ stopReason: 'interrupted' }, { errorSeen: false }), 'interrupted');
  assert.equal(turnOutcomeFor({ stopReason: 'exited', errorMessage: '허브 재시작' }, { errorSeen: false, interruptionReason: 'hub-restart' }), 'interrupted');
  assert.equal(turnOutcomeFor({ stopReason: 'exited' }, { errorSeen: false }), 'failed');
  assert.equal(turnOutcomeFor({ stopReason: 'failed' }, { errorSeen: false }), 'failed');
  assert.equal(turnOutcomeFor({ stopReason: 'end_turn', errorMessage: '로그인이 필요합니다' }, { errorSeen: false }), 'failed');
  assert.equal(turnOutcomeFor({ stopReason: 'end_turn' }, { errorSeen: true }), 'failed');
  assert.equal(turnOutcomeFor({ stopReason: 'max_tokens' }, { errorSeen: false }), 'completed');
  assert.equal(turnOutcomeFor({ stopReason: 'completed' }), 'completed');
  // 허브가 분류한 실패(U5)가 실린 턴은 문구가 없어도 실패다. 사용자 중단은 그대로 중단이다.
  const failure = { class: 'usage_limit', agent: 'claude', message: '한도', code: null, retryable: false, resetAt: null };
  assert.equal(turnOutcomeFor({ stopReason: 'max_tokens', failure }, { errorSeen: false }), 'failed');
  assert.equal(turnOutcomeFor({ stopReason: 'interrupted', failure }, { errorSeen: false }), 'interrupted');
});
