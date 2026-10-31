import test from 'node:test';
import assert from 'node:assert/strict';
import { CorrectionLedger } from '../src/agent/correction-ledger.ts';
import { ReviewSignalOutbox } from '../src/agent/taste-signals.ts';
import type { ReviewSignal } from '../src/agent/types.ts';
import { normalizeReviewSignalFrame } from '../../rhwp-agent/taste-signals.mjs';

function setup(t: any, paras = ['고객에게 보냅니다.', '고객과 협의합니다.']) {
  const batches: ReviewSignal[][] = [];
  let enabled = true;
  const ledger = new CorrectionLedger({ reader: { count: () => paras.length, text: ref => paras[ref.paraIdx] },
    enabled: () => enabled, emit: signals => batches.push(signals) });
  t.after(() => ledger.clear());
  const edit = (index: number, text: string) => { ledger.begin({ sectionIndex: 0, paragraphIndex: index, charOffset: 0 }); paras[index] = text; ledger.end(); };
  return { ledger, batches, paras, edit, disable: () => { enabled = false; } };
}
test('independent corrections batch once; fresh text and undo/redo cannot inflate evidence', t => {
  const h = setup(t);
  h.edit(0, '이용자에게 보냅니다.'); h.ledger.flush(); assert.equal(h.batches.length, 0);
  h.edit(1, '이용자과 협의합니다.'); h.ledger.flush(); assert.equal(h.batches.length, 1);
  assert.equal(new Set(h.batches[0].map(s => s.passageId)).size, 2);
  h.ledger.flush(); assert.equal(h.batches.length, 1);
  h.ledger.invalidate(); h.paras[0] = '고객에게 보냅니다.'; h.paras[1] = '고객과 협의합니다.';
  h.edit(0, '이용자에게 보냅니다.'); h.edit(1, '이용자과 협의합니다.'); h.ledger.flush();
  assert.equal(h.batches.length, 1);
});
test('IME waits for composition completion; paste, structural edits and disabled learning do not teach', t => {
  const h = setup(t);
  h.ledger.composition(true, { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  h.paras[0] = '이용자에게 보냅니다.'; h.ledger.flush(); assert.equal(h.batches.length, 0);
  h.ledger.composition(false); h.edit(1, '이용자과 협의합니다.'); h.ledger.flush(); assert.equal(h.batches.length, 1);
  h.ledger.clear(); h.ledger.suspend(true); h.edit(0, '고객에게 보냅니다.'); h.ledger.suspend(false);
  h.edit(1, '고객과 협의합니다.'); h.ledger.flush(); assert.equal(h.batches.length, 1);
  h.disable(); h.edit(0, '이용자에게 보냅니다.'); h.ledger.flush(); assert.equal(h.batches.length, 1);
});
test('single-character replacements are eligible, pure insertion is not', t => {
  const h = setup(t, ['값은 A입니다.', 'A를 씁니다.', '']);
  h.edit(2, 'B'); h.ledger.flush(); assert.equal(h.batches.length, 0);
  h.edit(0, '값은 B입니다.'); h.edit(1, 'B를 씁니다.'); h.ledger.flush();
  assert.equal(h.batches[0].length, 2);
});
test('corrections reach the hub with the evidence it needs to verify citations', t => {
  const h = setup(t);
  const frames: unknown[] = [];
  const outbox = new ReviewSignalOutbox({ send: frame => { frames.push(frame); return true; }, canSend: () => true, documentId: () => 'doc' });
  t.after(() => outbox.dispose());
  h.edit(0, '이용자에게 보냅니다.'); h.edit(1, '이용자과 협의합니다.'); h.ledger.flush();
  outbox.push({ threadId: 'th1', documentId: 'doc', turnId: null }, h.batches[0]);
  outbox.flush();
  const signals = normalizeReviewSignalFrame(frames[0])!.signals;
  assert.deepEqual(signals.map(s => [s.kind, s.passageId]), [['correction', 's0#0'], ['correction', 's0#1']]);
  assert.ok(signals.every(s => s.evidenceId));
});
test('a correction the document no longer holds is not evidence', t => {
  const h = setup(t);
  h.edit(0, '이용자에게 보냅니다.'); h.edit(1, '이용자과 협의합니다.');
  h.paras[1] = '고객과 협의합니다.';
  h.ledger.flush();
  assert.equal(h.batches.length, 0);
});
test('a structural edit drops unsent evidence but still remembers what was sent', t => {
  const paras = ['고객에게 보냅니다.', '고객과 협의합니다.'];
  const h = setup(t, paras);
  h.edit(0, '이용자에게 보냅니다.'); h.edit(1, '이용자과 협의합니다.'); h.ledger.flush();
  assert.equal(h.batches.length, 1);
  h.ledger.begin({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }); paras.push('새 문단'); h.ledger.end();
  paras.pop();
  h.paras[0] = '고객에게 보냅니다.'; h.paras[1] = '고객과 협의합니다.';
  h.edit(0, '이용자에게 보냅니다.'); h.edit(1, '이용자과 협의합니다.'); h.ledger.flush();
  assert.equal(h.batches.length, 1, 'the same edits are not sent twice after the structural edit');
});
