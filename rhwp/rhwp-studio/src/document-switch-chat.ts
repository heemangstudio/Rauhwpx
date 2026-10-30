/**
 * 열린 문서 사이를 옮길 때 보일 채팅을 고른다. 순수 함수다.
 *
 * 1. 그 문서에서 일하는 채팅 — 지금 보이는 채팅이 일하면 그것을 그대로 둔다.
 * 2. 그 문서에서 마지막으로 본 채팅이 대화가 있는 채팅이면 그대로 둔다.
 * 3. 아니면(빈 새 채팅) 그 문서의 가장 최근 대화를 연다.
 */
import { threadMatchesDocument, type ThreadSummary } from './agent/threads.ts';

export interface SwitchChat {
  running: boolean;
  threadId: string | null;
}

export type DocumentSwitchChat =
  | { kind: 'keep' }
  | { kind: 'show'; index: number }
  | { kind: 'open-thread'; threadId: string };

export function pickChatForDocument(input: {
  chats: readonly SwitchChat[];
  /** 그 문서 세션에서 마지막으로 보인 채팅의 자리. 없으면 -1. */
  activeIndex: number;
  /** 대화가 있는 채팅, 최근 대화 순(listThreadSummaries()). */
  threads: readonly Pick<ThreadSummary, 'id' | 'documentId' | 'docKey'>[];
  documentId: string | null;
  docKey: string | null;
}): DocumentSwitchChat {
  const active = input.chats[input.activeIndex];
  if (active?.running) return { kind: 'keep' };
  const running = input.chats.findIndex((chat) => chat.running);
  if (running >= 0) return { kind: 'show', index: running };
  if (active?.threadId && input.threads.some((thread) => thread.id === active.threadId)) return { kind: 'keep' };
  const latest = input.threads.find((thread) => threadMatchesDocument(thread, input.documentId, input.docKey));
  if (!latest) return { kind: 'keep' };
  const holder = input.chats.findIndex((chat) => chat.threadId === latest.id);
  if (holder >= 0) return holder === input.activeIndex ? { kind: 'keep' } : { kind: 'show', index: holder };
  return { kind: 'open-thread', threadId: latest.id };
}
