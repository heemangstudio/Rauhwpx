/**
 * A shared-prefix maintenance barrier. Warm sessions keep their native resume state.
 * The barrier covers only the install and the status refresh. `afterRelease`
 * runs once the barrier is down (model catalogs, for example), so new chats
 * never wait on slow follow-up work after npm has finished.
 */
export function createProviderMaintenance({ busy, releaseIdle, install, refresh, afterRelease = null }) {
  let pending = null;
  return {
    active: () => pending !== null,
    wait: () => pending?.catch(() => {}) ?? Promise.resolve(),
    run(agent) {
      if (!['claude', 'codex'].includes(agent)) return Promise.reject(new Error('Unknown provider'));
      if (pending || busy()) return Promise.reject(Object.assign(new Error('채팅이 끝나기를 기다리고 있습니다.'), { status: 409 }));
      // The barrier is visible before releaseIdle can yield to a new message.
      const running = Promise.resolve().then(async () => {
        await releaseIdle();
        await install(agent);
        return refresh(agent);
      }).finally(() => { pending = null; });
      pending = running;
      if (typeof afterRelease === 'function') {
        void running.then(() => afterRelease(agent)).catch(() => {});
      }
      return running;
    },
  };
}

/**
 * One automatic harness-update round. Claude and Codex only read the registry
 * for a newer version, so open chats never defer them. Pi swaps its prefix on
 * disk, so it waits until no chat holds a provider process.
 *
 * @param {{ piOnly?: boolean, canActivate: () => boolean,
 *   checkRegistry: () => Promise<void>, updatePi: () => Promise<void> }} round
 * @returns {Promise<{ piDeferred: boolean }>}
 */
export async function runHarnessUpdateRound({ piOnly = false, canActivate, checkRegistry, updatePi }) {
  if (!piOnly) await checkRegistry();
  if (!canActivate()) return { piDeferred: true };
  await updatePi();
  return { piDeferred: false };
}
