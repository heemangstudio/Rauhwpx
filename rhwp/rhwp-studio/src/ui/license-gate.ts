import type { DesktopHost } from '../desktop-integration';
import { licenseSummary, looksLikeFullKey, msUntilNextTrialTick, renewalPrompt, trialTimeLeft, type DesktopLicenseApi, type LicenseStatus } from './agent-sidebar/settings-license';
import { markLicensedHere } from './initial-setup/active';
import { createRenewalNotice } from './license-renewal-notice';
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

/** 라이선스 등록 단추들. 게이트가 상태를 받을 때마다 보이기를 맞춘다. 상태를 알기 전에는 숨긴다. */
const registerButtons = new Set<HTMLElement>();
let licenseApi: DesktopLicenseApi | null = null;
let lastStatus: LicenseStatus | null = null;

/** 체험 중·체험 끝·해지된 키·기간이 끝난 연간 키일 때만 보인다. 라이선스가 있으면 숨는다. */
function showsRegisterButton(status: LicenseStatus): boolean {
  return status.state === 'trial' || status.state === 'trial_expired' || status.state === 'revoked' || status.state === 'expired';
}

/**
 * 라이선스 등록 단추를 slot 에 둔다. 누르면 아래에 키 칸이 열려 그 자리에서 활성화한다.
 * 키를 다 붙여 넣으면 누르지 않아도 확인하고, 키가 없으면 구매 페이지로 가는 길을 둔다.
 */
export function mountLicenseRegisterButton(slot: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'license-register';
  wrap.hidden = !lastStatus || !showsRegisterButton(lastStatus);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'license-register-toggle';
  toggle.textContent = '라이선스 등록';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'license-register-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '라이선스 등록');
  pop.hidden = true;
  const form = document.createElement('form');
  form.className = 'license-register-form';
  form.noValidate = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'license-register-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'characters');
  input.placeholder = '라이선스 키 붙여넣기';
  input.setAttribute('aria-label', '라이선스 키');
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'license-register-submit';
  submitButton.textContent = '활성화';
  form.append(input, submitButton);
  const note = document.createElement('p');
  note.className = 'license-register-note';
  note.setAttribute('role', 'alert');
  const buyRow = document.createElement('p');
  buyRow.className = 'license-register-buy';
  const buy = document.createElement('button');
  buy.type = 'button';
  buy.className = 'license-register-buy-link';
  buy.textContent = '구매하기';
  buy.addEventListener('click', () => { void licenseApi?.openPricing(); });
  buyRow.append('키가 없나요? ', buy);
  pop.append(form, note, buyRow);
  wrap.append(toggle, pop);

  let busy = false;
  function render(): void {
    input.disabled = busy;
    submitButton.disabled = busy || !input.value.trim();
    submitButton.setAttribute('aria-busy', busy ? 'true' : 'false');
    note.hidden = !note.textContent;
  }

  function onOutside(event: PointerEvent): void {
    if (!wrap.contains(event.target as Node)) setOpen(false);
  }
  let open = false;
  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    pop.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      note.textContent = '';
      render();
      document.addEventListener('pointerdown', onOutside, true);
      input.focus();
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
    }
  }

  async function submit(): Promise<void> {
    const key = input.value.trim();
    if (!key || busy || !licenseApi) return;
    busy = true;
    note.textContent = '';
    render();
    try {
      const result = await licenseApi.activate(key);
      busy = false;
      if (result.ok) {
        input.value = '';
        markLicensedHere();
        setOpen(false);
        render();
        showToast({ message: '라이선스가 활성화됐어요.', durationMs: 4000 });
        return;
      }
      note.textContent = result.message ?? '키를 확인하지 못했어요. 다시 넣어 주세요.';
    } catch {
      busy = false;
      note.textContent = '라이선스 서버에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.';
    }
    render();
    input.focus();
    input.select();
  }

  toggle.addEventListener('click', () => setOpen(!open));
  pop.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setOpen(false);
    toggle.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener('input', render);
  // 구매 페이지에서 복사한 키를 붙여 넣으면 누르지 않아도 바로 확인한다.
  input.addEventListener('paste', () => {
    window.setTimeout(() => {
      if (looksLikeFullKey(input.value)) void submit();
    }, 0);
  });

  registerButtons.add(wrap);
  slot.append(wrap);
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
  licenseApi = api;

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
  let pillObserver: ResizeObserver | null = null;
  const renewalNotice = createRenewalNotice();
  /** 이 페이지가 체험 끝 처리를 시작했는지. 메인이 아직 'trial' 이라고 해도 잠근 채로 둔다. */
  let trialFinished = false;
  /** 기한 5초 전에 시작한 자동 저장. 끝나는 순간에 기다린다. */
  let expirySave: Promise<number> | null = null;
  let savingAtLock: 'trial' | 'license' | null = null;
  let trialEndedBanner: TrialEndedBanner | null = null;

  licensePrompt = (detail, leave) => {
    trialEndedBanner?.dismiss();
    const expired = current?.state === 'trial_expired' || (trialFinished && current?.state === 'trial');
    const prompt = showTrialEndedBanner({
      title: expired ? '체험이 끝났어요' : current?.state === 'expired' ? '라이선스 기간이 끝났어요' : '라이선스를 확인해 주세요',
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
    const bar = search?.parentElement ?? document.getElementById('menu-bar');
    if (!bar) return;
    // 검색 바로 왼쪽의 자동 수정 단추와 검색 사이에 끼지 않고, 그 묶음 앞에 선다.
    const autofix = search?.previousElementSibling?.id === 'editor-autofix-manual' ? search.previousElementSibling : null;
    if (search) (autofix ?? search).before(pill);
    else bar.append(pill);
    bar.classList.add('has-license-pill');
    measurePillReserve();
    if (typeof ResizeObserver !== 'undefined' && !pillObserver) {
      pillObserver = new ResizeObserver(measurePillReserve);
      pillObserver.observe(bar);
      pillObserver.observe(pill);
    }
  }

  function unmount(): void {
    const bar = pill.parentElement;
    pill.remove();
    pillObserver?.disconnect();
    pillObserver = null;
    bar?.classList.remove('has-license-pill');
    bar?.style.removeProperty('--license-pill-reserve');
  }

  /**
   * 통합 제목 막대는 파일 이름을 창 가운데에 절대 배치한다. 오른쪽에 붙는 알약·검색
   * 묶음의 실제 폭을 CSS 에 넘겨, 이름이 알약 위로 겹치지 않게 양쪽 여백을 비운다.
   */
  function measurePillReserve(): void {
    const bar = pill.parentElement;
    if (!bar || !pill.isConnected) return;
    const reserve = Math.max(0, Math.ceil(bar.getBoundingClientRect().right - pill.getBoundingClientRect().left));
    bar.style.setProperty('--license-pill-reserve', `${reserve}px`);
  }

  function show(text: string, actionText: string, readOnly: boolean, hint = ''): void {
    label.textContent = text;
    action.textContent = actionText;
    action.hidden = !actionText;
    pill.classList.toggle('license-pill-read-only', readOnly);
    pill.title = hint;
    pill.setAttribute('aria-label', [text, actionText].filter(Boolean).join(', '));
    mount();
    // 글자가 바뀌면 알약 폭도 바뀐다. ResizeObserver 알림을 기다리지 않고 바로 다시 잰다.
    measurePillReserve();
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
      show(savingAtLock === 'trial' ? '체험 끝, 저장 중' : '읽기 전용, 저장 중', '', true);
      return;
    }
    if (status.state === 'trial' && !trialFinished) {
      const now = Date.now();
      const remaining = status.trial.endsAt - now;
      if (remaining <= 0) {
        void lockTrialEnded();
        return;
      }
      // 기한 5초 전부터 자동 저장만 시작한다. 저장 요청이 기한 전에 메인에 닿아야 한다.
      // 잠금과 체험 끝 카드는 실제로 끝나는 순간까지 미룬다.
      if (remaining <= EXPIRY_SAVE_LEAD_MS) startExpirySave();
      show(`체험 ${trialTimeLeft(status.trial.endsAt, now)} 남음`, '활성화', false, licenseSummary(status, now).detail);
      tick = window.setTimeout(paint, Math.min(msUntilNextTrialTick(status.trial.endsAt, now), remaining) + 20);
      return;
    }
    if (trialFinished && status.state === 'trial') {
      show('읽기 전용', '활성화', true);
      return;
    }
    if (status.canEdit) {
      unmount();
      return;
    }
    const summary = licenseSummary(status);
    // 연간 키 만료는 알약에서 '기간 끝 ·'을 빼고 짧게 둔다. 설정에는 '기간 끝 · 읽기 전용'이 남는다.
    const title = status.state === 'expired' ? '읽기 전용' : summary.title;
    show(title, status.state === 'lease_expired' ? '확인' : '활성화', true, summary.detail);
  }

  /**
   * 기한 5초 전에 자동 저장만 시작한다. 잠그거나 카드를 띄우지 않는다.
   * 저장 요청이 기한 전에 메인에 닿아야 끝난 뒤에도 쓰기를 받아 준다.
   */
  function startExpirySave(): void {
    if (expirySave) return;
    if (!options.saveBeforeLock || !options.hasUnsavedWork?.()) return;
    const endsAt = current?.trial.endsAt ?? 0;
    expirySave = options.saveBeforeLock(async () => {
      // 기한에 붙어 시작하면 메인의 자동 저장 유예를 받는다. 그 전이면 요청 시각으로 받는다.
      if (Date.now() >= endsAt - 500) await api.beginExpirySave?.().catch(() => null);
    }).then(
      ({ failed }) => failed,
      (error) => {
        console.warn('[license] 체험 끝 전 자동 저장 실패:', error);
        return 1;
      },
    );
  }

  /**
   * 체험이 실제로 끝난 순간 한 번 돈다. 새 편집을 막고, 5초 전에 시작한 저장을 기다린 뒤
   * 마지막 순간에 바뀐 문서까지 남기고 읽기 전용으로 둔다. 그다음에 체험 끝 카드를 띄운다.
   */
  async function lockTrialEnded(): Promise<void> {
    if (trialFinished) return;
    trialFinished = true;
    setReadOnly(true);
    setLicenseViewerMode(true);
    const pending = expirySave;
    let failed = 0;
    if (pending || (options.saveBeforeLock && options.hasUnsavedWork?.())) {
      savingAtLock = 'trial';
      paint();
      failed = pending ? await pending : 0;
      if (options.saveBeforeLock && options.hasUnsavedWork?.()) {
        try {
          failed = (await options.saveBeforeLock(async () => {
            await api.beginExpirySave?.().catch(() => null);
          })).failed;
        } catch (error) {
          console.warn('[license] 체험 끝 자동 저장 실패:', error);
          failed = 1;
        }
      }
      savingAtLock = null;
    }
    paint();
    trialEndedBanner = showTrialEndedBanner({
      onActivate: () => { void api.openActivation(); },
      onPurchase: () => { void api.openPricing(); },
    });
    if (failed > 0) {
      showToast({ message: `체험이 끝나 저장하지 못한 문서가 ${failed}개 있어요.`, durationMs: 6000 });
    }
  }

  /**
   * 이 창이 켜져 있는 동안 해지·lease 만료·재활성화 필요로 잠기는 순간 한 번 돈다.
   * 새 편집을 먼저 막고, 바뀐 문서를 저장한 뒤 읽기 전용으로 둔다.
   */
  async function lockForLicense(): Promise<void> {
    if (savingAtLock) return;
    setReadOnly(true);
    setLicenseViewerMode(true);
    let failed = 0;
    if (options.saveBeforeLock && options.hasUnsavedWork?.()) {
      savingAtLock = 'license';
      paint();
      try {
        failed = (await options.saveBeforeLock(async () => {
          await api.beginExpirySave?.().catch(() => null);
        })).failed;
      } catch (error) {
        console.warn('[license] 잠기기 전 자동 저장 실패:', error);
        failed = 1;
      }
      savingAtLock = null;
    }
    paint();
    if (failed > 0) {
      showToast({ message: `읽기 전용이 되어 저장하지 못한 문서가 ${failed}개 있어요.`, durationMs: 6000 });
    }
  }

  /** 결제가 실패한 동안(편집됨)과 기간이 끝난 뒤(읽기 전용) 오른쪽 아래에 연장 안내를 띄운다. */
  function paintRenewalNotice(status: LicenseStatus): void {
    const prompt = renewalPrompt(status);
    renewalNotice.show(prompt ? {
      id: `${prompt.kind}:${status.license?.paymentGraceEndsAt ?? status.license?.licenseExpiresAt ?? ''}`,
      title: prompt.title,
      detail: prompt.detail,
      action: prompt.action,
      onAction: () => { void (api.openPaymentFix ? api.openPaymentFix() : api.openPricing()); },
      // 끝난 구독은 Groble에서 다시 살릴 수 없을 때가 있어 새로 구매하는 길도 둔다.
      secondary: prompt.kind === 'lapsed' ? { label: '새로 구매하기', onClick: () => { void api.openPricing(); } } : undefined,
    } : null);
  }

  function render(status: LicenseStatus): void {
    const previous = current;
    current = status;
    lastStatus = status;
    for (const register of registerButtons) register.hidden = !showsRegisterButton(status);
    paintRenewalNotice(status);
    // 잠자기에서 깨어 메인이 먼저 기한을 알려 온 경우에도 저장부터 한다.
    if (status.state === 'trial_expired' && previous?.state === 'trial' && !trialFinished) {
      void lockTrialEnded();
      return;
    }
    // 해지 등으로 편집하던 창이 잠기면 같은 방법으로 먼저 남긴다.
    if (!status.canEdit && previous?.canEdit && status.state !== 'trial_expired') {
      void lockForLicense();
      return;
    }
    // 활성화하면 다시 편집할 수 있다.
    if (status.canEdit && status.state !== 'trial') {
      trialFinished = false;
      expirySave = null;
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
    pillObserver?.disconnect();
  }, { once: true });
  try {
    const initial = await api.getStatus();
    if (!receivedChange) render(initial);
  } catch {
    setLicenseViewerMode(true);
    show('라이선스 확인 실패, 읽기 전용', '활성화', true);
  }
}
