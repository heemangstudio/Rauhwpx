import { randomUUID } from 'node:crypto';

/**
 * One window can hold several live documents: the visible one and documents
 * whose agent keeps working in the background. Each lives in its own slot.
 * Callers that never name a slot use this one, which is the window's only
 * document in the single-document flow.
 */
export const DEFAULT_DOCUMENT_SLOT = 'default';
const SLOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeDocumentSlotId(slotId) {
  if (slotId === undefined || slotId === null) return DEFAULT_DOCUMENT_SLOT;
  if (typeof slotId !== 'string' || !SLOT_ID_PATTERN.test(slotId)) {
    throw new Error('Document slot id is invalid');
  }
  return slotId;
}

function identityKeys(identity, canonicalPath) {
  if (typeof identity?.documentId !== 'string' || identity.documentId.length === 0) {
    throw new Error('Document ownership requires a documentId');
  }
  if (identity.sourceDigest !== null && (
    typeof identity.sourceDigest !== 'string' || identity.sourceDigest.length === 0
  )) {
    throw new Error('Document ownership sourceDigest is invalid');
  }
  const keys = [`document:${identity.documentId}`];
  if (identity.sourceDigest && !canonicalPath && identity.useSourceDigest !== false) {
    keys.push(`digest:${identity.sourceDigest}`);
  }
  if (canonicalPath) keys.push(`path:${canonicalPath}`);
  if (keys.length === 0) throw new Error('Document ownership requires an identity');
  return keys;
}

/**
 * Release every document claim a window's renderer held. Runs on window close
 * and when the renderer dies: a crashed renderer's blank window would
 * otherwise keep owning the path, so opening that file again only focused the
 * dead window. In-flight native writes keep their path until they finish.
 */
export function releaseRendererDocuments(sessionId, { documentLeases, nativeFiles }) {
  documentLeases.releaseSession(sessionId);
  nativeFiles.releaseSession(sessionId);
}

export class DocumentLeaseManager {
  #claimsByKey = new Map();
  // sessionId -> Map(slotId -> lease)
  #leasesBySession = new Map();
  #reservations = new Map();
  #createId;

  constructor({ createId = randomUUID } = {}) {
    this.#createId = createId;
  }

  ownerForPath(canonicalPath) {
    return this.#claimsByKey.get(`path:${canonicalPath}`)?.sessionId ?? null;
  }

  /**
   * A claim held by the same window in another slot is a conflict too: two
   * live copies of one document in one window would save over each other.
   */
  reserve(sessionId, identity, canonicalPath = null, slotId = DEFAULT_DOCUMENT_SLOT) {
    const slot = normalizeDocumentSlotId(slotId);
    const keys = identityKeys(identity, canonicalPath);
    for (const key of keys) {
      const claim = this.#claimsByKey.get(key);
      if (claim && (claim.sessionId !== sessionId || claim.slotId !== slot)) {
        return { ok: false, ownerSessionId: claim.sessionId };
      }
    }

    const reservationId = this.#createId();
    const reservation = {
      reservationId,
      sessionId,
      slotId: slot,
      identity: Object.freeze({
        documentId: identity?.documentId ?? null,
        sourceDigest: identity?.sourceDigest ?? null,
        useSourceDigest: identity?.useSourceDigest !== false,
      }),
      canonicalPath,
      keys,
      claimedKeys: keys.filter((key) => !this.#claimsByKey.has(key)),
    };
    this.#reservations.set(reservationId, reservation);
    for (const key of reservation.claimedKeys) this.#claimsByKey.set(key, reservation);
    return { ok: true, reservationId };
  }

  commit(sessionId, reservationId, slotId) {
    const reservation = this.#reservationForSession(sessionId, reservationId, slotId);
    const slots = this.#slotsForSession(sessionId);
    const previous = slots.get(reservation.slotId);
    if (previous) this.#releaseClaim(previous);

    this.#reservations.delete(reservationId);
    const lease = { ...reservation, reservationId: null, claimedKeys: reservation.keys };
    slots.set(reservation.slotId, lease);
    for (const key of lease.keys) this.#claimsByKey.set(key, lease);
    return lease;
  }

  cancel(sessionId, reservationId, slotId) {
    const reservation = this.#reservationForSession(sessionId, reservationId, slotId);
    this.#reservations.delete(reservationId);
    this.#releaseClaim(reservation);
    return true;
  }

  /** Release one slot's lease and its pending reservations. */
  releaseSlot(sessionId, slotId = DEFAULT_DOCUMENT_SLOT) {
    const slot = normalizeDocumentSlotId(slotId);
    const slots = this.#leasesBySession.get(sessionId);
    const lease = slots?.get(slot);
    if (lease) {
      slots.delete(slot);
      if (slots.size === 0) this.#leasesBySession.delete(sessionId);
      this.#releaseClaim(lease);
    }
    for (const [reservationId, reservation] of this.#reservations) {
      if (reservation.sessionId !== sessionId || reservation.slotId !== slot) continue;
      this.#reservations.delete(reservationId);
      this.#releaseClaim(reservation);
    }
  }

  /**
   * Release every slot the window holds. `keepDefaultSlot` keeps the default
   * slot for a reloaded renderer, which reopens that document itself.
   */
  releaseSession(sessionId, { keepDefaultSlot = false } = {}) {
    const slots = new Set(this.#leasesBySession.get(sessionId)?.keys() ?? []);
    for (const reservation of this.#reservations.values()) {
      if (reservation.sessionId === sessionId) slots.add(reservation.slotId);
    }
    for (const slot of slots) {
      if (keepDefaultSlot && slot === DEFAULT_DOCUMENT_SLOT) continue;
      this.releaseSlot(sessionId, slot);
    }
  }

  /** Any lease or pending reservation of the window may authorize its own exact target. */
  validateSaveTarget(sessionId, identity, canonicalPath) {
    const leases = [...(this.#leasesBySession.get(sessionId)?.values() ?? [])];
    if (leases.length === 0) throw new Error('The window does not own an open document');
    const pending = [...this.#reservations.values()]
      .filter((reservation) => reservation.sessionId === sessionId);
    const candidates = [...leases, ...pending];
    if (candidates.some((claim) => (
      identity?.documentId === claim.identity.documentId
      && identity?.sourceDigest === claim.identity.sourceDigest
      && canonicalPath
      && canonicalPath === claim.canonicalPath
    ))) return true;
    const sameDocument = leases.filter((lease) => identity?.documentId === lease.identity.documentId);
    if (sameDocument.length === 0) {
      throw new Error('The save target does not belong to the active document');
    }
    if (!sameDocument.some((lease) => identity?.sourceDigest === lease.identity.sourceDigest)) {
      throw new Error('The save request has a stale document identity');
    }
    throw new Error('The native save target is owned by another document');
  }

  /** 창이 쥔 문서 파일의 이름이 바뀌었다. 그 경로로 잡은 점유를 새 경로로 옮긴다. */
  renamePath(sessionId, previousPath, nextPath) {
    if (previousPath === nextPath) return true;
    const previousKey = `path:${previousPath}`;
    const nextKey = `path:${nextPath}`;
    const claim = this.#claimsByKey.get(previousKey);
    if (!claim || claim.sessionId !== sessionId) return false;
    const other = this.#claimsByKey.get(nextKey);
    if (other && other !== claim) throw new Error('The renamed path is already owned');
    this.#claimsByKey.delete(previousKey);
    this.#claimsByKey.set(nextKey, claim);
    claim.canonicalPath = nextPath;
    claim.keys = claim.keys.map((key) => (key === previousKey ? nextKey : key));
    claim.claimedKeys = claim.claimedKeys.map((key) => (key === previousKey ? nextKey : key));
    return true;
  }

  leaseForSession(sessionId, slotId = DEFAULT_DOCUMENT_SLOT) {
    return this.#leasesBySession.get(sessionId)?.get(normalizeDocumentSlotId(slotId)) ?? null;
  }

  /** True while the window holds a committed document in any slot. */
  hasLease(sessionId) {
    return (this.#leasesBySession.get(sessionId)?.size ?? 0) > 0;
  }

  #slotsForSession(sessionId) {
    let slots = this.#leasesBySession.get(sessionId);
    if (!slots) {
      slots = new Map();
      this.#leasesBySession.set(sessionId, slots);
    }
    return slots;
  }

  #reservationForSession(sessionId, reservationId, slotId) {
    const reservation = this.#reservations.get(reservationId);
    if (
      !reservation
      || reservation.sessionId !== sessionId
      || (slotId !== undefined && slotId !== null
        && reservation.slotId !== normalizeDocumentSlotId(slotId))
    ) {
      throw new Error('Document reservation does not belong to this window');
    }
    return reservation;
  }

  #releaseClaim(claim) {
    for (const key of claim.claimedKeys) {
      if (this.#claimsByKey.get(key) === claim) this.#claimsByKey.delete(key);
    }
  }
}
