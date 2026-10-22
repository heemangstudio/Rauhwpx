import assert from 'node:assert/strict';
import test from 'node:test';
import { browserEventReachesSession } from '../browser-event-scope.mjs';

test('에이전트 미리보기와 커서는 그 채팅을 연 Studio 에만 간다', () => {
  for (const type of ['owned_browser_activity', 'owned_browser_pointer']) {
    assert.equal(browserEventReachesSession({ type, sessionId: 'a' }, 'a'), true);
    assert.equal(browserEventReachesSession({ type, sessionId: 'a' }, 'b'), false);
    assert.equal(browserEventReachesSession({ type }, 'b'), false, '세션이 없는 커서는 아무 창에도 그리지 않는다');
  }
  assert.equal(browserEventReachesSession({ type: 'owned_browser_inventory' }, 'b'), true, '탭 목록은 모든 창이 받는다');
});
