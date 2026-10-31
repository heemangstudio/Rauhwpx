// 예전 말투 맞추기 옮기기: 지침은 AGENTS.md 로 한 번, 한국어 원고만 남기고 나머지는 지운다.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentInstructionsStore } from '../agent-instructions.mjs';
import { UserMemoryStore } from '../user-memory-store.mjs';
import { appendLegacyInstruction, migrateLegacyWritingStyle, readLegacySources } from '../writing-style-legacy.mjs';

/** 예전 WritingStyleStore 가 남긴 모양의 폴더. */
function writeLegacyFolder(root, { language = 'ko', instruction = '', files = [] } = {}) {
  mkdirSync(path.join(root, 'sources'), { recursive: true });
  writeFileSync(path.join(root, 'style.md'), '# 말투\n');
  writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({ language, updatedAt: '2026-10-01T00:00:00.000Z' }));
  if (instruction) writeFileSync(path.join(root, 'additional-instruction.md'), instruction);
  const entries = files.map(({ name, text }, index) => {
    const bytes = Buffer.from(text, 'utf8');
    const id = crypto.createHash('sha256').update(bytes).digest('hex');
    const storedName = `${String(index + 1).padStart(2, '0')}-${id}${path.extname(name)}`;
    writeFileSync(path.join(root, 'sources', storedName), bytes);
    return { id, sha256: id, storedName, name, type: 'text/plain', size: bytes.length, addedAt: '2026-10-01T00:00:00.000Z' };
  });
  writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ version: 1, files: entries }));
  return entries;
}

async function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-style-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const instructions = await new AgentInstructionsStore({ rootDir: path.join(dir, 'instructions') }).init();
  const userMemory = new UserMemoryStore({ dir: path.join(dir, 'memory') });
  return { dir, root: path.join(dir, 'writing-style'), instructions, userMemory };
}

test('the instruction moves into AGENTS.md once and Korean samples stay for a later style learn', async (t) => {
  const h = await harness(t);
  const entries = writeLegacyFolder(h.root, { instruction: '문장은 짧게 쓴다.\n', files: [{ name: 'a.txt', text: '첫 원고' }, { name: 'b.md', text: '둘째 원고' }] });
  const revision = h.instructions.snapshot().revision;
  assert.deepEqual(await migrateLegacyWritingStyle({ root: h.root, instructions: h.instructions, userMemory: h.userMemory }), { files: 2 });
  const after = h.instructions.snapshot();
  assert.equal(after.revision, revision + 1);
  assert.match(after.content, /\n## 말투 지침\n문장은 짧게 쓴다\.\n$/);
  assert.deepEqual(await h.userMemory.legacyState(), { instructionMigrated: true });

  // 다음 시작에는 다시 붙이지 않는다 — 사용자가 그 절을 지웠어도.
  await h.instructions.update('# 내 지시\n', { expectedRevision: after.revision });
  assert.deepEqual(await migrateLegacyWritingStyle({ root: h.root, instructions: h.instructions, userMemory: h.userMemory }), { files: 2 });
  assert.equal(h.instructions.snapshot().content, '# 내 지시\n');

  // 원고는 sha256 을 확인해 읽는다. 바뀐 파일은 뺀다.
  writeFileSync(path.join(h.root, 'sources', entries[1].storedName), '바뀐 글');
  const sources = await readLegacySources(h.root);
  assert.deepEqual(sources.map((source) => [source.name, source.bytes.toString('utf8')]), [['a.txt', '첫 원고']]);
});

test('an English profile or one without samples is deleted after its instruction moves', async (t) => {
  const english = await harness(t);
  writeLegacyFolder(english.root, { language: 'en', instruction: 'Keep it short.', files: [{ name: 'a.txt', text: 'draft' }] });
  assert.equal(await migrateLegacyWritingStyle({ root: english.root, instructions: english.instructions, userMemory: english.userMemory }), null);
  assert.equal(existsSync(english.root), false);
  assert.match(english.instructions.snapshot().content, /## 말투 지침\nKeep it short\./);

  const empty = await harness(t);
  writeLegacyFolder(empty.root, {});
  const before = empty.instructions.snapshot().revision;
  assert.equal(await migrateLegacyWritingStyle({ root: empty.root, instructions: empty.instructions, userMemory: empty.userMemory }), null);
  assert.equal(existsSync(empty.root), false);
  assert.equal(empty.instructions.snapshot().revision, before, 'an empty instruction changes nothing');

  const missing = await harness(t);
  assert.equal(await migrateLegacyWritingStyle({ root: missing.root, instructions: missing.instructions, userMemory: missing.userMemory }), null);
  await assert.rejects(readLegacySources(missing.root), { code: 'LEGACY_NOT_FOUND' });
});

test('the instruction section is appended once and never duplicates text already there', () => {
  assert.equal(appendLegacyInstruction('# 지시\n', '짧게'), '# 지시\n\n## 말투 지침\n짧게\n');
  assert.equal(appendLegacyInstruction('# 지시\n\n## 말투 지침\n짧게\n', '짧게'), null);
  assert.equal(appendLegacyInstruction('# 지시\n', '  '), null);
  assert.equal(appendLegacyInstruction('', '짧게'), '## 말투 지침\n짧게\n');
  assert.ok(readFileSync(new URL('../writing-style-legacy.mjs', import.meta.url), 'utf8').includes('RHWP_WRITING_STYLE_DIR'));
});
