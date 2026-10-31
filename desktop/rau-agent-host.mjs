// Rau 에이전트를 허브에 잇는다: 허브 자식 프로세스의 요청에 Rau 자격과(Rau 를 쓸 수 있을 때만) lease 를 준다.
// Rau 하네스는 Pi 런타임이 lease 를 API 키로 써서 사이트 API 의 /v1/rau/agent 로 모델을 부른다 — 선물 크레딧과 같은 길이다.
// 자격은 GET /v1/rau/status(rau-client.mjs 의 status)로 묻는다. Rau-0.1 학습과 같은 자격·크레딧이다.

/**
 * 허브의 {type:'rhwp-rau-agent-request', id, operation:'status'} 에 답한다. 다른 메시지면 null.
 * value: {availability:'active', lease, apiBase, status} | {availability:'not_eligible'|'unavailable', reason}
 *   active: Rau 요금제나 Rau 체험이 살아 있다 (크레딧을 다 썼어도 — 허브가 exhausted 로 보인다).
 *     status 는 사이트 API 의 status 답 모양(ok, eligible, source, allowanceUsd, usedUsd, remainingUsd, resetsAt, agent)이다.
 *   not_eligible: 서버가 eligible:false 나 403 rau_plan_required 로 답했다 (무료·Hama 요금제).
 *   unavailable: 호스팅 기능에 줄 lease 없음(no_license — 로그아웃·무료 lease), 서버 꺼짐(rau_not_configured),
 *     네트워크·서버 오류, 거절된 lease, 알 수 없는 Rau 경로(bad_agent).
 */
export async function handleRauAgentRequest({ client, currentLease }, message) {
  if (!message || message.type !== 'rhwp-rau-agent-request' || typeof message.id !== 'string') return null;
  const response = { type: 'rhwp-rau-agent-response', id: message.id };
  if (message.operation !== 'status') {
    return { ...response, ok: false, error: 'Unsupported Rau operation.', code: 'RAU_AGENT_UNSUPPORTED' };
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
  let status;
  try {
    status = await client.status(lease);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'network';
    return {
      ...response,
      ok: true,
      value: code === 'rau_plan_required'
        ? { availability: 'not_eligible', reason: code }
        : { availability: 'unavailable', reason: code },
    };
  }
  // 자격이 없으면 lease 는 보내지 않는다.
  if (!status?.eligible) return { ...response, ok: true, value: { availability: 'not_eligible', reason: 'rau_plan_required' } };
  if (!status.agent) return { ...response, ok: true, value: { availability: 'unavailable', reason: 'bad_agent' } };
  return {
    ...response,
    ok: true,
    value: {
      availability: 'active',
      lease,
      apiBase: client.baseUrl,
      status: {
        ok: true,
        eligible: true,
        source: status.source,
        allowanceUsd: status.allowanceUsd,
        usedUsd: status.usedUsd,
        remainingUsd: status.remainingUsd,
        resetsAt: status.resetsAt,
        agent: status.agent,
      },
    },
  };
}

/** 멈추는 중이거나 이전 허브의 요청에 보내는 거절. */
export function staleRauAgentResponse(message) {
  return { type: 'rhwp-rau-agent-response', id: message?.id, ok: false, error: 'stale', code: 'RAU_AGENT_OWNER_STALE' };
}
