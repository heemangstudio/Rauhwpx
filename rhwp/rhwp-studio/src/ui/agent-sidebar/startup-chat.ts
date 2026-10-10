/**
 * 새로고침·앱 시작 뒤 사이드바가 처음 띄울 채팅을 고른다.
 *
 * 창의 허브 세션은 새로고침을 넘어 살아 있다. 그래서 사이드바는 스레드 저장소가 준비되고
 * 허브의 첫 답(welcome)을 반영한 뒤에 고른다 — 허브가 그 창의 채팅을 아직 돌리고 있으면
 * 그 채팅을 다시 시작하지 않고 그대로 잇는다(adopt).
 *
 * 순수 함수다. S3 의 시작 정리(중단된 턴 기록)도 같은 결정을 받아 쓴다.
 */
import type { HubChat } from '../../agent/bridge.ts';
import { threadMatchesDocument, type ChatThread } from '../../agent/threads.ts';

/**
 * 허브의 첫 답을 기다리는 상한. 새로고침이면 허브가 이미 떠 있어 수십 ms 안에 답한다. 허브를 새로
 * 띄우는 중이면 이을 세션도 없으니, 이보다 늦어지면 예전처럼 마지막 채팅을 복원한다.
 */
export const STARTUP_HUB_ANSWER_TIMEOUT_MS = 5_000;

export type StartupChatDecision =
  /** 허브의 살아 있는 세션이 이 화면 문서의 채팅이다 — 멈추거나 다시 시작하지 않고 잇는다. */
  | { kind: 'adopt'; threadId: string; live: HubChat }
  /**
   * 살아 있는 턴(또는 질문·계획 승인 대기)의 문서가 아직 열리지 않았다. 그 문서가 열리면
   * 문서 전환이 잇고, 다른 문서가 열리면 새 채팅이 그 턴을 끝낸다.
   */
  | { kind: 'await-document'; live: HubChat }
  /**
   * 마지막 채팅을 복원한다(없으면 threadId 는 null). stopLive 는 다른 문서의 살아 있는 턴으로,
   * 화면에 없는 문서를 고칠 수 없으니 복원 전에 끝낸다.
   */
  | { kind: 'restore'; threadId: string | null; stopLive: HubChat | null };

export interface StartupChatInput {
  /** bridge.getHubChat() — 허브의 첫 답을 반영한 뒤의 값. */
  live: HubChat | null;
  getThread(id: string): ChatThread | null;
  /** 최근 대화 순서의 저장된 채팅(listThreads()). */
  threads: readonly ChatThread[];
  documentId: string | null;
  docKey: string | null;
}

/** 살아 있는 세션이 사용자를 기다리게 하거나 일하는 중인가 — 그렇지 않은 유휴 세션은 버려도 잃을 게 없다. */
export function hubChatBusy(live: HubChat | null): boolean {
  return Boolean(live && (live.running || live.awaitingUser));
}

export function decideStartupChat(input: StartupChatInput): StartupChatDecision {
  const { live, documentId, docKey } = input;
  const liveThread = live ? input.getThread(live.threadId) : null;
  if (live && liveThread && threadMatchesDocument(liveThread, documentId, docKey)) {
    return { kind: 'adopt', threadId: liveThread.id, live };
  }
  const busy = hubChatBusy(live);
  // 문서가 아직 없다(데스크톱 실행 파일·자동 저장 복원이 곧 연다) — 그 문서를 기다린다.
  if (live && busy && documentId === null && docKey === null) return { kind: 'await-document', live };
  const restored = input.threads.find((thread) => threadMatchesDocument(thread, documentId, docKey)) ?? null;
  return { kind: 'restore', threadId: restored?.id ?? null, stopLive: live && busy ? live : null };
}
