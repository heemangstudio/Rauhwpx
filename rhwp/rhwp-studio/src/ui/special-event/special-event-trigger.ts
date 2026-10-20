/**
 * 특별 이벤트 창을 언제 띄울지 정한다. 이벤트마다 한 번만 뜬다.
 *
 * 띄우면 저장소에 'shown' 을 먼저 남겨 다른 창이 또 띄우지 않게 하고, 닫히면 'claimed'·'dismissed' 로 바꾼다.
 * 나중에를 눌러도 받기는 Pi 설정에 남는다. 처음 설정이 떠 있으면 닫힐 때까지 기다린다.
 * 창 모듈(그림·CSS)은 띄울 때만 불러오도록 open 으로 넘겨받는다.
 *
 * 내 OpenRouter 키가 있으면 받기와 함께 쓰는 순서(먼저·내 키 다음에)를 고르는 창을 띄운다. 이 창은 기록을
 * 따로(`…:order`) 남겨, 예전 창을 보거나 닫은 사람에게도 한 번 더 뜬다. 이미 받았으면 순서만 고른다.
 */
import { GiftClaimError, type DesktopGiftApi, type DesktopGiftStatus, type PiGiftOrderAccess } from './gift.ts';
import type { SpecialEventOccasion, SpecialEventOptions, SpecialEventResult } from './special-event-popup.ts';

export const SPECIAL_EVENT_STORAGE_PREFIX = 'rhwp-special-event:';
/** 내 키가 있는 사람에게 띄운 순서 고르기 창의 기록. */
const ORDER_RECORD_SUFFIX = ':order';
/** 허브가 Pi 상태를 답할 때까지 기다리는 시간. 넘으면 내 키가 없는 것으로 본다. */
const PI_STATUS_WAIT_MS = 8_000;
const PI_STATUS_RETRY_MS = 1_000;

export type SpecialEventRecord = 'shown' | 'claimed' | 'dismissed';

type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function specialEventStorageKey(eventId: string): string {
  return `${SPECIAL_EVENT_STORAGE_PREFIX}${eventId}`;
}

export function specialEventOrderStorageKey(eventId: string): string {
  return `${specialEventStorageKey(eventId)}${ORDER_RECORD_SUFFIX}`;
}

/** 저장소가 막혀 있으면 기록이 있는 것으로 본다. 매번 뜨는 것보다 안 뜨는 편이 낫다. */
function readRecord(storage: RecordStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return 'shown';
  }
}

function writeRecord(storage: RecordStorage, key: string, record: SpecialEventRecord): void {
  try {
    storage.setItem(key, record);
  } catch {
    // 기록하지 못해도 이 창에서는 다시 띄우지 않는다(러너가 기억한다).
  }
}

export function readSpecialEventRecord(storage: RecordStorage, eventId: string): string | null {
  return readRecord(storage, specialEventStorageKey(eventId));
}

export function writeSpecialEventRecord(storage: RecordStorage, eventId: string, record: SpecialEventRecord): void {
  writeRecord(storage, specialEventStorageKey(eventId), record);
}

/** 진행 중이고, 받을 수 있고, 아직 안 받았고, 이 이벤트를 띄운 적이 없을 때만. */
export function shouldShowSpecialEvent(status: DesktopGiftStatus | null | undefined, storage: RecordStorage): boolean {
  const event = status?.event;
  if (!status?.available || !event?.active || !event.id) return false;
  if (!status.eligible || status.claimed) return false;
  return readSpecialEventRecord(storage, event.id) === null;
}

/**
 * 띄울 창. offer 는 예전 창(받기만), order 는 내 키가 있는 사람의 창이다. claimed 면 받기 없이 순서만 고른다.
 */
export type SpecialEventPlan =
  | { kind: 'offer' }
  | { kind: 'order'; claimed: false }
  | { kind: 'order'; claimed: true; balanceUsd: number };

/** 이벤트 상태, 기록, 내 키 여부로 띄울 창을 정한다. 띄우지 않으면 null. */
export function planSpecialEvent(
  status: DesktopGiftStatus | null | undefined,
  storage: RecordStorage,
  pi: { keyConfigured: boolean } | null,
): SpecialEventPlan | null {
  const event = status?.event;
  if (!status?.available || !event?.active || !event.id) return null;
  if (!pi?.keyConfigured) return shouldShowSpecialEvent(status, storage) ? { kind: 'offer' } : null;
  if (readRecord(storage, specialEventOrderStorageKey(event.id)) !== null) return null;
  if (!status.claimed) return status.eligible ? { kind: 'order', claimed: false } : null;
  const balanceUsd = status.remainingUsd ?? event.amountUsd;
  return balanceUsd > 0 ? { kind: 'order', claimed: true, balanceUsd } : null;
}

export interface SpecialEventRunnerDeps {
  gift: DesktopGiftApi;
  storage: RecordStorage;
  /** 편집기와 부트 화면이 준비되면 풀린다. */
  whenReady: () => Promise<void>;
  isSetupActive: () => boolean;
  onSetupInactive: (listener: () => void) => () => void;
  open: (options: SpecialEventOptions) => Promise<SpecialEventResult>;
  /** 내 키 여부와 순서 저장. 없으면 언제나 예전 창이다. */
  pi?: PiGiftOrderAccess;
  /** 기다림을 시험에서 줄인다. */
  piStatusWaitMs?: number;
  /** 띄울 때 정하는 계기. 처음 설정에서 키를 막 활성화했으면 license. 없으면 update. */
  occasion?: () => SpecialEventOccasion;
}

/** 받기를 데스크톱에 맡긴다. 거절되면 그 메시지로 실패한다. */
async function claimThrough(gift: DesktopGiftApi, amountUsd: number): Promise<{ balanceUsd: number }> {
  const result = await gift.claim();
  if (!result.ok) throw new GiftClaimError(result.code, result.message);
  return { balanceUsd: result.status.remainingUsd ?? result.status.event?.amountUsd ?? amountUsd };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 허브가 Pi 상태를 답할 때까지 잠깐 기다린다. 끝내 모르면 null(내 키가 없는 것으로 본다). */
async function readPiStatus(
  pi: PiGiftOrderAccess,
  waitMs: number,
  stopped: () => boolean,
): Promise<{ keyConfigured: boolean; giftOrder?: 'first' | 'after' } | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const status = await pi.status();
      if (status) return status;
    } catch {
      // 허브가 아직 붙지 않았다. 다시 묻는다.
    }
    if (stopped() || Date.now() + PI_STATUS_RETRY_MS > deadline) return null;
    await delay(PI_STATUS_RETRY_MS);
  }
}

/**
 * 준비되면 상태를 한 번 보고, 상태가 바뀔 때마다 다시 본다. 이 창에서는 많아야 한 번 띄운다.
 */
export function startSpecialEvent(deps: SpecialEventRunnerDeps): { dispose(): void } {
  let ready = false;
  let opened = false;
  let disposed = false;
  let checking = false;
  let latest: DesktopGiftStatus | null = null;
  let stopWaitingForSetup: (() => void) | null = null;

  /** 처음 설정이 떠 있으면 닫힐 때 다시 보도록 걸어 두고 false. */
  function setupClear(): boolean {
    if (!deps.isSetupActive()) return true;
    if (!stopWaitingForSetup) {
      stopWaitingForSetup = deps.onSetupInactive(() => {
        stopWaitingForSetup?.();
        stopWaitingForSetup = null;
        void evaluate();
      });
    }
    return false;
  }

  async function evaluate(): Promise<void> {
    if (!ready || opened || disposed || checking) return;
    const event = latest?.available && latest.event?.active ? latest.event : null;
    if (!event?.id || !setupClear()) return;
    let pi: { keyConfigured: boolean; giftOrder?: 'first' | 'after' } | null = null;
    if (deps.pi) {
      checking = true;
      try {
        pi = await readPiStatus(deps.pi, deps.piStatusWaitMs ?? PI_STATUS_WAIT_MS, () => disposed);
      } finally {
        checking = false;
      }
      if (opened || disposed || !setupClear()) return;
    }
    const status = latest!;
    const plan = planSpecialEvent(status, deps.storage, pi);
    if (!plan) return;
    const current = status.event!;
    const occasion = deps.occasion?.() ?? 'update';
    opened = true;
    if (plan.kind === 'offer') {
      writeSpecialEventRecord(deps.storage, current.id, 'shown');
      void deps.open({ amountUsd: current.amountUsd, occasion, claim: () => claimThrough(deps.gift, current.amountUsd) })
        .then((result) => writeSpecialEventRecord(deps.storage, current.id, result))
        .catch(() => {
          // 창을 열지 못했다. 'shown' 이 남아 다음 실행에도 띄우지 않는다. 받기는 Pi 설정에 있다.
        });
      return;
    }
    const orderKey = specialEventOrderStorageKey(current.id);
    writeRecord(deps.storage, orderKey, 'shown');
    const access = deps.pi!;
    void deps.open({
      amountUsd: current.amountUsd,
      occasion,
      claim: () => claimThrough(deps.gift, current.amountUsd),
      ...(plan.claimed ? { claimedBalanceUsd: plan.balanceUsd } : {}),
      order: { initial: pi?.giftOrder ?? 'first', choose: (order) => access.setGiftOrder(order) },
    })
      .then((result) => {
        writeRecord(deps.storage, orderKey, result);
        // 예전 창의 기록도 맞춰 둔다. 받았으면 받은 것으로, 아니면 이미 본 것으로.
        if (result === 'claimed' || readSpecialEventRecord(deps.storage, current.id) === null) {
          writeSpecialEventRecord(deps.storage, current.id, result);
        }
      })
      .catch(() => {});
  }

  const unsubscribe = deps.gift.onChange((status) => {
    latest = status;
    void evaluate();
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
    void evaluate();
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
