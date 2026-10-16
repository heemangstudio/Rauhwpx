import assert from 'node:assert/strict';

const MODE_BLOCK = /^<rhwp_mode>\n[\s\S]*?\n<\/rhwp_mode>\n\n/;

/** provider 에 간 사용자 턴 글에서 앞의 현재 모드 블록을 확인하고 떼어 낸다. */
export function withoutModeBlock(text) {
  const match = MODE_BLOCK.exec(String(text));
  assert.ok(match, 'the user turn starts with the current mode block');
  return String(text).slice(match[0].length);
}
