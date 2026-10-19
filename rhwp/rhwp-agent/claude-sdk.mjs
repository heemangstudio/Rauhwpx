let sdk = null;

/**
 * Claude Agent SDK 는 첫 SDK 턴이나 모델 목록에서 읽는다. 허브 기동 때 읽으면 Codex·Pi 만 쓰는
 * 사용자도 30 MiB 가량을 계속 들고 있고 준비가 0.1초쯤 늦어진다.
 */
export function loadClaudeSdk() {
  sdk ??= import('@anthropic-ai/claude-agent-sdk').catch((error) => {
    sdk = null;
    throw error;
  });
  return sdk;
}

/**
 * SDK query() 와 같은 모양(비동기 반복과 close)을 바로 돌려주고, SDK 는 그 뒤에 읽어 시작한다.
 * 읽기 전에 닫으면 시작하지 않는다.
 */
export function queryClaudeSdk(params) {
  let query = null;
  let closed = false;
  const ready = loadClaudeSdk().then(({ query: start }) => {
    if (closed) return null;
    query = start(params);
    return query;
  });
  return {
    async *[Symbol.asyncIterator]() {
      const started = await ready;
      if (started) yield* started;
    },
    async close() {
      closed = true;
      const started = query ?? await ready.catch(() => null);
      return started?.close();
    },
  };
}
