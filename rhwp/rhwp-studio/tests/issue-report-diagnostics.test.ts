import test from 'node:test';
import assert from 'node:assert/strict';

import { createRendererDiagnostics, type DiagnosticEntry } from '../src/ui/issue-report/renderer-diagnostics.ts';

function harness() {
  let clock = 0;
  const batches: DiagnosticEntry[][] = [];
  const pending: Array<() => void> = [];
  const diagnostics = createRendererDiagnostics((entries) => batches.push(entries), {
    now: () => clock,
    schedule: (run) => pending.push(run),
  });
  return {
    diagnostics,
    batches,
    advance(ms: number) { clock += ms; },
    flush() { while (pending.length) pending.shift()!(); },
  };
}

test('a renderer error loop is sent once with its repeat count, not once per frame', () => {
  const h = harness();
  for (let i = 0; i < 500; i += 1) {
    h.diagnostics.record('error', 'window error: TypeError: x is undefined');
    h.advance(16);
  }
  h.advance(30_000);
  h.diagnostics.record('error', 'window error: TypeError: x is undefined');
  h.flush();
  const texts = h.batches.flat().map((entry) => entry.text);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /repeated \d+ more times/);
});

test('distinct errors past the rate limit are dropped and counted', () => {
  const h = harness();
  for (let i = 0; i < 100; i += 1) h.diagnostics.record('error', `console.error: failure ${i}`);
  h.flush();
  const entries = h.batches.flat();
  assert.equal(entries.filter((entry) => entry.level === 'error').length, 30);
  assert.match(entries.at(-1)!.text, /70 renderer log entries dropped/);
  const long = 'z'.repeat(10_000);
  h.advance(60_000);
  h.diagnostics.record('error', long);
  h.flush();
  assert.ok(h.batches.flat().at(-1)!.text.length <= 4001);
});
