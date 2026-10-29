// Hama 플랜을 허브에 잇는다: 허브 자식 프로세스의 요청에 플랜 상태와(플랜이 살아 있을 때만) lease 를 준다.
// Hama 하네스는 Pi 런타임이 lease 를 API 키로 써서 사이트 API 프록시로 모델을 부른다 — 선물 크레딧과 같은 길이다.
import { HamaServerError } from './hama-client.mjs';

/**
 * 허브의 {type:'rhwp-hama-request', id, operation:'status'} 에 답한다. 다른 메시지면 null.
 * value: {availability:'active', lease, apiBase, status} | {availability:'not_enrolled'|'unavailable', reason}
 *   not_enrolled: 서버가 403 hama_not_enrolled 로 답했다 (Free·Pro 포함 Hama 플랜이 아닌 라이선스).
 *   unavailable: 라이선스 없음(no_license), 서버 꺼짐(not_configured), 네트워크·서버 오류, 거절된 lease.
 */
export async function handleHamaRequest({ client, currentLease }, message) {
  if (!message || message.type !== 'rhwp-hama-request' || typeof message.id !== 'string') return null;
  const response = { type: 'rhwp-hama-response', id: message.id };
  if (message.operation !== 'status') {
    return { ...response, ok: false, error: 'Unsupported Hama operation.', code: 'HAMA_UNSUPPORTED' };
  }
  let lease = null;
  try {
    lease = await currentLease();
  } catch {
    lease = null;
  }
  if (typeof lease !== 'string' || !lease) {
    return { ...response, ok: true, value: { availability: 'unavailable', reason: 'no_license' } };
  }
  try {
    const status = await client.status(lease);
    const active = status?.plan?.status === 'active';
    return {
      ...response,
      ok: true,
      value: active
        ? { availability: 'active', lease, apiBase: client.baseUrl, status }
        // 가입은 됐지만 꺼진 플랜도 쓸 수 없다. lease 는 보내지 않는다.
        : { availability: 'not_enrolled', reason: 'plan_disabled' },
    };
  } catch (error) {
    const code = error instanceof HamaServerError ? error.code : 'network';
    return {
      ...response,
      ok: true,
      value: code === 'hama_not_enrolled'
        ? { availability: 'not_enrolled', reason: code }
        : { availability: 'unavailable', reason: code },
    };
  }
}

/** 멈추는 중이거나 이전 허브의 요청에 보내는 거절. */
export function staleHamaResponse(message) {
  return { type: 'rhwp-hama-response', id: message?.id, ok: false, error: 'stale', code: 'HAMA_OWNER_STALE' };
}
