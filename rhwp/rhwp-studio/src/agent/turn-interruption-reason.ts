/**
 * 바깥이 턴을 끊은 이유와 그 문구 — 채팅 기록(threads.ts)·대기열(follow-ups.ts)·중단 표시
 * (turn-interruption.ts)가 함께 쓰는 잎 모듈이다. 다른 모듈을 들여오지 않는다.
 *
 * - hub-restart: 에이전트 허브 프로세스가 바뀌었다(재시작·충돌).
 * - app-restart: 데스크톱 앱이 다시 시작됐다.
 * - reload: 페이지를 새로 고쳤다(그 페이지의 채팅 세션은 함께 닫힌다).
 * - agent-exit: 허브는 그대로인데 이 채팅의 세션이 사라졌다.
 * - engine-trap: 문서 엔진이 멈춰 문서를 복구본으로 다시 열었다(S7).
 */
export type TurnInterruptionReason = 'hub-restart' | 'app-restart' | 'reload' | 'agent-exit' | 'engine-trap';

export const TURN_INTERRUPTION_REASONS: readonly TurnInterruptionReason[] = Object.freeze([
  'hub-restart', 'app-restart', 'reload', 'agent-exit', 'engine-trap',
]);

export function isTurnInterruptionReason(value: unknown): value is TurnInterruptionReason {
  return typeof value === 'string' && (TURN_INTERRUPTION_REASONS as readonly string[]).includes(value);
}

/** 짧은 이유 — 질문 카드(만료됨 · …), 대기열 붙잡음 줄의 머리말. */
export const INTERRUPTION_LABEL: Readonly<Record<TurnInterruptionReason, string>> = Object.freeze({
  'hub-restart': '허브 재시작',
  'app-restart': '앱 재시작',
  reload: '새로고침',
  'agent-exit': '에이전트 프로세스 종료',
  'engine-trap': '문서 엔진 멈춤',
});

/** 끊긴 자리에 남는 한 줄. */
export const INTERRUPTION_NOTICE: Readonly<Record<TurnInterruptionReason, string>> = Object.freeze({
  'hub-restart': '에이전트 허브가 다시 시작되어 작업이 중단됐어요',
  'app-restart': '앱이 다시 시작되어 작업이 중단됐어요',
  reload: '페이지를 새로 고쳐 작업이 중단됐어요',
  'agent-exit': '에이전트 프로세스가 끝나 작업이 중단됐어요',
  'engine-trap': '문서 엔진이 멈춰 작업이 중단됐어요',
});

/** 에이전트에게 보내는 이어 가기 블록의 원인 문장(영어, 모델이 읽는다). */
export const INTERRUPTION_CAUSE: Readonly<Record<TurnInterruptionReason, string>> = Object.freeze({
  'hub-restart': 'the Rauhwpx agent hub restarted',
  'app-restart': 'the Rauhwpx app was restarted',
  reload: "the user's editor page was reloaded",
  'agent-exit': 'your agent session ended unexpectedly',
  'engine-trap': 'the document engine stopped and the document was reopened from a recovery copy',
});

/**
 * 연결된 허브가 이 채팅의 세션이 없다고 답했다(welcome {session:null}). 허브 프로세스가 그대로면
 * 이 채팅의 세션만 사라졌고(에이전트 프로세스 종료), 바뀌었거나 모르면(옛 허브) 허브 재시작이다.
 */
export function lostSessionReason(
  previousHubInstanceId: string | null | undefined,
  hubInstanceId: string | null | undefined,
): 'hub-restart' | 'agent-exit' {
  return previousHubInstanceId && hubInstanceId && previousHubInstanceId === hubInstanceId ? 'agent-exit' : 'hub-restart';
}
