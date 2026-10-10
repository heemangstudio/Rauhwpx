/**
 * 한 턴이 어떻게 끝났는지 — 턴 접힘(U4)과 채팅 목록 알림(U3)이 같은 규칙을 쓴다.
 *
 * - completed: 끝까지 갔다. max_tokens 처럼 모르는 종료 이유도 여기다 — 표시용 분류다.
 * - interrupted: 사용자가 멈췄거나, 바깥(허브 재시작·새로고침 복구)이 턴을 끊었다.
 * - failed: 오류로 끝났다.
 *
 * 편집 검토 규칙(bridge.ts 의 turnEndDisposition)과는 따로다 — 그쪽은 성공을 좁게 본다.
 */
export type TurnOutcome = 'completed' | 'interrupted' | 'failed';

export const TURN_OUTCOMES: readonly TurnOutcome[] = Object.freeze(['completed', 'interrupted', 'failed']);

export function isTurnOutcome(value: unknown): value is TurnOutcome {
  return value === 'completed' || value === 'interrupted' || value === 'failed';
}

/** turn-end 이벤트에서 결과를 가르는 필드만. */
export interface TurnEndFacts {
  stopReason?: unknown;
  errorMessage?: unknown;
}

export interface TurnOutcomeContext {
  /** 턴이 도는 동안 'error' 이벤트(또는 같은 뜻의 턴 실패 알림)를 받았는가 */
  errorSeen: boolean;
  /**
   * 바깥이 턴을 끊은 이유 — 허브 재시작, 새로고침 뒤 복구처럼 사용자가 멈추지 않았는데
   * 끊긴 턴이다. 있으면 다른 신호보다 앞서 중단으로 본다. 값의 이름은 넘기는 쪽 몫이다.
   */
  interruptionReason?: string | null;
}

export function turnOutcomeFor(event: TurnEndFacts, ctx: TurnOutcomeContext = { errorSeen: false }): TurnOutcome {
  if (typeof ctx.interruptionReason === 'string' && ctx.interruptionReason.length > 0) return 'interrupted';
  if (event.stopReason === 'interrupted') return 'interrupted';
  const errorMessage = typeof event.errorMessage === 'string' && event.errorMessage.trim().length > 0;
  if (errorMessage || ctx.errorSeen || event.stopReason === 'failed' || event.stopReason === 'exited') return 'failed';
  return 'completed';
}
