import assert from 'node:assert/strict';
import test from 'node:test';

import { GiftClaimError, type DesktopGiftApi, type DesktopGiftStatus, type GiftClaimResult } from '../src/ui/special-event/gift.ts';
import {
  shouldShowSpecialEvent,
  specialEventStorageKey,
  startSpecialEvent,
} from '../src/ui/special-event/special-event-trigger.ts';
import type { SpecialEventOptions, SpecialEventResult } from '../src/ui/special-event/special-event-popup.ts';

const EVENT_ID = 'special-2026-10';

function giftStatus(patch: Partial<DesktopGiftStatus> = {}): DesktopGiftStatus {
  return {
    available: true,
    event: { id: EVENT_ID, amountUsd: 20, endsAt: null, active: true },
    eligible: true,
    claimed: false,
    remainingUsd: null,
    usedUsd: null,
    claimedAt: null,
    checkedAt: 1,
    error: null,
    ...patch,
  };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeGift(initial: DesktopGiftStatus, claim: () => Promise<GiftClaimResult>) {
  const listeners = new Set<(status: DesktopGiftStatus) => void>();
  const api: DesktopGiftApi = {
    getStatus: async () => initial,
    claim,
    onChange: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return { api, change: (status: DesktopGiftStatus) => { for (const listener of listeners) listener(status); } };
}

test('the popup is offered only for an active, eligible, unclaimed event that was never shown', () => {
  const empty = memoryStorage();
  assert.equal(shouldShowSpecialEvent(giftStatus(), empty), true);
  assert.equal(shouldShowSpecialEvent(giftStatus({ claimed: true, remainingUsd: 20 }), empty), false);
  assert.equal(shouldShowSpecialEvent(giftStatus({ eligible: false }), empty), false);
  assert.equal(shouldShowSpecialEvent(giftStatus({ available: false }), empty), false);
  assert.equal(shouldShowSpecialEvent(giftStatus({ event: { id: EVENT_ID, amountUsd: 20, endsAt: null, active: false } }), empty), false);
  assert.equal(shouldShowSpecialEvent(null, empty), false);
  for (const record of ['shown', 'dismissed', 'claimed']) {
    assert.equal(shouldShowSpecialEvent(giftStatus(), memoryStorage({ [specialEventStorageKey(EVENT_ID)]: record })), false);
  }
  // 다음 이벤트는 다시 뜬다.
  const next = giftStatus({ event: { id: 'special-2027-01', amountUsd: 20, endsAt: null, active: true } });
  assert.equal(shouldShowSpecialEvent(next, memoryStorage({ [specialEventStorageKey(EVENT_ID)]: 'dismissed' })), true);
  // 저장소가 막혀 있으면 띄우지 않는다.
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
  assert.equal(shouldShowSpecialEvent(giftStatus(), blocked), false);
});

test('the runner waits for first-run setup, opens once, and records the outcome per event', async () => {
  const storage = memoryStorage();
  const gift = fakeGift(giftStatus(), async () => ({ ok: true, status: giftStatus({ claimed: true, remainingUsd: 20 }) }));
  let setupActive = true;
  const setupListeners = new Set<() => void>();
  const opened: SpecialEventOptions[] = [];
  let close: (result: SpecialEventResult) => void = () => {};
  startSpecialEvent({
    gift: gift.api,
    storage,
    whenReady: async () => {},
    isSetupActive: () => setupActive,
    onSetupInactive: (listener) => {
      setupListeners.add(listener);
      return () => { setupListeners.delete(listener); };
    },
    open: (options) => {
      opened.push(options);
      return new Promise((resolve) => { close = resolve; });
    },
  });
  await settle();
  assert.equal(opened.length, 0, 'first-run setup is still open');

  setupActive = false;
  for (const listener of [...setupListeners]) listener();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.amountUsd, 20);
  assert.equal(storage.values.get(specialEventStorageKey(EVENT_ID)), 'shown');

  // 열린 동안 상태가 다시 와도 두 번 띄우지 않는다.
  gift.change(giftStatus({ checkedAt: 2 }));
  assert.equal(opened.length, 1);

  assert.deepEqual(await opened[0]!.claim(), { balanceUsd: 20 });
  close('claimed');
  await settle();
  assert.equal(storage.values.get(specialEventStorageKey(EVENT_ID)), 'claimed');
});

test('a gift that becomes claimable later opens the popup, and a rejected claim carries the server message', async () => {
  const storage = memoryStorage();
  const gift = fakeGift(giftStatus({ eligible: false }), async () => ({
    ok: false,
    code: 'budget_exhausted',
    message: '준비한 크레딧이 모두 소진되었습니다.',
  }));
  const opened: SpecialEventOptions[] = [];
  startSpecialEvent({
    gift: gift.api,
    storage,
    whenReady: async () => {},
    isSetupActive: () => false,
    onSetupInactive: () => () => {},
    open: (options) => {
      opened.push(options);
      return new Promise(() => {});
    },
  });
  await settle();
  assert.equal(opened.length, 0);

  gift.change(giftStatus());
  assert.equal(opened.length, 1);
  await assert.rejects(opened[0]!.claim(), (error: unknown) =>
    error instanceof GiftClaimError && error.message === '준비한 크레딧이 모두 소진되었습니다.');
});
