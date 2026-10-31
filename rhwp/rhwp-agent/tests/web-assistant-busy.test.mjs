import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createChatgptDriver, createChatgptStore } from '../chatgpt-web.mjs';
import { createClaudeDriver, createClaudeStore } from '../claude-web.mjs';

// Chrome 로그인 중에는 앱 브라우저가 멈춘다. 그때 묻거나 상태를 보면 "데스크톱 앱에서만"이 아니라 로그인 중이라고 알린다.
for (const [name, createStore, createDriver, code] of [
  ['ChatGPT', createChatgptStore, createChatgptDriver, 'CHATGPT_BUSY'],
  ['Claude', createClaudeStore, createClaudeDriver, 'CLAUDE_BUSY'],
]) {
  test(`${name} reports a Chrome sign-in in progress instead of the desktop-only error`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-web-assistant-busy-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = createStore({ filePath: path.join(dir, 'state.json'), platform: 'darwin' });
    await store.ready(); await store.setEnabled(true);
    let busy = true; let drives = 0;
    const driver = createDriver({ store, browser: { available: () => true, busy: () => busy, drive: async () => { drives++; return { signedIn: true }; } } });
    await assert.rejects(driver.ask({ chatKey: 'thread', question: 'hello' }), { code });
    const status = await driver.status({ check: true });
    assert.deepEqual([status.available, status.busy, status.signedIn], [true, true, null]);
    assert.equal(drives, 0, 'nothing touches the paused browser');
    busy = false;
    assert.equal((await driver.status({ check: false })).busy, undefined);
  });
}
