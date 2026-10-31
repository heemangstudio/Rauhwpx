// 기억(계정 단계)의 허브 연결: Rau 요금제일 때만 <user_memory> 를 싣고 도구에 돌려주며, 공급자 세션마다 한 번만 싣는다.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DocumentMemoryStore } from '../document-memory-store.mjs';
import { createUserMemoryHub, newSessionUserMemory } from '../user-memory-hub.mjs';
import { UserMemoryStore } from '../user-memory-store.mjs';

function harness(t, { availability = 'active', legacy = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-user-memory-hub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new UserMemoryStore({ dir });
  const documentStore = new DocumentMemoryStore({ dir });
  const state = { availability };
  const listeners = new Set();
  const hosted = {
    cachedEligibility: () => state.availability,
    eligibility: async () => state.availability,
    onEligibilityChange: (callback) => listeners.add(callback),
  };
  const frames = [];
  const changed = [];
  const hub = createUserMemoryHub({
    store,
    hosted,
    documentStore,
    legacy: () => legacy,
    broadcast: (frame) => frames.push(frame),
    changed: (...args) => changed.push(args),
  });
  const setAvailability = (value) => {
    state.availability = value;
    for (const listener of listeners) listener(value);
  };
  return { store, documentStore, hub, frames, changed, setAvailability };
}

test('<user_memory> rides once per provider session, again after a change, a forced new session or a forgotten delivery', async (t) => {
  const { store, hub } = harness(t);
  await store.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [] });
  await hub.prepare();
  const session = { agent: 'claude', userMemory: newSessionUserMemory() };
  const first = hub.takeBlock(session);
  assert.match(first, /<user_memory revision="1">[\s\S]*\[STYLE, 강도 1\] 본문은 한다체 사용/);
  hub.settleDelivery(session, true);
  assert.equal(hub.takeBlock(session), '', 'delivered already');
  hub.settleDelivery(session, true);
  assert.match(hub.takeBlock(session, { force: true }), /본문은 한다체 사용/, 'a new provider session gets it again');
  hub.settleDelivery(session, false);
  assert.equal(hub.takeBlock(session), '', 'a failed turn keeps the earlier delivery');
  hub.settleDelivery(session, true);
  await store.addUserRule({ kind: 'term', text: "'고객' 대신 '이용자'" });
  assert.match(hub.takeBlock(session), /<user_memory revision="2">/, 'a new revision is sent');
  hub.settleDelivery(session, true);
  hub.forgetDelivery(session);
  assert.match(hub.takeBlock(session), /<user_memory revision="2">/, 'sent again after compaction or a lost resume');
  // 세션 상태가 없는 세션도 처음 싣는 데 쓴다.
  assert.match(hub.takeBlock({ agent: 'codex' }), /<user_memory/);
});

test('without the Rau plan nothing is injected, the tool returns no rules, and a delivered memory is announced as emptied once', async (t) => {
  const { store, hub, frames, setAvailability } = harness(t, { availability: 'not_eligible' });
  await store.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [] });
  await hub.prepare();
  const session = { agent: 'claude' };
  assert.equal(hub.takeBlock(session), '');
  assert.equal(await hub.toolAccount(), null);
  assert.equal(hub.personalProfile(), false);
  const hama = await hub.snapshot();
  assert.deepEqual([hama.available, hama.availability, hama.rules.length], [false, 'not_eligible', 1]);

  setAvailability('exhausted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.at(-1).type, 'user-memory', 'eligibility changes reach every window');
  assert.equal(frames.at(-1).memory.availability, 'exhausted');
  assert.match(hub.takeBlock(session), /본문은 한다체 사용/, 'used-up credits still inject memory');
  hub.settleDelivery(session, true);
  assert.deepEqual(await hub.toolAccount(), { revision: 1, rules: [{ id: (await store.read()).rules[0].id, kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', strength: 1 }] });
  assert.equal(hub.personalProfile(), true);

  setAvailability('unavailable');
  const emptied = hub.takeBlock(session);
  assert.match(emptied, /No user habits apply now/);
  assert.doesNotMatch(emptied, /한다체/);
  hub.settleDelivery(session, true);
  assert.equal(hub.takeBlock(session), '', 'the emptied notice is sent once');
});

test('Rau tab requests add, edit, delete, restore and undo, broadcast each change and restore folded document notes', async (t) => {
  const { store, documentStore, hub, frames, changed } = harness(t, { legacy: { files: 3 } });
  const key = await documentStore.resolveKey({ documentId: 'doc-1', fileName: '보고서.hwpx' });
  const added = await documentStore.apply(key, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true }], { origin: 'learned' });
  const folded = await documentStore.apply(key, [{ op: 'remove', id: added.changes[0].entryId, folded: true }], { origin: 'learned' });
  await store.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [key], folded: [{ key, entry: folded.changes[0].prev }] });

  const listed = await hub.studioRequest({ op: 'list' });
  assert.deepEqual([listed.ok, listed.memory.legacy, listed.memory.rules.length, listed.memory.available], [true, { files: 3 }, 1, true]);
  assert.equal(frames.length, 0, 'list broadcasts nothing');

  const add = await hub.studioRequest({ op: 'add', rule: { kind: 'term', text: "'고객' 대신 '이용자'" } });
  assert.equal(add.ok, true);
  assert.equal(frames.at(-1).type, 'user-memory');
  const userRule = add.memory.rules.find((rule) => rule.origin === 'user');
  const edit = await hub.studioRequest({ op: 'edit', id: userRule.id, text: "'고객' 대신 '사용자'" });
  assert.equal(edit.memory.rules.find((rule) => rule.id === userRule.id).text, "'고객' 대신 '사용자'");
  const removed = await hub.studioRequest({ op: 'delete', id: userRule.id });
  assert.equal(removed.memory.retired[0].reason, 'deleted');
  const restored = await hub.studioRequest({ op: 'restore', id: userRule.id });
  assert.equal(restored.memory.rules.some((rule) => rule.id === userRule.id), true);

  const escalation = restored.memory.events.find((event) => event.kind === 'escalated');
  const undone = await hub.studioRequest({ op: 'undo', eventId: escalation.id });
  assert.equal(undone.ok, true);
  assert.deepEqual((await documentStore.read(key)).entries.map((entry) => entry.text), ['본문은 한다체 사용'], 'the folded note is back');
  assert.deepEqual(changed.map(([documentId, changedKey]) => [documentId, changedKey]), [['doc-1', key]]);

  for (const [msg, code] of [
    [{ op: 'undo', eventId: escalation.id }, 'USER_MEMORY_UNDO_STALE'],
    [{ op: 'edit', id: 'rule_000000000000', text: 'x' }, 'USER_MEMORY_NOT_FOUND'],
    [{ op: 'add', rule: { kind: 'decision', text: 'x' } }, 'USER_MEMORY_INVALID'],
    [{ op: 'wipe' }, 'USER_MEMORY_INVALID'],
  ]) {
    const reply = await hub.studioRequest(msg);
    assert.deepEqual([reply.ok, reply.error.code], [false, code], JSON.stringify(msg));
  }
});
