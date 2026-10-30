import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLocalBodyTextReplaceResult, parseTextRemoval, validateTextContent, concatTextContent } from '../src/core/local-text-replace-result.ts';

const content = { text: '😀\u00a0\u2007', specialSpaceOrigins: [{ charIndex: 1, origin: 'NbSpace' as const }, { charIndex: 2, origin: 'FwSpace' as const }] };
test('로컬 결과는 실제 삭제 콘텐츠와 scalar 좌표를 보존한다', () => {
  const value = { ok: true, charOffset: 0, documentPaginationPending: true, flowChanged: false, removedStart: 0, removedCount: 3, removedContent: content };
  assert.deepEqual(parseLocalBodyTextReplaceResult(JSON.stringify(value)), value);
  assert.deepEqual(parseTextRemoval({ ok: true }), {});
  validateTextContent({ text: '\u00a0\u2007' }); // 구형 rich payload는 unknown이다.
});
test('잘못된 origin 및 부분 inverse payload는 거부한다', () => {
  for (const origins of [[{ charIndex: 0, origin: 'NbSpace' }], [{ charIndex: 1, origin: 'FwSpace' }], [{ charIndex: 1, origin: 'NbSpace' }, { charIndex: 1, origin: 'NbSpace' }], [{ charIndex: -1, origin: 'Literal' }], [{ charIndex: 3, origin: 'Literal' }], [{ charIndex: 1.5, origin: 'Literal' }], [{ charIndex: 1, origin: 'Other' }]]) {
    assert.throws(() => validateTextContent({ text: content.text, specialSpaceOrigins: origins }));
  }
  assert.throws(() => parseTextRemoval({ removedStart: 0 }));
  assert.throws(() => parseTextRemoval({ removedStart: 0, removedCount: 4, removedContent: content }));
  assert.throws(() => parseLocalBodyTextReplaceResult('{"ok":true,"charOffset":0,"documentPaginationPending":true,"flowChanged":true}'));
});
test('합성은 nonBMP UTF16 길이가 아닌 scalar 길이로 이동하고 unknown을 유지한다', () => {
  const result = concatTextContent({ text: '😀\u00a0', specialSpaceOrigins: [] }, { text: '\u2007\u00a0', specialSpaceOrigins: [{ charIndex: 0, origin: 'FwSpace' }, { charIndex: 1, origin: 'Literal' }] });
  assert.deepEqual(result.specialSpaceOrigins, [{ charIndex: 2, origin: 'FwSpace' }, { charIndex: 3, origin: 'Literal' }]);
  assert.deepEqual(content.specialSpaceOrigins, [{ charIndex: 1, origin: 'NbSpace' }, { charIndex: 2, origin: 'FwSpace' }]);
});
test('실제 명령 undo/redo/coalesce 콘텐츠 보존', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href, join(here, 'support', 'command-special-space.runner.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SPECIAL_SPACE_COMMAND_BEHAVIOUR_OK/);
});
