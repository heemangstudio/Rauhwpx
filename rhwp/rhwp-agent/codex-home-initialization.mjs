import path from 'node:path';

const pending = new Map();
const poisoned = new Map();

/** Fresh Codex SQLite migrations race across app-server clients sharing a home.
 * Hold this barrier from before spawn through initialize ACK or failed cleanup.
 * Turns and initialized clients run independently. Cancelled waiters never spawn.
 * Unconfirmed cleanup poisons that home until hub restart; no waiter may spawn.
 */
export async function acquireCodexHomeInitialization(codexHome, { signal } = {}) {
  signal?.throwIfAborted();
  const home = path.resolve(codexHome);
  if (poisoned.has(home)) throw poisoned.get(home);
  const previous = pending.get(home) ?? Promise.resolve();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => held);
  pending.set(home, tail);
  void tail.then(() => { if (pending.get(home) === tail) pending.delete(home); });
  let onAbort;
  try {
    if (signal) {
      await Promise.race([previous, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('Codex initialization cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
      signal.throwIfAborted();
    } else await previous;
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (poisoned.has(home)) { release(); throw poisoned.get(home); }
  release.poison = error => {
    if (!poisoned.has(home)) poisoned.set(home, Object.assign(new Error('Codex initialization cleanup is unconfirmed; restart the hub', { cause: error }), { code: 'CODEX_HOME_INITIALIZATION_BLOCKED' }));
  };
  return release;
}
