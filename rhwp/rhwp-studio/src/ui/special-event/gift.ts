/**
 * 선물 크레딧(특별 이벤트)의 데스크톱 API 와 화면에 보일 상태.
 * 상태는 데스크톱 메인(desktop/gift-manager.mjs)이 서버에서 받아 가진다. 쓸 수 있는 플랫폼도 메인이 정한다.
 * DOM 을 쓰지 않아 노드 시험에서 바로 부를 수 있다.
 */

export interface DesktopGiftEvent {
  id: string;
  amountUsd: number;
  endsAt: string | number | null;
  active: boolean;
}

export interface DesktopGiftStatus {
  /** 선물 플랫폼(macOS·Windows)이고 라이선스가 유효하며 서버 답을 한 번이라도 받았다. */
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

/**
 * 데스크톱의 선물 API. 웹에서는 null. 선물을 주지 않는 플랫폼이면 메인이 늘 available:false 로 답해
 * 팝업과 설정 줄이 보이지 않는다.
 */
export function desktopGiftApi(
  host: { rhwpDesktop?: { gift?: DesktopGiftApi } } | undefined = globalThis as never,
): DesktopGiftApi | null {
  return host?.rhwpDesktop?.gift ?? null;
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
