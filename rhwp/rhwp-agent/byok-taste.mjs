/**
 * Rau-0.1 취향 학습은 BYOK(pi) 채팅에서 돌지 않는다. 다른 하네스(Claude·Codex·Rau)와 호스팅 Rau 경로는 그대로다.
 *
 * @param {string | null | undefined} agent 이 턴(또는 이 문서를 맡은 채팅)의 에이전트
 */
export function tasteLearningAllowed(agent) {
  return agent !== 'pi';
}
