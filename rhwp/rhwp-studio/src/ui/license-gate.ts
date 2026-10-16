import type { DesktopHost } from '../desktop-integration';
import { licenseSummary, msUntilNextTrialTick, trialTimeLeft, type LicenseStatus } from './agent-sidebar/settings-license';
import { showToast } from './toast';
import { setLicenseViewerMode } from './license-viewer-mode';
import { showTrialEndedBanner, type TrialEndedBanner } from './trial-ended-banner';
import './license-gate.css';

/** 체험이 끝나기 이만큼 전에 자동 저장을 시작한다. 이 저장은 메인이 기한 전에 받는다. */
const EXPIRY_SAVE_LEAD_MS = 5_000;

/** 설치한 게이트가 채운다. 잠긴 동안 막힌 동작 위에 체험 끝 카드를 띄운다. */
let licensePrompt: ((detail: string, leave?: { label: string; onClick: () => void }) => TrialEndedBanner) | null = null;

/**
 * 라이선스가 잠긴 화면(설정) 위에 닫을 수 없는 카드를 띄운다. 활성화되면 게이트가 스스로 내린다.
 * onLeave 는 카드의 '홈으로' 단추다. 게이트가 없으면(브라우저) null.
 */
export function showLicenseLockedPrompt(onLeave: () => void): TrialEndedBanner | null {
  return licensePrompt?.('설정은 라이선스를 활성화한 뒤에 바꿀 수 있어요.', { label: '홈으로', onClick: onLeave }) ?? null;
}

/** 잠긴 동안 막힌 동작(새 문서 등)을 누르면 닫을 수 있는 체험 끝 카드를 띄운다. */
export function showLicenseRequiredPrompt(detail: string): TrialEndedBanner | null {
  return licensePrompt?.(detail) ?? null;
}

/** 구매를 권하는 단추들. 게이트가 상태를 받을 때마다 보이기를 맞춘다. 상태를 알기 전에는 숨긴다. */
const buyButtons = new Set<HTMLButtonElement>();
let openPricing: (() => void) | null = null;
let lastStatus: LicenseStatus | null = null;

/** 체험 중·체험 끝·해지된 키일 때만 보인다. 라이선스가 있으면 숨는다. */
function showsBuyButton(status: LicenseStatus): boolean {
  return status.state === 'trial' || status.state === 'trial_expired' || status.state === 'revoked';
}

/** 라이선스 구매 단추를 slot 에 둔다. 누르면 구매 페이지를 연다. */
export function mountLicenseBuyButton(slot: HTMLElement): void {
  const buy = document.createElement('button');
  buy.type = 'button';
  buy.className = 'license-buy';
  buy.textContent = '라이선스 구매';
  buy.hidden = !lastStatus || !showsBuyButton(lastStatus);
  buy.addEventListener('click', () => { openPricing?.(); });
  buyButtons.add(buy);
  slot.append(buy);
}

export interface LicenseGateOptions {
  /** 저장하지 않은 문서가 있는지 */
  hasUnsavedWork?: () => boolean;
  /**
   * 체험이 끝나 잠그기 전에 문서를 남긴다. 파일에 쓰기 직전마다 prepareWrite 를 부른다.
   * failed 는 남기지 못한 문서 수.
   */
  saveBeforeLock?: (prepareWrite: () => Promise<void>) => Promise<{ failed: number }>;
}

/**
 * 메인의 상태를 입력·명령·에이전트에 함께 적용한다. 상태를 읽기 전에는 편집을 잠근다.
 * 체험 중이거나 읽기 전용이면 메뉴 막대의 명령 검색 왼쪽에 상태 알약을 둔다. 누르면 활성화 창을 연다.
 * 체험이 끝나는 순간에는 바뀐 문서를 먼저 저장한 뒤 잠근다.
 * 라이선스가 읽기 전용이면 문서 보기 전용(license-viewer-mode)으로 두어 에이전트도 닫는다.
 * 상태를 확인하는 동안에는 편집만 잠그고 에이전트는 그대로 둔다.
 */
export async function installLicenseGate(
  setReadOnly: (value: boolean) => void,
  options: LicenseGateOptions = {},
): Promise<void> {
  const found = (window as unknown as DesktopHost).rhwpDesktop?.license;
  if (!found) return;
  const api = found;
  setReadOnly(true);
  openPricing = () => { void api.openPricing(); };

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'license-pill';
  const label = document.createElement('span');
  label.className = 'license-pill-label';
  label.setAttribute('role', 'status');
  const action = document.createElement('span');
  action.className = 'license-pill-action';
  pill.append(label, action);
  pill.addEventListener('click', () => { void api.openActivation(); });

  let current: LicenseStatus | null = null;
  let tick: number | undefined;
  /** 이 페이지가 체험 끝 처리를 시작했는지. 메인이 아직 'trial' 이라고 해도 잠근 채로 둔다. */
  let trialFinished = false;
  let savingAtLock: 'trial' | 'license' | null = null;
  let trialEndedBanner: TrialEndedBanner | null = null;

  licensePrompt = (detail, leave) => {
    trialEndedBanner?.dismiss();
    const expired = current?.state === 'trial_expired' || (trialFinished && current?.state === 'trial');
    const prompt = showTrialEndedBanner({
      title: expired ? '체험이 끝났어요' : '라이선스를 확인해 주세요',
      detail,
      onActivate: () => { void api.openActivation(); },
      onPurchase: () => { void api.openPricing(); },
      leave,
    });
    trialEndedBanner = prompt;
    return prompt;
  };

  function mount(): void {
    if (pill.isConnected) return;
    const search = document.getElementById('editor-command-search');
    if (search?.parentElement) search.before(pill);
    else document.getElementById('menu-bar')?.append(pill);
  }

  function show(text: string, actionText: string, readOnly: boolean, hint = ''): void {
    label.textContent = text;
    action.textContent = actionText;
    action.hidden = !actionText;
    pill.classList.toggle('license-pill-read-only', readOnly);
    pill.title = hint;
    pill.setAttribute('aria-label', [text, actionText].filter(Boolean).join(', '));
    mount();
  }

  function locked(status: LicenseStatus): boolean {
    return !status.canEdit || (trialFinished && status.state === 'trial');
  }

  function paint(): void {
    window.clearTimeout(tick);
    tick = undefined;
    const status = current;
    if (!status) return;
    if (savingAtLock) {
      show(savingAtLock === 'trial' ? '체험 끝 · 저장 중' : '읽기 전용 · 저장 중', '', true);
      return;
    }
    if (status.state === 'trial' && !trialFinished) {
      const now = Date.now();
      if (status.trial.endsAt - now <= EXPIRY_SAVE_LEAD_MS) {
        void saveAndLock('trial');
        return;
      }
      show(`체험 ${trialTimeLeft(status.trial.endsAt, now)} 남음`, '활성화', false, licenseSummary(status, now).detail);
      // 자동 저장 시작 시각을 넘기지 않게 깬다.
      const untilSave = status.trial.endsAt - EXPIRY_SAVE_LEAD_MS - now;
      tick = window.setTimeout(paint, Math.min(msUntilNextTrialTick(status.trial.endsAt, now), untilSave) + 20);
      return;
    }
    if (trialFinished && status.state === 'trial') {
      show('체험 끝 · 읽기 전용', '활성화', true);
      return;
    }
    if (status.canEdit) {
      pill.remove();
      return;
    }
    const summary = licenseSummary(status);
    show(summary.title, status.state === 'lease_expired' ? '확인' : '활성화', true, summary.detail);
  }

  /**
   * 편집할 수 있다가 잠기는 순간 한 번 돈다. 새 편집을 먼저 막고, 바뀐 문서를 저장한 뒤 읽기 전용으로 둔다.
   * - trial: 체험이 끝나는 순간(또는 잠자기에서 깨어 이미 끝난 것을 안 순간).
   * - license: 이 창이 켜져 있는 동안 해지·lease 만료·재활성화 필요로 잠긴 순간.
   */
  async function saveAndLock(kind: 'trial' | 'license'): Promise<void> {
    if (savingAtLock) return;
    if (kind === 'trial') {
      if (trialFinished) return;
      trialFinished = true;
    }
    setReadOnly(true);
    setLicenseViewerMode(true);
    const endsAt = current?.trial.endsAt ?? 0;
    let failed = 0;
    if (options.saveBeforeLock && options.hasUnsavedWork?.()) {
      savingAtLock = kind;
      paint();
      // 잠긴 뒤에 쓰는 저장은 메인에서 한 번만 받는 유예가 있어야 한다. 체험은 기한 전에 시작하면 필요 없다.
      const prepareWrite = async () => {
        if (kind === 'license' || Date.now() >= endsAt - 500) await api.beginExpirySave?.().catch(() => null);
      };
      try {
        failed = (await options.saveBeforeLock(prepareWrite)).failed;
      } catch (error) {
        console.warn('[license] 잠기기 전 자동 저장 실패:', error);
        failed = 1;
      }
      savingAtLock = null;
    }
    paint();
    // 체험이 끝나는 순간에만 배너를 띄운다. 이미 끝난 채로 켜면 메인이 활성화 창을 연다.
    if (kind === 'trial') {
      trialEndedBanner = showTrialEndedBanner({
        onActivate: () => { void api.openActivation(); },
        onPurchase: () => { void api.openPricing(); },
      });
    }
    if (failed > 0) {
      const reason = kind === 'trial' ? '체험이 끝나' : '읽기 전용이 되어';
      showToast({ message: `${reason} 저장하지 못한 문서가 ${failed}개 있어요.`, durationMs: 6000 });
    }
  }

  function render(status: LicenseStatus): void {
    const previous = current;
    current = status;
    lastStatus = status;
    for (const buy of buyButtons) buy.hidden = !showsBuyButton(status);
    // 잠자기에서 깨어 메인이 먼저 기한을 알려 온 경우에도 저장부터 한다.
    if (status.state === 'trial_expired' && previous?.state === 'trial' && !trialFinished) {
      void saveAndLock('trial');
      return;
    }
    // 해지 등으로 편집하던 창이 잠기면 같은 방법으로 먼저 남긴다.
    if (!status.canEdit && previous?.canEdit && status.state !== 'trial_expired') {
      void saveAndLock('license');
      return;
    }
    // 활성화하면 다시 편집할 수 있다.
    if (status.canEdit && status.state !== 'trial') {
      trialFinished = false;
      trialEndedBanner?.dismiss();
      trialEndedBanner = null;
    }
    const readOnly = locked(status);
    setReadOnly(readOnly);
    setLicenseViewerMode(readOnly);
    paint();
  }

  // 잠자기·창 숨김 동안 밀린 타이머를 기다리지 않고 바로 다시 그린다.
  const refresh = () => { if (document.visibilityState === 'visible') paint(); };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);

  show('라이선스 확인 중', '', true);
  let receivedChange = false;
  const unsubscribe = api.onChange(status => { receivedChange = true; render(status); });
  window.addEventListener('pagehide', () => {
    unsubscribe();
    window.clearTimeout(tick);
  }, { once: true });
  try {
    const initial = await api.getStatus();
    if (!receivedChange) render(initial);
  } catch {
    setLicenseViewerMode(true);
    show('라이선스 확인 실패 · 읽기 전용', '활성화', true);
  }
}
