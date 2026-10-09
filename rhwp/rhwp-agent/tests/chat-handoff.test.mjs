import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexHistoryItems,
  estimateTokens,
  handoffBudget,
  handoffTokenCap,
  normalizeChatHistory,
  prepareHandoff,
  resolveContextWindow,
  selectHistory,
} from '../chat-handoff.mjs';

test('token estimate counts UTF-8 bytes, so Korean costs about one token per character', () => {
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('abcdefg'), 3);
  assert.equal(estimateTokens('가나다라'), 4);
  assert.equal(estimateTokens(''), 0);
});

test('the env cap defaults to 16k and is clamped to 1k–64k', () => {
  assert.equal(handoffTokenCap({}), 16_000);
  assert.equal(handoffTokenCap({ RHWP_CONTEXT_HANDOFF_TOKEN_CAP: '32000' }), 32_000);
  assert.equal(handoffTokenCap({ RHWP_CONTEXT_HANDOFF_TOKEN_CAP: '10' }), 1_024);
  assert.equal(handoffTokenCap({ RHWP_CONTEXT_HANDOFF_TOKEN_CAP: '-5' }), 1_024);
  assert.equal(handoffTokenCap({ RHWP_CONTEXT_HANDOFF_TOKEN_CAP: '900000' }), 64_000);
  assert.equal(handoffTokenCap({ RHWP_CONTEXT_HANDOFF_TOKEN_CAP: 'lots' }), 16_000);
});

test('the budget leaves room for the native session, the request and a quarter of the window', () => {
  // 200k 창: 여유분 50k. 상한(16k)이 먼저 걸린다.
  assert.equal(handoffBudget({ window: 200_000 }), 16_000);
  assert.equal(handoffBudget({ cap: 64_000, window: 200_000 }), 64_000);
  // 이어 받은 세션이 140k 를 쓰고 있으면 200k − 140k − 50k = 10k.
  assert.equal(handoffBudget({ cap: 64_000, window: 200_000, usedTokens: 140_000 }), 10_000);
  // 한글 요청 3,000자는 약 3,000토큰을 뺀다. 100k 창의 여유분은 최소값 16k 가 아니라 25k.
  assert.equal(handoffBudget({ cap: 64_000, window: 100_000, usedTokens: 50_000, userText: '가'.repeat(3_000) }), 22_000);
  // 작은 창은 여유분(최소 16k)도 못 채운다.
  assert.equal(handoffBudget({ window: 8_192 }), 0);
  // 창을 모르면 128k 로 본다.
  assert.equal(handoffBudget({ cap: 64_000, window: undefined }), 64_000);
  assert.equal(handoffBudget({ cap: 64_000, window: undefined, usedTokens: 80_000 }), 128_000 - 80_000 - 32_000);
});

test('the context window prefers the model config, then the last reported window, then the provider default', () => {
  assert.equal(resolveContextWindow('pi', { modelContextLength: 1_000_000, reportedMaxTokens: 200_000 }), 1_000_000);
  assert.equal(resolveContextWindow('claude', { reportedMaxTokens: 1_000_000 }), 1_000_000);
  assert.equal(resolveContextWindow('codex', {}), 258_400);
  assert.equal(resolveContextWindow('claude', { reportedMaxTokens: 0 }), 200_000);
  assert.equal(resolveContextWindow('grok', {}), 128_000);
});

test('history normalization validates entries without budget truncation', () => {
  const long = 'x'.repeat(50_000);
  const history = normalizeChatHistory([
    { role: 'system', text: 'dropped' },
    { role: 'user', text: '  first  ', agent: 'claude', id: 'msg-1' },
    { role: 'assistant', text: 'tools', kind: 'tools', agent: 'codex', id: 'a'.repeat(129) },
    { role: 'assistant', text: 'odd', kind: 'telepathy', agent: 'hal' },
    { role: 'user', text: '   ' },
    { role: 'assistant', text: long },
  ]);
  assert.deepEqual(history.slice(0, 3), [
    { role: 'user', text: 'first', kind: 'message', agent: 'claude', id: 'msg-1' },
    { role: 'assistant', text: 'tools', kind: 'tools', agent: 'codex' },
    { role: 'assistant', text: 'odd', kind: 'message' },
  ]);
  assert.equal(history[3].text.length, 50_000);

  const many = normalizeChatHistory(Array.from({ length: 450 }, (_, index) => ({ role: 'user', text: `m${index}` })));
  assert.equal(many.length, 400);
  assert.equal(many[0].text, 'm50');
  assert.equal(normalizeChatHistory([{ role: 'user', text: 'y'.repeat(150_000) }])[0].text.length, 100_000);
  // 전체 2M 자를 넘으면 오래된 쪽을 버린다.
  const huge = normalizeChatHistory(Array.from({ length: 25 }, (_, index) => ({ role: 'user', text: `${index}`.padEnd(100_000, '.') })));
  assert.equal(huge.length, 20);
  assert.match(huge[0].text, /^5\./);
});

function entry(role, text, extra = {}) {
  return { role, text, kind: 'message', ...extra };
}

test('selection keeps the latest request, the latest answer and the first request before newer filler', () => {
  const entries = [
    entry('user', 'FIRST-REQUEST: keep the 2024 budget table.'),
    entry('assistant', `old answer ${'a'.repeat(3_000)}`),
    entry('user', `middle ${'b'.repeat(3_000)}`),
    entry('assistant', `recent filler ${'c'.repeat(1_200)}`),
    entry('assistant', 'LATEST-ANSWER: the table is on page 3.'),
    entry('user', 'LATEST-REQUEST: move it to page 2.'),
  ];
  const selection = selectHistory(entries, 900);
  const texts = selection.entries.map((item) => item.text);
  assert.deepEqual(texts.slice(0, 1), [entries[0].text]);
  assert.ok(texts.includes(entries[4].text));
  assert.equal(texts.at(-1), entries[5].text);
  // 오래된 큰 항목은 통째로 빠지고, 남은 예산에 맞는 최신 항목이 먼저 들어간다.
  assert.equal(texts.includes(entries[1].text), false);
  assert.equal(texts.includes(entries[2].text), false);
  assert.ok(texts.includes(entries[3].text));
  assert.equal(selection.omitted, 2);
  assert.equal(selection.truncated, false);
  // 들어간 항목은 하나도 잘리지 않았다.
  for (const item of selection.entries) assert.ok(entries.some((source) => source.text === item.text));

  // 예산이 빠듯하면 더 새로운 항목보다 첫 요청이 먼저다: 첫 요청이 없을 때 들어가던 항목이 밀려난다.
  const withoutFirst = selectHistory(entries.slice(1), 585).entries.map((item) => item.text);
  assert.ok(withoutFirst.includes(entries[3].text));
  const tight = selectHistory(entries, 585).entries.map((item) => item.text);
  assert.deepEqual(tight, [entries[0].text, entries[4].text, entries[5].text]);
});

test('only the latest request is cut when it alone exceeds the budget', () => {
  const big = `START ${'요청'.repeat(5_000)} END`;
  const entries = [
    entry('user', 'first request'),
    entry('assistant', `large answer ${'z'.repeat(9_000)}`),
    entry('user', big),
  ];
  const selection = selectHistory(entries, 1_000);
  const latest = selection.entries.at(-1);
  assert.equal(selection.truncated, true);
  assert.ok(latest.text.startsWith('START '));
  assert.ok(latest.text.endsWith('…[truncated]'));
  assert.equal(latest.text.includes(' END'), false);
  assert.equal(selection.entries.some((item) => item.text.startsWith('large answer')), false);
  const handoff = prepareHandoff(entries, 1_000);
  assert.ok(estimateTokens(handoff.block) <= 1_000);
});

test('the rendered block stays within budget and states coverage, sources and the document pointer', () => {
  const entries = [
    entry('user', '계약서 3조를 고쳐 줘.', { agent: 'claude' }),
    entry('assistant', `${'긴 설명 '.repeat(2_000)}`, { agent: 'claude' }),
    entry('assistant', 'replace_range · ok · 3조 수정', { agent: 'codex', kind: 'tools' }),
    entry('user', '이제 4조도.', { agent: 'codex' }),
  ];
  for (const budget of [300, 600, 1_200, 5_000, 20_000]) {
    const handoff = prepareHandoff(entries, budget);
    assert.ok(estimateTokens(handoff.block) <= budget, `budget ${budget}`);
  }
  const handoff = prepareHandoff(entries, 600);
  assert.equal(handoff.selection.entries.length, 3);
  assert.match(handoff.block, /^<chat_history trust="conversation-transcript">\n/);
  assert.match(handoff.block, /3 of 4 earlier chat entries included \(1 omitted\)\. Sources: Claude, Codex\./);
  assert.match(handoff.block, /get_structure/);
  assert.match(handoff.block, /\[assistant · Codex · tools\]\nreplace_range · ok · 3조 수정/);
  assert.match(handoff.block, /\[user · Codex\]\n이제 4조도\.\n.*not a new request.*\n<\/chat_history>$/);
  assert.equal(prepareHandoff(entries, 0), null);
  assert.equal(prepareHandoff([], 10_000), null);

  // 같은 선택이 Codex 네이티브 항목이 된다: 안내 한 개 + 이름표 붙은 항목.
  const items = codexHistoryItems(handoff);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0].content[0].type, 'input_text');
  assert.match(items[0].content[0].text, /3 of 4 earlier chat entries included[\s\S]*not a new request/);
  assert.deepEqual(items.slice(1).map((item) => [item.type, item.role, item.content[0].type]), [
    ['message', 'user', 'input_text'],
    ['message', 'assistant', 'output_text'],
    ['message', 'user', 'input_text'],
  ]);
  assert.equal(items[3].content[0].text, '[user · Codex]\n이제 4조도.');
});
