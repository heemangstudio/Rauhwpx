/**
 * 특별 이벤트 창을 언제 띄울지 정한다. 이벤트마다 한 번만 뜬다.
 *
 * 띄우면 저장소에 'shown' 을 먼저 남겨 다른 창이 또 띄우지 않게 하고, 닫히면 'claimed'·'dismissed' 로 바꾼다.
 * 나중에를 눌러도 받기는 Pi 설정에 남는다. 처음 설정이 떠 있으면 닫힐 때까지 기다린다.
 * 창 모듈(그림·CSS)은 띄울 때만 불러오도록 open 으로 넘겨받는다.
 */
import { GiftClaimError, type DesktopGiftApi, type DesktopGiftStatus } from './gift.ts';
import type { SpecialEventOptions, SpecialEventResult } from './special-event-popup.ts';

export const SPECIAL_EVENT_STORAGE_PREFIX = 'rhwp-special-event:';

export type SpecialEventRecord = 'shown' | 'claimed' | 'dismissed';

type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function specialEventStorageKey(eventId: string): string {
  return `${SPECIAL_EVENT_STORAGE_PREFIX}${eventId}`;
}

/** 저장소가 막혀 있으면 기록이 있는 것으로 본다. 매번 뜨는 것보다 안 뜨는 편이 낫다. */
export function readSpecialEventRecord(storage: RecordStorage, eventId: string): string | null {
  try {
    return storage.getItem(specialEventStorageKey(eventId));
  } catch {
    return 'shown';
  }
}

export function writeSpecialEventRecord(storage: RecordStorage, eventId: string, record: SpecialEventRecord): void {
  try {
    storage.setItem(specialEventStorageKey(eventId), record);
  } catch {
    // 기록하지 못해도 이 창에서는 다시 띄우지 않는다(러너가 기억한다).
  }
}

/** 진행 중이고, 받을 수 있고, 아직 안 받았고, 이 이벤트를 띄운 적이 없을 때만. */
export function shouldShowSpecialEvent(status: DesktopGiftStatus | null | undefined, storage: RecordStorage): boolean {
  const event = status?.event;
  if (!status?.available || !event?.active || !event.id) return false;
  if (!status.eligible || status.claimed) return false;
  return readSpecialEventRecord(storage, event.id) === null;
}

export interface SpecialEventRunnerDeps {
  gift: DesktopGiftApi;
  storage: RecordStorage;
  /** 편집기와 부트 화면이 준비되면 풀린다. */
  whenReady: () => Promise<void>;
  isSetupActive: () => boolean;
  onSetupInactive: (listener: () => void) => () => void;
  open: (options: SpecialEventOptions) => Promise<SpecialEventResult>;
}

/** 받기를 데스크톱에 맡긴다. 거절되면 그 메시지로 실패한다. */
async function claimThrough(gift: DesktopGiftApi, amountUsd: number): Promise<{ balanceUsd: number }> {
  const result = await gift.claim();
  if (!result.ok) throw new GiftClaimError(result.code, result.message);
  return { balanceUsd: result.status.remainingUsd ?? result.status.event?.amountUsd ?? amountUsd };
}

/**
 * 준비되면 상태를 한 번 보고, 상태가 바뀔 때마다 다시 본다. 이 창에서는 많아야 한 번 띄운다.
 */
export function startSpecialEvent(deps: SpecialEventRunnerDeps): { dispose(): void } {
  let ready = false;
  let opened = false;
  let disposed = false;
  let latest: DesktopGiftStatus | null = null;
  let stopWaitingForSetup: (() => void) | null = null;

  function evaluate(): void {
    if (!ready || opened || disposed || !shouldShowSpecialEvent(latest, deps.storage)) return;
    if (deps.isSetupActive()) {
      if (stopWaitingForSetup) return;
      stopWaitingForSetup = deps.onSetupInactive(() => {
        stopWaitingForSetup?.();
        stopWaitingForSetup = null;
        evaluate();
      });
      return;
    }
    const status = latest!;
    const event = status.event!;
    opened = true;
    writeSpecialEventRecord(deps.storage, event.id, 'shown');
    void deps.open({ amountUsd: event.amountUsd, claim: () => claimThrough(deps.gift, event.amountUsd) })
      .then((result) => writeSpecialEventRecord(deps.storage, event.id, result))
      .catch(() => {
        // 창을 열지 못했다. 'shown' 이 남아 다음 실행에도 띄우지 않는다. 받기는 Pi 설정에 있다.
      });
  }

  const unsubscribe = deps.gift.onChange((status) => {
    latest = status;
    evaluate();
  });

  void (async () => {
    await deps.whenReady();
    if (disposed) return;
    try {
      const status = await deps.gift.getStatus();
      // 기다리는 사이 onChange 로 더 새 상태가 왔으면 그것을 쓴다.
      latest ??= status;
    } catch {
      // 상태를 못 받았다. onChange 가 오면 그때 본다.
    }
    ready = true;
    evaluate();
  })();

  return {
    dispose(): void {
      disposed = true;
      unsubscribe();
      stopWaitingForSetup?.();
      stopWaitingForSetup = null;
    },
  };
}
