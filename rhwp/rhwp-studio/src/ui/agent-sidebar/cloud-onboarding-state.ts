import type {
  BoatMachine,
  BoatServerSnapshot,
  BoatSetupProgress,
  BoatSetupStage,
  BoatSignInChallenge,
  BoatSnapshot,
  CloudAppServerProvider,
  CloudProfileDraft,
  CloudSandboxSummary,
  CloudServerMode,
  CloudSnapshot,
} from '../../cloud/types.ts';
import { inferCloudLink } from '../../cloud/link.ts';

export type CloudSetupIntent = 'transfer' | 'manage';
/** 선택 화면의 세 갈래. boat 는 데스크톱이 기억하는 서버 방식이 아니라 내 서버의 한 종류다. */
export type CloudSetupChoice = CloudServerMode | 'boat';
export type BoatProvider = BoatSetupProgress['importedProviders'][number];
/** 로그인은 두 박자다. 링크를 먼저 열고, 로그인한 뒤에야 코드를 보여 준다. */
export type BoatSignInBeat = 'open' | 'opened' | 'code';
export type CloudSetupStage = 'installing';
export type CloudProfileField =
  | 'name'
  | 'host'
  | 'sshUser'
  | 'sshPort'
  | 'tailscaleHttpsPort'
  | 'endpoint'
  | 'keyPath'
  | 'serverPublicKey'
  | 'pairingCode';
export type CloudFieldErrors = Partial<Record<CloudProfileField, string>>;

export interface CloudSetupIssue {
  title: string;
  guidance: string;
  detail: string;
}

/** 실패한 단계가 남은 자원을 결정한다. 생성 실패는 남긴 것이 없고, 종료 실패는 유료 샌드박스를 남긴다. */
export type SandboxFailurePhase = 'spawn' | 'teardown';
export const RAUCLOUD_SETUP_WAIT_MINUTES = 30;

export function raucloudSetupElapsed(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export type CloudSetupState =
  | {
      kind: 'choose';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      mode: CloudSetupChoice;
      /** 놓고 온 유료 서버처럼 다음 화면까지 살아 있어야 하는 사실. */
      notice?: string;
    }
  | {
      kind: 'sandbox-intro';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      provider: CloudAppServerProvider;
    }
  | {
      kind: 'sandbox-unavailable';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      provider: CloudAppServerProvider | null;
    }
  | {
      kind: 'sandbox-provisioning';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      startedAt: number;
    }
  | {
      kind: 'sandbox-failed';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      issue: CloudSetupIssue;
      phase: SandboxFailurePhase;
    }
  | {
      kind: 'sandbox-ready';
      intent: CloudSetupIntent;
      name: string;
      sandbox: CloudSandboxSummary;
    }
  | { kind: 'sandbox-tearing-down'; intent: CloudSetupIntent; name: string }
  | { kind: 'intro'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'editing'; draft: CloudProfileDraft; intent: CloudSetupIntent; errors: CloudFieldErrors }
  | { kind: 'checking'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'check-failed'; draft: CloudProfileDraft; intent: CloudSetupIntent; issue: CloudSetupIssue }
  | { kind: 'ready-to-install'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'installing'; draft: CloudProfileDraft; intent: CloudSetupIntent; stage: CloudSetupStage }
  | {
      kind: 'install-failed';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      issue: CloudSetupIssue;
      retry: 'install' | 'pair';
      pairingCode?: string;
    }
  | {
      kind: 'existing';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      errors: CloudFieldErrors;
      pairingCode: string;
    }
  | { kind: 'pairing'; draft: CloudProfileDraft; intent: CloudSetupIntent; pairingCode: string }
  | { kind: 'connected'; profile: CloudProfileDraft; intent: CloudSetupIntent }
  | {
      kind: 'boat-connect';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      email: string;
      error: string | null;
      pending: boolean;
    }
  | {
      kind: 'boat-key';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      apiKey: string;
      error: string | null;
      pending: boolean;
    }
  | {
      kind: 'boat-signin';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      email: string;
      challenge: BoatSignInChallenge;
      beat: BoatSignInBeat;
      expired: boolean;
      pending: boolean;
    }
  | { kind: 'boat-billing'; draft: CloudProfileDraft; intent: CloudSetupIntent; opened: boolean; pending: boolean }
  | { kind: 'boat-confirm'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | {
      kind: 'boat-progress';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      /** 이 화면이 시작을 요청한 시각. 이보다 오래된 실패 기록은 지난 시도의 것이다. */
      startedAt: number;
    }
  | { kind: 'boat-failed'; draft: CloudProfileDraft; intent: CloudSetupIntent; issue: CloudSetupIssue }
  | { kind: 'boat-ready'; intent: CloudSetupIntent; importedProviders: BoatProvider[] };

export type BoatSetupState = Extract<CloudSetupState, { kind: `boat-${string}` }>;

const DEFAULT_DRAFT: CloudProfileDraft = {
  name: 'My VPS',
  host: '',
  sshUser: 'ubuntu',
  sshPort: 22,
  tailscaleHttpsPort: 443,
  auth: { kind: 'ssh-agent' },
  transport: { kind: 'tailscale' },
};

function cloneDraft(draft: CloudProfileDraft): CloudProfileDraft {
  // boat 표시는 데스크톱이 만든 프로필에만 붙는다. 사람이 고치는 VPS 초안으로 옮기지 않는다.
  const { serverPublicKey, boat: _boat, ...rest } = draft;
  return {
    ...rest,
    name: draft.name.trim(),
    host: draft.host.trim(),
    sshUser: draft.sshUser.trim(),
    ...(typeof serverPublicKey === 'string' ? { serverPublicKey: serverPublicKey.trim() } : {}),
    auth: draft.auth.kind === 'key-file'
      ? { kind: 'key-file', keyPath: draft.auth.keyPath.trim() }
      : { kind: 'ssh-agent' },
    transport: draft.transport.kind === 'https'
      ? { kind: 'https', endpoint: draft.transport.endpoint.trim() }
      : draft.transport.kind === 'ssh-tunnel'
        ? { kind: 'ssh-tunnel' }
        : { kind: 'tailscale' },
  };
}

function draftsEqual(left: CloudProfileDraft, right: CloudProfileDraft): boolean {
  return left.name === right.name
    && left.host === right.host
    && left.sshUser === right.sshUser
    && left.sshPort === right.sshPort
    && left.tailscaleHttpsPort === right.tailscaleHttpsPort
    && left.serverPublicKey === right.serverPublicKey
    && left.auth.kind === right.auth.kind
    && (left.auth.kind !== 'key-file' || (right.auth.kind === 'key-file' && left.auth.keyPath === right.auth.keyPath))
    && left.transport.kind === right.transport.kind
    && (left.transport.kind !== 'https' || (right.transport.kind === 'https' && left.transport.endpoint === right.transport.endpoint));
}

function validHost(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  }
  return /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

function isTailscaleHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value.endsWith('.ts.net') || !value.includes('.')) return validHost(value);
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function validHttpsEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function defaultCloudProfileDraft(profile?: CloudProfileDraft): CloudProfileDraft {
  return cloneDraft(profile ?? DEFAULT_DRAFT);
}

export function validateCloudProfileDraft(
  draft: CloudProfileDraft,
  options: { existing?: boolean; pairingCode?: string } = {},
): CloudFieldErrors {
  const errors: CloudFieldErrors = {};
  const host = draft.host.trim();
  if (!host) errors.host = draft.transport.kind === 'tailscale'
    ? 'VPS의 Tailscale IP 또는 기기 이름 필요'
    : '원격 Mac 또는 VPS의 SSH 주소 필요';
  else if (!validHost(host)) errors.host = '프로토콜·경로 없는 VPS 주소 필요';
  else if (draft.transport.kind === 'tailscale' && !isTailscaleHost(host)) errors.host = 'Tailscale IP 또는 MagicDNS 이름 필요';
  if (!draft.sshUser.trim()) errors.sshUser = 'SSH 사용자 이름 필요';
  else if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(draft.sshUser.trim())) errors.sshUser = 'SSH 사용자 이름 형식 오류';
  if (!draft.name.trim()) errors.name = '환경 이름 필요';
  else if (draft.name.trim().length > 80) errors.name = '환경 이름은 80자 이하';
  if (!Number.isSafeInteger(draft.sshPort) || draft.sshPort < 1 || draft.sshPort > 65535) errors.sshPort = '포트는 1–65535';
  const httpsPort = draft.tailscaleHttpsPort ?? 443;
  if (!Number.isSafeInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) errors.tailscaleHttpsPort = '포트는 1–65535';
  if (draft.auth.kind === 'key-file' && !draft.auth.keyPath.trim()) errors.keyPath = '개인 키 파일 경로 필요';
  else if (draft.auth.kind === 'key-file' && (draft.auth.keyPath.includes('\0') || draft.auth.keyPath.trim().length > 4096)) {
    errors.keyPath = '개인 키 파일 경로 형식 오류';
  }
  if (draft.transport.kind === 'https' && !validHttpsEndpoint(draft.transport.endpoint.trim())) {
    errors.endpoint = '자격 증명·쿼리·조각 없는 HTTPS 주소 필요';
  }
  if (options.existing) {
    if (!draft.serverPublicKey?.trim()) errors.serverPublicKey = '서버 ID 키 필요';
    else if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(draft.serverPublicKey.trim())) errors.serverPublicKey = '서버 ID 키는 ed25519:로 시작합니다.';
    const code = options.pairingCode?.trim().toUpperCase() ?? '';
    if (!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/.test(code)) errors.pairingCode = '페어링 코드 형식: XXXX-XXXX-XXXX';
  }
  return errors;
}

export function mapSandboxIssue(error: unknown): CloudSetupIssue {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (/not configured|railway_token|railway_project_id|railway_environment_id/.test(normalized)) {
    return {
      title: 'Raucloud가 아직 준비되지 않았습니다',
      guidance: '내 서버를 쓰거나 앱을 업데이트합니다.',
      detail,
    };
  }
  if (/cannot manage the/.test(normalized)) {
    return {
      title: '이 앱이 관리할 수 없는 샌드박스입니다',
      guidance: '연결을 놓은 뒤 공급자 콘솔에서 서버를 직접 삭제합니다.',
      detail,
    };
  }
  if (/does not include app-provided|provider_unavailable|unknown app server provider/.test(normalized)) {
    return {
      title: '이 빌드에는 Raucloud가 없습니다',
      guidance: '내 서버 사용',
      detail,
    };
  }
  if (/rejected the configured api token|unauthorized/.test(normalized)) {
    return {
      title: '앱 서버 자격 증명이 거부되었습니다',
      guidance: '잠시 후 다시 시도 · 또는 내 서버 사용',
      detail,
    };
  }
  if (/unreachable|timed out|timeout|fetch failed|failed to fetch/.test(normalized)) {
    return {
      title: '앱 서버에 연결할 수 없습니다',
      guidance: '네트워크 확인 후 다시 시도',
      detail,
    };
  }
  if (/deployment|deploy|reports crashed|reports failed/.test(normalized)) {
    return {
      title: '샌드박스를 시작하지 못했습니다',
      guidance: '잠시 후 다시 시도 · 또는 내 서버 사용',
      detail,
    };
  }
  if (/health|did not answer/.test(normalized)) {
    return {
      title: '샌드박스가 응답하지 않습니다',
      guidance: '샌드박스 다시 만들기',
      detail,
    };
  }
  if (/before shutting it down|has_work/.test(normalized)) {
    return {
      title: '진행 중인 Cloud 작업이 있습니다',
      guidance: '작업을 마치거나 취소한 뒤 종료합니다.',
      detail,
    };
  }
  if (/shut down the app-provided sandbox|sandbox_still_active/.test(normalized)) {
    return {
      title: '앱 샌드박스 종료 필요',
      guidance: 'Raucloud 종료 후 내 서버 연결',
      detail,
    };
  }
  if (/identity|signature|pinned/.test(normalized)) {
    return {
      title: '샌드박스 ID를 확인하지 못했습니다',
      guidance: '샌드박스 종료 후 다시 만들기',
      detail,
    };
  }
  return {
    title: 'Raucloud를 준비하지 못했습니다',
    guidance: '다시 시도 · 또는 내 서버 사용',
    detail,
  };
}

export function mapCloudSetupIssue(error: unknown, transport: CloudProfileDraft['transport']['kind'] = 'tailscale'): CloudSetupIssue {
  // 화면 문장으로 바뀐 오류는 원문을 detail 에 둔다. 원인은 원문으로 가른다.
  const raw = (error as { detail?: unknown } | null)?.detail;
  const detail = typeof raw === 'string' && raw ? raw : error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (/shut down the app-provided sandbox|sandbox_still_active/.test(normalized)) return mapSandboxIssue(error);
  if (/spawn .*enoent|enoent.*spawn|ssh .*not (?:found|installed)/.test(normalized)) {
    return {
      title: '이 기기에 OpenSSH 클라이언트가 없습니다',
      guidance: 'OpenSSH 클라이언트 설치 후 다시 시도 (Windows: 설정 > 선택 기능)',
      detail,
    };
  }
  if (/permission denied|authentication failed|publickey/.test(normalized)) {
    return {
      title: 'SSH 인증에 실패했습니다',
      guidance: 'SSH agent에 키를 추가하거나 개인 키 파일 선택 (Windows: ssh-add)',
      detail,
    };
  }
  if (/timed out|timeout|econnrefused|could not resolve|name or service not known|no route to host/.test(normalized)) {
    return {
      title: '원격 호스트에 연결할 수 없습니다',
      guidance: transport === 'tailscale'
        ? 'Tailscale 연결, VPS 주소, SSH 포트 확인'
        : transport === 'ssh-tunnel'
          ? 'SSH 주소·포트, 키 인증, 방화벽 확인'
          : 'VPS 주소, SSH 포트, 방화벽, HTTPS 주소 확인',
      detail,
    };
  }
  if (/passwordless sudo|sudo.*password|requires a password/.test(normalized)) {
    return { title: '비밀번호 없는 sudo가 필요합니다', guidance: 'SSH 사용자에게 비밀번호 없는 sudo 권한 설정', detail };
  }
  if (/macos 14|apple silicon|ubuntu|debian|unsupported.*distribution|operating system/.test(normalized)) {
    return { title: '지원하는 원격 운영체제가 필요합니다', guidance: 'Apple silicon macOS 14 이상 또는 Ubuntu/Debian', detail };
  }
  if (/no compatible (?:stable |prerelease )?cloud asset|cloud release asset|curl.*(?:requested url.*404|error:\s*404)/.test(normalized)) {
    return {
      title: 'Cloud 설치 파일을 찾을 수 없습니다',
      guidance: '이 버전용 설치 파일이 아직 없습니다 · 앱 업데이트',
      detail,
    };
  }
  if (transport === 'tailscale' && /enotfound|name_not_resolved|could not resolve|dns|fetch failed|failed to fetch/.test(normalized)) {
    return {
      title: 'Tailscale DNS 꺼짐',
      guidance: 'Tailscale 설정에서 Accept DNS를 켠 뒤 다시 연결',
      detail,
    };
  }
  if (/tailscale/.test(normalized)) {
    return { title: 'VPS Tailscale 확인 필요', guidance: 'VPS에 Tailscale을 설치하고 같은 네트워크에 연결', detail };
  }
  if (/architecture|amd64|arm64|x86_64|aarch64/.test(normalized)) {
    return { title: '지원하지 않는 서버 구조입니다', guidance: 'Mac은 Apple silicon, Linux는 amd64·arm64', detail };
  }
  if (/identity|server.*key|signature|pinned/.test(normalized)) {
    return { title: '서버 ID를 확인하지 못했습니다', guidance: '서버 ID 키가 바뀌었을 수 있습니다 · 예상 못 한 변경이면 중단', detail };
  }
  if (/pairing|code.*expired|invalid code/.test(normalized)) {
    return { title: '페어링 코드를 사용할 수 없습니다', guidance: 'VPS에서 새 코드를 만들어 다시 입력', detail };
  }
  return { title: 'Cloud 설정을 마치지 못했습니다', guidance: '연결 정보 확인 후 다시 시도', detail };
}

export function snapshotProfile(snapshot: CloudSnapshot): CloudProfileDraft | undefined {
  return snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'self-hosted'
    ? defaultCloudProfileDraft(snapshot.profile.profile)
    : undefined;
}

/** 설정을 마친 공급자를 먼저 고르고, 없으면 첫 공급자를 돌려 설정 안내를 보여준다. */
export function appServerProvider(snapshot: CloudSnapshot): CloudAppServerProvider | null {
  const providers = snapshot.server.providers;
  return providers.find((provider) => provider.configured) ?? providers[0] ?? null;
}

export function snapshotSandbox(snapshot: CloudSnapshot): { name: string; sandbox: CloudSandboxSummary } | null {
  return snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted'
    ? { name: snapshot.profile.name, sandbox: snapshot.profile.sandbox }
    : null;
}

function chooseState(
  snapshot: CloudSnapshot,
  intent: CloudSetupIntent,
  draft: CloudProfileDraft,
  boatAvailable: boolean,
): CloudSetupState {
  if (boatAvailable && snapshot.boat?.account.connected) return { kind: 'choose', draft, intent, mode: 'boat' };
  const preferred = snapshot.server.preferredMode
    ?? (snapshot.server.providers.some((provider) => provider.configured) ? 'app-hosted' : 'self-hosted');
  return { kind: 'choose', draft, intent, mode: preferred };
}

/**
 * 저장된 연결이 이미 모드를 정했으면 모드 선택을 건너뛴다. 선택 화면은 아직 아무것도 고르지 않은
 * 사용자에게만 의미가 있고, 연결이 끊긴 서버를 고치려던 사용자를 처음으로 되돌리면 안 된다.
 */
function entryState(
  snapshot: CloudSnapshot,
  intent: CloudSetupIntent,
  fallback?: CloudProfileDraft,
  boatAvailable = false,
): CloudSetupState {
  const connected = snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready';
  const sandbox = snapshotSandbox(snapshot);
  if (sandbox) {
    const { lifecycle, message } = snapshot.server;
    if (lifecycle === 'tearing-down') return { kind: 'sandbox-tearing-down', intent, name: sandbox.name };
    if (lifecycle === 'provisioning') {
      return { kind: 'sandbox-provisioning', draft: defaultCloudProfileDraft(fallback), intent, startedAt: Date.now() };
    }
    if (connected && lifecycle !== 'error') {
      return { kind: 'sandbox-ready', intent, name: sandbox.name, sandbox: sandbox.sandbox };
    }
    const detail = message ?? (snapshot.profile.kind === 'configured' ? snapshot.profile.message : null);
    return {
      kind: 'sandbox-failed',
      draft: defaultCloudProfileDraft(fallback),
      intent,
      issue: mapSandboxIssue(new Error(detail ?? 'App sandbox is not ready')),
      phase: 'spawn',
    };
  }
  const boat = boatEntryState(snapshot, intent);
  if (boat) return boat;
  const profile = snapshotProfile(snapshot);
  if (profile) return connected ? { kind: 'connected', profile, intent } : { kind: 'intro', draft: profile, intent };
  if (snapshot.server.lifecycle === 'provisioning') {
    return { kind: 'sandbox-provisioning', draft: defaultCloudProfileDraft(fallback), intent, startedAt: Date.now() };
  }
  return chooseState(snapshot, intent, defaultCloudProfileDraft(fallback), boatAvailable);
}

/**
 * 복구 줄에서 바로 여는 화면. pair = 이미 설치한 환경에 다시 페어링, boat-key = boat 서버를 둔 채
 * API 키만 다시 넣기.
 */
export type CloudSetupEntry = 'pair' | 'boat-key';

export function createCloudSetupState(
  snapshot: CloudSnapshot,
  intent: CloudSetupIntent,
  options: { boat?: boolean; entry?: CloudSetupEntry } = {},
): CloudSetupState {
  const profile = snapshotProfile(snapshot);
  if (options.entry === 'pair' && profile && !snapshotBoatProfile(snapshot)) {
    return { kind: 'existing', draft: profile, intent, errors: {}, pairingCode: '' };
  }
  if (options.entry === 'boat-key' && snapshotBoatProfile(snapshot)) {
    return { kind: 'boat-key', draft: defaultCloudProfileDraft(), intent, apiKey: '', error: null, pending: false };
  }
  return entryState(snapshot, intent, profile, options.boat === true);
}

export function reconcileCloudSetupState(state: CloudSetupState, snapshot: CloudSnapshot): CloudSetupState {
  if (isBoatSetupState(state)) return reconcileBoatState(state, snapshot);
  const sandbox = snapshotSandbox(snapshot);
  const sandboxReady = Boolean(sandbox) && snapshot.profile.kind === 'configured'
    && snapshot.profile.connection === 'ready' && snapshot.server.lifecycle !== 'error';
  if (state.kind === 'sandbox-ready' || state.kind === 'sandbox-tearing-down') {
    if (state.kind === 'sandbox-tearing-down' && snapshot.server.lifecycle === 'tearing-down') return state;
    if (sandboxReady && sandbox) {
      return state.kind === 'sandbox-ready'
        && state.name === sandbox.name
        && state.sandbox.sandboxId === sandbox.sandbox.sandboxId
        ? state
        : { kind: 'sandbox-ready', intent: state.intent, name: sandbox.name, sandbox: sandbox.sandbox };
    }
    return entryState(snapshot, state.intent, snapshotProfile(snapshot));
  }
  if (state.kind === 'sandbox-provisioning') {
    if (snapshot.server.lifecycle === 'provisioning') return state;
    return entryState(snapshot, state.intent, state.draft);
  }
  if (state.kind !== 'connected') return state;
  if (sandboxReady && sandbox) {
    return { kind: 'sandbox-ready', intent: state.intent, name: sandbox.name, sandbox: sandbox.sandbox };
  }
  const boat = boatEntryState(snapshot, state.intent);
  if (boat) return boat;
  const profile = snapshotProfile(snapshot);
  if (profile && snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready') {
    return draftsEqual(profile, state.profile) ? state : { ...state, profile };
  }
  return entryState(snapshot, state.intent, profile ?? state.profile);
}

/* ── boat ───────────────────────────────────────────────
   계정 연결 → (요금제) → 확인 → 준비 → 완료. 화면은 모두 이 순수 전이에서 나온다.
   데스크톱이 보내는 boat 스냅샷이 사실이고, 화면 상태는 그 위에서 다음 단계를 고를 뿐이다. */

export const BOAT_MACHINE: BoatMachine = 'default';
export const BOAT_MACHINE_LABELS: Readonly<Record<BoatMachine, string>> = {
  default: '4 vCPU · 8 GB',
  small: '2 vCPU · 4 GB',
};
export const BOAT_REGION_LABEL = 'EU';
export const BOAT_CARD_TITLE = `boat · ${BOAT_REGION_LABEL}`;
export const BOAT_DEFAULT_IDLE_MINUTES = 30;
export const BOAT_STAGE_ORDER = ['creating', 'starting', 'installing', 'pairing', 'credentials'] as const;
export type BoatVisibleStage = typeof BOAT_STAGE_ORDER[number];
export type BoatHostPlatform = 'mac' | 'windows' | 'other';

const BOAT_PROVIDER_LABELS: Readonly<Record<BoatProvider, string>> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
/** 실패 기록의 시각은 데스크톱이 찍는다. 같은 기기라 시계는 같지만 반올림 여유를 둔다. */
const BOAT_SETUP_CLOCK_SLACK_MS = 2_000;

export function isBoatSetupState(state: CloudSetupState | null): state is BoatSetupState {
  return Boolean(state && state.kind.startsWith('boat-'));
}

/** boat 로 만든 내 서버 프로필. 일반 VPS 프로필과 같은 모양이지만 boat 표시가 붙는다. */
export function snapshotBoatProfile(snapshot: CloudSnapshot): { sandboxId: string; machine: BoatMachine } | null {
  return snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'self-hosted'
    ? snapshot.profile.profile.boat ?? null
    : null;
}

/**
 * 이번 시도에 속한 설정 기록. 실패가 없는 기록은 시작 시각과 상관없이 받는다(예전 데스크톱은 다시 시도에도
 * 처음 시각을 보낸다). 이번 시도보다 먼저 시작된 실패만 지난 시도의 것으로 버린다.
 */
export function boatAttemptSetup(
  setup: BoatSetupProgress | null | undefined,
  attemptStartedAt: number,
): BoatSetupProgress | null {
  if (!setup) return null;
  if (!setup.error) return setup;
  const setupAt = Date.parse(setup.startedAt);
  return !Number.isFinite(setupAt) || setupAt >= attemptStartedAt - BOAT_SETUP_CLOCK_SLACK_MS ? setup : null;
}

export function boatSetupRunning(setup: BoatSetupProgress | null | undefined): boolean {
  return Boolean(setup && !setup.error && setup.stage !== 'done');
}

export function boatStageLabel(stage: BoatVisibleStage, platform: BoatHostPlatform = 'mac'): string {
  switch (stage) {
    case 'creating': return '서버 만들기';
    case 'starting': return '서버 켜기';
    case 'installing': return 'Cloud 설치';
    case 'pairing': return platform === 'windows' ? '이 PC 연결' : platform === 'other' ? '이 컴퓨터 연결' : '이 Mac 연결';
    case 'credentials': return '로그인 정보 옮기기';
  }
}

export interface BoatStageRow {
  stage: BoatVisibleStage;
  label: string;
  status: 'done' | 'active' | 'pending';
}

/** 현재 단계 앞은 끝났고, 뒤는 기다린다. 'done' 이면 모두 끝났다. */
export function boatStageRows(stage: BoatSetupStage, platform: BoatHostPlatform = 'mac'): BoatStageRow[] {
  const current = stage === 'done' ? BOAT_STAGE_ORDER.length : BOAT_STAGE_ORDER.indexOf(stage);
  return BOAT_STAGE_ORDER.map((entry, index) => ({
    stage: entry,
    label: boatStageLabel(entry, platform),
    status: index < current ? 'done' : index === current ? 'active' : 'pending',
  }));
}

/** 표 숫자로 맞춰 읽히도록 m:ss (한 시간이 넘으면 h:mm:ss). */
export function formatBoatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** 6자리 코드는 세 자리씩 끊어 읽는다. 다른 길이는 그대로 둔다. */
export function formatBoatUserCode(code: string): string {
  const compact = code.replace(/\s+/g, '');
  return /^\d{6}$/.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : compact;
}

export function formatBoatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}시간`;
}

export function boatProvidersLabel(providers: readonly BoatProvider[]): string {
  return providers.map((provider) => BOAT_PROVIDER_LABELS[provider]).join(' · ');
}

export function boatIdleLabel(minutes: number): string {
  return minutes % 60 === 0 && minutes >= 60 ? `${minutes / 60}시간 쓰지 않으면` : `${minutes}분 쓰지 않으면`;
}

/** 자동 중지 한 줄. 필드가 없는 데스크톱은 idle 로 읽는다. */
export function boatAutoStopLabel(server: Pick<BoatServerSnapshot, 'idleStopMinutes'>
  & Partial<Pick<BoatServerSnapshot, 'autoStop' | 'timerHours'>> | null | undefined): string {
  if (server?.autoStop === 'timer' && typeof server.timerHours === 'number' && server.timerHours > 0) {
    return `시작 후 ${formatBoatHours(server.timerHours)}`;
  }
  return boatIdleLabel(server?.idleStopMinutes ?? BOAT_DEFAULT_IDLE_MINUTES);
}

export function validateBoatEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return '이메일이 필요합니다.';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254 ? null : '이메일 형식이 올바르지 않습니다.';
}

export function validateBoatApiKey(apiKey: string): string | null {
  const value = apiKey.trim();
  if (!value) return 'API 키가 필요합니다.';
  return /^boat_[A-Za-z0-9_-]{8,}$/.test(value) ? null : 'boat_로 시작하는 키가 필요합니다.';
}

/** 계정이 연결된 뒤의 다음 화면. 요금제가 없다고 확인된 경우에만 결제로 보낸다. */
export function boatStateAfterAccount(
  snapshot: CloudSnapshot,
  intent: CloudSetupIntent,
  draft: CloudProfileDraft,
): BoatSetupState {
  const account = snapshot.boat?.account;
  if (!account?.connected) return { kind: 'boat-connect', draft, intent, email: '', error: null, pending: false };
  // 이미 있는 boat 서버에 계정을 다시 이은 것이다. 새로 설정하지 않는다.
  if (snapshotBoatProfile(snapshot)) {
    return { kind: 'boat-ready', intent, importedProviders: snapshot.boat?.setup?.importedProviders ?? [] };
  }
  if (account.canStart === false) return { kind: 'boat-billing', draft, intent, opened: false, pending: false };
  return { kind: 'boat-confirm', draft, intent };
}

export function boatSetupIssue(error: BoatSetupProgress['error'] | unknown): CloudSetupIssue {
  const reported = error && typeof error === 'object' && !(error instanceof Error)
    ? error as { title?: unknown; guidance?: unknown; detail?: unknown }
    : null;
  if (reported && typeof reported.title === 'string') {
    return {
      title: reported.title,
      guidance: typeof reported.guidance === 'string' ? reported.guidance : '',
      detail: typeof reported.detail === 'string' ? reported.detail : '',
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  return {
    title: 'boat 서버를 준비하지 못했습니다',
    guidance: message || '잠시 후 다시 시도합니다.',
    detail: code ? `${code}\n${message}` : message,
  };
}

/**
 * 설정 진행·실패 기록이 화면을 차지해도 되는지. 다른 서버를 이미 쓰고 있으면 지난 boat 기록은
 * 그 서버의 설정을 가리지 않는다.
 */
export function boatSetupOwnsEntry(snapshot: CloudSnapshot): boolean {
  return snapshot.profile.kind === 'unconfigured';
}

/** 실패한 설정. 계정이 끊겨 있으면 다시 시도해도 같은 실패라 계정 연결로 보낸다. */
function boatFailureState(
  snapshot: CloudSnapshot,
  intent: CloudSetupIntent,
  draft: CloudProfileDraft,
  error: BoatSetupProgress['error'],
): BoatSetupState {
  if (snapshot.boat?.account.connected === false) {
    return { kind: 'boat-connect', draft, intent, email: '', error: null, pending: false };
  }
  return { kind: 'boat-failed', draft, intent, issue: boatSetupIssue(error) };
}

/** 이 화면에 들어올 때 이미 진행 중이거나 끝난 boat 설정이 있으면 그 자리로 간다. */
function boatEntryState(snapshot: CloudSnapshot, intent: CloudSetupIntent): BoatSetupState | null {
  const setup = boatSetupOwnsEntry(snapshot) ? snapshot.boat?.setup : null;
  const draft = defaultCloudProfileDraft();
  if (setup?.error) return boatFailureState(snapshot, intent, draft, setup.error);
  if (setup && boatSetupRunning(setup)) {
    const startedAt = Date.parse(setup.startedAt);
    return { kind: 'boat-progress', draft, intent, startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() };
  }
  if (snapshotBoatProfile(snapshot)) {
    // 계정이 끊긴 boat 서버는 계정 연결로 간다. 서버와 페어링은 그대로 둔다.
    if (snapshot.boat?.account.connected === false) {
      return { kind: 'boat-connect', draft, intent, email: '', error: null, pending: false };
    }
    // 계정에서 지워진 서버는 같은 설정으로 새로 만든다.
    if (snapshot.boat?.server?.state === 'missing') return { kind: 'boat-confirm', draft, intent };
    return { kind: 'boat-ready', intent, importedProviders: snapshot.boat?.setup?.importedProviders ?? [] };
  }
  return null;
}

function sameProviders(left: readonly BoatProvider[], right: readonly BoatProvider[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

export function reconcileBoatState(state: BoatSetupState, snapshot: CloudSnapshot): CloudSetupState {
  const boat: BoatSnapshot | null = snapshot.boat ?? null;
  const account = boat?.account;
  switch (state.kind) {
    case 'boat-signin':
      return account?.connected ? boatStateAfterAccount(snapshot, state.intent, state.draft) : state;
    case 'boat-key':
      return state.pending && account?.connected ? boatStateAfterAccount(snapshot, state.intent, state.draft) : state;
    case 'boat-billing':
      if (!account?.connected) return { kind: 'boat-connect', draft: state.draft, intent: state.intent, email: '', error: null, pending: false };
      return account.canStart === true ? { kind: 'boat-confirm', draft: state.draft, intent: state.intent } : state;
    case 'boat-progress': {
      const setup = boat?.setup;
      const attempt = boatAttemptSetup(setup, state.startedAt);
      if (attempt?.error) return boatFailureState(snapshot, state.intent, state.draft, attempt.error);
      if (snapshotBoatProfile(snapshot) && (!setup || setup.stage === 'done')) {
        return { kind: 'boat-ready', intent: state.intent, importedProviders: setup?.importedProviders ?? [] };
      }
      return state;
    }
    case 'boat-ready': {
      if (!snapshotBoatProfile(snapshot)) return entryState(snapshot, state.intent, undefined, true);
      const imported = boat?.setup?.importedProviders;
      return imported && imported.length && !sameProviders(imported, state.importedProviders)
        ? { ...state, importedProviders: imported }
        : state;
    }
    default:
      return state;
  }
}

export interface BoatCardStatus {
  title: string;
  detail: string;
  dot: 'connected' | 'connecting' | 'disconnected' | 'unknown';
  pulse: boolean;
  /** account 는 서버를 둔 채 boat 계정만 다시 잇는 API 키 입력이다. */
  action: { kind: 'wake' | 'stop' | 'open' | 'account'; label: string; disabled: boolean } | null;
  /** 연결 해제·서버 삭제 메뉴. 설정이 진행 중일 때만 숨긴다. */
  menu: boolean;
}

/** 설정의 Cloud 서버 카드가 boat 를 보여 줄 때의 한 줄. boat 와 무관하면 null. */
export function boatCardStatus(snapshot: CloudSnapshot, platform: BoatHostPlatform = 'mac'): BoatCardStatus | null {
  const boat = snapshot.boat ?? null;
  const profile = snapshotBoatProfile(snapshot);
  // 다른 서버를 쓰는 동안 남은 boat 설정 기록은 카드를 차지하지 않는다.
  const setup = boatSetupOwnsEntry(snapshot) ? boat?.setup ?? null : null;
  if (setup && boatSetupRunning(setup)) {
    return {
      title: BOAT_CARD_TITLE,
      detail: `설정 중 · ${boatStageLabel(setup.stage as BoatVisibleStage, platform)}`,
      dot: 'connecting', pulse: true,
      action: { kind: 'open', label: '진행 보기', disabled: false },
      menu: false,
    };
  }
  if (setup?.error) {
    return {
      title: BOAT_CARD_TITLE,
      detail: setup.error.title,
      dot: 'disconnected', pulse: false,
      action: { kind: 'open', label: '관리', disabled: false },
      menu: true,
    };
  }
  if (!profile) return null;
  const server = boat?.server ?? null;
  const hours = server?.monthHours !== null && server?.monthHours !== undefined
    ? ` · 이번 달 ${formatBoatHours(server.monthHours)}`
    : '';
  const link = inferCloudLink(snapshot);
  const base = { title: BOAT_CARD_TITLE, menu: true };
  // 키가 끊기면 시작·중지·상태 읽기가 모두 막힌다. 서버 상태보다 이것을 먼저 보인다.
  if (boat?.account.connected === false) {
    return { ...base, detail: 'boat 계정 연결이 끊겼습니다', dot: 'disconnected', pulse: false,
      action: { kind: 'account', label: 'API 키 입력', disabled: false } };
  }
  switch (server?.state) {
    case 'running':
      if (link.kind === 'reconnecting' || link.kind === 'recreating') {
        return { ...base, detail: '연결하는 중', dot: 'connecting', pulse: true,
          action: { kind: 'stop', label: '중지', disabled: true } };
      }
      if (link.kind === 'failed') {
        return { ...base, detail: '연결에 문제가 있습니다', dot: 'disconnected', pulse: false,
          action: { kind: 'stop', label: '중지', disabled: false } };
      }
      return { ...base, detail: `실행 중${hours}`, dot: 'connected', pulse: false,
        action: { kind: 'stop', label: '중지', disabled: false } };
    case 'stopped':
      return { ...base, detail: `정지됨${hours}`, dot: 'unknown', pulse: false,
        action: { kind: 'wake', label: '시작', disabled: false } };
    case 'waking':
      return { ...base, detail: '시작하는 중', dot: 'connecting', pulse: true,
        action: { kind: 'wake', label: '시작', disabled: true } };
    case 'stopping':
      return { ...base, detail: '중지하는 중', dot: 'connecting', pulse: true,
        action: { kind: 'stop', label: '중지', disabled: true } };
    case 'missing':
      return { ...base, detail: '서버를 찾을 수 없습니다', dot: 'disconnected', pulse: false,
        action: { kind: 'open', label: '다시 만들기', disabled: false } };
    case 'error':
      return { ...base, detail: server.message ?? '서버에 문제가 있습니다', dot: 'disconnected', pulse: false,
        action: { kind: 'wake', label: '시작', disabled: false } };
    default:
      return { ...base, detail: '상태 확인 중', dot: 'unknown', pulse: false, action: null };
  }
}

/** 멈춘 boat VM 은 끊긴 연결이 아니다. 보내거나 여는 순간 데스크톱이 깨운다. */
export function boatServerResting(snapshot: CloudSnapshot): boolean {
  const state = snapshot.boat?.server?.state;
  return Boolean(snapshotBoatProfile(snapshot)) && (state === 'stopped' || state === 'stopping');
}

export function boatServerWaking(snapshot: CloudSnapshot): boolean {
  return Boolean(snapshotBoatProfile(snapshot)) && snapshot.boat?.server?.state === 'waking';
}
