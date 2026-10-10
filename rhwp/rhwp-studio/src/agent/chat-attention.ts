/**
 * 백그라운드 채팅 알림 장부 — 페이지에 하나.
 *
 * 각 사이드바는 자기 채팅들의 상태(chat-status)를 사실에서 다시 계산해 쓰고, 바뀐 상태를
 * 여기 알린다(report). 장부는 "이 턴의 이 상태"마다 한 번만 알리고, 알렸지만 아직 보지 않은
 * 채팅을 센다 — 그 수가 앱 아이콘 배지다. 알리는 길(OS 알림·앱 안 토스트)은 구독자가 고른다.
 *
 * - 보고 있는 채팅(보이고 창에 초점)은 알리지 않는다.
 * - 창에 초점이 있으면 앱 안(in-app), 없으면 시스템(system). 완료는 앱 안에서는 알리지 않는다 —
 *   칩과 머리 숫자로 충분하다.
 * - 같은 열쇠는 다시 알리지 않는다. 한 턴의 끝 상태(검토·오류·완료)는 열쇠 하나를 나눠 쓴다.
 * - 시스템 알림(OS·브라우저)은 잠금 화면과 알림 센터에 남는다. 그래서 기본은 앱 이름과 정해진
 *   문구뿐이고, 채팅 제목과 문서 이름은 사용자가 켰을 때만 싣는다. 앱 안 토스트는 늘 제목을 보인다.
 *
 * 순수 장부다 — 환경(상태 읽기·창 초점·제목 표시 설정)은 주입받는다.
 */
import { loadAttentionPrefs } from './attention-prefs.ts';
import { ATTENTION_STATUSES, getChatStatus, subscribeChatStatus, type ChatRunStatus } from './chat-status.ts';

export type AttentionState = 'needs-input' | 'needs-review' | 'failed' | 'finished';
/** 상태의 까닭 — 알림 문구를 고른다. */
export type AttentionReason = 'question' | 'plan' | 'error' | 'interrupted';

export interface AttentionNotice {
  threadId: string;
  key: string;
  state: AttentionState;
  /** 시스템 알림 제목 — 앱 이름('HamaEditor'). 제목 표시를 켰으면 채팅 제목. */
  title: string;
  /** 시스템 알림 본문 — `답변을 기다립니다`. 제목 표시를 켰으면 `답변을 기다립니다 · 사업 제안서.hwpx`. */
  body: string;
  /** 앱 안 토스트 글 — `{제목} — 답변을 기다립니다`. */
  message: string;
  channel: 'system' | 'in-app';
}

export interface AttentionReport {
  threadId: string;
  status: ChatRunStatus | null;
  /** 한 번만 알릴 단위 — `{턴}:input:{질문}`, `{턴}:input:plan:{계획}`, `{턴}:end`. */
  key: string;
  /** 지금 그 채팅을 보고 있는가(보이고 창에 초점). */
  seen: boolean;
  title: string;
  documentName: string | null;
  reason?: AttentionReason | null;
  /** failed 의 짧은 이유('로그인 필요' …). */
  label?: string | null;
  /** failed 의 알림 문구 — 실패 알림 제목처럼 이유보다 자세한 한 줄. */
  summary?: string | null;
}

export interface AttentionListener {
  notice?(notice: AttentionNotice): void;
  /** 알렸지만 아직 보지 않은 채팅 수가 바뀌었다. */
  count?(count: number): void;
}

export interface ChatAttentionLedger {
  report(report: AttentionReport): void;
  /** 그 채팅을 보았다 — 배지에서 뺀다. */
  seen(threadId: string): void;
  /** 공유 상태가 바뀌었다(다른 창·탭·사이드바) — 더는 볼 일이 없는 채팅을 뺀다. */
  refresh(): void;
  /** 알렸지만 아직 보지 않은 채팅 수. */
  count(): number;
  isEnabled(): boolean;
  /** 끄면 대기 목록을 비우고(배지 0) 이후 보고를 무시한다. 레일 점과 칩은 그대로다. */
  setEnabled(on: boolean): void;
  subscribe(listener: AttentionListener): () => void;
}

export interface ChatAttentionEnvironment {
  getStatus(threadId: string): ChatRunStatus | null;
  /** 창이 보이고 초점이 있는가 (document.hasFocus() && visible). */
  windowFocused(): boolean;
  /** 시스템 알림에 채팅 제목과 문서 이름을 싣는가. 없으면 싣지 않는다. 알릴 때마다 읽는다. */
  showDetails?(): boolean;
  /** 기억할 열쇠 수. 기본 256. */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 256;
/** 내용을 싣지 않는 시스템 알림의 제목. */
export const ATTENTION_APP_NAME = 'HamaEditor';
const TITLE_MAX = 60;
/** 앱 안 토스트는 손을 대야 하는 상태만 — 완료는 칩과 머리 숫자가 알린다. */
const IN_APP_STATES: ReadonlySet<AttentionState> = new Set<AttentionState>(['needs-input', 'needs-review', 'failed']);

function isAttentionState(status: ChatRunStatus | null): status is AttentionState {
  return status !== null && ATTENTION_STATUSES.has(status);
}

/** 알림 제목 — 비면 '새 채팅', 길면 말줄임. */
export function attentionTitle(title: string | null | undefined): string {
  const text = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '새 채팅';
  const chars = [...text];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : text;
}

/** 상태와 까닭에 맞는 한 줄. */
export function attentionPhrase(
  state: AttentionState,
  reason?: AttentionReason | null,
  label?: string | null,
  summary?: string | null,
): string {
  switch (state) {
    case 'needs-input':
      return reason === 'plan' ? '계획 승인을 기다립니다' : '답변을 기다립니다';
    case 'needs-review':
      return '검토할 변경이 있습니다';
    case 'failed':
      if (reason === 'interrupted') return '작업이 중단됐습니다';
      return summary?.trim() || label?.trim() || '오류로 멈췄습니다';
    case 'finished':
      return '작업을 마쳤습니다';
  }
}

export function createChatAttentionLedger(env: ChatAttentionEnvironment): ChatAttentionLedger {
  const maxKeys = Math.max(1, env.maxKeys ?? DEFAULT_MAX_KEYS);
  const keys = new Set<string>();
  /** 알렸지만 아직 보지 않은 채팅 → 마지막 상태 */
  const pending = new Map<string, AttentionState>();
  const listeners = new Set<AttentionListener>();
  let enabled = true;
  let lastCount = 0;

  const each = (fn: (listener: AttentionListener) => void) => {
    for (const listener of [...listeners]) {
      try { fn(listener); } catch (error) {
        console.warn('[attention] 알림 구독자 오류:', error);
      }
    }
  };

  function emitCount(): void {
    if (pending.size === lastCount) return;
    lastCount = pending.size;
    const count = lastCount;
    each((listener) => listener.count?.(count));
  }

  function remember(key: string): void {
    keys.add(key);
    while (keys.size > maxKeys) {
      const oldest = keys.values().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
    }
  }

  function seen(threadId: string): void {
    if (pending.delete(threadId)) emitCount();
  }

  return {
    report(report) {
      if (!enabled || !report.threadId) return;
      if (report.seen) {
        seen(report.threadId);
        return;
      }
      if (!isAttentionState(report.status)) {
        if (pending.delete(report.threadId)) emitCount();
        return;
      }
      const state = report.status;
      if (!report.key || keys.has(report.key)) {
        // 같은 턴의 다음 상태(검토 → 완료) — 다시 알리지 않고, 이미 센 채팅이면 상태만 잇는다.
        if (pending.has(report.threadId)) pending.set(report.threadId, state);
        return;
      }
      remember(report.key);
      pending.set(report.threadId, state);
      emitCount();
      const channel = env.windowFocused() ? 'in-app' : 'system';
      if (channel === 'in-app' && !IN_APP_STATES.has(state)) return;
      const title = attentionTitle(report.title);
      const phrase = attentionPhrase(state, report.reason, report.label, report.summary);
      const details = env.showDetails?.() === true;
      const documentName = details ? report.documentName?.trim() : '';
      const notice: AttentionNotice = {
        threadId: report.threadId,
        key: report.key,
        state,
        title: details ? title : ATTENTION_APP_NAME,
        body: documentName ? `${phrase} · ${documentName}` : phrase,
        message: `${title} — ${phrase}`,
        channel,
      };
      each((listener) => listener.notice?.(notice));
    },
    seen,
    refresh() {
      let changed = false;
      for (const threadId of [...pending.keys()]) {
        if (isAttentionState(env.getStatus(threadId))) continue;
        pending.delete(threadId);
        changed = true;
      }
      if (changed) emitCount();
    },
    count: () => pending.size,
    isEnabled: () => enabled,
    setEnabled(on) {
      enabled = on;
      if (!on) {
        pending.clear();
        emitCount();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function realWindowFocused(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return false;
  }
}

/** 실제 환경으로 만든 페이지 하나짜리 장부. */
export const chatAttention: ChatAttentionLedger = createChatAttentionLedger({
  getStatus: getChatStatus,
  windowFocused: realWindowFocused,
  showDetails: () => loadAttentionPrefs().showChatDetails,
});

/**
 * 공유 상태가 바뀔 때마다(다른 창에서 열어 보았거나, 답했거나, 지웠다) 장부를 다시 맞춘다.
 * 페이지를 꾸리는 쪽(main.ts·미리보기)이 한 번 부른다.
 */
export function connectChatAttention(ledger: ChatAttentionLedger = chatAttention): () => void {
  return subscribeChatStatus(() => ledger.refresh());
}
