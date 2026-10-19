/**
 * 선물 크레딧(특별 이벤트)의 데스크톱 API 와 화면에 보일 상태.
 * 상태는 데스크톱 메인(desktop/gift-manager.mjs)이 서버에서 받아 가진다. macOS·Windows 에서만 쓴다.
 * DOM 을 쓰지 않아 노드 시험에서 바로 부를 수 있다.
 */

export interface DesktopGiftEvent {
  id: string;
  amountUsd: number;
  endsAt: string | number | null;
  active: boolean;
}

export interface DesktopGiftStatus {
  /** macOS·Windows 이고 라이선스가 유효하며 서버 답을 한 번이라도 받았다. */
  available: boolean;
  event: DesktopGiftEvent | null;
  eligible: boolean;
  claimed: boolean;
  remainingUsd: number | null;
  usedUsd: number | null;
  claimedAt: string | number | null;
  checkedAt: number | null;
  error: string | null;
}

export type GiftClaimResult =
  | { ok: true; status: DesktopGiftStatus }
  | { ok: false; code: string; message: string; status?: DesktopGiftStatus };

export interface DesktopGiftApi {
  getStatus(options?: { refresh?: boolean }): Promise<DesktopGiftStatus>;
  claim(): Promise<GiftClaimResult>;
  onChange(callback: (status: DesktopGiftStatus) => void): () => void;
}

/** 받기를 서버가 거절했다. 메시지는 그대로 사용자에게 보인다. */
export class GiftClaimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GiftClaimError';
    this.code = code;
  }
}

const GIFT_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'win32']);

/** macOS·Windows 데스크톱에서만 선물 API 를 돌려준다. 다른 플랫폼과 웹에서는 null. */
export function desktopGiftApi(
  host: { rhwpDesktop?: { platform?: string; gift?: DesktopGiftApi } } | undefined = globalThis as never,
): DesktopGiftApi | null {
  const desktop = host?.rhwpDesktop;
  if (!GIFT_PLATFORMS.has(desktop?.platform ?? '') || !desktop?.gift) return null;
  return desktop.gift;
}

/**
 * 내 OpenRouter 키가 있을 때 선물 크레딧을 쓰는 순서. 허브(pi-manager)가 저장한다.
 * first: 선물 먼저, 다 쓰면 내 키. after: 내 키 먼저, 그 크레딧이 떨어지면 선물.
 */
export type GiftOrder = 'first' | 'after';

export const GIFT_ORDER_OPTIONS: ReadonlyArray<{ value: GiftOrder; label: string }> = [
  { value: 'first', label: '먼저 사용' },
  { value: 'after', label: '내 키 다음에' },
];

/** 순서를 고를 때 보는 Pi 상태와 허브에 저장하는 길. 허브가 없으면 status 가 null 이다. */
export interface PiGiftOrderAccess {
  status(): Promise<{ keyConfigured: boolean; giftOrder?: GiftOrder } | null>;
  /** 저장하지 못하면 거부한다. */
  setGiftOrder(order: GiftOrder): Promise<void>;
}

/**
 * 남은 양 막대의 비율과 최대값. 서버가 한도를 늘려 남은 양이 처음 금액보다 많아도 막대가 넘치지 않는다.
 */
export function giftMeter(amountUsd: number, remainingUsd: number): { ratio: number; max: number } {
  const remaining = Math.max(0, remainingUsd);
  const max = Math.max(amountUsd, remaining);
  return { ratio: max > 0 ? remaining / max : 0, max };
}

/** 이벤트 금액. 정수면 소수점을 빼고('$20'), 아니면 센트까지 쓴다. */
export function formatGiftAmount(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** 남은 양. 항상 센트까지 쓴다('$18.40'). */
export function formatGiftBalance(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

/** Pi 설정의 선물 한 줄. null 이면 줄을 숨긴다. */
export type GiftLineState =
  | { kind: 'offer'; amountUsd: number }
  | { kind: 'balance'; amountUsd: number; remainingUsd: number }
  | { kind: 'exhausted' };

/**
 * 진행 중인 이벤트만 보인다. 받았으면 남은 양(다 썼으면 소진), 안 받았으면 받을 자격이 있을 때만 제안한다.
 * 이벤트가 끝나면 Pi 도 선물을 쓰지 않으므로 줄을 숨긴다.
 */
export function giftLineState(status: DesktopGiftStatus | null | undefined): GiftLineState | null {
  const event = status?.available ? status.event : null;
  if (!status || !event?.active) return null;
  if (status.claimed) {
    const remaining = status.remainingUsd ?? event.amountUsd;
    return remaining <= 0
      ? { kind: 'exhausted' }
      : { kind: 'balance', amountUsd: event.amountUsd, remainingUsd: remaining };
  }
  return status.eligible ? { kind: 'offer', amountUsd: event.amountUsd } : null;
}
