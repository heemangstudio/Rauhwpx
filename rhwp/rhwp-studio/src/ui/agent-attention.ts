/**
 * 웹 배포판의 백그라운드 채팅 알림 — 장부(agent/chat-attention)의 알림을 이미 허락된 브라우저
 * 알림으로 보낸다. 데스크톱의 OS 알림과 앱 아이콘 배지는 desktop-integration 이 맡는다.
 * 앱 안에서는 채팅 목록 행의 상태가 알린다.
 *
 * 알림은 초점을 가져가지 않는다 — 쓰는 중인 글과 한글 조합을 깨지 않는다.
 */
import type { AttentionNotice, ChatAttentionLedger } from '../agent/chat-attention.ts';

/** 브라우저 알림의 최소 모양 — 테스트가 가짜를 넣는다. */
export interface WebNotificationLike {
  onclick: ((this: unknown, event: Event) => unknown) | null;
  close(): void;
}

export interface WebNotificationConstructor {
  readonly permission: string;
  new (title: string, options?: { body?: string; tag?: string }): WebNotificationLike;
}

export interface WebAttentionHost {
  Notification?: WebNotificationConstructor;
  focus?: () => void;
}

/** 이 페이지가 브라우저 알림을 보낼 수 있는가 — 이미 허락받았을 때만. Studio 는 묻지 않는다. */
export function webNotificationsGranted(host: WebAttentionHost = globalThis as WebAttentionHost): boolean {
  try {
    return typeof host.Notification === 'function' && host.Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/**
 * 웹 배포판 — 창에 초점이 없을 때의 알림은 이미 허락된 브라우저 알림으로만 보낸다.
 * 누르면 창으로 돌아와 그 채팅을 연다.
 */
export function installWebAgentAttention(
  ledger: ChatAttentionLedger,
  openThread: (threadId: string) => void,
  host: WebAttentionHost = globalThis as WebAttentionHost,
): () => void {
  return ledger.subscribe({
    notice(notice: AttentionNotice) {
      if (!webNotificationsGranted(host)) return;
      try {
        const NotificationCtor = host.Notification!;
        const shown = new NotificationCtor(notice.title, { body: notice.body, tag: notice.key });
        shown.onclick = () => {
          try { host.focus?.(); } catch { /* 창을 앞으로 가져오지 못해도 채팅은 연다 */ }
          openThread(notice.threadId);
          shown.close();
        };
      } catch (error) {
        console.warn('[attention] 브라우저 알림을 띄우지 못했습니다:', error);
      }
    },
  });
}
