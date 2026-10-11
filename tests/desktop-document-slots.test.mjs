import assert from 'node:assert/strict';
import test from 'node:test';

import { DocumentLeaseManager } from '../desktop/document-leases.mjs';

function identity(documentId, sourceDigest = `blake3:${documentId}`) {
  return { documentId, sourceDigest };
}

function manager() {
  let next = 0;
  return new DocumentLeaseManager({ createId: () => `reservation-${++next}` });
}

function open(leases, sessionId, doc, path, slotId) {
  const reserved = leases.reserve(sessionId, doc, path, slotId);
  assert.equal(reserved.ok, true);
  leases.commit(sessionId, reserved.reservationId);
  return reserved.reservationId;
}

test('one window holds a document per slot and replacing one slot keeps the others', () => {
  const leases = manager();
  open(leases, 'window-a', identity('doc-a'), '/docs/a.hwp');
  open(leases, 'window-a', identity('doc-b'), '/docs/b.hwp', 'background-1');

  // Replacing the visible document must not release the background one.
  open(leases, 'window-a', identity('doc-c'), '/docs/c.hwp');
  assert.equal(leases.reserve('window-b', identity('doc-a'), '/docs/a.hwp').ok, true);
  assert.deepEqual(
    leases.reserve('window-b', identity('doc-b'), '/docs/b.hwp'),
    { ok: false, ownerSessionId: 'window-a' },
  );
  assert.equal(leases.ownerForPath('/docs/b.hwp'), 'window-a');
  assert.equal(leases.leaseForSession('window-a')?.identity.documentId, 'doc-c');
  assert.equal(leases.leaseForSession('window-a', 'background-1')?.identity.documentId, 'doc-b');
});

test('the same document cannot live in two slots of one window', () => {
  const leases = manager();
  open(leases, 'window-a', identity('doc-a'), '/docs/a.hwp');

  assert.deepEqual(
    leases.reserve('window-a', identity('doc-a'), '/docs/a.hwp', 'background-1'),
    { ok: false, ownerSessionId: 'window-a' },
  );
  assert.equal(leases.reserve('window-a', identity('doc-x'), '/docs/a.hwp', 'background-1').ok, false);
  // Reopening in its own slot still works.
  assert.equal(leases.reserve('window-a', identity('doc-a'), '/docs/a.hwp').ok, true);
});

test('releasing a slot frees only that slot and window release frees every slot', () => {
  const leases = manager();
  open(leases, 'window-a', identity('doc-a'), '/docs/a.hwp');
  open(leases, 'window-a', identity('doc-b'), '/docs/b.hwp', 'background-1');
  const pendingSaveAs = leases.reserve('window-a', identity('doc-b'), '/docs/b-copy.hwp', 'background-1');
  assert.equal(pendingSaveAs.ok, true);

  leases.releaseSlot('window-a', 'background-1');
  assert.equal(leases.ownerForPath('/docs/b.hwp'), null);
  assert.equal(leases.ownerForPath('/docs/b-copy.hwp'), null);
  assert.throws(() => leases.commit('window-a', pendingSaveAs.reservationId), /does not belong/);
  assert.equal(leases.ownerForPath('/docs/a.hwp'), 'window-a');
  assert.equal(leases.hasLease('window-a'), true);

  open(leases, 'window-a', identity('doc-b'), '/docs/b.hwp', 'background-2');
  leases.releaseSession('window-a');
  assert.equal(leases.hasLease('window-a'), false);
  assert.equal(leases.reserve('window-b', identity('doc-a'), '/docs/a.hwp').ok, true);
  assert.equal(leases.reserve('window-b', identity('doc-b'), '/docs/b.hwp').ok, true);
});

test('a reload releases background slots but keeps the default document', () => {
  const leases = manager();
  open(leases, 'window-a', identity('doc-a'), '/docs/a.hwp');
  open(leases, 'window-a', identity('doc-b'), '/docs/b.hwp', 'background-1');

  leases.releaseSession('window-a', { keepDefaultSlot: true });
  assert.equal(leases.ownerForPath('/docs/a.hwp'), 'window-a');
  assert.equal(leases.ownerForPath('/docs/b.hwp'), null);
});

test('a background document saves only to its own path', () => {
  const leases = manager();
  const visible = identity('doc-a');
  const background = identity('doc-b');
  open(leases, 'window-a', visible, '/docs/a.hwp');
  open(leases, 'window-a', background, '/docs/b.hwp', 'background-1');

  assert.equal(leases.validateSaveTarget('window-a', background, '/docs/b.hwp'), true);
  assert.equal(leases.validateSaveTarget('window-a', visible, '/docs/a.hwp'), true);
  assert.throws(
    () => leases.validateSaveTarget('window-a', background, '/docs/a.hwp'),
    /owned by another document/,
  );
  assert.throws(
    () => leases.validateSaveTarget('window-a', identity('doc-b', 'blake3:old'), '/docs/b.hwp'),
    /stale document identity/,
  );
  assert.throws(
    () => leases.validateSaveTarget('window-b', background, '/docs/b.hwp'),
    /does not own an open document/,
  );
});

test('a reservation commits and cancels only through its own slot', () => {
  const leases = manager();
  const reserved = leases.reserve('window-a', identity('doc-b'), '/docs/b.hwp', 'background-1');
  assert.equal(reserved.ok, true);
  assert.throws(() => leases.commit('window-a', reserved.reservationId, 'default'), /does not belong/);
  assert.throws(() => leases.reserve('window-a', identity('doc-c'), null, '../escape'), /slot id is invalid/);
  leases.commit('window-a', reserved.reservationId, 'background-1');
  assert.equal(leases.leaseForSession('window-a'), null);
  assert.equal(leases.leaseForSession('window-a', 'background-1')?.identity.documentId, 'doc-b');
});
