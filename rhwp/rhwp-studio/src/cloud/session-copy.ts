import type { AgentName } from '../agent/types.ts';

const PROVIDER_LABELS: Partial<Record<AgentName, string>> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

/** 이 Mac 의 로그인을 다시 보내면 풀리는 멈춤. */
export const PROVIDER_AUTH_SUSPEND_CODES: ReadonlySet<string> = new Set(['PROVIDER_AUTH_EXPIRED', 'AUTH_REQUIRED']);
/** 서버의 작업 실행기 문제로 멈춘 작업. 서버 재시작이 도움이 된다. */
export const WORKER_SUSPEND_CODES: ReadonlySet<string> = new Set(['WORKER_UNSTABLE', 'WORKER_START_FAILED']);

function hangul(text: string | null | undefined): string | null {
  return text && /[가-힣]/.test(text) ? text : null;
}

/** 멈춘 Cloud 작업의 한 줄. 서버 원문은 진단용 영어라서 code 로 문장을 고른다. */
export function suspendedSessionTitle(code: string | null | undefined, provider: AgentName | null | undefined, reason = ''): string {
  const label = (provider && PROVIDER_LABELS[provider]) || '에이전트';
  switch (code) {
    case 'PROVIDER_AUTH_EXPIRED': return `${label} 로그인이 만료되었습니다.`;
    case 'AUTH_REQUIRED': return `${label} 로그인이 필요합니다.`;
    case 'PROVIDER_UNAVAILABLE': return `서버에 ${label}가 설치되어 있지 않습니다.`;
    case 'WORKER_UNSTABLE': return '작업 실행기가 반복해서 멈췄습니다.';
    case 'WORKER_START_FAILED': return '작업 실행기를 시작하지 못했습니다.';
    case 'WORKER_REPLACED_UNCERTAIN': return '작업 도중 실행기가 바뀌었습니다.';
    case 'PROVIDER_TURN_FAILED': return `${label}가 응답을 끝내지 못했습니다.`;
    case 'TURN_LIMIT': return '대화 횟수 한도에 도달했습니다.';
    case 'DURATION_LIMIT': return '작업 시간 한도에 도달했습니다.';
    case 'LOW_DISK': return '서버 저장 공간이 부족합니다.';
    case 'PAUSE_TIMEOUT': return '안전한 경계에서 멈추지 못했습니다.';
    case 'LEASE_ENDED': return 'Cloud 사용 시간이 끝났습니다.';
    case 'USER_PAUSED': return 'Cloud 작업이 일시 중지되었습니다.';
    default: return hangul(reason) ?? 'Cloud 작업이 멈췄습니다.';
  }
}

/**
 * 서버 거절 code 의 한 줄. 서버 원문은 영어라서 code 로 고르고, 원문 맨 앞의 제공자 이름
 * (예: "claude must be authenticated")만 빌린다. 알 수 없는 code 는 null.
 */
export function cloudErrorCodeText(code: string | null | undefined, message = ''): string | null {
  const named = /^\s*(claude|codex|pi|grok|cursor|opencode)\b/i.exec(message)?.[1]?.toLowerCase() as AgentName | undefined;
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'PROVIDER_AUTH_EXPIRED':
    case 'PROVIDER_UNAVAILABLE':
      return suspendedSessionTitle(code, named ?? null);
    default: return null;
  }
}

/** 로그인 문제를 서버에서 풀 때 쓸 명령. 브라우저처럼 로그인을 보낼 수 없는 곳에서 안내한다. */
export function providerLoginHint(provider: string | null | undefined): string {
  return provider ? `서버에서 sudo rauhwpx-cloud provider login ${provider} 실행 후 계속하세요.` : '';
}

/** 실패한 Cloud 작업의 한 줄. 한국어 원문은 그대로 쓴다. */
export function failedSessionTitle(code: string, message: string): string {
  if (code === 'RESULT_EXPIRED') return '결과 보관 기간이 지났습니다.';
  if (code === 'RESULT_PURGED') return '결과가 서버에서 지워졌습니다.';
  return hangul(message) ?? 'Cloud 작업이 실패했습니다.';
}

/** 데스크톱이 보낸 진행 문장. 예전 데스크톱의 영어 문장은 fallback 으로 바꾼다. */
export function sessionProgressText(text: string | null | undefined, fallback: string): string {
  return hangul(text?.trim()) ?? fallback;
}
