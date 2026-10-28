import assert from 'node:assert/strict';
import test from 'node:test';

import { pickChatForDocument } from '../src/document-switch-chat.ts';
import {
  initialSwitchIndex,
  stepIndex,
  stepOpenIndex,
  switcherRows,
  type OpenDocumentRow,
  type RecentDocumentRow,
} from '../src/ui/document-switcher/model.ts';

const open = (documentId: string, name: string, current = false): OpenDocumentRow => ({
  kind: 'open', documentId, name, dirty: false, status: null, current,
});
const recent = (documentId: string, name: string): RecentDocumentRow => ({
  kind: 'recent', documentId, name, format: 'hwpx', openedAt: 0,
});

const tabs = [open('a', '제안서.hwpx'), open('b', '회의록.hwpx', true), open('c', 'Budget.hwp')];

test('rows list open documents in open order, then recent ones not already open, then actions', () => {
  const rows = switcherRows({ open: tabs, recent: [recent('b', '회의록.hwpx'), recent('d', '계약서.hwp')] });
  assert.deepEqual(rows.map((row) => row.kind === 'action' ? row.action : row.documentId),
    ['a', 'b', 'c', 'd', 'new', 'open', 'home']);
});

test('search matches Korean names and ignores case, across open, recent and actions', () => {
  const recents = [recent('d', '회의록 초안.hwp'), recent('e', 'budget-2025.hwpx')];
  const names = (query: string) => switcherRows({ open: tabs, recent: recents, query })
    .map((row) => row.kind === 'action' ? row.label : row.name);
  assert.deepEqual(names('회의록'), ['회의록.hwpx', '회의록 초안.hwp']);
  assert.deepEqual(names('BUDGET'), ['Budget.hwp', 'budget-2025.hwpx']);
  assert.deepEqual(names('홈'), ['문서 홈']);
});

test('without a query only the latest recent documents show; a query searches them all', () => {
  const many = Array.from({ length: 9 }, (_, i) => recent(`r${i}`, `문서${i}.hwp`));
  assert.equal(switcherRows({ open: [], recent: many }).filter((row) => row.kind === 'recent').length, 5);
  assert.equal(switcherRows({ open: [], recent: many, query: '문서' }).filter((row) => row.kind === 'recent').length, 9);
});

test('Ctrl+Tab starts on the document after the current one and Tab wraps around the open documents only', () => {
  const rows = switcherRows({ open: tabs, recent: [recent('d', '계약서.hwp')] });
  assert.equal(initialSwitchIndex(rows, 1), 2);
  assert.equal(initialSwitchIndex(rows, -1), 0);
  assert.equal(stepOpenIndex(rows, 2, 1), 0, 'past the last open document it wraps to the first');
  assert.equal(stepOpenIndex(rows, 0, -1), 2);
  assert.equal(stepOpenIndex(rows, 4, 1), 0, 'from an action row Tab returns to the open documents');
  assert.equal(stepIndex(6, 1, 7), 0, 'arrows wrap across every row');
  assert.equal(stepIndex(-1, -1, 7), 6);
});

test('switching documents shows the running chat, else the last one seen, else the latest conversation', () => {
  const threads = [
    { id: 't-new', documentId: 'doc-a', docKey: null },
    { id: 't-old', documentId: 'doc-a', docKey: null },
    { id: 't-other', documentId: 'doc-b', docKey: null },
  ];
  const pick = (chats: { running: boolean; threadId: string | null }[], activeIndex: number) =>
    pickChatForDocument({ chats, activeIndex, threads, documentId: 'doc-a', docKey: '제안서.hwpx' });

  assert.deepEqual(pick([{ running: false, threadId: 't-old' }, { running: true, threadId: 't-run' }], 0),
    { kind: 'show', index: 1 }, 'a hidden running chat wins over the last seen one');
  assert.deepEqual(pick([{ running: true, threadId: 't-run' }, { running: true, threadId: 't-run2' }], 1),
    { kind: 'keep' }, 'a running chat already on screen stays');
  assert.deepEqual(pick([{ running: false, threadId: 't-old' }], 0), { kind: 'keep' },
    'the last chat seen with a conversation stays even when another is newer');
  assert.deepEqual(pick([{ running: false, threadId: 'draft' }], 0), { kind: 'open-thread', threadId: 't-new' },
    'an empty draft gives way to the latest conversation for the document');
  assert.deepEqual(pick([{ running: false, threadId: 'draft' }, { running: false, threadId: 't-new' }], 0),
    { kind: 'show', index: 1 }, 'a chat window already holding it is shown instead of reopening');
  assert.deepEqual(pickChatForDocument({
    chats: [{ running: false, threadId: 'draft' }], activeIndex: 0, threads, documentId: 'doc-z', docKey: null,
  }), { kind: 'keep' }, 'a document with no conversation keeps its draft');
});
