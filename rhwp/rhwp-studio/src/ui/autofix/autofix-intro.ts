/**
 * 기존 사용자에게 자동 버그 수정을 한 번 소개한다(데스크톱만).
 *
 * 처음 설정을 이미 마쳤고 아직 켤지 말지 답하지 않았을 때(decided=false)만 띄운다. 어느 쪽으로 답해도
 * decided 가 되어 다시 뜨지 않는다. 버전이 아니라 답했는지로 정하므로, 처음 설정에서 답한 사람에게는
 * 뜨지 않는다. 처음 설정이 있는 실행(첫 실행·미룬 설정)에서는 묻지 않는다. 처음 설정 창이 떠 있으면
 * 닫힐 때까지, 대화상자나 라이선스 잠금이 화면을 막고 있으면 풀릴 때까지 기다린다.
 * 창 모듈(시트·CSS)은 띄울 때만 불러온다.
 */
import { openModalCount } from '../modal-stack.ts';
import { isInitialSetupActive, onInitialSetupInactive } from '../initial-setup/active.ts';
import { isInitialSetupComplete } from '../initial-setup/state.ts';
import {
  autofixApi,
  autofixSettings,
  loadAutofixSettings,
  onAutofixSettings,
  updateAutofixSettings,
  type AutofixSettings,
} from './autofix.ts';

/** 막힌 동안 다시 보는 간격 */
const BLOCKED_RETRY_MS = 3_000;

export interface AutofixIntroDeps {
  /** 편집기와 부트 화면이 준비되면 풀린다. */
  whenReady: () => Promise<void>;
  /** 화면에 뜬 모달 말고도 막을 것(라이선스 잠금 등)이 있는지 */
  isBlocked?: () => boolean;
  isSetupComplete?: () => boolean;
  isSetupActive?: () => boolean;
  onSetupInactive?: (listener: () => void) => () => void;
  /** 소개 창을 띄운다. 켜기면 true, 나중에·닫기면 false. signal 이 끊기면 창을 닫는다. */
  open?: (signal: AbortSignal) => Promise<boolean>;
  retryMs?: number;
}

/** 데스크톱이고, 처음 설정을 마쳤고, 아직 답하지 않았을 때만. */
export function shouldShowAutofixIntro(settings: AutofixSettings | null | undefined, setupComplete: boolean): boolean {
  return Boolean(settings) && settings!.decided !== true && setupComplete;
}

/** 보이는 모달(대화상자·시트·처음 설정·체험 끝 카드 등)이 떠 있는지. 숨겨 둔 모달은 치지 않는다. */
export function modalOnScreen(): boolean {
  if (openModalCount() > 0) return true;
  if (typeof document === 'undefined') return false;
  for (const node of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
    const visible = typeof node.checkVisibility === 'function'
      ? node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : node.getClientRects().length > 0;
    if (visible) return true;
  }
  return false;
}

async function openDefault(signal: AbortSignal): Promise<boolean> {
  return (await import('./autofix-intro-popup.ts')).openAutofixIntro(signal);
}

/** 준비되면 한 번 보고, 막혀 있으면 풀릴 때 다시 본다. 이 창에서는 많아야 한 번 띄운다. */
export function startAutofixIntro(deps: AutofixIntroDeps): { dispose(): void } {
  const setupComplete = deps.isSetupComplete ?? (() => isInitialSetupComplete());
  const setupActive = deps.isSetupActive ?? isInitialSetupActive;
  const onSetupInactive = deps.onSetupInactive ?? onInitialSetupInactive;
  const isBlocked = () => modalOnScreen() || deps.isBlocked?.() === true;
  const open = deps.open ?? openDefault;
  let disposed = false;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopWaitingForSetup: (() => void) | null = null;

  function evaluate(): void {
    timer = null;
    if (disposed || opened) return;
    if (!shouldShowAutofixIntro(autofixSettings(), setupComplete())) return;
    if (setupActive()) {
      stopWaitingForSetup ??= onSetupInactive(() => {
        stopWaitingForSetup?.();
        stopWaitingForSetup = null;
        evaluate();
      });
      return;
    }
    if (isBlocked()) {
      timer = setTimeout(evaluate, deps.retryMs ?? BLOCKED_RETRY_MS);
      return;
    }
    opened = true;
    void show();
  }

  /** 띄우기 직전에 설정을 다시 읽는다. 떠 있는 동안 다른 창에서 답하면 이 창은 답하지 않고 닫는다. */
  async function show(): Promise<void> {
    try {
      if (!shouldShowAutofixIntro(await loadAutofixSettings(), setupComplete()) || disposed) return;
    } catch {
      return;
    }
    const answeredElsewhere = new AbortController();
    const stop = onAutofixSettings((next) => {
      if (next?.decided) answeredElsewhere.abort();
    });
    try {
      const enable = await open(answeredElsewhere.signal).catch(() => false);
      if (answeredElsewhere.signal.aborted) return;
      await updateAutofixSettings(enable ? { decided: true, enabled: true } : { decided: true });
    } catch (error) {
      console.warn('[autofix] 자동 버그 수정 답을 저장하지 못했습니다:', error);
    } finally {
      stop();
    }
  }

  void (async () => {
    await deps.whenReady();
    // 처음 설정이 있는 실행에서는 묻지 않는다. 설정 안에서 답하거나 다음 실행에 본다.
    if (disposed || !autofixApi() || !setupComplete()) return;
    try {
      await loadAutofixSettings();
    } catch {
      return;
    }
    evaluate();
  })();

  return {
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopWaitingForSetup?.();
      stopWaitingForSetup = null;
    },
  };
}
