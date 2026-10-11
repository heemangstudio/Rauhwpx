import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

test('브리지는 허브가 수락한 Browserbase 키만 보관하고, 허브가 지운 뒤에만 버린다', async () => {
  const replies: unknown[] = [];
  const frames: unknown[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    browserbaseOverride: null,
    request: async (frame: unknown) => {
      frames.push(frame);
      return replies.shift() ?? null;
    },
  });
  const status = { configured: true, keyTail: 'abcd' };

  assert.equal(await bridge.setBrowserbaseCredentials({ apiKey: 'bb_live_rejected' }), null);
  assert.equal(bridge.browserbaseOverride, null, '거절된 키는 재연결 때 다시 보내지 않는다');

  replies.push(status);
  assert.equal(await bridge.setBrowserbaseCredentials({ apiKey: 'bb_live_ok', projectId: '' }), status);
  assert.deepEqual(bridge.browserbaseOverride, { apiKey: 'bb_live_ok' });

  assert.equal(await bridge.clearBrowserbaseCredentials(), null);
  assert.deepEqual(bridge.browserbaseOverride, { apiKey: 'bb_live_ok' }, '허브가 지우지 못했으면 탭 상태도 유지한다');
  replies.push({ configured: false });
  await bridge.clearBrowserbaseCredentials();
  assert.equal(bridge.browserbaseOverride, null);
  assert.deepEqual(frames.map((frame) => (frame as { type: string }).type), [
    'browserbase-credentials-set',
    'browserbase-credentials-set',
    'browserbase-credentials-clear',
    'browserbase-credentials-clear',
  ]);
});

// 남은 소스 가드: settings.ts 는 DOM 과 CSS 를 직접 만들어 Node 에서 실행할 수 없다.
// 자격 증명 입력과 무제한 기본 모드·지시 승인 게이트만 남긴다.
const settings = readFileSync(new URL('../src/ui/agent-sidebar/settings.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

test('설정의 Browserbase 키는 비밀번호 칸이고 허브 검증이 성공한 뒤에만 탭에 보관·삭제한다', () => {
  assert.match(settings, /createTextField\('Browserbase 키', \{\s*type: 'password',[\s\S]*?autocomplete: 'new-password',/);
  assert.match(settings, /createTextField\('Gemini 키', \{\s*type: 'password',[\s\S]*?autocomplete: 'new-password',/);
  const submit = settings.match(
    /async function submitBrowserbase\(\): Promise<void> \{[\s\S]*?\n  async function resetBrowserbase/,
  )?.[0] ?? '';
  const success = submit.match(/if \(status\) \{[\s\S]*?\n    \} else if \(!browserbaseMessage\)/)?.[0] ?? '';
  assert.match(success, /saveBrowserbaseOverride\(/);
  assert.match(success, /browserbaseKey\.input\.value = '';/);
  assert.doesNotMatch(submit.replace(success, ''), /saveBrowserbaseOverride/);
  assert.match(settings, /const status = await bridge\.clearBrowserbaseCredentials\(\);[\s\S]*if \(status\) \{\s*clearBrowserbaseOverride\(\);/);
});

test('무제한 기본 모드와 에이전트 지시 변경은 사용자 확인을 거친다', () => {
  assert.match(settings, /nextPrefs\.defaultMode === 'full'[\s\S]*confirmSheet\(aiStatus, '기본 모드를 전체로', UNRESTRICTED_DEFAULT_WARNING/);
  assert.match(settings, /bridge\.confirmAgentInstructionsDraft\(draft\)/);
  assert.match(settings, /bridge\.rejectAgentInstructionsDraft\(draft\)/);
});
