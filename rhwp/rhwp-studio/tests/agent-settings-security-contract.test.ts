import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// 남은 소스 가드: settings.ts 는 DOM 과 CSS 를 직접 만들어 Node 에서 실행할 수 없다.
// 무제한 기본 모드 확인 게이트를 유지한다.
const settings = readFileSync(new URL('../src/ui/agent-sidebar/settings.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

test('무제한 기본 모드는 사용자 확인을 거친다', () => {
  assert.match(settings, /nextPrefs\.defaultMode === 'full'[\s\S]*confirmSheet\(aiStatus, '기본 모드를 전체로', UNRESTRICTED_DEFAULT_WARNING/);
});
