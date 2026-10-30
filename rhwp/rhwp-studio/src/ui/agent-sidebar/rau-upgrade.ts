// 호스팅 Rau-0.1(Pro) 업그레이드 안내. 허브가 Pro 가 아니라는 답(rau_requires_pro)을 받으면 rau-upgrade 를 한 번
// 보내고, 사이드바는 입력창 위에 칩을 띄운다. 닫거나 업그레이드 페이지를 열면 그 거절에는 다시 띄우지 않는다.
// 서버 호출과 lease 는 데스크톱 main 이 가진다. 여기서는 데스크톱의 rau API 로 자격을 묻고 페이지를 연다.
import { createIcon } from './icons.ts';

export const RAU_UPGRADE_PRICE = '월 ₩3,900';
export const RAU_PRICING_URL = 'https://heemangstudios.com/pricing.html';
const DISMISSED_KEY = 'rhwp.rau-upgrade.dismissed';

/** 데스크톱 main 의 rau:status 답. 라이선스가 없으면 reason 이 no_license 다. */
export interface RauStatus {
  ok: boolean;
  eligible?: boolean;
  reason?: 'rau_requires_pro' | 'no_license' | null;
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

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function rauUpgradeDismissed(reason: string, store: Storage | null = storage()): boolean {
  try { return store?.getItem(DISMISSED_KEY) === reason; } catch { return false; }
}

export function dismissRauUpgrade(reason: string, store: Storage | null = storage()): void {
  try { store?.setItem(DISMISSED_KEY, reason); } catch { /* 저장소가 없으면 이 창에서만 닫는다 */ }
}

export interface RauUpgradeChip {
  root: HTMLElement;
  /** 허브의 rau-upgrade. 이미 닫은 거절이면 띄우지 않는다. 띄웠으면 true. */
  show(prompt: { reason: string; upgradeUrl: string | null }): boolean;
}

export function createRauUpgradeChip({
  rau,
  store = storage(),
  onChange = () => {},
}: {
  rau: DesktopRauApi | null;
  store?: Storage | null;
  onChange?: () => void;
}): RauUpgradeChip {
  const root = document.createElement('div');
  root.className = 'ag-calibration-chip ag-rau-upgrade-chip';
  root.hidden = true;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ag-calibration-chip-open';
  const text = document.createElement('span');
  text.className = 'ag-calibration-chip-text';
  text.textContent = 'Rau-0.1 호스팅은 Pro에서 써요';
  const action = document.createElement('span');
  action.className = 'ag-calibration-chip-action';
  action.textContent = RAU_UPGRADE_PRICE;
  open.append(text, action);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ag-calibration-chip-close';
  close.setAttribute('aria-label', '닫기');
  close.append(createIcon('close'));
  root.append(open, close);

  let current: { reason: string; upgradeUrl: string | null } | null = null;
  function settle(): void {
    if (current) dismissRauUpgrade(current.reason, store);
    current = null;
    root.hidden = true;
    onChange();
  }
  open.addEventListener('click', () => {
    openRauUpgrade(rau, current?.upgradeUrl);
    settle();
  });
  close.addEventListener('click', settle);

  return {
    root,
    show(prompt) {
      if (rauUpgradeDismissed(prompt.reason, store)) return false;
      current = prompt;
      root.hidden = false;
      onChange();
      return true;
    },
  };
}
