import assert from 'node:assert/strict';
import test from 'node:test';
import { readAgentPointer, viewportPointToDisplay } from '../src/ui/agent-sidebar/browser-agent-cursor.ts';

test('에이전트 포인터의 페이지 좌표는 줄여 그린 프레임 위 자리로 옮겨진다', () => {
  const viewport = { width: 1280, height: 800 };
  // 640×400으로 줄여 표면 가운데(위 20px 여백)에 그린 프레임.
  const displayed = { left: 0, top: 20, width: 640, height: 400 };
  assert.deepEqual(viewportPointToDisplay({ x: 640, y: 400 }, viewport, displayed), { x: 320, y: 220 });
  assert.deepEqual(viewportPointToDisplay({ x: 1280, y: 0 }, viewport, displayed), { x: 640, y: 20 });
  assert.equal(viewportPointToDisplay({ x: 1300, y: 10 }, viewport, displayed), null, '뷰포트 밖은 그리지 않는다');
  assert.equal(viewportPointToDisplay({ x: 10, y: 10 }, viewport, { ...displayed, width: 0 }), null, '접힌 프레임에는 그리지 않는다');
});

test('허브 포인터 이벤트만 읽고 이동 시간은 범위 안으로 줄인다', () => {
  const tab = { tabId: 't1' } as never;
  assert.deepEqual(readAgentPointer({ type: 'owned_browser_pointer', tab, x: 5, y: 6, phase: 'click', durationMs: 160 }), { tabId: 't1', x: 5, y: 6, phase: 'click', durationMs: 160 });
  assert.equal(readAgentPointer({ type: 'owned_browser_pointer', tab, x: 5, y: 6, phase: 'wiggle' }), null);
  assert.equal(readAgentPointer({ type: 'owned_browser_activity', tab, x: 5, y: 6, phase: 'move' }), null);
  assert.equal(readAgentPointer({ type: 'owned_browser_pointer', tab, x: 5, y: 6, phase: 'move', durationMs: 60_000 })?.durationMs, 600);
});
