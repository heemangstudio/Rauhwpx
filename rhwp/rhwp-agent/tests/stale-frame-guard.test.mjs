import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installStaleFrameGuard } from '../stale-frame-guard.mjs';

function staleFrameError() {
  const error = new Error('Frame has been detached.');
  error.stack = `Error: Frame has been detached.\n    at CRPage._sessionForFrame (/x/node_modules/playwright-core/lib/coreBundle.js:1:1)\n    at _FrameSession._eventBelongsToStaleFrame (/x/node_modules/playwright-core/lib/coreBundle.js:2:2)`;
  return error;
}

test('a Playwright event for a detached frame keeps the hub running while other crashes still exit', () => {
  const target = new EventEmitter(); const exits = [];
  target.exit = (code) => exits.push(code);
  const log = { warn() {}, error() {} };
  installStaleFrameGuard(target, log);
  target.emit('uncaughtException', staleFrameError(), 'uncaughtException');
  assert.deepEqual(exits, []);
  target.emit('uncaughtException', new Error('Frame has been detached.'), 'uncaughtException');
  target.emit('uncaughtException', new TypeError('boom'), 'uncaughtException');
  assert.deepEqual(exits, [1, 1]);
});
