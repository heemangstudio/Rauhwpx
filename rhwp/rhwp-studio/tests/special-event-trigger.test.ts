import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopGiftApi, GiftClaimError, giftMeter, type DesktopGiftApi, type DesktopGiftStatus, type GiftClaimResult } from '../src/ui/special-event/gift.ts';
import {
  planSpecialEvent,
  shouldShowSpecialEvent,
  specialEventOrderStorageKey,
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

test('an own-key user gets the order popup once, even after the old popup was seen or claimed', () => {
  const ownKey = { keyConfigured: true };
  const oldRecord = (record: string) => memoryStorage({ [specialEventStorageKey(EVENT_ID)]: record });
  // 예전 창을 닫았거나 본 사람도 받기와 순서를 함께 고른다.
  for (const record of ['shown', 'dismissed']) {
    assert.deepEqual(planSpecialEvent(giftStatus(), oldRecord(record), ownKey), { kind: 'order', claimed: false });
  }
  // 예전 창에서 이미 받았으면 순서만 고른다. 서버가 한도를 늘려 남은 양이 처음보다 많아도 그대로 쓴다.
  assert.deepEqual(
    planSpecialEvent(giftStatus({ claimed: true, remainingUsd: 26 }), oldRecord('claimed'), ownKey),
    { kind: 'order', claimed: true, balanceUsd: 26 },
  );
  assert.equal(planSpecialEvent(giftStatus({ claimed: true, remainingUsd: 0 }), memoryStorage(), ownKey), null);
  assert.equal(planSpecialEvent(giftStatus({ eligible: false }), memoryStorage(), ownKey), null);
  // 순서 창을 한 번 띄웠으면 다시 띄우지 않는다.
  const seen = memoryStorage({ [specialEventOrderStorageKey(EVENT_ID)]: 'dismissed' });
  assert.equal(planSpecialEvent(giftStatus(), seen, ownKey), null);
  // 내 키가 없거나 모르면 예전 창 그대로다.
  assert.deepEqual(planSpecialEvent(giftStatus(), memoryStorage(), { keyConfigured: false }), { kind: 'offer' });
  assert.deepEqual(planSpecialEvent(giftStatus(), memoryStorage(), null), { kind: 'offer' });
  assert.equal(planSpecialEvent(giftStatus(), oldRecord('dismissed'), null), null);
});

test('the order popup saves the chosen order through the hub and records its own outcome', async () => {
  const storage = memoryStorage({ [specialEventStorageKey(EVENT_ID)]: 'dismissed' });
  const amount = { id: EVENT_ID, amountUsd: 35, endsAt: null, active: true };
  const gift = fakeGift(giftStatus({ event: amount }), async () => ({
    ok: true, status: giftStatus({ event: amount, claimed: true, remainingUsd: 35 }),
  }));
  const saved: string[] = [];
  const opened: SpecialEventOptions[] = [];
  let close: (result: SpecialEventResult) => void = () => {};
  const deps = {
    gift: gift.api,
    storage,
    whenReady: async () => {},
    isSetupActive: () => false,
    onSetupInactive: () => () => {},
    pi: {
      status: async () => ({ keyConfigured: true, giftOrder: 'after' as const }),
      setGiftOrder: async (order: 'first' | 'after') => { saved.push(order); },
    },
    open: (options: SpecialEventOptions) => {
      opened.push(options);
      return new Promise<SpecialEventResult>((resolve) => { close = resolve; });
    },
  };
  startSpecialEvent(deps);
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.amountUsd, 35, 'the per-key amount from the server');
  assert.equal(opened[0]!.order?.initial, 'after');
  assert.equal(opened[0]!.claimedBalanceUsd, undefined);
  assert.deepEqual(await opened[0]!.claim(), { balanceUsd: 35 });
  await opened[0]!.order!.choose('first');
  assert.deepEqual(saved, ['first']);
  close('claimed');
  await settle();
  assert.equal(storage.values.get(specialEventOrderStorageKey(EVENT_ID)), 'claimed');
  assert.equal(storage.values.get(specialEventStorageKey(EVENT_ID)), 'claimed');

  // 다음 실행에서는 뜨지 않는다.
  startSpecialEvent({ ...deps, open: (options: SpecialEventOptions) => { opened.push(options); return new Promise(() => {}); } });
  await settle();
  assert.equal(opened.length, 1);
});

test('without a hub answer the runner falls back to the plain popup', async () => {
  const storage = memoryStorage();
  const gift = fakeGift(giftStatus(), async () => ({ ok: true, status: giftStatus({ claimed: true, remainingUsd: 20 }) }));
  const opened: SpecialEventOptions[] = [];
  startSpecialEvent({
    gift: gift.api,
    storage,
    whenReady: async () => {},
    isSetupActive: () => false,
    onSetupInactive: () => () => {},
    pi: { status: async () => null, setGiftOrder: async () => {} },
    piStatusWaitMs: 0,
    open: (options) => {
      opened.push(options);
      return new Promise(() => {});
    },
  });
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.order, undefined);
  assert.equal(storage.values.get(specialEventStorageKey(EVENT_ID)), 'shown');
  assert.equal(storage.values.has(specialEventOrderStorageKey(EVENT_ID)), false);
});

test('the gift API exists on macOS and Windows desktops only, and the meter never overflows', () => {
  const gift = fakeGift(giftStatus(), async () => ({ ok: true, status: giftStatus() })).api;
  for (const platform of ['darwin', 'win32']) assert.equal(desktopGiftApi({ rhwpDesktop: { platform, gift } }), gift);
  assert.equal(desktopGiftApi({ rhwpDesktop: { platform: 'linux', gift } }), null);
  assert.equal(desktopGiftApi({}), null);
  assert.deepEqual(giftMeter(20, 10), { ratio: 0.5, max: 20 });
  // 서버가 한도를 늘려 남은 양이 처음 금액보다 많다.
  assert.deepEqual(giftMeter(20, 30), { ratio: 1, max: 30 });
  assert.deepEqual(giftMeter(20, -1), { ratio: 0, max: 20 });
});
