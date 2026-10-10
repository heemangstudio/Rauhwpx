/**
 * 엔진이 멈춰 중단한 채팅의 표시 — 이 함수 하나만 부른다.
 *
 * 그 채팅의 마지막 턴을 '문서 엔진 멈춤'으로 끊긴 턴으로 남긴다(S3): 열면 멈춘 자리에
 * "문서 엔진이 멈춰 작업이 중단됐어요"와 이어서 진행이 보이고, 대기 메시지는 그 이유로 붙잡힌다.
 * 부팅 정리가 먼저 '새로고침'으로 정착했어도 아직 아무도 이어 가지 않았으면 이 이유가 이긴다.
 *
 * 복구가 문서를 다시 열기 전에 부른다. 채팅은 문서와 함께 저장소에서 다시 열리므로 표시가 함께 보인다.
 * 그 채팅을 이미 연 사이드바가 있으면 저장소 대신 그 사이드바에 맡긴다 — 사이드바는 다음 저장 때
 * 자기 사본으로 저장소를 덮는다.
 */
import { waitForThreadsPersistence } from '../agent/threads.ts';
import { markThreadInterrupted, type TurnInterruptionReason } from '../agent/turn-interruption.ts';

/** 그 채팅을 지금 보여 주는 사이드바(AgentSidebarHandle 의 일부). */
export interface InterruptibleChat {
  markInterrupted(reason: TurnInterruptionReason): boolean;
}

export async function markThreadInterruptedByEngineTrap(
  threadId: string,
  openIn?: (threadId: string) => InterruptibleChat | null,
): Promise<void> {
  // 저장소를 다 읽기 전에 고치면 읽어 온 기록이 이 표시를 덮는다.
  await waitForThreadsPersistence();
  const shown = openIn?.(threadId) ?? null;
  if (shown?.markInterrupted('engine-trap')) return;
  markThreadInterrupted(threadId, 'engine-trap');
}
