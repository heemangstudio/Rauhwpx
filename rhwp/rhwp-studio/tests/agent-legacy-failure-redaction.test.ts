/**
 * 이전 허브(failure 없음)의 실패 문구는 Studio 가 직접 가린다 — 흔한 자격 증명 모양을 지우고,
 * 거대한 stderr 도 화면을 붙잡지 않게 선형 시간에 끝나며, 미리 자른 자리에 비밀 조각이 남지 않는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_FAILURE_MESSAGE, legacyProviderFailure } from '../src/agent/provider-failure.ts';

const JWT = `eyJ${'a'.repeat(24)}.${'b'.repeat(40)}.${'c'.repeat(30)}`;

test('older hub failure text loses bearer tokens, keys, JWTs and URL queries', () => {
  const raw = [
    'Authorization: Bearer abcdefghijklmnop0123456789',
    'key sk-ant-oat01-LEGACYSECRETabcdefghij0123456789',
    `token ${JWT} and auth-${JWT}`,
    'see https://example.com/cb?code=LEGACYSECRETquery#frag then http://a/b)http://c',
    '\u001b[31mred\u001b[0m',
  ].join('\n');
  const { message } = legacyProviderFailure('claude', raw);
  assert.doesNotMatch(message, /LEGACYSECRET|abcdefghijklmnop0123456789/);
  assert.equal(message.includes(JWT), false);
  assert.match(message, /auth-\[redacted\]/, 'a JWT glued to a word by a hyphen is removed too');
  assert.match(message, /https:\/\/example\.com\/cb\?\[redacted\] then http:\/\/a\/b\)http:\/\/c/);
  assert.doesNotMatch(message, /\u001b/);
});

test('a secret cut where the long text is read never shows as a fragment', () => {
  // 앞의 긴 토큰이 가려져 줄면, 읽는 상한(8,000자)에서 잘린 자리가 보이는 문구 안으로 들어온다.
  const secret = `sk-${'LEGACYSECRET'.repeat(4)}`;
  const raw = `Bearer ${'A'.repeat(7_980)} ${secret} tail ${'x'.repeat(10_000)}`;
  assert.ok(raw.indexOf(secret) < 8_000 && raw.indexOf(secret) + secret.length > 8_000);
  const { message } = legacyProviderFailure('claude', raw);
  assert.doesNotMatch(message, /sk-|LEGACY/);
  assert.equal(message, 'Bearer [redacted]');
  assert.ok(message.length <= MAX_FAILURE_MESSAGE);
});

test('redacting a huge older hub failure stays fast and grows no faster than its length', () => {
  const repeated = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  for (const unit of ['-eyJ', 'http://']) {
    const time = (size: number) => {
      const text = repeated(unit, size);
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        legacyProviderFailure('claude', text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    time(1024);
    const small = time(16 * 1024);
    const large = time(64 * 1024);
    assert.ok(large <= small * 8 + 50, `${unit}: 64 KB took ${large.toFixed(1)} ms vs ${small.toFixed(1)} ms for 16 KB`);
  }
});
