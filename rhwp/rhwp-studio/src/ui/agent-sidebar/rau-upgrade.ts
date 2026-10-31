// 호스팅 Rau-0.1(Basic·Hama) 자격과 업그레이드 페이지. 설정의 Rau-0.1 줄이 쓴다.
// 서버 호출과 lease 는 데스크톱 main 이 가진다. 여기서는 데스크톱의 rau API 로 자격을 묻고 페이지를 연다.

export const RAU_PRICING_URL = 'https://heemangstudios.com/pricing.html';

/** 데스크톱 main 의 rau:status 답. 라이선스가 없으면 reason 이 no_license 다. */
export interface RauStatus {
  ok: boolean;
  eligible?: boolean;
  reason?: 'rau_requires_basic' | 'no_license' | null;
  upgradeUrl?: string;
  capUsd?: number | null;
  usedUsd?: number | null;
  remainingUsd?: number | null;
  resetsAt?: number | null;
}

export interface DesktopRauApi {
  getStatus(): Promise<RauStatus>;
  openUpgrade(url?: string | null): Promise<void>;
}

/** 데스크톱 앱의 rau API. 웹·미리보기에는 없다. */
export function desktopRauApi(host: { rhwpDesktop?: { rau?: DesktopRauApi } } = globalThis as never): DesktopRauApi | null {
  return host?.rhwpDesktop?.rau ?? null;
}

/** https 주소만 연다. 데스크톱은 main 이 다시 거른다. */
export function openRauUpgrade(api: DesktopRauApi | null, url: string | null | undefined): void {
  if (api) {
    void api.openUpgrade(url ?? null);
    return;
  }
  const safe = typeof url === 'string' && url.startsWith('https://') ? url : RAU_PRICING_URL;
  window.open(safe, '_blank', 'noopener,noreferrer');
}
