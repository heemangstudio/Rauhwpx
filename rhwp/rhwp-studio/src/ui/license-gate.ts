import type { DesktopHost } from '../desktop-integration';
import { licenseSummary, msUntilNextTrialTick, trialTimeLeft, type LicenseStatus } from './agent-sidebar/settings-license';
import { showToast } from './toast';
import { setLicenseViewerMode } from './license-viewer-mode';
import './license-gate.css';

/** 체험이 끝나기 이만큼 전에 자동 저장을 시작한다. 이 저장은 메인이 기한 전에 받는다. */
const EXPIRY_SAVE_LEAD_MS = 5_000;

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
  let savingAtExpiry = false;

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
    if (savingAtExpiry) {
      show('체험 끝 · 저장 중', '', true);
      return;
    }
    if (status.state === 'trial' && !trialFinished) {
      const now = Date.now();
      if (status.trial.endsAt - now <= EXPIRY_SAVE_LEAD_MS) {
        void finishTrial();
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
   * 체험이 끝나는 순간(또는 잠자기에서 깨어 이미 끝난 것을 안 순간) 한 번 돈다.
   * 새 편집을 먼저 막고, 바뀐 문서를 저장한 뒤 읽기 전용으로 둔다.
   */
  async function finishTrial(): Promise<void> {
    if (trialFinished) return;
    trialFinished = true;
    setReadOnly(true);
    setLicenseViewerMode(true);
    const endsAt = current?.trial.endsAt ?? 0;
    let failed = 0;
    if (options.saveBeforeLock && options.hasUnsavedWork?.()) {
      savingAtExpiry = true;
      paint();
      // 기한이 지난 뒤에 쓰는 저장은 메인에서 한 번만 받는 유예가 있어야 한다.
      const prepareWrite = async () => {
        if (Date.now() >= endsAt - 500) await api.beginExpirySave?.().catch(() => null);
      };
      try {
        failed = (await options.saveBeforeLock(prepareWrite)).failed;
      } catch (error) {
        console.warn('[license] 체험 종료 자동 저장 실패:', error);
        failed = 1;
      }
      savingAtExpiry = false;
    }
    paint();
    if (failed > 0) {
      showToast({ message: `체험이 끝나 저장하지 못한 문서가 ${failed}개 있어요.`, durationMs: 6000 });
    }
  }

  function render(status: LicenseStatus): void {
    const previous = current;
    current = status;
    // 잠자기에서 깨어 메인이 먼저 기한을 알려 온 경우에도 저장부터 한다.
    if (status.state === 'trial_expired' && previous?.state === 'trial' && !trialFinished) {
      void finishTrial();
      return;
    }
    // 활성화하면 다시 편집할 수 있다.
    if (status.canEdit && status.state !== 'trial') trialFinished = false;
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
