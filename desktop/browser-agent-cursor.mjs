// 에이전트 커서: 보이는 게스트 위에 커서 크기의 투명 뷰를 잠깐 띄운다.
// 웹 페이지 DOM 에는 아무것도 넣지 않는다. 뷰는 이동과 누름이 끝나면 곧 숨겨 사용자 입력을 오래 가리지 않는다.

export const AGENT_CURSOR_SIZE = { width: 24, height: 28 };
// 화살표 끝이 뷰 안에서 놓인 위치. 페이지 좌표는 이 점에 맞춘다.
const HOT_SPOT = 2;
const FRAME_MS = 16;
const MAX_GLIDE_MS = 600;
const PHASES = new Set(['move', 'down', 'up', 'click']);
// 누름이 끝난 뒤 남겨 두는 시간. 끌기 중(down)에는 놓을 때까지 조금 더 기다린다.
const LINGER_MS = { move: 400, click: 260, up: 220, down: 1500 };

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;user-select:none;cursor:default}
svg{display:block;fill:#171b22;stroke:#fff;stroke-width:1.3;stroke-linejoin:round;filter:drop-shadow(0 1px 1.5px rgb(0 0 0 / .3));transform-origin:2px 2px;transition:transform 70ms ease-out}
body.pressed svg{transform:scale(.8)}
</style><body><svg viewBox="0 0 18 22" width="18" height="22"><path d="M2 2v15.2l3.9-3.6 2.8 6.3 2.7-1.2-2.8-6.2h5.3z"/></svg>
<script>let timer;function press(phase){clearTimeout(timer);if(phase==='up'){document.body.className='';return}document.body.className='pressed';if(phase==='click')timer=setTimeout(()=>{document.body.className=''},110)}</script>`;
const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`;

/** 페이지 CSS px 를 창 콘텐츠 좌표(DIP)로 옮긴다. 확대 배율을 반영하고 게스트 밖이면 null. */
export function agentCursorPoint({ bounds, zoomFactor, x, y }) {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  if (!bounds || !(bounds.width > 0 && bounds.height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const left = x * zoom; const top = y * zoom;
  if (left < 0 || top < 0 || left > bounds.width || top > bounds.height) return null;
  return { x: bounds.x + left, y: bounds.y + top };
}

/** 커서 뷰의 자리. 게스트 오른쪽·아래 가장자리 밖으로는 나가지 않게 자른다. */
export function agentCursorBounds(point, guest) {
  const x = Math.round(point.x) - HOT_SPOT; const y = Math.round(point.y) - HOT_SPOT;
  return { x, y, width: Math.max(1, Math.min(AGENT_CURSOR_SIZE.width, guest.x + guest.width - x)), height: Math.max(1, Math.min(AGENT_CURSOR_SIZE.height, guest.y + guest.height - y)) };
}

export function readAgentPointer(payload) {
  const { x, y, phase, durationMs } = payload ?? {};
  if (!Number.isFinite(x) || !Number.isFinite(y) || !PHASES.has(phase)) return null;
  return { x, y, phase, durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.min(MAX_GLIDE_MS, durationMs)) : 0 };
}

const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export class AgentCursorOverlay {
  constructor({ WebContentsView, setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now() }) {
    this.WebContentsView = WebContentsView;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.cursors = new Map();
  }

  cursor(window) {
    let cursor = this.cursors.get(window);
    if (cursor && !cursor.view.webContents.isDestroyed()) return cursor;
    const view = new this.WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, transparent: true, backgroundThrottling: false, spellcheck: false } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    void view.webContents.loadURL(PAGE_URL).catch(() => {});
    cursor = { view, window, tab: null, last: null, timer: null };
    this.cursors.set(window, cursor);
    window.once?.('closed', () => this.release(window));
    return cursor;
  }

  /** 보이는 게스트 위에서만 그린다. 그리지 않았으면 false. */
  show({ window, tab, bounds, zoomFactor, x, y, phase, durationMs }) {
    const point = agentCursorPoint({ bounds, zoomFactor, x, y });
    if (!point || window.isDestroyed()) { this.hide(window); return false; }
    const cursor = this.cursor(window);
    this.stop(cursor);
    const content = window.contentView;
    // 게스트를 다시 올렸으면(띄우기 등) 커서를 그 위로 옮긴다.
    if (content.children.at(-1) !== cursor.view) content.addChildView(cursor.view);
    // 숨긴 뒤에도 같은 탭이면 마지막 페이지 좌표에서 다시 미끄러진다. 게스트가 움직였어도 페이지 기준이라 맞는다.
    const from = cursor.tab === tab && cursor.last ? agentCursorPoint({ bounds, zoomFactor, ...cursor.last }) : null;
    cursor.tab = tab; cursor.last = { x, y };
    const duration = from ? durationMs : 0;
    const start = this.now();
    const step = () => {
      cursor.timer = null;
      if (window.isDestroyed() || cursor.view.webContents.isDestroyed()) return;
      const progress = duration > 0 ? Math.min(1, (this.now() - start) / duration) : 1;
      const eased = ease(progress);
      const at = from ? { x: from.x + (point.x - from.x) * eased, y: from.y + (point.y - from.y) * eased } : point;
      cursor.view.setBounds(agentCursorBounds(at, bounds));
      if (!cursor.view.getVisible()) cursor.view.setVisible(true);
      if (progress < 1) { cursor.timer = this.setTimer(step, FRAME_MS); return; }
      if (phase !== 'move') void cursor.view.webContents.executeJavaScript(`press(${JSON.stringify(phase)})`, false).catch(() => {});
      cursor.timer = this.setTimer(() => { cursor.timer = null; this.hide(window); }, LINGER_MS[phase]);
    };
    step();
    return true;
  }

  stop(cursor) { if (cursor.timer) this.clearTimer(cursor.timer); cursor.timer = null; }

  hide(window, { forget = false } = {}) {
    const cursor = this.cursors.get(window);
    if (!cursor) return;
    this.stop(cursor);
    if (forget) { cursor.tab = null; cursor.last = null; }
    if (!cursor.view.webContents.isDestroyed()) {
      cursor.view.setVisible(false);
      void cursor.view.webContents.executeJavaScript('press("up")', false).catch(() => {});
    }
  }

  /** 게스트를 떼거나 옮기면 그 위의 커서도 바로 숨긴다. */
  hideTab(tab) { for (const [window, cursor] of this.cursors) if (cursor.tab === tab) this.hide(window, { forget: true }); }

  release(window) {
    const cursor = this.cursors.get(window);
    if (!cursor) return;
    this.stop(cursor);
    this.cursors.delete(window);
    if (!window.isDestroyed?.()) window.contentView?.removeChildView(cursor.view);
    if (!cursor.view.webContents.isDestroyed()) cursor.view.webContents.close();
  }

  dispose() { for (const window of [...this.cursors.keys()]) this.release(window); }
}
