import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Drives the same calls against two copies of a service, one on memory stores and one on
 * Postgres stores, and checks after every step that both answered the same and hold the same state.
 */

/** Deterministic `random(n)`: both copies draw the same keys, ids, sessions and grants. */
export function seededRandom(seed) {
  let counter = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let offset = 0; offset < n; offset += 32) {
      createHash('sha256').update(`${seed}:${counter}`).digest().copy(out, offset);
      counter += 1;
    }
    return out;
  };
}

/** What a JSON file would hold: `undefined` dropped, `-0` → 0. The memory store keeps both. */
export const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function outcome(fn) {
  try {
    return { ok: true, value: asJson(await fn()) };
  } catch (error) {
    return { ok: false, error: { code: error?.code, status: error?.status, message: error?.message, extra: asJson(error?.extra) } };
  }
}

/**
 * `worlds` = { memory, postgres }, each `{ stores: { name: store } }` plus whatever the steps use.
 * `orderOf(name, state)` lists the key orders that must match too (deepEqual ignores them).
 * Returns `step(label, fn)` → the memory copy's answer (`{ ok, value | error }`).
 */
export function differential(worlds, { orderOf = () => null } = {}) {
  async function sameState(label) {
    for (const name of Object.keys(worlds.memory.stores)) {
      const expected = asJson(await worlds.memory.stores[name].read());
      const actual = await worlds.postgres.stores[name].read();
      assert.deepStrictEqual(actual, expected, `${label}: ${name} state`);
      assert.deepStrictEqual(orderOf(name, actual), orderOf(name, expected), `${label}: ${name} key order`);
    }
  }
  return async function step(label, fn) {
    const expected = await outcome(() => fn(worlds.memory));
    const actual = await outcome(() => fn(worlds.postgres));
    assert.deepStrictEqual(actual, expected, `${label}: answer`);
    await sameState(label);
    return expected;
  };
}
