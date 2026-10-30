import test from 'node:test';
import assert from 'node:assert/strict';
import { readHamaStatus } from '../src/agent/hama-status.ts';
import { setHamaModels, effortsForAgent, resolveEffortForAgent } from '../src/agent/models.ts';
const haiku = { id: 'anthropic/claude-haiku-5.5', name: 'Haiku 5.5', reasoning: true, supportsImages: true, defaultEffort: 'medium' };

test('Hama status preserves native effort options through the UI registry and clamps stale choices', () => {
  const deepseek = { ...haiku, id: 'deepseek/deepseek-v4.1-flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
  const status = readHamaStatus({ availability: 'active', plan: { status: 'active' }, models: [{ ...haiku, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, deepseek] });
  setHamaModels(status.models);
  try {
    assert.deepEqual(effortsForAgent('hama', haiku.id).map((x) => x.id), ['xhigh', 'high', 'medium', 'low']);
    assert.deepEqual(effortsForAgent('hama', deepseek.id).map((x) => x.id), ['max', 'high', 'low']);
    assert.equal(resolveEffortForAgent('hama', 'max', haiku.id), 'medium');
    assert.equal(resolveEffortForAgent('hama', 'xhigh', deepseek.id), 'high');
  } finally {
    setHamaModels([]);
  }
});
