// 계정 화면. 홈에서는 별도로 열고, 설정에서는 계정 탭 안에 붙인다.
// 로그아웃이면 로그인 판만, 로그인했으면 한 단의 프로필 화면(사진·이름·이메일, 요금제, 사용량, 기기, 라이선스,
// 로그아웃·계정 삭제)을 보인다. 동작마다 그 단추에 진행을 보이고 오류는 그 옆에 한 줄로 둔다.
// 어디서든 window 의 'rhwp:open-account' 이벤트로 연다(detail.section 으로 갈 곳을 짚는다).
import '../agent-sidebar/sheet.css';
import './account-page.css';
import loginNeurons from './login-neurons.txt?raw';
import { createIcon } from '../agent-sidebar/icons.ts';
import { createSheetFrame } from '../agent-sidebar/sheet.ts';
import { createHamaMark } from '../plan/hama-mark.ts';
import { createHamaScene } from '../plan/hama-scene.ts';
import { PLAN_CYCLES, planPrice, planSkuAvailable, upgradeFamilies, won, type PlanFamily } from '../plan/plan-offers.ts';
import { sharedPlanStore, type PlanStore } from '../plan/plan-store.ts';
import type { PlanSku } from '../plan/plan-types.ts';
import {
  ACCOUNT_TIER_LABEL,
  deleteConfirmMatches,
  formatLastSeen,
  formatShortDate,
  hamaUsageRatio,
  licenseLine,
  licenseStatusLabel,
  paymentFailedLine,
  planCycleLabel,
  planTermLine,
  platformLabel,
  usd,
  validateAccountName,
  NAME_MAX,
} from './account-format.ts';
import { createAvatar, platformGlyph } from './account-glyphs.ts';
import {
  ACCOUNT_SECTIONS,
  OPEN_ACCOUNT_EVENT,
  accountStore,
  isSignedIn,
  type AccountSection,
  type AccountStore,
} from './account-store.ts';
import type { AccountDevice, AccountLicense, AccountResult, AccountStatus } from './account-types.ts';
import { prepareAvatar } from './avatar-image.ts';
import { createSignInPanel, setBusy } from './sign-in-panel.ts';
import { openPostLogin } from './post-login.ts';


export interface AccountPageOptions {
  store?: AccountStore;
  /** 요금제 칸의 결제 단추. 없으면 결제 단추를 두지 않는다. */
  plan?: PlanStore | null;
  section?: AccountSection;
  /** 이 페이지에서 로그인을 마치면 페이지를 닫고 부른다(요금제 카드로 돌아가기). */
  onSignedIn?: () => void;
  /** 설정의 계정 탭 안에 붙인다. 별도 창·대화상자를 열지 않는다. */
  container?: HTMLElement;
}

export interface AccountPageHandle {
  close(): void;
  closed: Promise<void>;
}

let openPage: { handle: AccountPageHandle; reveal(options: AccountPageOptions): void } | null = null;

export function isAccountPageOpen(): boolean {
  return openPage !== null;
}

export function closeAccountPage(): void {
  openPage?.handle.close();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text = ''): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function alertLine(): HTMLParagraphElement {
  const line = el('p', 'acct-error');
  line.setAttribute('role', 'alert');
  line.hidden = true;
  return line;
}

function say(line: HTMLElement, text: string): void {
  line.textContent = text;
  line.hidden = !text;
}

function section(name: string, label: string): { root: HTMLElement; head: HTMLElement } {
  const root = el('section', 'acct-section');
  root.dataset.section = name;
  const head = el('div', 'acct-section-head');
  const title = el('h2', 'acct-label', label);
  title.id = `acct-section-${name}`;
  root.setAttribute('aria-labelledby', title.id);
  head.append(title);
  root.append(head);
  return { root, head };
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 시트(계정 삭제 확인, 요금제 카드)가 위에 떠 있으면 키는 그쪽 몫이다. */
function sheetAbove(): boolean {
  return document.querySelector('.ag-sheet-layer:not(.ag-sheet-closing)') !== null;
}

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null);
}

/** 열린 페이지가 있으면 그 페이지를 짚고, 없으면 새로 연다. 계정 API 가 없으면 열지 않는다. */
export function openAccountPage(options: AccountPageOptions = {}): AccountPageHandle | null {
  const store = options.store ?? accountStore();
  if (!store.api) return null;
  if (openPage && !options.container) {
    openPage.reveal(options);
    return openPage.handle;
  }
  const api = store.api;
  const embedded = !!options.container;
  let plan = options.plan ?? sharedPlanStore();
  let onSignedIn = options.onSignedIn;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const layer = el('div', 'acct-layer');
  const page = el('div', 'acct-page');
  if (embedded) {
    layer.classList.add('acct-embedded-layer');
    page.classList.add('acct-embedded');
  }
  // 제품 웹사이트의 한글 뉴런 그림을 로그인 배경으로 옅게 쓴다.
  const art = el('pre', 'acct-login-art', loginNeurons);
  art.setAttribute('aria-hidden', 'true');
  layer.append(page);
  page.setAttribute('role', embedded ? 'region' : 'dialog');
  if (!embedded) page.setAttribute('aria-modal', 'true');
  page.setAttribute('aria-label', '계정');
  const bar = el('div', 'acct-bar');
  const back = button('acct-back');
  back.setAttribute('aria-label', '돌아가기');
  back.title = '돌아가기';
  back.append(createIcon('browserBack'));
  bar.append(back);
  const scroll = el('div', 'acct-scroll');
  const column = el('div', 'acct-column');
  scroll.append(column);
  page.append(art, bar, scroll);

  const signIn = createSignInPanel(store, { variant: 'page' });
  const signed = el('div', 'acct-signed');
  column.append(signIn.element, signed);

  // ── 프로필 ──────────────────────────────────────────
  const profile = el('header', 'acct-profile');
  const avatarButton = button('acct-profile-avatar');
  avatarButton.setAttribute('aria-label', '사진 변경');
  const avatar = createAvatar('acct-avatar-large');
  avatarButton.append(avatar.element);
  const fileInput = el('input', 'acct-file');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  const profileCopy = el('div', 'acct-profile-copy');
  const nameRow = el('div', 'acct-name-row');
  const nameText = el('h1', 'acct-name');
  const nameEdit = button('acct-icon-btn acct-name-edit');
  nameEdit.setAttribute('aria-label', '이름 바꾸기');
  nameEdit.title = '이름 바꾸기';
  nameEdit.append(createIcon('pencil'));
  nameRow.append(nameText, nameEdit);
  const nameForm = el('form', 'acct-name-form');
  nameForm.noValidate = true;
  nameForm.hidden = true;
  const nameInput = el('input', 'acct-input acct-name-input');
  nameInput.type = 'text';
  nameInput.autocomplete = 'name';
  nameInput.maxLength = NAME_MAX + 10;
  nameInput.setAttribute('aria-label', '이름');
  const nameSave = el('button', 'acct-btn acct-btn-primary', '저장');
  nameSave.type = 'submit';
  const nameCancel = button('acct-btn acct-btn-quiet', '취소');
  nameForm.append(nameInput, nameSave, nameCancel);
  const nameError = alertLine();
  const emailRow = el('p', 'acct-email-row');
  const emailText = el('span', 'acct-email');
  const offline = el('span', 'acct-offline', '오프라인');
  emailRow.append(emailText, offline);
  const photoActions = el('div', 'acct-photo-actions');
  const photoChange = button('acct-link', '사진 변경');
  const photoRemove = button('acct-link', '사진 삭제');
  photoActions.append(photoChange, photoRemove);
  const photoError = alertLine();
  profileCopy.append(nameRow, nameForm, nameError, emailRow, photoActions, photoError);
  profile.append(avatarButton, profileCopy, fileInput);

  // ── 요금제 ──────────────────────────────────────────
  const planSection = section('plan', '요금제');
  const planHead = el('div', 'acct-plan-head');
  const planName = el('p', 'acct-plan-name');
  const manage = button('acct-btn', '구독 관리');
  planHead.append(planName, manage);
  const planTerm = el('p', 'acct-meta acct-plan-term');
  const planAlert = el('div', 'acct-alert');
  const planAlertText = el('p', 'acct-alert-text');
  planAlertText.setAttribute('role', 'alert');
  const fixPayment = button('acct-btn acct-btn-primary', '결제 수단 바꾸기');
  planAlert.append(planAlertText, fixPayment);
  const offers = el('div', 'acct-offers');
  const planError = alertLine();
  planSection.root.append(planHead, planTerm, planAlert, offers, planError);

  // ── 사용량 ──────────────────────────────────────────
  const statsSection = section('stats', '사용량');
  const statsGrid = el('div', 'acct-stats');
  statsSection.root.append(statsGrid);

  // ── 기기 ────────────────────────────────────────────
  const devicesSection = section('devices', '기기');
  const deviceCount = el('span', 'acct-meta acct-count');
  devicesSection.head.append(deviceCount);
  const deviceList = el('ul', 'acct-device-list');
  const deviceError = alertLine();
  devicesSection.root.append(deviceList, deviceError);

  // ── 라이선스 ────────────────────────────────────────
  const licensesSection = section('licenses', '라이선스');
  const licenseList = el('ul', 'acct-license-list');
  const localKeyNote = el('p', 'acct-meta acct-local-key');
  const redeemForm = el('form', 'acct-inline-form acct-redeem');
  redeemForm.noValidate = true;
  const redeemInput = el('input', 'acct-input acct-key-input');
  redeemInput.type = 'text';
  redeemInput.autocomplete = 'off';
  redeemInput.spellcheck = false;
  redeemInput.setAttribute('autocapitalize', 'characters');
  redeemInput.placeholder = 'HAMA-…';
  redeemInput.setAttribute('aria-label', '라이선스 키');
  const redeemSubmit = el('button', 'acct-btn', '키 등록');
  redeemSubmit.type = 'submit';
  redeemForm.append(redeemInput, redeemSubmit);
  const redeemError = alertLine();
  const redeemNote = el('p', 'acct-meta acct-redeem-note');
  redeemNote.setAttribute('role', 'status');
  redeemNote.hidden = true;
  const claimToggle = button('acct-link acct-disclosure', '주문번호로 찾기');
  claimToggle.setAttribute('aria-expanded', 'false');
  claimToggle.setAttribute('aria-controls', 'acct-claim-form');
  const claimForm = el('form', 'acct-claim');
  claimForm.id = 'acct-claim-form';
  claimForm.noValidate = true;
  claimForm.hidden = true;
  const claimOrder = el('input', 'acct-input');
  claimOrder.type = 'text';
  claimOrder.autocomplete = 'off';
  claimOrder.spellcheck = false;
  claimOrder.placeholder = '주문번호';
  claimOrder.setAttribute('aria-label', '주문번호');
  const claimEmail = el('input', 'acct-input');
  claimEmail.type = 'email';
  claimEmail.autocomplete = 'email';
  claimEmail.spellcheck = false;
  claimEmail.placeholder = 'Groble 이메일';
  claimEmail.setAttribute('aria-label', 'Groble 이메일');
  const claimSubmit = el('button', 'acct-btn', '찾기');
  claimSubmit.type = 'submit';
  claimForm.append(claimOrder, claimEmail, claimSubmit);
  const claimError = alertLine();
  licensesSection.root.append(licenseList, localKeyNote, redeemForm, redeemError, redeemNote, claimToggle, claimForm, claimError);

  // ── 로그아웃·계정 삭제 ──────────────────────────────
  const exit = el('section', 'acct-section acct-exit');
  exit.setAttribute('aria-label', '로그아웃과 계정 삭제');
  const signOut = button('acct-btn', '로그아웃');
  const deleteAccount = button('acct-btn acct-btn-danger-quiet', '계정 삭제');
  const exitError = alertLine();
  const exitRow = el('div', 'acct-exit-row');
  exitRow.append(signOut, deleteAccount);
  exit.append(exitRow, exitError);

  signed.append(profile, planSection.root, statsSection.root, devicesSection.root, licensesSection.root, exit);

  // ── 상태 ────────────────────────────────────────────
  let nameEditing = false;
  let nameBusy = false;
  let photoBusy: 'set' | 'remove' | null = null;
  let checkoutBusy: PlanSku | null = null;
  let deviceConfirm: string | null = null;
  let deviceBusy: string | null = null;
  let redeemBusy = false;
  let claimBusy = false;
  let signOutBusy = false;
  let manageBusy = false;
  let deleting = false;

  const status = (): AccountStatus | null => store.status();

  /** 결과의 오류 글. 성공이면 빈 글. 던지면 연결 오류로 본다. */
  async function run(action: () => Promise<AccountResult>): Promise<string> {
    try {
      const result = await action();
      return result.ok ? '' : result.message;
    } catch {
      return '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.';
    }
  }

  async function openManage(control: HTMLButtonElement, errorLine: HTMLElement): Promise<void> {
    if (manageBusy) return;
    manageBusy = true;
    control.disabled = true;
    try {
      await api.openManage();
      say(errorLine, '');
    } catch {
      say(errorLine, '브라우저를 열지 못했어요.');
    } finally {
      manageBusy = false;
      control.disabled = false;
    }
  }

  function startNameEdit(): void {
    const account = status()?.account;
    if (!account) return;
    nameEditing = true;
    nameInput.value = account.name;
    say(nameError, '');
    render();
    nameInput.focus();
    nameInput.select();
  }

  function stopNameEdit(): void {
    nameEditing = false;
    say(nameError, '');
    render();
    nameEdit.focus();
  }

  async function saveName(): Promise<void> {
    if (nameBusy) return;
    const checked = validateAccountName(nameInput.value);
    if (!checked.ok) {
      say(nameError, checked.message);
      nameInput.focus();
      return;
    }
    if (checked.name === status()?.account?.name) {
      stopNameEdit();
      return;
    }
    nameBusy = true;
    render();
    const message = await run(() => api.updateName(checked.name));
    nameBusy = false;
    if (message) {
      say(nameError, message);
      render();
      nameInput.focus();
      return;
    }
    stopNameEdit();
  }

  async function changePhoto(file: File): Promise<void> {
    if (photoBusy) return;
    photoBusy = 'set';
    say(photoError, '');
    render();
    const prepared = await prepareAvatar(file);
    const message = prepared.ok ? await run(() => api.setAvatar(prepared.bytes, prepared.type)) : prepared.message;
    photoBusy = null;
    say(photoError, message);
    render();
  }

  async function removePhoto(): Promise<void> {
    if (photoBusy) return;
    photoBusy = 'remove';
    say(photoError, '');
    render();
    const message = await run(() => api.removeAvatar());
    photoBusy = null;
    say(photoError, message);
    render();
  }

  async function checkout(sku: PlanSku): Promise<void> {
    const planApi = plan?.api;
    if (!planApi || checkoutBusy) return;
    checkoutBusy = sku;
    say(planError, '');
    render();
    try {
      const result = await planApi.startCheckout(sku);
      if (result.code === 'sign_in_required') say(planError, '먼저 로그인해 주세요.');
      else if (!result.ok && result.code === 'not_available') say(planError, '아직 살 수 없는 요금제예요.');
    } catch {
      say(planError, '결제 페이지를 열지 못했어요.');
    } finally {
      checkoutBusy = null;
      render();
    }
  }

  async function cancelCheckout(control: HTMLButtonElement): Promise<void> {
    control.disabled = true;
    try { await plan?.api?.cancelCheckout(); } catch { /* 다음 상태가 다시 그린다 */ }
    render();
  }

  async function removeDevice(device: AccountDevice): Promise<void> {
    if (deviceBusy) return;
    deviceBusy = device.id;
    say(deviceError, '');
    render();
    const message = await run(() => api.removeDevice(device.id));
    deviceBusy = null;
    deviceConfirm = null;
    say(deviceError, message);
    render();
  }

  async function redeem(): Promise<void> {
    const key = redeemInput.value.trim();
    if (!key || redeemBusy) return;
    redeemBusy = true;
    say(redeemError, '');
    say(redeemNote, '');
    render();
    let alreadyLinked = false;
    const message = await run(async () => {
      const result = await api.redeem(key);
      alreadyLinked = result.ok && result.alreadyLinked;
      return result;
    });
    redeemBusy = false;
    if (!message) redeemInput.value = '';
    say(redeemError, message);
    say(redeemNote, alreadyLinked ? '이미 이 계정에 있는 키예요.' : '');
    render();
    if (message) redeemInput.focus();
  }

  async function claim(): Promise<void> {
    const orderId = claimOrder.value.trim();
    const email = claimEmail.value.trim();
    if (!orderId || !email || claimBusy) return;
    claimBusy = true;
    say(claimError, '');
    render();
    const message = await run(() => api.claim(orderId, email));
    claimBusy = false;
    if (!message) {
      claimOrder.value = '';
      claimEmail.value = '';
      claimForm.hidden = true;
      claimToggle.setAttribute('aria-expanded', 'false');
    }
    say(claimError, message);
    render();
  }

  async function doSignOut(): Promise<void> {
    if (signOutBusy) return;
    signOutBusy = true;
    say(exitError, '');
    render();
    const message = await run(() => api.signOut());
    signOutBusy = false;
    say(exitError, message);
    render();
  }

  // ── 그리기 ──────────────────────────────────────────
  function planNameNode(current: AccountStatus): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const tier = current.plan.tier;
    if (tier === 'hama') fragment.append(createHamaMark('acct-hama-mark'));
    fragment.append(el('span', 'acct-plan-current', '현재 요금제'), el('span', 'acct-plan-tier', ACCOUNT_TIER_LABEL[tier]));
    const cycle = planCycleLabel(current.plan);
    if (cycle) fragment.append(el('span', 'acct-plan-cycle', cycle));
    return fragment;
  }

  /** 결제를 기다리는 동안 결제 단추 자리에 둔다. */
  function checkoutWait(): HTMLElement[] {
    const waiting = el('span', 'acct-offer-wait');
    waiting.setAttribute('role', 'status');
    const spin = el('span', 'ui-spinner');
    spin.setAttribute('aria-hidden', 'true');
    waiting.append(spin, el('span', '', '결제 확인 중'));
    const cancel = button('acct-btn acct-btn-quiet', '취소');
    cancel.addEventListener('click', () => { void cancelCheckout(cancel); });
    return [waiting, cancel];
  }

  /** 두 요금제를 같은 크기로 비교하고 Pro 를 먼저 둔다. */
  function offerRow(family: PlanFamily): HTMLElement {
    const planStatus = plan?.status() ?? null;
    const { monthly, yearly } = PLAN_CYCLES[family];
    const row = el('div', `acct-offer${family === 'hama' ? ' acct-hama-offer' : ''}`);
    row.dataset.plan = family;
    const head = el('div', 'acct-offer-head');
    head.append(el('h3', 'acct-offer-name', family === 'basic' ? 'Basic' : 'Hama'));
    if (family === 'hama') head.append(createHamaScene('acct-hama-scene'));
    const copy = el('p', 'acct-offer-description', family === 'basic'
      ? '내 Codex·Claude를 연결해 문서 작업을 함께해요.'
      : '별도 AI 연결 없이 Hama와 바로 시작해요.');
    const monthlyPrice = planPrice(planStatus, monthly);
    const yearlyPrice = planPrice(planStatus, yearly);
    const price = el('p', 'acct-offer-price');
    if (monthlyPrice !== null) price.append(el('strong', '', won(monthlyPrice)), el('span', '', ' / 월'));
    const annual = el('p', 'acct-offer-annual', yearlyPrice === null ? '' : `연간 ${won(yearlyPrice)}`);
    const actions = el('div', 'acct-offer-actions');
    const pending = planStatus?.pendingCheckout?.sku;
    if (pending === monthly || pending === yearly) actions.append(...checkoutWait());
    else {
      const skus = [monthly, yearly].filter((sku) => planSkuAvailable(planStatus, sku));
      if (skus.length === 0) {
        const soon = button('acct-btn', '곧 출시');
        soon.disabled = true;
        actions.append(soon);
      }
      for (const sku of skus) {
        const buy = button(sku === yearly ? 'acct-link acct-offer-yearly' : `acct-btn${family === 'basic' ? ' acct-btn-primary' : ''}`, sku === monthly ? '월간 구독' : '연간 구독');
        buy.dataset.sku = sku;
        buy.setAttribute('aria-label', `${family === 'basic' ? 'Basic' : 'Hama'} ${sku === monthly ? '월간' : '연간'} 구독`);
        buy.disabled = checkoutBusy !== null || pending != null;
        if (checkoutBusy === sku) setBusy(buy, true);
        buy.addEventListener('click', () => { void checkout(sku); });
        actions.append(buy);
      }
    }
    row.append(head, copy, price, annual, actions);
    return row;
  }

  function statTile(kind: string, label: string, value: string): HTMLElement {
    const tile = el('div', 'acct-stat');
    tile.dataset.stat = kind;
    tile.append(el('span', 'acct-stat-value', value), el('span', 'acct-stat-label', label));
    return tile;
  }

  function hamaTile(hama: NonNullable<NonNullable<AccountStatus['stats']>['hama']>): HTMLElement {
    const tile = el('div', 'acct-stat acct-stat-hama');
    tile.dataset.stat = 'hama';
    const value = el('span', 'acct-stat-value', usd(hama.usedUsd));
    value.append(el('span', 'acct-stat-of', ` / ${usd(hama.allowanceUsd)}`));
    const label = el('span', 'acct-stat-label');
    label.append(createHamaMark('acct-hama-mark'), el('span', '', 'Hama'));
    const meter = el('span', 'acct-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Hama 사용량');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(hama.allowanceUsd));
    meter.setAttribute('aria-valuenow', String(hama.usedUsd));
    const fill = el('span', 'acct-meter-fill');
    fill.style.width = `${(hamaUsageRatio(hama) * 100).toFixed(1)}%`;
    meter.append(fill);
    tile.append(value, label, meter, el('span', 'acct-meta', `${formatShortDate(hama.periodEndsAt)} 초기화`));
    return tile;
  }

  function deviceRow(device: AccountDevice): HTMLLIElement {
    const row = el('li', 'acct-device');
    row.dataset.deviceId = device.id;
    if (device.current) row.dataset.current = 'true';
    const icon = el('span', 'acct-device-icon');
    icon.append(platformGlyph(device.platform));
    const copy = el('span', 'acct-device-copy');
    const name = el('span', 'acct-device-name', device.name);
    if (device.current) name.append(el('span', 'acct-badge', '이 기기'));
    const meta = `${platformLabel(device.platform)} · ${device.current ? '지금 사용 중' : formatLastSeen(device.lastSeenAt)}`;
    copy.append(name, el('span', 'acct-meta', meta));
    const actions = el('span', 'acct-device-actions');
    if (deviceConfirm === device.id) {
      const no = button('acct-btn acct-btn-quiet', '취소');
      no.disabled = deviceBusy !== null;
      no.addEventListener('click', () => {
        deviceConfirm = null;
        render();
        deviceList.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(device.id)}"] .acct-device-remove`)?.focus();
      });
      const yes = button('acct-btn acct-btn-danger acct-device-confirm', device.current ? '빼고 로그아웃' : '빼기');
      yes.disabled = deviceBusy !== null;
      if (deviceBusy === device.id) setBusy(yes, true);
      yes.addEventListener('click', () => { void removeDevice(device); });
      actions.append(no, yes);
    } else {
      const remove = button('acct-btn acct-btn-quiet acct-device-remove', '빼기');
      remove.setAttribute('aria-label', `${device.name} 빼기`);
      remove.disabled = deviceBusy !== null;
      remove.addEventListener('click', () => {
        deviceConfirm = device.id;
        render();
        deviceList.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(device.id)}"] .acct-device-confirm`)?.focus();
      });
      actions.append(remove);
    }
    row.append(icon, copy, actions);
    return row;
  }

  function licenseRow(license: AccountLicense, many: boolean): HTMLLIElement {
    const row = el('li', 'acct-license');
    row.dataset.status = license.status;
    const head = el('span', 'acct-license-head');
    head.append(el('code', 'acct-key', license.maskedKey));
    const state = licenseStatusLabel(license);
    if (state) head.append(el('span', 'acct-badge acct-badge-warn', state));
    else if (license.primary && many) head.append(el('span', 'acct-badge', '사용 중'));
    row.append(head);
    const line = licenseLine(license);
    if (line) row.append(el('span', 'acct-meta', line));
    return row;
  }

  /** 다시 그려도 같은 자리의 단추에 초점을 돌려준다. */
  function keepFocus(container: HTMLElement, draw: () => void): void {
    const active = document.activeElement as HTMLElement | null;
    const inside = active && container.contains(active);
    const key = inside ? active.closest<HTMLElement>('[data-device-id], [data-plan]') : null;
    const selector = key?.dataset.deviceId
      ? `[data-device-id="${CSS.escape(key.dataset.deviceId)}"]`
      : key?.dataset.plan ? `[data-plan="${key.dataset.plan}"]` : null;
    const className = inside ? [...active.classList].find((name) => name.startsWith('acct-device-') || name === 'acct-btn-primary') : undefined;
    draw();
    if (!inside || container.contains(document.activeElement)) return;
    const target = selector
      ? container.querySelector<HTMLElement>(`${selector} ${className ? `.${className}` : 'button'}:not([disabled])`)
        ?? container.querySelector<HTMLElement>(`${selector} button:not([disabled])`)
      : null;
    (target ?? container.querySelector<HTMLElement>('button:not([disabled])'))?.focus({ preventScroll: true });
  }

  function renderSigned(current: AccountStatus): void {
    const account = current.account!;
    avatar.paint(current, store.avatar());
    avatarButton.disabled = photoBusy !== null;
    avatarButton.dataset.busy = photoBusy === 'set' ? 'true' : 'false';
    nameText.textContent = account.name;
    nameRow.hidden = nameEditing;
    nameForm.hidden = !nameEditing;
    nameInput.disabled = nameBusy;
    nameSave.disabled = nameBusy;
    nameCancel.disabled = nameBusy;
    setBusy(nameSave, nameBusy);
    emailText.textContent = account.email;
    offline.hidden = !current.sync.offline;
    photoChange.disabled = photoBusy !== null;
    photoRemove.disabled = photoBusy !== null;
    photoRemove.hidden = account.avatarRev === null;
    setBusy(photoChange, photoBusy === 'set');
    setBusy(photoRemove, photoBusy === 'remove');

    const planInfo = current.plan;
    planName.replaceChildren(planNameNode(current));
    planSection.root.dataset.tier = planInfo.tier;
    manage.hidden = !planInfo.manageUrl || planInfo.paymentFailed;
    // 결제가 실패한 동안은 지난 결제일 대신 안내 한 줄만 둔다.
    const term = planInfo.paymentFailed ? '' : planTermLine(planInfo);
    planTerm.textContent = term;
    planTerm.hidden = !term;
    planAlert.hidden = !planInfo.paymentFailed;
    planAlertText.textContent = planInfo.paymentFailed ? paymentFailedLine(planInfo) : '';
    // 결제가 실패한 동안은 결제 수단 바꾸기만 권한다.
    const families = plan?.api && !planInfo.paymentFailed ? upgradeFamilies(planInfo.tier) : [];
    keepFocus(offers, () => offers.replaceChildren(...families.map(offerRow)));
    offers.hidden = families.length === 0;
    if (plan?.status()?.pendingCheckout) say(planError, '');
    else if (!checkoutBusy && plan?.status()?.lastCheckout?.code === 'timed_out') {
      say(planError, '결제 확인 시간이 지났어요. 잠시 후 다시 시도해 주세요.');
    }

    const stats = current.stats;
    statsSection.root.hidden = !stats;
    if (stats) {
      statsGrid.replaceChildren(
        ...(stats.hama ? [hamaTile(stats.hama)] : []),
        statTile('sessions', '에이전트 세션', stats.agentSessions.toLocaleString('ko-KR')),
        statTile('documents', '편집한 문서', stats.documentsEdited.toLocaleString('ko-KR')),
      );
      statsGrid.dataset.count = String(statsGrid.children.length);
    }

    if (deviceConfirm && !current.devices.some((device) => device.id === deviceConfirm)) deviceConfirm = null;
    deviceCount.textContent = `${current.devices.length} / ${current.deviceLimit}`;
    keepFocus(deviceList, () => deviceList.replaceChildren(...current.devices.map(deviceRow)));

    const many = current.licenses.length > 1;
    licenseList.replaceChildren(...current.licenses.map((license) => licenseRow(license, many)));
    licenseList.hidden = current.licenses.length === 0;
    const elsewhere = current.localKey?.state === 'linked_elsewhere' ? current.localKey.maskedKey : '';
    localKeyNote.textContent = elsewhere ? `이 기기의 키 ${elsewhere}는 다른 계정에 연결돼 있어요.` : '';
    localKeyNote.hidden = !elsewhere;
    redeemInput.disabled = redeemBusy;
    redeemSubmit.disabled = redeemBusy || !redeemInput.value.trim();
    setBusy(redeemSubmit, redeemBusy);
    claimOrder.disabled = claimBusy;
    claimEmail.disabled = claimBusy;
    claimSubmit.disabled = claimBusy || !claimOrder.value.trim() || !claimEmail.value.trim();
    setBusy(claimSubmit, claimBusy);

    signOut.disabled = signOutBusy || deleting;
    setBusy(signOut, signOutBusy);
    deleteAccount.disabled = deleting;
  }

  let lastState: AccountStatus['state'] | null = null;
  let signInStartedAt: number | null = null;
  function render(): void {
    const current = status();
    const signedIn = isSignedIn(current);
    if (current?.signIn) signInStartedAt = current.signIn.startedAt;
    const wasSigningIn = lastState === 'signing_in' || lastState === 'choose_device';
    if (!embedded && signedIn && wasSigningIn) {
      lastState = current!.state;
      const done = onSignedIn;
      onSignedIn = undefined;
      const createdAt = current!.account?.createdAt ?? 0;
      const newAccount = signInStartedAt !== null && createdAt >= signInStartedAt - 5000
        && createdAt <= Date.now() + 60_000;
      finish();
      if (done) done();
      else void openPostLogin(current!, store, plan, newAccount);
      return;
    }
    layer.dataset.modal = !embedded && !signedIn ? 'true' : 'false';
    page.dataset.authPopup = !embedded && !signedIn ? 'true' : 'false';
    back.setAttribute('aria-label', signedIn ? '돌아가기' : '닫기');
    back.title = signedIn ? '돌아가기' : '닫기';
    back.replaceChildren(createIcon(signedIn ? 'browserBack' : 'close'));
    page.dataset.state = signedIn ? 'signed_in' : current?.state ?? 'signed_out';
    signIn.element.hidden = signedIn;
    signed.hidden = !signedIn;
    column.dataset.view = signedIn ? 'profile' : 'sign-in';
    if (signedIn) renderSigned(current!);
    else {
      nameEditing = false;
      deviceConfirm = null;
    }
    const state = current?.state ?? null;
    if (state !== lastState) {
      lastState = state;
      // 판이 바뀌면 초점이 사라진 단추에 남지 않게 새 판의 첫 자리로 옮긴다.
      if (!embedded && (!page.contains(document.activeElement) || document.activeElement === document.body)) {
        (signedIn ? back : signIn.focusTarget() ?? back).focus({ preventScroll: true });
      }
    }
  }

  // ── 사건 ────────────────────────────────────────────
  avatarButton.addEventListener('click', () => fileInput.click());
  photoChange.addEventListener('click', () => fileInput.click());
  photoRemove.addEventListener('click', () => { void removePhoto(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void changePhoto(file);
  });
  nameEdit.addEventListener('click', startNameEdit);
  nameText.addEventListener('dblclick', startNameEdit);
  nameCancel.addEventListener('click', stopNameEdit);
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveName();
  });
  nameInput.addEventListener('input', () => { if (!nameError.hidden) say(nameError, ''); });
  manage.addEventListener('click', () => { void openManage(manage, planError); });
  fixPayment.addEventListener('click', () => { void openManage(fixPayment, planError); });
  redeemInput.addEventListener('input', () => {
    say(redeemNote, '');
    redeemSubmit.disabled = redeemBusy || !redeemInput.value.trim();
  });
  redeemForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void redeem();
  });
  claimToggle.addEventListener('click', () => {
    const open = claimForm.hidden;
    claimForm.hidden = !open;
    claimToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) claimOrder.focus();
    else say(claimError, '');
  });
  for (const input of [claimOrder, claimEmail]) {
    input.addEventListener('input', () => {
      claimSubmit.disabled = claimBusy || !claimOrder.value.trim() || !claimEmail.value.trim();
    });
  }
  claimForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void claim();
  });
  signOut.addEventListener('click', () => { void doSignOut(); });
  deleteAccount.addEventListener('click', () => {
    const email = status()?.account?.email;
    if (!email || deleting) return;
    deleting = true;
    render();
    void openDeleteSheet(store, email).finally(() => {
      deleting = false;
      if (page.isConnected) render();
    });
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (sheetAbove()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (nameEditing && !nameBusy) {
        stopNameEdit();
        return;
      }
      if (deviceConfirm && !deviceBusy) {
        const id = deviceConfirm;
        deviceConfirm = null;
        render();
        deviceList.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(id)}"] .acct-device-remove`)?.focus();
        return;
      }
      finish();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(page);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !page.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !page.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  /** 페이지 밖(제목 막대의 단추 등)을 누르면 닫는다. 계정 단추는 스스로 닫는다. */
  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Element | null;
    if (!target || page.contains(target) || sheetAbove() || target.closest('.acct-button')) return;
    finish();
  }

  function reveal(next: AccountPageOptions): void {
    if (next.plan) plan = next.plan;
    if (next.onSignedIn) onSignedIn = next.onSignedIn;
    if (next.plan) subscribePlan();
    render();
    const target = next.section;
    if (!target) return;
    requestAnimationFrame(() => {
      if (target === 'sign-in' || !isSignedIn(status())) {
        (signIn.focusTarget() ?? back).focus({ preventScroll: true });
        return;
      }
      const node = signed.querySelector<HTMLElement>(`[data-section="${target}"]`);
      if (!node) return;
      node.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      node.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus({ preventScroll: true });
    });
  }

  let unsubscribePlan: () => void = () => {};
  function subscribePlan(): void {
    unsubscribePlan();
    unsubscribePlan = plan ? plan.subscribe(() => { if (page.isConnected) render(); }) : () => {};
  }
  subscribePlan();
  const unsubscribe = store.subscribe(() => render());

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let finished = false;
  function finish(): void {
    if (finished) return;
    finished = true;
    unsubscribe();
    unsubscribePlan();
    signIn.dispose();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    if (!embedded) openPage = null;
    page.classList.remove('acct-page-open');
    const remove = (): void => { layer.remove(); };
    if (embedded || reducedMotion()) remove();
    else {
      page.addEventListener('transitionend', (event) => { if (event.target === page) remove(); }, { once: true });
      window.setTimeout(remove, 400);
    }
    const active = document.activeElement;
    if (!embedded && (!active || active === document.body || page.contains(active)) && previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
    resolveClosed();
  }
  back.addEventListener('click', finish);

  (options.container ?? document.body).append(layer);
  if (!embedded) {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
  }
  render();
  requestAnimationFrame(() => {
    page.classList.add('acct-page-open');
    if (!embedded && !options.section) (isSignedIn(status()) ? back : signIn.focusTarget() ?? back).focus({ preventScroll: true });
  });
  const handle: AccountPageHandle = { close: finish, closed };
  if (!embedded) openPage = { handle, reveal };
  if (options.section) reveal(options);
  return handle;
}

/** 계정 삭제 확인. 계정 이메일을 그대로 적어야 삭제 단추가 열린다. */
function openDeleteSheet(store: AccountStore, email: string): Promise<void> {
  const api = store.api!;
  const frame = createSheetFrame({ title: '계정 삭제', center: true, role: 'dialog', className: 'acct-delete-sheet', dragIgnore: 'button, input, label' });
  const { sheet, id } = frame;
  const message = el('p', 'ag-sheet-message', '라이선스 연결이 풀리고 사진과 사용 기록이 지워져요.');
  message.id = `${id}-message`;
  sheet.setAttribute('aria-describedby', message.id);
  const label = el('label', 'acct-delete-label', '계정 이메일을 적어 주세요');
  const input = el('input', 'acct-input acct-delete-input');
  input.type = 'email';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = email;
  label.append(input);
  const error = alertLine();
  const manageRow = el('div', 'acct-delete-manage');
  manageRow.hidden = true;
  const manage = button('acct-btn', '구독 관리');
  manageRow.append(manage);
  const actions = el('div', 'ag-sheet-actions');
  const cancel = button('ag-sheet-btn ag-sheet-cancel', '취소');
  const confirm = button('ag-sheet-btn ag-sheet-confirm acct-delete-confirm', '계정 삭제');
  confirm.dataset.tone = 'destructive';
  confirm.disabled = true;
  actions.append(cancel, confirm);
  sheet.append(message, label, error, manageRow, actions);

  let busy = false;
  const sync = (): void => {
    confirm.disabled = busy || !deleteConfirmMatches(email, input.value);
    input.disabled = busy;
    setBusy(confirm, busy);
  };
  input.addEventListener('input', () => {
    say(error, '');
    manageRow.hidden = true;
    sync();
  });

  return new Promise<void>((resolve) => {
    const finish = frame.present(() => input, () => resolve());
    async function submit(): Promise<void> {
      if (busy || !deleteConfirmMatches(email, input.value)) return;
      busy = true;
      sync();
      try {
        const result = await api.deleteAccount(input.value.trim());
        busy = false;
        if (result.ok) {
          finish(true);
          return;
        }
        say(error, result.message);
        manageRow.hidden = result.code !== 'subscription_active';
      } catch {
        busy = false;
        say(error, '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
      sync();
      if (!manageRow.hidden) manage.focus();
    }
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    });
    manage.addEventListener('click', () => { void api.openManage().catch(() => say(error, '브라우저를 열지 못했어요.')); });
  });
}

/**
 * window 의 'rhwp:open-account' 를 계정 페이지로 잇는다. 창마다 하나만 듣는다 — 다시 부르면 앞의 것을 바꾼다.
 */
let detachAccountEvents: (() => void) | null = null;
export function listenForAccountPageEvents(options: Omit<AccountPageOptions, 'section' | 'onSignedIn'> = {}): () => void {
  detachAccountEvents?.();
  const onOpen = (event: Event): void => {
    const detail = (event as CustomEvent<{ section?: unknown } | null>).detail;
    const target = ACCOUNT_SECTIONS.find((name) => name === detail?.section);
    openAccountPage({ ...options, ...(target ? { section: target } : {}) });
  };
  window.addEventListener(OPEN_ACCOUNT_EVENT, onOpen);
  const detach = (): void => {
    window.removeEventListener(OPEN_ACCOUNT_EVENT, onOpen);
    if (detachAccountEvents === detach) detachAccountEvents = null;
  };
  detachAccountEvents = detach;
  return detach;
}
