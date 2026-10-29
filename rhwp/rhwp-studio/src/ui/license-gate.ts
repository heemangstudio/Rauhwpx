import type { DesktopHost } from '../desktop-integration';
import { licenseSummary, looksLikeFullKey, renewalPrompt, type DesktopLicenseApi, type LicenseStatus } from './agent-sidebar/settings-license';
import { markLicensedHere } from './initial-setup/active';
import { createRenewalNotice } from './license-renewal-notice';
import { showToast } from './toast';
import './license-gate.css';

/** 라이선스 등록 단추들. 게이트가 상태를 받을 때마다 보이기를 맞춘다. 상태를 알기 전에는 숨긴다. */
const registerButtons = new Set<HTMLElement>();
let licenseApi: DesktopLicenseApi | null = null;
let lastStatus: LicenseStatus | null = null;

/** 키가 없거나, 해지됐거나, 기간이 끝난 연간 키일 때만 보인다. 라이선스가 있으면 숨는다. */
function showsRegisterButton(status: LicenseStatus): boolean {
  return status.state === 'free' || status.state === 'revoked' || status.state === 'expired';
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

/** 키를 넣었지만 확인하지 못한 상태. 메뉴 막대에 알약을 둔다. 편집은 막지 않는다. */
function showsPill(status: LicenseStatus): boolean {
  return status.state === 'lease_expired' || status.state === 'needs_activation';
}

/**
 * 메인의 라이선스 상태를 화면에 반영한다. 편집은 막지 않는다.
 * 키를 넣었지만 확인하지 못했으면 메뉴 막대의 명령 검색 왼쪽에 알약을 둔다. 누르면 활성화 창을 연다.
 * 결제가 실패했거나 기간이 끝난 연간 키는 오른쪽 아래에 연장 안내를 띄운다.
 */
export async function installLicenseGate(): Promise<void> {
  const found = (window as unknown as DesktopHost).rhwpDesktop?.license;
  if (!found) return;
  const api = found;
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

  let pillObserver: ResizeObserver | null = null;
  const renewalNotice = createRenewalNotice();
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

  function show(text: string, actionText: string, hint = ''): void {
    label.textContent = text;
    action.textContent = actionText;
    action.hidden = !actionText;
    pill.title = hint;
    pill.setAttribute('aria-label', [text, actionText].filter(Boolean).join(', '));
    mount();
    // 글자가 바뀌면 알약 폭도 바뀐다. ResizeObserver 알림을 기다리지 않고 바로 다시 잰다.
    measurePillReserve();
  }

  /** 결제가 실패한 동안과 기간이 끝난 뒤 오른쪽 아래에 연장 안내를 띄운다. */
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
    lastStatus = status;
    for (const register of registerButtons) register.hidden = !showsRegisterButton(status);
    paintRenewalNotice(status);
    if (!showsPill(status)) {
      unmount();
      return;
    }
    const summary = licenseSummary(status);
    show(summary.title, status.state === 'lease_expired' ? '확인' : '활성화', summary.detail);
  }

  let receivedChange = false;
  const unsubscribe = api.onChange(status => { receivedChange = true; render(status); });
  window.addEventListener('pagehide', () => {
    unsubscribe();
    pillObserver?.disconnect();
  }, { once: true });
  try {
    const initial = await api.getStatus();
    if (!receivedChange) render(initial);
  } catch {
    // 상태를 읽지 못해도 편집기는 그대로 쓴다.
  }
}
