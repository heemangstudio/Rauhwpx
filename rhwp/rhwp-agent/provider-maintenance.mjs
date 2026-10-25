/** A shared-prefix maintenance barrier. Warm sessions keep their native resume state. */
export function createProviderMaintenance({ busy, releaseIdle, install, refresh }) {
  let pending = null;
  return {
    active: () => pending !== null,
    wait: () => pending?.catch(() => {}) ?? Promise.resolve(),
    run(agent) {
      if (!['claude', 'codex'].includes(agent)) return Promise.reject(new Error('Unknown provider'));
      if (pending || busy()) return Promise.reject(Object.assign(new Error('채팅이 끝나기를 기다리고 있습니다.'), { status: 409 }));
      // The barrier is visible before releaseIdle can yield to a new message.
      pending = Promise.resolve().then(async () => {
        await releaseIdle();
        await install(agent);
        return refresh(agent);
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
