import test from 'node:test';
import assert from 'node:assert/strict';

import type { AutosaveDraftSummary } from '../src/recovery/autosave-store.ts';
import {
  TRAP_MANIFEST_KEY,
  buildTrapManifest,
  createTrapRecoveryRun,
  describeTrapOutcome,
  planTrapEntry,
  runTrapRecovery,
  settleUnfinishedTrapSave,
  takeTrapManifest,
  trapRecoveryNeedsReview,
  writeTrapManifest,
  type TrapEntryFacts,
  type TrapEntryPlan,
  type TrapManifestEntry,
  type TrapOpenResult,
  type TrapRecoveryDeps,
  type TrapRecoveryManifest,
} from '../src/recovery/trap-recovery.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function entry(id: string, overrides: Partial<TrapManifestEntry> = {}): TrapManifestEntry {
  return {
    id,
    slot: 'extra',
    attached: false,
    documentId: `doc-${id}`,
    fileName: `${id}.hwp`,
    dirty: true,
    draft: { id: `draft-${id}`, savedAt: 2_000, fresh: true },
    hasFile: true,
    worktree: 'none',
    pendingAgentOps: 0,
    activeThreadId: null,
    interruptedThreadIds: [],
    suspect: false,
    readOnly: false,
    ...overrides,
  };
}

function manifest(entries: TrapManifestEntry[], overrides: Partial<TrapRecoveryManifest> = {}): TrapRecoveryManifest {
  return {
    v: 1,
    createdAt: 3_000,
    attempt: 1,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
    entries,
    ...overrides,
  };
}

function draftRow(id: string, savedAt = 2_000): AutosaveDraftSummary {
  return { id, fileName: 'x.hwp', sourceFormat: 'hwp', savedAt, byteLength: 10, documentId: 'doc' };
}

test('the reopen list survives one reload and is gone after it is read', () => {
  const storage = memoryStorage();
  const list = manifest([entry('a', { slot: 'default', attached: true })], {
    deliveredLaunchHandleIds: ['launch-1'],
  });
  assert.equal(writeTrapManifest(storage, list), true);
  assert.deepEqual(takeTrapManifest(storage), list);
  assert.equal(takeTrapManifest(storage), null, 'a second read finds nothing, so a failing recovery cannot loop');
  assert.equal(storage.values.has(TRAP_MANIFEST_KEY), false);

  storage.setItem(TRAP_MANIFEST_KEY, JSON.stringify({ ...list, v: 2 }));
  assert.equal(takeTrapManifest(storage), null, 'another version is ignored');
  assert.equal(storage.values.has(TRAP_MANIFEST_KEY), false, 'and still consumed');
  storage.setItem(TRAP_MANIFEST_KEY, '{not json');
  assert.equal(takeTrapManifest(storage), null);
});

test('a list that cannot be deleted is not used, so it cannot reopen documents on every reload', () => {
  const storage = memoryStorage();
  writeTrapManifest(storage, manifest([entry('a')]));
  const stuck = { ...storage, removeItem: () => { throw new DOMException('denied', 'SecurityError'); } };
  assert.equal(takeTrapManifest(stuck), null);
});

test('each document reopens from the best copy, and every plan that loses data says what it loses', () => {
  const plan = (overrides: Partial<TrapManifestEntry>, row: AutosaveDraftSummary | null = draftRow('draft-a')) =>
    planTrapEntry(entry('a', overrides), row);
  const cases: Array<[string, TrapEntryPlan, string, string | null]> = [
    ['fresh copy of an edited document', plan({}), 'restore-draft', null],
    ['older autosave when the trap copy failed',
      plan({ draft: { id: 'draft-a', savedAt: 1_000, fresh: false } }, draftRow('draft-a', 1_000)), 'restore-draft', 'stale-draft'],
    ['clean document with a file', plan({ dirty: false, draft: null }), 'reopen-file', null],
    ['clean document without a file', plan({ dirty: false, hasFile: false }), 'restore-draft', null],
    ['edited document whose copy failed, with a file', plan({ draft: null }), 'reopen-file', 'unsaved-changes'],
    ['edited document whose copy disappeared', plan({}, null), 'reopen-file', 'unsaved-changes'],
    ['edited document with no copy and no file', plan({ draft: null, hasFile: false }), 'skip', 'not-reopenable'],
    ['document that stopped the engine while reopening', plan({ suspect: true }), 'skip', 'suspect'],
    ['version workspace document', plan({ worktree: 'managed' }), 'skip', 'managed-worktree'],
  ];
  for (const [label, result, action, loss] of cases) {
    assert.equal(result.action, action, label);
    assert.equal(result.loss?.kind ?? null, loss, label);
  }
  // 잃는 것이 있는 계획: 열지 않거나, 이번 복구본이 아니거나, 바뀐 문서를 파일로 연다.
  for (const [label, result] of cases) {
    const losesData = result.action === 'skip'
      || (result.action === 'restore-draft' && cases.find(([name]) => name === label)![3] === 'stale-draft')
      || (result.action === 'reopen-file' && label.startsWith('edited'));
    if (losesData) assert.ok(result.loss, `${label} names its loss`);
  }
  const clean = plan({ dirty: false, hasFile: false });
  assert.ok(clean.action === 'restore-draft' && clean.cleanAtTrap, 'a clean copy reopens clean when its file is found');
  const late = plan({ draft: { id: 'draft-a', savedAt: 1_000, fresh: false } }, draftRow('draft-a', 1_500));
  assert.equal(late.loss, null, 'a trap copy that finished after the timeout counts as fresh');
});

interface FakeRun {
  calls: string[];
  deps: TrapRecoveryDeps<string>;
  trapOn: Set<string>;
  failOn: Set<string>;
}

function fakeDeps(options: { drafts?: AutosaveDraftSummary[]; trapOn?: string[]; failOn?: string[] } = {}): FakeRun {
  const calls: string[] = [];
  let stopped = false;
  const trapOn = new Set(options.trapOn ?? []);
  const failOn = new Set(options.failOn ?? []);
  const open = (where: string, item: TrapManifestEntry, canMerge: boolean): TrapOpenResult => {
    calls.push(`${where}:${item.id}${canMerge ? ':merge' : ''}`);
    if (trapOn.has(item.id)) stopped = true;
    if (failOn.has(item.id) || trapOn.has(item.id)) return { kind: 'failed', reason: 'error', message: 'boom' };
    return { kind: 'opened' };
  };
  const deps: TrapRecoveryDeps<string> = {
    listDrafts: async () => options.drafts ?? [],
    engineStopped: () => stopped,
    defaultSession: () => 'session-default',
    markInterrupted: async (threadId) => { calls.push(`interrupted:${threadId}`); },
    openInDefault: async (item, _plan, { canMerge }) => open('default', item, canMerge),
    openInBackground: async (item, _plan, { canMerge }) => {
      const result = open('background', item, canMerge);
      return { result, session: result.kind === 'opened' ? `session-${item.id}` : null };
    },
    attach: async (session) => { calls.push(`attach:${session}`); },
  };
  return { calls, deps, trapOn, failOn };
}

const drafts = ['a', 'b', 'c', 'd'].map((id) => draftRow(`draft-${id}`));

test('the default-slot document opens first, the others in background sessions, then the shown one is attached', async () => {
  const { calls, deps } = fakeDeps({ drafts });
  const list = manifest([
    entry('a', { attached: true, interruptedThreadIds: ['thread-a'] }),
    entry('b', { slot: 'default' }),
    entry('c', { interruptedThreadIds: ['thread-c'] }),
  ]);
  const run = createTrapRecoveryRun<string>(list);
  const report = await runTrapRecovery(run, deps);
  assert.deepEqual(calls, [
    'interrupted:thread-a',
    'interrupted:thread-c',
    'default:b',
    'background:c',
    'background:a:merge',
    'attach:session-a',
  ]);
  assert.deepEqual(report.outcomes.map((outcome) => outcome.status), ['opened', 'opened', 'opened']);
  assert.equal(report.stoppedByTrap, false);
  assert.equal(run.state, 'finished');
  assert.equal(trapRecoveryNeedsReview(report), false, 'everything came back, so a toast is enough');
});

test('a document that fails to open does not stop the others, and is reported with its copy kept', async () => {
  const { calls, deps } = fakeDeps({ drafts, failOn: ['b'] });
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default', attached: true }),
    entry('b'),
    entry('c'),
  ]));
  const report = await runTrapRecovery(run, deps);
  assert.deepEqual(calls, ['default:a', 'background:b', 'background:c', 'attach:session-default']);
  assert.deepEqual(report.outcomes.map((outcome) => outcome.status), ['opened', 'failed', 'opened']);
  const failed = describeTrapOutcome(report.outcomes[1], report.stoppedByTrap);
  assert.equal(failed.canDownload, true);
  assert.equal(failed.clean, false);
  assert.equal(trapRecoveryNeedsReview(report), true);
});

test('when the first document cannot open, the next one takes the first session', async () => {
  const { calls, deps } = fakeDeps({ drafts, failOn: ['a'] });
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default', attached: true }),
    entry('b'),
    entry('c'),
  ]));
  await runTrapRecovery(run, deps);
  assert.deepEqual(calls, ['default:a', 'default:b', 'background:c', 'attach:session-default']);
});

test('a document that stopped the engine during a recovery is never opened automatically', async () => {
  const { calls, deps } = fakeDeps({ drafts });
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default', attached: true }),
    entry('b', { suspect: true, interruptedThreadIds: ['thread-b'] }),
  ], { attempt: 2 }));
  const report = await runTrapRecovery(run, deps);
  assert.ok(!calls.some((call) => call.endsWith(':b')), 'b is not opened');
  assert.ok(calls.includes('interrupted:thread-b'), 'its interrupted chat is still marked');
  const view = describeTrapOutcome(report.outcomes[1], false);
  assert.equal(report.outcomes[1].status, 'skipped');
  assert.ok(view.canDownload && view.canOpen, 'the user can download the copy or open it on purpose');
});

function facts(overrides: Partial<TrapEntryFacts> = {}): TrapEntryFacts {
  return {
    slot: 'extra',
    attached: false,
    documentId: 'doc-live',
    fileName: 'live.hwp',
    dirty: true,
    hasFile: true,
    worktree: 'none',
    pendingAgentOps: 0,
    activeThreadId: null,
    interruptedThreadIds: [],
    readOnly: false,
    save: { state: 'saved', draftId: 'draft-live', savedAt: 9_000 },
    ...overrides,
  };
}

test('a trap while reopening stops the run, and the next list carries the rest with the culprit marked suspect', async () => {
  const { calls, deps } = fakeDeps({ drafts, trapOn: ['b'] });
  const first = manifest([
    entry('a', { slot: 'default', attached: true }),
    entry('b'),
    entry('c'),
  ], { deliveredLaunchHandleIds: ['launch-1'] });
  const run = createTrapRecoveryRun<string>(first);
  const report = await runTrapRecovery(run, deps);
  assert.deepEqual(calls, ['default:a', 'background:b'], 'nothing opens after the engine stops');
  assert.equal(report.stoppedByTrap, true);
  assert.equal(run.state, 'stopped-by-trap');
  assert.equal(report.outcomes[2].status, 'not-attempted');

  // 사용자가 다시 문서 복구를 누른다. 살아 있는 세션은 이미 다시 연 a 뿐이다.
  const next = buildTrapManifest({
    now: 10_000,
    live: [{ session: 'session-default', facts: facts({ slot: 'default', fileName: 'a.hwp', documentId: 'doc-a' }) }],
    attachedSession: 'session-default',
    run,
    deliveredLaunchHandleIds: ['launch-2'],
    deliveredGeneratedDocumentIds: [],
  });
  assert.equal(next.attempt, 2);
  assert.deepEqual(next.deliveredLaunchHandleIds.sort(), ['launch-1', 'launch-2']);
  const byName = new Map(next.entries.map((item) => [item.fileName, item]));
  assert.deepEqual([...byName.keys()].sort(), ['a.hwp', 'b.hwp', 'c.hwp']);
  assert.equal(byName.get('a.hwp')!.attached, true, 'the document the user was looking at stays the shown one');
  assert.equal(byName.get('b.hwp')!.suspect, true);
  assert.equal(byName.get('c.hwp')!.suspect, false);
  assert.deepEqual(byName.get('c.hwp')!.draft, first.entries[2].draft, 'the unopened entry is carried unchanged');
  assert.equal(new Set(next.entries.map((item) => item.id)).size, 3, 'ids stay unique in the new list');

  // 그 목록으로 다시 열면 b 는 열지 않는다.
  const again = fakeDeps({ drafts });
  await runTrapRecovery(createTrapRecoveryRun<string>(next), again.deps);
  const opened = again.calls.filter((call) => call.startsWith('default:') || call.startsWith('background:'))
    .map((call) => next.entries.find((item) => item.id === call.split(':')[1])!.fileName);
  assert.deepEqual(opened, ['a.hwp', 'c.hwp'], 'the suspect b is left closed');
});

test('a trap that lands after a document opened still marks that document, not the next one', async () => {
  let stopped = false;
  const { deps } = fakeDeps({ drafts });
  deps.engineStopped = () => stopped;
  deps.openInBackground = async (item) => {
    if (item.id === 'b') stopped = true; // 열기는 끝났지만 그 문서를 그리다 멈췄다
    return { result: { kind: 'opened' }, session: `session-${item.id}` };
  };
  const run = createTrapRecoveryRun<string>(manifest([entry('a', { slot: 'default' }), entry('b'), entry('c')]));
  await runTrapRecovery(run, deps);
  const next = buildTrapManifest({
    now: 1,
    live: [
      { session: 'session-default', facts: facts({ slot: 'default', fileName: 'a.hwp' }) },
      { session: 'session-b', facts: facts({ fileName: 'b-live.hwp' }) },
    ],
    attachedSession: 'session-b',
    run,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  });
  const names = next.entries.map((item) => `${item.fileName}${item.suspect ? ':suspect' : ''}`).sort();
  assert.deepEqual(names, ['a.hwp', 'b.hwp:suspect', 'c.hwp'], 'the live session of the suspect is not listed twice');
});

test('without a recovery in progress the list is the live sessions, with the shown one attached', () => {
  const next = buildTrapManifest({
    now: 5,
    live: [
      { session: 's1', facts: facts({ slot: 'default', fileName: 'one.hwp', save: { state: 'skipped' }, dirty: false }) },
      { session: 's2', facts: facts({ fileName: 'two.hwp', save: { state: 'failed', draftId: 'draft-2', lastSavedAt: 4 } }) },
      { session: 's3', facts: facts({ fileName: 'three.hwp', save: { state: 'failed', draftId: null, lastSavedAt: null } }) },
    ],
    attachedSession: 's2',
    run: null,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  });
  assert.equal(next.attempt, 1);
  assert.deepEqual(next.entries.map((item) => [item.fileName, item.attached, item.draft]), [
    ['one.hwp', false, null],
    ['two.hwp', true, { id: 'draft-2', savedAt: 4, fresh: false }],
    ['three.hwp', false, null],
  ]);
});

test('a recovery with losses or staged agent edits is shown in a result dialog, not just a toast', async () => {
  const { deps } = fakeDeps({ drafts: [draftRow('draft-a', 1_000)] });
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default', draft: { id: 'draft-a', savedAt: 1_000, fresh: false } }),
  ]));
  const report = await runTrapRecovery(run, deps);
  assert.equal(report.outcomes[0].status, 'opened');
  assert.equal(trapRecoveryNeedsReview(report), true, 'an older autosave was used');

  const staged = fakeDeps({ drafts });
  const stagedReport = await runTrapRecovery(
    createTrapRecoveryRun<string>(manifest([entry('a', { slot: 'default', pendingAgentOps: 3 })])),
    staged.deps,
  );
  assert.equal(trapRecoveryNeedsReview(stagedReport), true, 'staged edits that became content are disclosed');
});

test('a trap while the shown document is put back on screen stops the recovery and holds that document back', async () => {
  let stopped = false;
  const { calls, deps } = fakeDeps({ drafts });
  deps.engineStopped = () => stopped;
  deps.attach = async (session) => {
    calls.push(`attach:${session}`);
    stopped = true; // 화면에 붙이며 다시 조판하다 멈췄다
  };
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default', attached: true }),
    entry('b'),
  ]));
  const report = await runTrapRecovery(run, deps);
  assert.deepEqual(calls, ['default:a', 'background:b', 'attach:session-default']);
  assert.equal(report.stoppedByTrap, true, 'the result does not claim a clean recovery on a stopped engine');
  assert.equal(trapRecoveryNeedsReview(report), true, 'a result dialog, not the "reopened n documents" toast');
  assert.equal(run.state, 'stopped-by-trap');

  const next = buildTrapManifest({
    now: 20,
    live: [
      { session: 'session-default', facts: facts({ slot: 'default', fileName: 'a-live.hwp', documentId: 'doc-a' }) },
      { session: 'session-b', facts: facts({ fileName: 'b.hwp', documentId: 'doc-b' }) },
    ],
    attachedSession: 'session-default',
    run,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  });
  const names = next.entries.map((item) => `${item.fileName}${item.suspect ? ':suspect' : ''}`).sort();
  assert.deepEqual(names, ['a.hwp:suspect', 'b.hwp'], 'a is listed once, as the document that stopped the engine');

  const again = fakeDeps({ drafts });
  await runTrapRecovery(createTrapRecoveryRun<string>(next), again.deps);
  assert.ok(!again.calls.some((call) => /^(default|background):/.test(call)
    && next.entries.find((item) => item.id === call.split(':')[1])?.fileName === 'a.hwp'),
  'the next recovery does not reopen a into the same trap');
});

test('a list made while a document is still opening names that document once, as the suspect', () => {
  const run = createTrapRecoveryRun<string>(manifest([
    entry('a', { slot: 'default' }),
    entry('b', { documentId: 'doc-b', attached: true }),
    entry('c'),
  ]));
  run.openedIds.add('a');
  run.sessions.set('a', 'session-default');
  // b 를 여는 중에 멈췄고, 그 열기는 아직 끝나지 않아 run 에 세션이 없다.
  run.openingId = 'b';
  run.state = 'running';
  const next = buildTrapManifest({
    now: 30,
    live: [
      { session: 'session-default', facts: facts({ slot: 'default', fileName: 'a.hwp', documentId: 'doc-a' }) },
      { session: 'session-fresh', facts: facts({ fileName: 'b.hwp', documentId: 'doc-b' }) },
    ],
    attachedSession: 'session-fresh',
    run,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  });
  const names = next.entries.map((item) => `${item.fileName}${item.suspect ? ':suspect' : ''}`).sort();
  assert.deepEqual(names, ['a.hwp', 'b.hwp:suspect', 'c.hwp']);
});

test('a recovery copy still being written at the wait cap is used when it lands before the reload', () => {
  // 처음 저장이 상한까지 끝나지 않았다. 앞서 남긴 자동 저장본은 없다.
  const pending = settleUnfinishedTrapSave({ state: 'saving' }, { draftId: 'draft-a', lastSavedAt: null }, 5_000);
  const list = buildTrapManifest({
    now: 40_000,
    live: [{ session: 's', facts: facts({ slot: 'default', fileName: 'a.hwp', save: pending }) }],
    attachedSession: 's',
    run: null,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  });
  const [listed] = list.entries;
  assert.equal(listed.draft?.id, 'draft-a', 'the list still points at the copy being written');

  const landed = planTrapEntry(listed, draftRow('draft-a', 6_000));
  assert.ok(landed.action === 'restore-draft' && landed.loss === null, 'a copy written after the trap reopens without loss');
  const missing = planTrapEntry(listed, null);
  assert.equal(missing.loss?.kind, 'unsaved-changes', 'a copy that never landed is reported as lost');

  // 앞서 남긴 자동 저장본이 있으면, 멈추기 전에 기록된 행은 그 시각의 자동 저장본이다.
  const older = settleUnfinishedTrapSave({ state: 'saving' }, { draftId: 'draft-a', lastSavedAt: 3_000 }, 5_000);
  const [olderEntry] = buildTrapManifest({
    now: 40_000,
    live: [{ session: 's', facts: facts({ slot: 'default', fileName: 'a.hwp', save: older }) }],
    attachedSession: 's',
    run: null,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: [],
  }).entries;
  const stale = planTrapEntry(olderEntry, draftRow('draft-a', 3_000));
  assert.deepEqual(stale.loss, { kind: 'stale-draft', savedAt: 3_000 });
  assert.equal(planTrapEntry(olderEntry, draftRow('draft-a', 7_000)).loss, null);

  // 끝난 저장은 그대로다.
  const saved = { state: 'saved', draftId: 'draft-a', savedAt: 9 } as const;
  assert.equal(settleUnfinishedTrapSave(saved, { draftId: 'draft-a', lastSavedAt: 9 }, 5_000), saved);
});

test('a read-only document is listed as read-only and keeps that through the reload', () => {
  const storage = memoryStorage();
  const list = buildTrapManifest({
    now: 50,
    live: [{
      session: 's',
      facts: facts({ slot: 'default', fileName: 'preview.hwpx', dirty: false, hasFile: false, readOnly: true }),
    }],
    attachedSession: 's',
    run: null,
    deliveredLaunchHandleIds: [],
    deliveredGeneratedDocumentIds: ['generated-1'],
  });
  assert.equal(writeTrapManifest(storage, list), true);
  const [entryBack] = takeTrapManifest(storage)!.entries;
  assert.equal(entryBack.readOnly, true);
  const plan = planTrapEntry(entryBack, draftRow('draft-live'));
  assert.ok(plan.action === 'restore-draft' && plan.cleanAtTrap, 'its copy is reopened as a clean document');
});
