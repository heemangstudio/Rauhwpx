/**
 * 엔진이 멈춰 중단한 채팅의 표시 — 이 함수 하나만 부른다.
 *
 * 지금은 대체 구현이다: 채팅 기록 끝에 시스템 안내를 남긴다. S3(채팅 중단 표시)가 들어오면 본문을
 * `markThreadInterrupted(threadId, 'engine-trap')`(문서 엔진 멈춤 · 이어서 진행)로 바꾸고
 * appendThreadSystemNotice 를 지운다.
 *
 * 복구가 문서를 다시 열기 전에 부른다. 채팅은 문서와 함께 저장소에서 다시 열리므로 표시가 함께 보인다.
 */
import { appendThreadSystemNotice, waitForThreadsPersistence } from '../agent/threads.ts';

export const ENGINE_TRAP_INTERRUPTED_NOTICE =
  '문서 엔진이 멈춰 이 작업이 중단되었습니다. 문서는 복구본으로 다시 열었습니다.';

export async function markThreadInterruptedByEngineTrap(threadId: string): Promise<void> {
  // 저장소를 다 읽기 전에 덧붙이면 읽어 온 기록이 이 줄을 덮는다.
  await waitForThreadsPersistence();
  appendThreadSystemNotice(threadId, ENGINE_TRAP_INTERRUPTED_NOTICE);
}
