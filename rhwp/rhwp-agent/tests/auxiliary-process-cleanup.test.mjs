import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { generateChatTitle } from '../agents/title.mjs';
import { PROCESS_TREE_CLEANUP_OUTCOME } from '../process-tree.mjs';

class FakeStream extends EventEmitter {
  end(value) { this.value = value; }
  setEncoding() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;
  pid = 7001;
}

function gatedTermination(child) {
  let release;
  const completion = new Promise((resolve) => { release = resolve; });
  return {
    release,
    terminateProcess(proc) {
      assert.equal(proc, child);
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      return completion;
    },
  };
}

test('chat-title output cap waits for tree cleanup before returning a fallback', async () => {
  const child = new FakeProcess();
  const gate = gatedTermination(child);
  const title = generateChatTitle('긴 대화', {
    model: 'gpt-6.1-luna',
    spawnProcess: (_command, args) => {
      assert.ok(args.includes('gpt-6.1-luna'));
      return child;
    },
    terminateProcess: gate.terminateProcess,
  });
  let settled = false;
  void title.finally(() => { settled = true; });

  child.stdout.emit('data', 'x'.repeat((64 * 1024) + 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.release(true);
  assert.equal(await title, null);
});

test('chat title keeps a parsed result from a successful drained close when proof is unavailable', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    terminateProcess: async () => null,
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '문서 정리' },
  })}\n`);
  child.exitCode = 0;
  child.emit('close', 0, null);

  assert.equal(await title, '문서 정리');
});

test('chat title starts hub-owned cleanup at the terminal event before leader exit', async () => {
  const child = new FakeProcess();
  let cleanups = 0;
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    cleanupProcessOutcome(proc) {
      cleanups += 1;
      assert.equal(proc, child);
      assert.equal(proc.exitCode, null);
      return PROCESS_TREE_CLEANUP_OUTCOME.PROVEN;
    },
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '문서 정리' },
  })}\n`);

  assert.equal(await title, '문서 정리');
  assert.equal(cleanups, 1);
});

test('chat title discards parsed output from a nonzero drained close', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    terminateProcess: async () => null,
  });

  child.stdout.emit('data', `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '사용하면 안 되는 제목' },
  })}\n`);
  child.exitCode = 1;
  child.emit('close', 1, null);

  assert.equal(await title, null);
});

test('chat title handles an asynchronous stdin pipe failure', async () => {
  const child = new FakeProcess();
  const title = generateChatTitle('문서 정리', {
    spawnProcess: () => child,
    cleanupProcessOutcome: async () => PROCESS_TREE_CLEANUP_OUTCOME.PROVEN,
  });

  child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }));
  assert.equal(await title, null);
});
