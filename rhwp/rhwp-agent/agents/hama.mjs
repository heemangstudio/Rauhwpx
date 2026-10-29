/**
 * Hama 하네스 어댑터. 런타임·MCP 도구·시스템 프롬프트는 Pi 와 같고, 모델과 과금만 다르다:
 * 자격은 Hama 플랜의 라이선스 lease, 홈은 `<piRoot>/agent-hama`, 모델은 Hama 목록(Haiku 5.5 + 싼 모델)이다.
 * 허브가 resolvePiAccess 로 Hama 자격만 넘긴다 — 사용자 키(BYOK)로 넘어가는 길은 없다.
 */
import { canResumePiSession, createPiSession } from './pi.mjs';

/** @param {import('./pi.mjs').PiBackendOptions} opts */
export function createHamaSession(opts, deps) {
  return createPiSession({ ...opts, agentName: 'hama' }, deps);
}

/** 세션 파일은 Pi 와 같은 `<piRoot>/sessions` 에 있다. */
export const canResumeHamaSession = canResumePiSession;
