// 데스크톱 라이선스 API(rhwpDesktop.license)의 꼴. 요금제는 계정이 정하고(ui/account), 이 API 는
// 계정 API 가 없는 예전 데스크톱에서 요금제 카드의 '키 직접 입력'만 쓴다.

export type LicenseState =
  | 'licensed'
  /** 키가 없다. 편집은 모두 된다. */
  | 'free'
  | 'revoked'
  /** 연간 키의 기간이 끝났다(서버가 만료라고 했거나, 오프라인 유예 7일도 지났다). */
  | 'expired'
  | 'lease_expired'
  | 'needs_activation'
  | 'unenforced';

export interface LicenseStatus {
  state: LicenseState;
  /** 서명한 lease 로 Basic 기능을 쓸 수 있는지. */
  paid: boolean;
  /** 서버가 알려 준 판. 예전 서버는 보내지 않는다. */
  edition?: 'basic' | 'hama' | null;
  plan?: 'monthly' | 'annual' | 'lifetime' | null;
  /** 호스팅 Rau 자격. 모르면 null. */
  rau?: { eligible: boolean | null };
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
  onChange: (callback: (status: LicenseStatus) => void) => () => void;
}
