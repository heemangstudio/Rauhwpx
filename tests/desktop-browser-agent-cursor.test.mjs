import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCursorOverlay, agentCursorPoint } from '../desktop/browser-agent-cursor.mjs';

test('페이지 CSS px 는 게스트 위치와 확대 배율을 거쳐 창 좌표가 되고, 게스트 밖은 그리지 않는다', () => {
  const bounds = { x: 300, y: 80, width: 600, height: 400 };
  assert.deepEqual(agentCursorPoint({ bounds, zoomFactor: 1, x: 100, y: 50 }), { x: 400, y: 130 });
  assert.deepEqual(agentCursorPoint({ bounds, zoomFactor: 1.5, x: 100, y: 50 }), { x: 450, y: 155 });
  assert.equal(agentCursorPoint({ bounds, zoomFactor: 2, x: 350, y: 10 }), null, '확대하면 보이는 영역 밖이 된다');
  assert.equal(agentCursorPoint({ bounds: { ...bounds, width: 0 }, zoomFactor: 1, x: 1, y: 1 }), null);
});

function fixture() {
  const timers = new Map(); let clock = 0; let nextTimer = 1;
  const views = [];
  class View {
    constructor() { this.bounds = null; this.visible = true; this.boundsHistory = []; this.scripts = []; views.push(this);
      this.webContents = { destroyed: false, isDestroyed: () => this.webContents.destroyed, setWindowOpenHandler() {}, on() {}, loadURL: async () => {},
        executeJavaScript: async (code) => { this.scripts.push(code); }, close: () => { this.webContents.destroyed = true; } }; }
    setBackgroundColor() {} setVisible(value) { this.visible = value; } getVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; this.boundsHistory.push(bounds); }
  }
  const children = [];
  const window = { destroyed: false, isDestroyed: () => window.destroyed, once() {},
    contentView: { children, addChildView: (view) => { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); children.push(view); }, removeChildView: (view) => { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); } } };
  const overlay = new AgentCursorOverlay({ WebContentsView: View, now: () => clock,
    setTimer: (callback, ms) => { const id = nextTimer++; timers.set(id, { at: clock + ms, callback }); return id; },
    clearTimer: (id) => timers.delete(id) });
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].callback();
    }
    clock = end;
  };
  return { overlay, window, views, advance, children };
}

test('에이전트 커서는 게스트 위로 미끄러진 뒤 누르고, 잠깐 뒤 숨어 입력을 가리지 않는다', () => {
  const { overlay, window, views, advance, children } = fixture();
  const guest = { id: 'guest' }; children.push(guest);
  const bounds = { x: 0, y: 40, width: 600, height: 400 };
  assert.equal(overlay.show({ window, tab: guest, bounds, zoomFactor: 1, x: 10, y: 10, phase: 'move', durationMs: 160 }), true);
  const [view] = views;
  assert.equal(children.at(-1), view, '커서는 게스트 위에 있다');
  assert.deepEqual(view.bounds, { x: 8, y: 48, width: 24, height: 28 }, '처음에는 미끄러지지 않고 그 자리에 나타난다');
  overlay.show({ window, tab: guest, bounds, zoomFactor: 1, x: 210, y: 110, phase: 'click', durationMs: 160 });
  advance(80);
  const middle = view.bounds;
  assert.ok(middle.x > 8 && middle.x < 208, `중간 프레임은 두 점 사이에 있다: ${middle.x}`);
  assert.equal(view.scripts.length, 0, '이동이 끝나기 전에는 누르지 않는다');
  advance(100);
  assert.deepEqual(view.bounds, { x: 208, y: 148, width: 24, height: 28 });
  assert.deepEqual(view.scripts, ['press("click")']);
  assert.equal(view.visible, true);
  advance(400);
  assert.equal(view.visible, false, '누름이 끝나면 숨는다');
  // 숨은 뒤 다음 동작은 마지막 자리에서 다시 미끄러진다.
  overlay.show({ window, tab: guest, bounds, zoomFactor: 1, x: 410, y: 110, phase: 'move', durationMs: 160 });
  assert.equal(view.bounds.x, 208);
  overlay.hideTab(guest);
  assert.equal(view.visible, false, '게스트를 떼면 바로 숨는다');
  assert.equal(overlay.show({ window, tab: guest, bounds, zoomFactor: 1, x: 900, y: 10, phase: 'move', durationMs: 160 }), false);
  overlay.dispose();
  assert.equal(view.webContents.isDestroyed(), true);
  assert.equal(children.includes(view), false);
});
