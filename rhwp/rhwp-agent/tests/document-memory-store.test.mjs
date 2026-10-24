import assert from 'node:assert/strict';
import { promises as fsPromises, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DocumentMemoryStore,
  MAX_MEMORY_ENTRIES,
  documentMemoryPromptBlock,
} from '../document-memory-store.mjs';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-document-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const explicit = { origin: 'explicit', source: { threadId: 'thread-1', turnId: 'turn-1', kind: 'turn' } };

test('variant worktrees share one memory through the repository, other documents stay separate', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const main = await store.resolveKey({ documentId: 'doc-main', repositoryId: 'repo-1' });
  await store.apply(main, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }], explicit);

  const variant = await store.resolveKey({ documentId: 'doc-variant', repositoryId: 'repo-1' });
  assert.equal(variant, main);
  assert.deepEqual((await store.read(variant)).entries.map((entry) => entry.text), ['본문은 한다체 사용']);

  const sibling = await store.resolveKey({ documentId: 'doc-sibling' });
  assert.notEqual(sibling, main);
  assert.deepEqual((await store.read(sibling)).entries, []);

  // A fresh store (hub restart) keeps the same bindings.
  const reopened = new DocumentMemoryStore({ dir });
  assert.equal(await reopened.resolveKey({ documentId: 'doc-variant' }), main);
  assert.equal((await reopened.read(main)).revision, 1);
});

test('a never-seen documentId with a known digest and name gets its own copy of that memory', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const key = await store.resolveKey({ documentId: 'doc-1', digest: 'blake3:aaaa', fileName: '보고서.hwpx' });
  const original = await store.apply(key, [{ op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일" }], explicit);

  // Studio minted a new id for the same bytes (re-minted id or a Finder copy): the notes come along, the key does not.
  const reopened = new DocumentMemoryStore({ dir });
  const copy = await reopened.resolveKey({ documentId: 'doc-2', digest: 'blake3:aaaa', fileName: '보고서.hwpx' });
  assert.notEqual(copy, key);
  const copied = (await reopened.read(copy)).entries;
  assert.deepEqual(copied.map((entry) => [entry.text, entry.origin, entry.source?.kind]), [["'고객' 대신 '이용자'로 통일", 'explicit', 'copy']]);
  assert.notEqual(copied[0].id, original.changes[0].entryId);

  // The two documents now diverge.
  await reopened.apply(copy, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }], explicit);
  assert.equal((await reopened.read(key)).entries.length, 1);
  assert.equal(await reopened.resolveKey({ documentId: 'doc-2', digest: 'blake3:aaaa', fileName: '보고서.hwpx' }), copy);
  assert.equal(await reopened.resolveKey({ documentId: 'doc-1', digest: 'blake3:aaaa', fileName: '보고서.hwpx' }), key);

  // A byte-identical file under another name is another document and starts empty.
  const renamed = await reopened.resolveKey({ documentId: 'doc-3', digest: 'blake3:aaaa', fileName: '보고서 사본.hwpx' });
  assert.deepEqual((await reopened.read(renamed)).entries, []);
  // An id first seen without its digest still gets the copy once the digest arrives.
  const late = new DocumentMemoryStore({ dir });
  const provisional = await late.resolveKey({ documentId: 'doc-4' });
  assert.equal(await late.resolveKey({ documentId: 'doc-4', digest: 'blake3:aaaa', fileName: '보고서.hwpx' }), provisional);
  assert.equal((await late.read(provisional)).entries.length >= 1, true);
});

test('new documents without a source digest never share memory, and an empty memory is never copied', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  // Studio sends no digest for 새 문서: two blank documents with the same name stay apart.
  const first = await store.resolveKey({ documentId: 'new-1' });
  await store.apply(first, [{ op: 'add', kind: 'style', text: '본문은 한다체 사용' }], { origin: 'user' });
  const second = await store.resolveKey({ documentId: 'new-2' });
  assert.notEqual(second, first);
  assert.deepEqual((await store.read(second)).entries, []);

  // A digest whose memory was emptied is not a copy source.
  const emptied = await store.resolveKey({ documentId: 'doc-a', digest: 'blake3:cccc', fileName: '계획.hwpx' });
  const added = await store.apply(emptied, [{ op: 'add', kind: 'fact', text: '마감 11월' }], explicit);
  await store.apply(emptied, [{ op: 'remove', id: added.changes[0].entryId }], { origin: 'user' });
  const other = await store.resolveKey({ documentId: 'doc-b', digest: 'blake3:cccc', fileName: '계획.hwpx' });
  assert.notEqual(other, emptied);
  assert.equal((await store.read(other)).revision, 0);
});

test('anchor quotes keep double spaces, tabs, U+00A0 and U+3000 exactly and drop only line breaks', async (t) => {
  const store = new DocumentMemoryStore({ dir: tempDir(t) });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  const quote = '제3장  연구\t방법\u00a0및\u3000범위';
  const result = await store.apply(key, [
    { op: 'add', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지', anchor: { quote: `${quote}\r\n` } },
    // 120 code units where the 120th is a high surrogate: the cut keeps the pair whole.
    { op: 'add', kind: 'protect', subject: '보호.긴글', text: '긴 인용', anchor: { quote: `${'가'.repeat(119)}😀끝` } },
  ], explicit);
  assert.equal(result.changes[0].entry.anchor.quote, quote);
  const long = result.changes[1].entry.anchor.quote;
  assert.equal(long, '가'.repeat(119));
  assert.equal(long.isWellFormed(), true);
  // Rereading from disk keeps the quote byte-exact.
  const reread = (await new DocumentMemoryStore({ dir: store.dir }).read(key)).entries[0].anchor.quote;
  assert.equal(Buffer.compare(Buffer.from(reread), Buffer.from(quote)), 0);
});

test('the index is written before the memory file, so a crash between them leaves no orphaned memory', async (t) => {
  const dir = tempDir(t);
  // Another document's memory means a valid index already exists (a missing index would be rebuilt).
  const seed = new DocumentMemoryStore({ dir });
  await seed.apply(await seed.resolveKey({ documentId: 'doc-0' }), [{ op: 'add', kind: 'fact', text: '다른 문서' }], explicit);
  // The second rename of the next write crashes, whichever file it is.
  let renames = 0;
  const crashing = {
    ...fsPromises,
    rename: async (from, to) => {
      renames += 1;
      if (renames === 2) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
      return fsPromises.rename(from, to);
    },
  };
  const store = new DocumentMemoryStore({ dir, fsApi: crashing });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  await assert.rejects(store.apply(key, [{ op: 'add', kind: 'fact', text: '마감 11월' }], explicit), /simulated crash/);

  // After a restart the document still resolves to the same memory, and the retried note lands there.
  const restarted = new DocumentMemoryStore({ dir });
  assert.equal(await restarted.resolveKey({ documentId: 'doc-1' }), key);
  await restarted.apply(key, [{ op: 'add', kind: 'fact', text: '마감 11월' }], explicit);
  const again = new DocumentMemoryStore({ dir });
  assert.equal(await again.resolveKey({ documentId: 'doc-1' }), key);
  assert.deepEqual((await again.read(key)).entries.map((entry) => entry.text), ['마감 11월']);
});

test('documents without notes write nothing to disk', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  await store.resolveKey({ documentId: 'doc-1', digest: 'blake3:bbbb' });
  assert.deepEqual(readdirSync(dir), []);
});

test('adding an existing subject updates that note and counts the confirmation', async (t) => {
  const store = new DocumentMemoryStore({ dir: tempDir(t) });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  const first = await store.apply(key, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 합니다체 사용' }], explicit);
  const second = await store.apply(key, [{ op: 'add', kind: 'style', subject: ' 문체.종결 ', text: '본문은 한다체 사용' }], { origin: 'learned' });
  assert.equal(second.changes[0].op, 'update');
  assert.equal(second.changes[0].entryId, first.changes[0].entryId);
  assert.equal(second.changes[0].prev.text, '본문은 합니다체 사용');
  const { entries } = await store.read(key);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '본문은 한다체 사용');
  assert.equal(entries[0].evidence, 2);
  assert.equal(entries[0].origin, 'learned');
});

test('caps reject a 41st note and an over-long memory without changing anything', async (t) => {
  const store = new DocumentMemoryStore({ dir: tempDir(t) });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  const ops = Array.from({ length: MAX_MEMORY_ENTRIES }, (_, index) => ({
    op: 'add', kind: 'fact', subject: `사실.${index}`, text: `사실 ${index}`,
  }));
  await store.apply(key, ops, explicit);
  await assert.rejects(
    store.apply(key, [{ op: 'add', kind: 'fact', subject: '사실.넘침', text: '하나 더' }], explicit),
    { code: 'MEMORY_FULL' },
  );
  // 30 notes of 300 characters pass the 8,000-character budget.
  const long = 'ㄱ'.repeat(300);
  const lengthen = (await store.read(key)).entries.slice(0, 30).map((entry) => ({ op: 'update', id: entry.id, text: long }));
  await assert.rejects(store.apply(key, lengthen, explicit), { code: 'MEMORY_FULL' });
  const after = await store.read(key);
  assert.equal(after.revision, 1);
  assert.equal(after.entries.length, MAX_MEMORY_ENTRIES);
});

test('a stale expectedRevision is refused', async (t) => {
  const store = new DocumentMemoryStore({ dir: tempDir(t) });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  await store.apply(key, [{ op: 'add', kind: 'decision', text: '3장은 표로 정리' }], { ...explicit, expectedRevision: 0 });
  await assert.rejects(
    store.apply(key, [{ op: 'add', kind: 'decision', text: '4장은 삭제' }], { ...explicit, expectedRevision: 0 }),
    { code: 'MEMORY_REVISION_CONFLICT' },
  );
  assert.equal((await store.read(key)).entries.length, 1);
});

test('revert undoes changes only while the notes are still as they were left', async (t) => {
  const store = new DocumentMemoryStore({ dir: tempDir(t) });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  const seeded = await store.apply(key, [
    { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' },
    { op: 'add', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지', anchor: { quote: '제3장 연구 방법', paraIdx: 12 } },
  ], explicit);
  const [style, protect] = seeded.changes.map((change) => change.entryId);
  const learned = await store.apply(key, [
    { op: 'update', id: style, text: '본문은 합니다체 사용' },
    { op: 'remove', id: protect },
    { op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'" },
  ], { origin: 'learned' });

  // The user edits the term afterwards; undoing the learner must leave that edit alone.
  const termId = learned.changes[2].entryId;
  await store.apply(key, [{ op: 'update', id: termId, text: "'고객' 대신 '사용자'" }], { origin: 'user' });

  const result = await store.revert(key, learned.changes);
  assert.deepEqual(result.reverted.sort(), [protect, style].sort());
  assert.deepEqual(result.skipped, [termId]);
  const texts = new Map((await store.read(key)).entries.map((entry) => [entry.id, entry.text]));
  assert.equal(texts.get(style), '본문은 한다체 사용');
  assert.equal(texts.get(protect), '3장 수정 금지');
  assert.equal(texts.get(termId), "'고객' 대신 '사용자'");

  // Reverting again finds nothing as it was left.
  const again = await store.revert(key, learned.changes);
  assert.deepEqual(again.reverted, []);
});

test('findSubject lists the same subject across documents', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const a = await store.resolveKey({ documentId: 'doc-a' });
  const b = await store.resolveKey({ documentId: 'doc-b' });
  await store.apply(a, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '한다체' }], explicit);
  await store.apply(b, [{ op: 'add', kind: 'style', subject: '문체.종결', text: '한다체' }], explicit);
  const hits = await new DocumentMemoryStore({ dir }).findSubject('문체.종결');
  assert.deepEqual(hits.map((hit) => hit.key).sort(), [a, b].sort());
});

test('a corrupt index is rebuilt from the memory files', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const key = await store.resolveKey({ documentId: 'doc-1', repositoryId: 'repo-9' });
  await store.apply(key, [{ op: 'add', kind: 'fact', text: '제출 기한 11월 3일' }], explicit);
  writeFileSync(path.join(dir, 'index.json'), '{not json');
  const reopened = new DocumentMemoryStore({ dir });
  assert.equal(await reopened.resolveKey({ documentId: 'doc-2', repositoryId: 'repo-9' }), key);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'docs', `${key}.json`), 'utf8')).entries.length, 1);
});

test('the prompt block leaves out notes whose anchor is gone and lists subjects past the budget', () => {
  const memory = {
    key: 'dm_x', revision: 4,
    entries: [
      { id: 'mem_aaaaaaaaaaaa', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', origin: 'user' },
      { id: 'mem_bbbbbbbbbbbb', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지', anchor: { quote: '제3장' }, origin: 'explicit' },
      { id: 'mem_dddddddddddd', kind: 'term', subject: '용어.고객', text: "'이용자'로 통일", origin: 'learned' },
      { id: 'mem_cccccccccccc', kind: 'fact', subject: '사실.긴글', text: '가'.repeat(290), origin: 'explicit' },
    ],
  };
  const block = documentMemoryPromptBlock(memory, { excludeIds: ['mem_bbbbbbbbbbbb'], budget: 120 });
  // Notes carry their origin; the block makes no trust claim for text an agent may have written.
  assert.match(block, /^<document_memory revision="4">\n/);
  assert.doesNotMatch(block, /trust=/);
  assert.match(block, /- \[style, 직접\] 본문은 한다체 사용 {2}\(mem_aaaaaaaaaaaa\)/);
  assert.match(block, /- \[term, 학습\] '이용자'로 통일/);
  assert.doesNotMatch(block, /3장 수정 금지/);
  assert.match(block, /Omitted .*mem_bbbbbbbbbbbb/);
  assert.match(block, /subjects only .*사실\.긴글 \(mem_cccccccccccc\)/);
  assert.equal(documentMemoryPromptBlock({ revision: 0, entries: [] }), '');
  assert.match(documentMemoryPromptBlock({ revision: 5, entries: [] }, { emptied: true }), /No notes/);
});

test('revert refuses a malformed change list and never restores past the size caps', async (t) => {
  const dir = tempDir(t);
  const store = new DocumentMemoryStore({ dir });
  const key = await store.resolveKey({ documentId: 'doc-1' });
  const long = (n) => `${n}${'가'.repeat(279)}`;
  const seeded = await store.apply(key, [{ op: 'add', kind: 'fact', subject: '사실.0', text: long(0) }], explicit);
  const removed = await store.apply(key, [{ op: 'remove', id: seeded.changes[0].entryId }], explicit);
  await assert.rejects(store.revert(key, [{ op: 'remove', entryId: seeded.changes[0].entryId }]), { code: 'MEMORY_INVALID' });
  await assert.rejects(store.revert(key, [{ ...removed.changes[0], prev: { ...removed.changes[0].prev, id: 'mem_000000000000' } }]), { code: 'MEMORY_INVALID' });

  // Fill the document to the character cap; restoring the removed note would pass it.
  const fill = Array.from({ length: 28 }, (_, index) => ({ op: 'add', kind: 'fact', subject: `사실.${index + 1}`, text: long(index + 1).slice(0, 285) }));
  await store.apply(key, fill, explicit);
  const result = await store.revert(key, removed.changes);
  assert.deepEqual([result.reverted, result.skipped], [[], [seeded.changes[0].entryId]]);
});
