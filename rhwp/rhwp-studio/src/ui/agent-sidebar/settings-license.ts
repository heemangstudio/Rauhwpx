// 설정 → 편집 → 라이선스. 데스크톱 앱에서만 보인다.
// 상태는 메인 프로세스(desktop/license-manager.mjs)가 가진다. 키 입력은 메인이 띄우는 활성화 창에서 한다.

export type LicenseState =
  | 'licensed'
  | 'trial'
  | 'trial_expired'
  | 'revoked'
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
    leaseExpiresAt: number | null;
    lastCheckAt: number | null;
    lastError: string | null;
  } | null;
  offline: boolean;
}

export interface DesktopLicenseApi {
  getStatus: () => Promise<LicenseStatus>;
  checkNow: () => Promise<LicenseStatus>;
  deactivate: () => Promise<{ ok: boolean; message?: string; status: LicenseStatus }>;
  openActivation: () => Promise<boolean>;
  openPricing: () => Promise<void>;
  onChange: (callback: (status: LicenseStatus) => void) => () => void;
}

const MINUTE_MS = 60 * 1000;

/** 체험 남은 시간. '2일 13시간' → '13시간 42분' → '42분'. 0 이 된 단위는 뺀다. */
export function trialTimeLeft(endsAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((endsAt - now) / MINUTE_MS));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  return `${mins}분`;
}

/** 다음에 남은 시간의 분이 바뀔 때까지의 ms. 카운트다운을 그 경계에 맞춰 다시 그린다. */
export function msUntilNextTrialMinute(endsAt: number, now = Date.now()): number {
  const rest = (endsAt - now) % MINUTE_MS;
  return rest > 0 ? rest : MINUTE_MS;
}

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
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
  switch (status.state) {
    case 'licensed':
      return {
        title: '정품 라이선스',
        detail: `${license?.maskedKey ?? ''} · 마지막 확인 ${formatTime(license?.lastCheckAt ?? null)}${status.offline ? ' · 오프라인' : ''}`,
        readOnly: false,
        canDeactivate: true,
        showActivate: false,
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
      return { title: '체험 끝 · 읽기 전용', detail: '라이선스 키를 넣으면 다시 저장할 수 있어요.', readOnly: true, canDeactivate: false, showActivate: true };
    case 'revoked':
      return { title: '해지된 라이선스 · 읽기 전용', detail: '환불 등으로 키가 해지되었어요. 새 키를 넣어 주세요.', readOnly: true, canDeactivate: false, showActivate: true };
    case 'lease_expired':
      return {
        title: '확인 필요 · 읽기 전용',
        detail: '7일 넘게 라이선스를 확인하지 못했어요. 인터넷에 연결한 뒤 ‘지금 확인’을 눌러 주세요.',
        readOnly: true,
        canDeactivate: true,
        showActivate: false,
      };
    case 'needs_activation':
      return {
        title: '다시 활성화 필요 · 읽기 전용',
        detail: license?.lastError ?? '이 Mac에서 키를 다시 활성화해 주세요.',
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

export function createLicenseSettingsSection(api: DesktopLicenseApi): { root: HTMLElement; dispose: () => void } {
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
  row.className = 'ag-settings-control';
  const copy = document.createElement('span');
  copy.className = 'ag-settings-control-copy';
  const title = document.createElement('span');
  title.className = 'ag-settings-control-label';
  const detail = document.createElement('span');
  detail.className = 'ag-settings-control-description';
  detail.setAttribute('role', 'status');
  copy.append(title, detail);
  const actions = document.createElement('span');
  actions.className = 'ag-settings-license-actions';
  const activate = button('키 넣기');
  const buy = button('구매하기');
  const check = button('지금 확인');
  const deactivate = button('이 기기 비활성화');
  actions.append(activate, buy, check, deactivate);
  row.append(copy, actions);
  body.append(row);
  root.append(head, body);

  function render(status: LicenseStatus): void {
    const summary = licenseSummary(status);
    title.textContent = summary.title;
    detail.textContent = summary.detail;
    activate.hidden = !summary.showActivate;
    buy.hidden = !summary.showActivate;
    check.hidden = !status.license;
    deactivate.hidden = !summary.canDeactivate;
    root.hidden = status.state === 'unenforced';
  }

  activate.addEventListener('click', () => { void api.openActivation(); });
  buy.addEventListener('click', () => { void api.openPricing(); });
  check.addEventListener('click', () => {
    check.disabled = true;
    void api.checkNow().then(render).finally(() => { check.disabled = false; });
  });
  deactivate.addEventListener('click', () => {
    if (!window.confirm('이 Mac에서 라이선스를 비활성화할까요? 다른 Mac에서 이 키를 쓸 수 있게 되고, 이 Mac은 읽기 전용이 돼요.')) return;
    deactivate.disabled = true;
    void api.deactivate().then((result) => {
      render(result.status);
      if (!result.ok && result.message) detail.textContent = result.message;
    }).finally(() => { deactivate.disabled = false; });
  });

  const unsubscribe = api.onChange(render);
  void api.getStatus().then(render).catch(() => { root.hidden = true; });
  return { root, dispose: unsubscribe };
}
