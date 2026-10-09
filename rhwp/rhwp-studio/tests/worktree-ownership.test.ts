import test from 'node:test';
import assert from 'node:assert/strict';
import { WorktreeOwnership } from '../src/versioning/worktree-ownership.ts';

/** 서로 다른 창이 같은 브라우저의 Web Locks를 공유하는 계약을 재현한다. */
function lockManager() {
  const held = new Set<string>();
  let pause: Promise<void> | null = null;
  let resume: (() => void) | null = null;
  let attempts = 0;
  let failNext = false;
  const locks = {
    async request(name: string, options: { mode: string; ifAvailable: boolean }, callback: (lock: object | null) => Promise<void>) {
      attempts += 1;
      assert.equal(options.mode, 'exclusive');
      assert.equal(options.ifAvailable, true);
      await Promise.resolve();
      if (pause) await pause;
      // 브라우저는 요청을 별도 작업으로 처리해 앞 callback의 즉시 해제를 먼저 반영한다.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (failNext) {
        failNext = false;
        throw new Error('Web Locks unavailable');
      }
      if (held.has(name)) return callback(null);
      held.add(name);
      try { await callback({ name }); }
      finally { held.delete(name); }
    },
  } as unknown as Pick<LockManager, 'request'>;
  return {
    locks,
    held,
    get attempts() { return attempts; },
    fail() { failNext = true; },
    pause() { pause = new Promise<void>((resolve) => { resume = resolve; }); },
    resume() { resume?.(); pause = null; },
  };
}

async function flushLocks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('같은 창의 소유자 둘과 다른 창의 관리자는 같은 작업 사본을 동시에 편집할 수 없다', async () => {
  const manager = lockManager();
  const firstWindow = new WorktreeOwnership(manager.locks);
  const secondWindow = new WorktreeOwnership(manager.locks);
  const first = {};
  const second = {};
  const remote = {};
  assert.equal(await firstWindow.claim(first, 'document-1'), true);
  assert.equal(await firstWindow.claim(second, 'document-1'), false);
  assert.equal(await secondWindow.claim(remote, 'document-1'), false);
  assert.equal(firstWindow.owns(first, 'document-1'), true);
  assert.equal(firstWindow.owns(second, 'document-1'), false);
  assert.equal(secondWindow.owns(remote, 'document-1'), false);
  firstWindow.release(first);
  await flushLocks();
  assert.equal(manager.held.size, 0);
});

test('사용할 수 없었던 소유권은 기존 소유자가 해제하면 같은 관리자가 다시 요청할 수 있다', async () => {
  const manager = lockManager();
  const firstWindow = new WorktreeOwnership(manager.locks);
  const secondWindow = new WorktreeOwnership(manager.locks);
  const owner = {};
  const waiting = {};
  assert.equal(await firstWindow.claim(owner, 'document-1'), true);
  assert.equal(await secondWindow.claim(waiting, 'document-1'), false);
  firstWindow.release(owner);
  await flushLocks();
  assert.equal(await secondWindow.claim(waiting, 'document-1'), true);
  assert.equal(secondWindow.owns(waiting, 'document-1'), true);
  secondWindow.release(waiting);
  await flushLocks();
  assert.equal(await firstWindow.claim(owner, 'document-1'), true);
  firstWindow.release(owner);
  await flushLocks();
});

test('Web Locks가 없는 환경에서는 작업 사본을 읽기 전용으로 유지한다', async () => {
  const ownership = new WorktreeOwnership(null);
  const owner = {};
  assert.equal(await ownership.claim(owner, 'document-1'), false);
  assert.equal(ownership.owns(owner, 'document-1'), false);
  ownership.release(owner);
  assert.equal(await ownership.claim(owner, 'document-1'), false);
});

test('세션을 닫으면 대기 중인 소유권 요청을 해제하고 늦은 응답은 잠금을 잡지 않는다', async () => {
  const manager = lockManager();
  manager.pause();
  const ownership = new WorktreeOwnership(manager.locks);
  const owner = {};
  const pending = ownership.claim(owner, 'document-1');
  ownership.release(owner);
  assert.equal(await pending, false);
  manager.resume();
  await flushLocks();
  assert.equal(ownership.owns(owner, 'document-1'), false);
  assert.equal(manager.held.size, 0);
  assert.equal(await ownership.claim(owner, 'document-1'), true);
  ownership.release(owner);
  await flushLocks();
});

test('Web Locks 요청이 실패해도 다음 요청으로 소유권을 얻을 수 있다', async () => {
  const manager = lockManager();
  manager.fail();
  const ownership = new WorktreeOwnership(manager.locks);
  const owner = {};
  assert.equal(await ownership.claim(owner, 'document-1'), false);
  assert.equal(await ownership.claim(owner, 'document-1'), true);
  assert.equal(ownership.owns(owner, 'document-1'), true);
  ownership.release(owner);
  await flushLocks();
});

test('같은 세션의 중복 요청은 잠금을 공유하고 문서를 바꾸면 이전 잠금을 놓는다', async () => {
  const manager = lockManager();
  const ownership = new WorktreeOwnership(manager.locks);
  const owner = {};
  assert.deepEqual(await Promise.all([
    ownership.claim(owner, 'document-1'), ownership.claim(owner, 'document-1'),
  ]), [true, true]);
  assert.equal(manager.attempts, 1);
  assert.equal(await ownership.claim(owner, 'document-2'), true);
  assert.equal(ownership.owns(owner, 'document-1'), false);
  assert.equal(ownership.owns(owner, 'document-2'), true);
  await flushLocks();
  assert.deepEqual([...manager.held], ['rhwp-worktree:document-2']);
  ownership.release(owner);
  await flushLocks();
});

test('해제된 요청의 늦은 응답은 같은 세션의 새 소유권 요청을 지우지 않는다', async () => {
  const manager = lockManager();
  manager.pause();
  const ownership = new WorktreeOwnership(manager.locks);
  const owner = {};
  const abandoned = ownership.claim(owner, 'document-1');
  ownership.release(owner);
  const replacement = ownership.claim(owner, 'document-1');
  manager.resume();
  assert.equal(await abandoned, false);
  assert.equal(await replacement, true);
  assert.equal(ownership.owns(owner, 'document-1'), true);
  ownership.release(owner);
  await flushLocks();
  assert.equal(manager.held.size, 0);
});
