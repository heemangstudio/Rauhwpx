// 설정 → 편집 → 라이선스. 데스크톱 앱에서만 보인다.
// 상태는 메인 프로세스(desktop/license-manager.mjs)가 가진다. 키 입력은 메인이 띄우는 활성화 창에서 한다.

export type LicenseState =
  | 'licensed'
  | 'trial'
  | 'trial_expired'
  | 'revoked'
  /** 연간 키의 기간이 끝났다(서버가 만료라고 했거나, 오프라인 유예 7일도 지났다). */
  | 'expired'
  | 'lease_expired'
  | 'needs_activation'
  | 'unenforced';

export interface LicenseStatus {
  state: LicenseState;
  canEdit: boolean;
  readOnly: boolean;
  trial: { startedAt: number; endsAt: number; active: boolean };
  license: {
    maskedKey: string;
    /** 서버가 정한 키 종류. 예전 메인 프로세스는 보내지 않는다. */
    tier?: 'paid' | 'beta';
    leaseExpiresAt: number | null;
    lastCheckAt: number | null;
    lastError: string | null;
    /** 연간 키가 끝나는 시각. 평생 키와 예전 메인 프로세스는 null 이거나 보내지 않는다. */
    licenseExpiresAt?: number | null;
    /** 연간 키가 자동 갱신되는지. 평생 키는 null. */
    autoRenew?: boolean | null;
    /** 기간이 지났지만 서버에 닿지 못해 더 쓰는 동안, 그 끝. */
    graceEndsAt?: number | null;
    /** 갱신 결제가 실패해 Groble 이 다시 시도하는 동안. 편집은 그대로 된다. */
    paymentFailed?: boolean;
    /** 결제 실패 유예의 끝. 이때까지 결제하면 같은 키로 이어서 쓴다. */
    paymentGraceEndsAt?: number | null;
    /** 결제 수단을 바꾸는 Groble 페이지. 연간 키에만 있다. */
    paymentFixUrl?: string | null;
  } | null;
  offline: boolean;
}

export interface DesktopLicenseApi {
  getStatus: () => Promise<LicenseStatus>;
  checkNow: () => Promise<LicenseStatus>;
  deactivate: () => Promise<{ ok: boolean; message?: string; status: LicenseStatus }>;
  /** 키를 이 창에서 바로 활성화한다. 처음 설정의 라이선스 단계가 쓴다. */
  activate: (key: string) => Promise<{ ok: boolean; code?: string; message?: string; status: LicenseStatus }>;
  openActivation: () => Promise<boolean>;
  openPricing: () => Promise<void>;
  /** Groble 주문 페이지를 연다. 결제 수단 바꾸기와 구독 관리(해지)가 쓴다. 예전 메인 프로세스에는 없다. */
  openPaymentFix?: () => Promise<void>;
  /** 문의 메일을 쓴다. 예전 메인 프로세스에는 없다. */
  openSupport?: () => Promise<void>;
  /** 이 기기의 키를 클립보드에 복사한다. 키는 메인이 바로 쓰고 렌더러로 오지 않는다. 예전 메인 프로세스에는 없다. */
  copyKey?: () => Promise<boolean>;
  /** 체험이 끝난 뒤 자동 저장용 유예를 한 번 받는다. */
  beginExpirySave?: () => Promise<{ ok: boolean; until: number | null }>;
  onChange: (callback: (status: LicenseStatus) => void) => () => void;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_SECONDS = 3600;

/** HAMA- 로 시작하고 다섯 묶음이 다 찼는지. 붙여 넣은 키를 바로 확인할지 정한다. */
export function looksLikeFullKey(raw: string): boolean {
  return /^HAMA(-?[0-9A-Z]{5}){5}$/.test(raw.trim().toUpperCase().replace(/\s+/g, ''));
}

/**
 * 체험 남은 시간. '2일 13시간' → '13시간 42분' → 마지막 한 시간은 '42분 15초' → '9초'.
 * 0 이 된 단위는 뺀다.
 */
export function trialTimeLeft(endsAt: number, now = Date.now()): string {
  const remaining = Math.max(0, endsAt - now);
  const seconds = Math.ceil(remaining / SECOND_MS);
  if (seconds < HOUR_SECONDS) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) return secs > 0 ? `${mins}분 ${secs}초` : `${mins}분`;
    return `${secs}초`;
  }
  const minutes = Math.ceil(remaining / MINUTE_MS);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
}

/**
 * 표시가 다음에 바뀔 때까지의 ms. 마지막 한 시간은 초마다, 그 전에는 분마다 그 경계에 맞춘다.
 */
export function msUntilNextTrialTick(endsAt: number, now = Date.now()): number {
  const remaining = endsAt - now;
  if (remaining <= 0) return SECOND_MS;
  if (Math.ceil(remaining / SECOND_MS) < HOUR_SECONDS) return remaining % SECOND_MS || SECOND_MS;
  const toSecondsMode = remaining - (HOUR_SECONDS - 1) * SECOND_MS;
  return Math.min(remaining % MINUTE_MS || MINUTE_MS, toSecondsMode);
}

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

/** 연간 키의 날짜. 서버가 한국 시간 하루 끝까지로 정하므로 한국 시간으로 보인다. 예: 2027년 10월 20일 */
export function formatLicenseDate(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' }).format(new Date(ms));
}

/** 연간 키의 갱신일 또는 끝나는 날. 평생 키는 빈 문자열. */
export function licenseTermText(license: LicenseStatus['license']): string {
  const expiresAt = license?.licenseExpiresAt;
  if (!expiresAt) return '';
  return license?.autoRenew === false ? `${formatLicenseDate(expiresAt)}까지` : `다음 갱신 ${formatLicenseDate(expiresAt)}`;
}

const SUPPORT_EMAIL = 'management@heemangstudios.com';

export const RENEWAL_PROMPT_TITLE = '키 만료, 연장할까요?';

/**
 * 결제가 실패했거나(편집은 됨) 기간이 끝난(읽기 전용) 연간 키에 띄우는 연장 안내. 해당 없으면 null.
 * 설정, 편집 화면의 알림 카드, 활성화 창이 같은 글을 쓴다.
 */
export function renewalPrompt(status: LicenseStatus): {
  kind: 'payment_failed' | 'lapsed';
  title: string;
  detail: string;
  action: string;
} | null {
  const license = status.license;
  if (status.state === 'licensed' && license?.paymentFailed && license.paymentGraceEndsAt) {
    return {
      kind: 'payment_failed',
      title: RENEWAL_PROMPT_TITLE,
      detail: `갱신 결제가 되지 않았어요. ${formatLicenseDate(license.paymentGraceEndsAt)}까지 결제 수단을 바꿔주세요.`,
      action: '결제 수단 바꾸기',
    };
  }
  if (status.state === 'expired' && license?.licenseExpiresAt) {
    return {
      kind: 'lapsed',
      title: RENEWAL_PROMPT_TITLE,
      detail: `${formatLicenseDate(license.licenseExpiresAt)}에 기간이 끝나 읽기 전용이에요. Groble에서 연장하면 바로 다시 편집할 수 있어요.`,
      action: 'Groble에서 연장하기',
    };
  }
  return null;
}

/** 설정 화면에 보일 한 줄 요약과 버튼. DOM 없이 시험할 수 있게 따로 둔다. */
export function licenseSummary(status: LicenseStatus, now = Date.now()): {
  title: string;
  detail: string;
  readOnly: boolean;
  canDeactivate: boolean;
  showActivate: boolean;
} {
  const license = status.license;
  const beta = license?.tier === 'beta';
  switch (status.state) {
    case 'licensed': {
      const prompt = renewalPrompt(status);
      if (prompt) return { title: prompt.title, detail: prompt.detail, readOnly: false, canDeactivate: true, showActivate: false };
      if (license?.graceEndsAt && license.licenseExpiresAt) {
        return {
          title: '정품 라이선스 · 갱신 확인 필요',
          detail: `${formatLicenseDate(license.licenseExpiresAt)}에 기간이 끝났어요. 인터넷에 연결해 갱신을 확인해 주세요. ${formatLicenseDate(license.graceEndsAt)}까지 쓸 수 있어요.`,
          readOnly: false,
          canDeactivate: true,
          showActivate: false,
        };
      }
      const term = licenseTermText(license);
      return {
        title: beta ? '베타 테스터 라이선스' : '정품 라이선스',
        detail: [license?.maskedKey ?? '', term, `마지막 확인 ${formatTime(license?.lastCheckAt ?? null)}`, status.offline ? '오프라인' : '']
          .filter(Boolean).join(' · '),
        readOnly: false,
        canDeactivate: true,
        showActivate: false,
      };
    }
    case 'expired':
      return {
        title: '기간 끝 · 읽기 전용',
        detail: `${license?.licenseExpiresAt ? `${formatLicenseDate(license.licenseExpiresAt)}에 ` : ''}라이선스 기간이 끝났어요. 구독을 갱신하거나 새 키를 넣으면 다시 저장할 수 있어요.`,
        readOnly: true,
        canDeactivate: true,
        showActivate: true,
      };
    case 'trial':
      return {
        title: '체험 중',
        detail: `${trialTimeLeft(status.trial.endsAt, now)} 남았어요. 끝나면 읽기 전용이 돼요.`,
        readOnly: false,
        canDeactivate: false,
        showActivate: true,
      };
    case 'trial_expired':
      return { title: '읽기 전용', detail: '라이선스 키를 넣으면 다시 저장할 수 있어요.', readOnly: true, canDeactivate: false, showActivate: true };
    case 'revoked':
      return {
        title: '해지된 라이선스 · 읽기 전용',
        detail: beta ? '베타 테스트 기간이 끝나 키가 해지되었어요.' : '환불 등으로 키가 해지되었어요. 새 키를 넣어 주세요.',
        readOnly: true,
        canDeactivate: false,
        showActivate: true,
      };
    case 'lease_expired':
      return {
        title: '확인 필요 · 읽기 전용',
        detail: `${beta ? 3 : 7}일 넘게 라이선스를 확인하지 못했어요. 인터넷에 연결한 뒤 ‘지금 확인’을 눌러 주세요.`,
        readOnly: true,
        canDeactivate: true,
        showActivate: false,
      };
    case 'needs_activation':
      return {
        title: '다시 활성화 필요 · 읽기 전용',
        detail: license?.lastError ?? '이 기기에서 키를 다시 활성화해 주세요.',
        readOnly: true,
        canDeactivate: false,
        showActivate: true,
      };
    default:
      return { title: '개발 빌드', detail: '라이선스를 확인하지 않아요.', readOnly: false, canDeactivate: false, showActivate: false };
  }
}

function button(label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ag-settings-btn';
  node.textContent = label;
  return node;
}

/**
 * 라이선스 탭의 내용. 상태 카드 아래에 버튼을 둔다.
 * 라이선스를 보지 않는 빌드(unenforced)면 숨기고 onAvailableChange 로 알린다.
 */
export function createLicenseSettingsSection(
  api: DesktopLicenseApi,
  { onAvailableChange }: { onAvailableChange?: (available: boolean) => void } = {},
): { root: HTMLElement; dispose: () => void } {
  const root = document.createElement('section');
  root.className = 'ag-settings-section ag-settings-license-section';
  const head = document.createElement('div');
  head.className = 'ag-settings-section-head';
  const heading = document.createElement('h3');
  heading.className = 'ag-settings-section-title';
  heading.textContent = '라이선스';
  head.append(heading);
  const body = document.createElement('div');
  body.className = 'ag-settings-section-body';
  const row = document.createElement('div');
  row.className = 'ag-settings-control-row';
  const copy = document.createElement('span');
  copy.className = 'ag-settings-control-copy';
  const title = document.createElement('span');
  title.className = 'ag-settings-control-label';
  const detail = document.createElement('span');
  detail.className = 'ag-settings-control-description';
  detail.setAttribute('role', 'status');
  // 가린 키(HAMA-…2000)를 누르면 전체 키를 복사한다.
  const keyButton = document.createElement('button');
  keyButton.type = 'button';
  keyButton.className = 'ag-settings-license-key';
  keyButton.title = '키 복사';
  keyButton.hidden = true;
  const detailText = document.createElement('span');
  detail.append(keyButton, detailText);
  copy.append(title, detail);
  if (api.openSupport) {
    const contact = document.createElement('span');
    contact.className = 'ag-settings-control-description';
    const mail = document.createElement('button');
    mail.type = 'button';
    mail.className = 'ag-settings-license-contact';
    mail.textContent = SUPPORT_EMAIL;
    mail.addEventListener('click', () => { void api.openSupport?.(); });
    contact.append('문의 ', mail);
    copy.append(contact);
  }
  const actions = document.createElement('span');
  actions.className = 'ag-settings-license-actions';
  const activate = button('키 넣기');
  const buy = button('연 ₩9,900에 구매하기');
  const check = button('지금 확인');
  const deactivate = button('이 기기 비활성화');
  const fixPayment = button('결제 수단 바꾸기');
  // 연간 구독 키: 해지·결제 수단은 Groble 주문 페이지에서 관리한다.
  const manage = button('구독 관리');
  actions.append(fixPayment, manage, activate, buy, check, deactivate);
  row.append(copy);
  body.append(row);
  root.append(head, body, actions);

  let maskedKey = '';
  let copiedTimer: number | undefined;

  function render(status: LicenseStatus): void {
    const summary = licenseSummary(status);
    // 결제 실패·기간 끝은 연장 안내의 제목을 쓴다. 무료 체험이 끝난 기기는 설정에서만 그렇게 부른다.
    // 메뉴 막대 알약은 자리가 좁아 '읽기 전용'을 그대로 쓴다.
    title.textContent = status.state === 'trial_expired'
      ? '무료 체험 만료'
      : renewalPrompt(status)?.title ?? summary.title;
    maskedKey = status.license?.maskedKey ?? '';
    const keyFirst = Boolean(maskedKey && api.copyKey && summary.detail.startsWith(maskedKey));
    keyButton.hidden = !keyFirst;
    keyButton.setAttribute('aria-label', `라이선스 키 복사, ${maskedKey}`);
    if (keyFirst && !copiedTimer) keyButton.textContent = maskedKey;
    detailText.textContent = keyFirst ? summary.detail.slice(maskedKey.length) : summary.detail;
    activate.hidden = !summary.showActivate;
    buy.hidden = !summary.showActivate;
    check.hidden = !status.license;
    deactivate.hidden = !summary.canDeactivate;
    const prompt = renewalPrompt(status);
    fixPayment.hidden = !prompt || !api.openPaymentFix;
    if (prompt) fixPayment.textContent = prompt.action;
    // 결제 안내가 같은 페이지를 열고 있으면 겹쳐 두지 않는다.
    manage.hidden = !status.license?.licenseExpiresAt || !api.openPaymentFix || !fixPayment.hidden;
    const available = status.state !== 'unenforced';
    root.hidden = !available;
    onAvailableChange?.(available);
  }

  keyButton.addEventListener('click', () => {
    void api.copyKey?.().then((copied) => {
      if (!copied) return;
      keyButton.textContent = '복사됨';
      window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => {
        copiedTimer = undefined;
        keyButton.textContent = maskedKey;
      }, 1400);
    });
  });
  activate.addEventListener('click', () => { void api.openActivation(); });
  buy.addEventListener('click', () => { void api.openPricing(); });
  fixPayment.addEventListener('click', () => { void api.openPaymentFix?.(); });
  manage.addEventListener('click', () => { void api.openPaymentFix?.(); });
  check.addEventListener('click', () => {
    check.disabled = true;
    void api.checkNow().then(render).finally(() => { check.disabled = false; });
  });
  deactivate.addEventListener('click', () => {
    if (!window.confirm('이 기기에서 라이선스를 비활성화할까요? 다른 기기에서 이 키를 쓸 수 있게 되고, 이 기기는 읽기 전용이 돼요.')) return;
    deactivate.disabled = true;
    void api.deactivate().then((result) => {
      render(result.status);
      if (!result.ok && result.message) {
        keyButton.hidden = true;
        detailText.textContent = result.message;
      }
    }).finally(() => { deactivate.disabled = false; });
  });

  const unsubscribe = api.onChange(render);
  void api.getStatus().then(render).catch(() => {
    root.hidden = true;
    onAvailableChange?.(false);
  });
  return { root, dispose: unsubscribe };
}
