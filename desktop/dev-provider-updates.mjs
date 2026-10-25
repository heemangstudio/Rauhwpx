/** Fixture for the unpackaged Electron update flow. Never calls a real provider installer. */
export function createDevProviderUpdates({ scenario, installed = {}, persist = async () => {}, busyMs = 0 }) {
  const until = Date.now() + busyMs;
  let failed = false;
  const statuses = Object.fromEntries(['claude', 'codex'].map((id) => [id, {
    installed: true, version: installed[id] ?? '1.0.0', latestVersion: '2.0.0',
    updateRequired: installed[id] !== '2.0.0',
  }]));
  return async (agent = null) => {
    if (!agent) return { statuses: structuredClone(statuses), busy: Date.now() < until };
    if (!['claude', 'codex'].includes(agent)) throw new Error('Unknown fixture provider');
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (scenario === 'partial-failure' && agent === 'claude' && !failed) {
      failed = true;
      throw new Error('Claude 다운로드 실패 테스트 응답');
    }
    statuses[agent].version = '2.0.0';
    statuses[agent].updateRequired = false;
    await persist(Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, status.version])));
    return { statuses: structuredClone(statuses) };
  };
}
