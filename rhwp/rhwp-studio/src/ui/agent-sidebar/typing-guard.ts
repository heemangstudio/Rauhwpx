/**
 * 입력 중 도착 보류 — 사용자가 글을 쓰는 동안 새로 도착한 질문 같은 상호작용 면이
 * 초점·키 입력·한글 조합·입력칸의 글을 빼앗지 않게 한다.
 *
 * 창 하나에 쓰기 활동 감시자 하나(typingActivity)를 두고, 사이드바마다 도착
 * 보류기(createArrivalGuard)를 둔다. 보류된 도착은 사용자가 쓰기를 멈춘 순간
 * — 1.5초 쉼(한글 조합이 열려 있지 않을 때), 텍스트 칸을 벗어남, 창 전환,
 * 입력기에서 보내기 — 에 도착 순서대로 한꺼번에 열린다.
 */
import { ownsTextInput } from '../../command/shortcut-target.ts';

/** 마지막 입력 뒤 이만큼 쉬면 쓰기를 멈춘 것으로 본다. */
export const TYPING_IDLE_MS = 1500;

/** 쓰기가 끝난 까닭 — 쉼, 텍스트 칸·창을 벗어남, 입력기에서 보냄. */
export type SettleCause = 'idle' | 'blur' | 'send';

export interface TypingActivity {
  /** 편집 가능한 곳에 초점이 있고, 1.5초 안에 쳤거나 한글 조합이 열려 있다. */
  isTyping(): boolean;
  /** 쓰기를 멈춘 순간(쉼·초점 이탈·보내기)마다 부른다. 해제 함수를 돌려준다. */
  onSettle(listener: (cause: SettleCause) => void): () => void;
  /** 입력기에서 보냈다 — 쓰기가 끝났다. */
  noteSend(): void;
  dispose(): void;
}

interface ActivityTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean | EventListenerOptions): void;
}

/** 테스트가 가짜 문서·창·시계를 넣을 수 있게 바깥 세계를 주입받는다. */
export interface TypingActivityEnv {
  doc: ActivityTarget & { readonly activeElement: Element | null };
  win: ActivityTarget;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  isEditable(target: EventTarget | null): boolean;
}

/** 이 키만 눌렀다면 아직 쓴 것이 아니다. */
const BARE_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function createTypingActivity(env: TypingActivityEnv): TypingActivity {
  let lastTypedAt = Number.NEGATIVE_INFINITY;
  let composing = false;
  let idleTimer: number | null = null;
  let focusOutTimer: number | null = null;
  const listeners = new Set<(cause: SettleCause) => void>();

  function clearIdle(): void {
    if (idleTimer === null) return;
    env.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(delay: number): void {
    clearIdle();
    idleTimer = env.setTimeout(onIdle, Math.max(0, delay));
  }

  function onIdle(): void {
    idleTimer = null;
    // 조합 중인 음절은 쉼으로 끝나지 않는다 — compositionend 가 다시 건다.
    if (composing) return;
    const elapsed = env.now() - lastTypedAt;
    if (elapsed >= TYPING_IDLE_MS) settle('idle');
    else armIdle(TYPING_IDLE_MS - elapsed);
  }

  function settle(cause: SettleCause): void {
    lastTypedAt = Number.NEGATIVE_INFINITY;
    // 초점을 떠나거나 보내면 열린 조합도 끝난 것이다. 편집기의 숨은 입력칸은
    // blur 에서 조합을 스스로 닫아 compositionend 를 내지 않을 수 있다.
    composing = false;
    clearIdle();
    for (const listener of [...listeners]) listener(cause);
  }

  function markTyped(): void {
    lastTypedAt = env.now();
    if (!composing) armIdle(TYPING_IDLE_MS);
  }

  /** 조합이 끝났다는 compositionend 없이 조합 밖의 입력이 오면 조합은 이미 끝난 것이다. */
  function noteComposingFlag(event: Event): void {
    if (composing && (event as KeyboardEvent | InputEvent).isComposing === false) composing = false;
  }

  // 사람이 친 것만 센다 — 코드가 보낸 input 이벤트나 값 변경은 쓰기가 아니다.
  const onKeyDown = (event: Event): void => {
    if (!event.isTrusted || !env.isEditable(event.target)) return;
    const key = (event as KeyboardEvent).key;
    if (BARE_MODIFIER_KEYS.has(key)) return;
    noteComposingFlag(event);
    markTyped();
  };
  const onInput = (event: Event): void => {
    if (!event.isTrusted || !env.isEditable(event.target)) return;
    noteComposingFlag(event);
    markTyped();
  };
  // 조합 이벤트는 isTrusted 를 보지 않는다. Chromium 은 조합을 확정할 때 compositionend 를
  // isTrusted=false 로 보내기도 한다. 조합 이벤트는 입력기(IME)만 낸다.
  const onCompositionStart = (): void => {
    composing = true;
    lastTypedAt = env.now();
    clearIdle();
  };
  const onCompositionUpdate = (): void => {
    lastTypedAt = env.now();
  };
  const onCompositionEnd = (): void => {
    composing = false;
    markTyped();
  };
  // 초점이 다른 텍스트 칸으로 옮겨 가면(입력기 → 문서) 아직 쓰는 중이다.
  // 새 초점은 focusout 다음에 정해지므로 다음 작업에서 본다.
  const onFocusOut = (event: Event): void => {
    if (!event.isTrusted) return;
    if (focusOutTimer !== null) env.clearTimeout(focusOutTimer);
    focusOutTimer = env.setTimeout(() => {
      focusOutTimer = null;
      if (!env.isEditable(env.doc.activeElement)) settle('blur');
    }, 0);
  };
  // 다른 앱으로 옮겨 가면 쓰기를 멈춘 것이다.
  const onWindowBlur = (event: Event): void => {
    if (event.target !== env.win) return;
    settle('blur');
  };

  env.doc.addEventListener('keydown', onKeyDown, true);
  env.doc.addEventListener('input', onInput, true);
  env.doc.addEventListener('compositionstart', onCompositionStart, true);
  env.doc.addEventListener('compositionupdate', onCompositionUpdate, true);
  env.doc.addEventListener('compositionend', onCompositionEnd, true);
  env.doc.addEventListener('focusout', onFocusOut, true);
  env.win.addEventListener('blur', onWindowBlur);

  return {
    isTyping(): boolean {
      if (!env.isEditable(env.doc.activeElement)) return false;
      return composing || env.now() - lastTypedAt < TYPING_IDLE_MS;
    },
    onSettle(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    noteSend(): void {
      settle('send');
    },
    dispose(): void {
      clearIdle();
      if (focusOutTimer !== null) env.clearTimeout(focusOutTimer);
      focusOutTimer = null;
      listeners.clear();
      env.doc.removeEventListener('keydown', onKeyDown, true);
      env.doc.removeEventListener('input', onInput, true);
      env.doc.removeEventListener('compositionstart', onCompositionStart, true);
      env.doc.removeEventListener('compositionupdate', onCompositionUpdate, true);
      env.doc.removeEventListener('compositionend', onCompositionEnd, true);
      env.doc.removeEventListener('focusout', onFocusOut, true);
      env.win.removeEventListener('blur', onWindowBlur);
    },
  };
}

let sharedActivity: TypingActivity | null = null;

/**
 * 창 전체의 쓰기 활동. 처음 부를 때 실제 문서에 붙고, 창 안의 모든 사이드바가
 * 함께 쓴다(채팅 상태 저장소처럼 모듈 하나에 하나). 창이 살아 있는 동안 걷지 않는다.
 */
export function typingActivity(): TypingActivity {
  sharedActivity ??= createTypingActivity({
    doc: document,
    win: window,
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    isEditable: (target) => target instanceof Element && ownsTextInput(target),
  });
  return sharedActivity;
}

export interface ArrivalGuard {
  /** 지금 쓰는 중이면 미루고 true, 아니면 바로 보여 주고 false. */
  hold(key: string, present: () => void): boolean;
  /** 보류 중에 끝난 도착 — 다시 보여 주지 않는다. */
  cancel(key: string): void;
  isHeld(key: string): boolean;
  /** 보류된 도착을 도착 순서대로 모두 보여 준다. */
  release(): void;
  dispose(): void;
}

/**
 * 사이드바 하나의 도착 보류기. 화면에 없는 사이드바(isShown false)는 초점을
 * 빼앗을 수 없으므로 바로 보여 준다. 쓰기가 멈추면 보류된 도착이 모두 열린다.
 */
export function createArrivalGuard(activity: TypingActivity, isShown: () => boolean): ArrivalGuard {
  const held = new Map<string, () => void>();
  const unsubscribe = activity.onSettle(() => release());

  function release(): void {
    if (held.size === 0) return;
    const arrivals = [...held.values()];
    held.clear();
    for (const present of arrivals) present();
  }

  return {
    hold(key, present) {
      held.delete(key);
      if (!isShown() || !activity.isTyping()) {
        present();
        return false;
      }
      held.set(key, present);
      return true;
    },
    cancel(key) {
      held.delete(key);
    },
    isHeld: (key) => held.has(key),
    release,
    dispose() {
      unsubscribe();
      held.clear();
    },
  };
}
