import assert from 'node:assert/strict';
import test from 'node:test';

import { tasteLearningAllowed } from '../byok-taste.mjs';

test('Rau-0.1 taste learning skips BYOK chats only', () => {
  assert.equal(tasteLearningAllowed('pi'), false);
  for (const agent of ['claude', 'codex']) assert.equal(tasteLearningAllowed(agent), true);
});
