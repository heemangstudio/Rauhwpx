import { readFile } from 'node:fs/promises';

import { APP_ID, PRODUCT_NAME } from './app-identity.mjs';
import { SerializedStateWriter } from './serialized-state-writer.mjs';

/**
 * 네이티브 셸 연동: 창 위치 복원, 문서 상태(프록시 아이콘·미저장 점),
 * 백그라운드 채팅 알림과 앱 아이콘 배지, 네이티브 우클릭 메뉴, 저장 확인 시트.
 * Electron 모듈은 주입받아 main.mjs 밖에서도 읽기 쉽게 둔다.
 */

const MIN_VISIBLE_EDGE = 80;

function finiteInt(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bounds = {
    x: finiteInt(raw.x),
    y: finiteInt(raw.y),
    width: finiteInt(raw.width),
    height: finiteInt(raw.height),
  };
  if (Object.values(bounds).some((value) => value === null)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return bounds;
}

/** 저장된 사각형을 보이는 디스플레이의 작업 영역 안으로 끌어온다. */
export function clampBoundsToDisplay(bounds, workArea, minimum = { width: 0, height: 0 }) {
  const width = Math.min(Math.max(bounds.width, minimum.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, minimum.height), workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function overlapsEnough(bounds, workArea) {
  const w = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const h = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  return w >= MIN_VISIBLE_EDGE && h >= MIN_VISIBLE_EDGE;
}

/** 마지막으로 닫히거나 옮겨진 창의 프레임을 기억해 다음 실행의 첫 창에 돌려준다. */
export class WindowFrameStore {
  #filePath;
  #screen;
  #state = null;
  #restoredThisLaunch = false;
  #writer;

  constructor({ filePath, screen, writeAtomically }) {
    this.#filePath = filePath;
    this.#screen = screen;
    this.#writer = new SerializedStateWriter({
      write: (snapshot) => writeAtomically(filePath, Buffer.from(snapshot, 'utf8')),
      onError: (error) => console.warn('[hamaeditor] window frame persist failed:', error),
    });
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8'));
      const bounds = normalizeBounds(parsed?.bounds);
      this.#state = bounds ? { bounds, zoomed: parsed.zoomed === true } : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[hamaeditor] window frame state unreadable:', error);
      this.#state = null;
    }
  }

  /** 첫 창이면 복원할 프레임을, 아니면 null 을 준다(추가 창은 기존 계단식 배치). */
  takeInitialFrame({ minWidth = 0, minHeight = 0 } = {}) {
    if (this.#restoredThisLaunch) return null;
    this.#restoredThisLaunch = true;
    if (!this.#state) return null;
    const { bounds, zoomed } = this.#state;
    const displays = this.#screen.getAllDisplays();
    const visible = displays.some((display) => overlapsEnough(bounds, display.workArea));
    const display = visible
      ? this.#screen.getDisplayMatching(bounds)
      : this.#screen.getPrimaryDisplay();
    const source = visible
      ? bounds
      : {
          ...bounds,
          x: display.workArea.x + Math.round((display.workArea.width - bounds.width) / 2),
          y: display.workArea.y + Math.round((display.workArea.height - bounds.height) / 2),
        };
    return {
      bounds: clampBoundsToDisplay(source, display.workArea, { width: minWidth, height: minHeight }),
      zoomed,
    };
  }

  track(window) {
    let timer = null;
    const capture = () => {
      if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
      const bounds = normalizeBounds(window.getNormalBounds());
      if (!bounds) return;
      this.#state = { bounds, zoomed: window.isMaximized() };
      this.#writer.enqueue(JSON.stringify(this.#state));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        capture();
      }, 400);
      timer.unref?.();
    };
    for (const eventName of ['moved', 'resized', 'maximize', 'unmaximize']) {
      window.on(eventName, schedule);
    }
    window.on('close', () => {
      if (timer) clearTimeout(timer);
      timer = null;
      capture();
    });
  }
}

const ATTENTION_THREAD_ID = /^[\w.:-]{1,128}$/;
const ATTENTION_TEXT_MAX = 200;
const ATTENTION_COUNT_MAX = 9999;
/** 한 창에서 같은 채팅의 알림 사이 최소 간격. */
const ATTENTION_THREAD_INTERVAL_MS = 10_000;
/** 한 창이 1분에 올릴 수 있는 알림 수. */
const ATTENTION_WINDOW_LIMIT = 6;
const ATTENTION_WINDOW_SPAN_MS = 60_000;

/**
 * Windows 는 앱 id 가 시작 메뉴 바로가기의 id 와 같을 때만 그 앱의 알림을 띄운다. 설치본은
 * build.appId(APP_ID)를, 바로가기가 없는 개발 실행은 실행 파일 경로를 쓴다(Electron 이 권하는 개발용 id) —
 * 개발 실행이 설치된 앱의 id 로 알림을 가로채지 않는다. 다른 플랫폼은 아무것도 하지 않는다.
 */
export function applyAppUserModelId({ app, platform = process.platform, execPath = process.execPath }) {
  if (platform !== 'win32') return null;
  const id = app.isPackaged ? APP_ID : execPath;
  app.setAppUserModelId(id);
  return id;
}

/**
 * 렌더러가 보낸 백그라운드 채팅 알림을 검증한다. 채팅 id 가 맞지 않으면 null(버린다).
 * 제목과 본문은 200자로 자른다.
 */
export function normalizeAttentionNotice(payload) {
  const threadId = typeof payload?.threadId === 'string' ? payload.threadId : '';
  if (!ATTENTION_THREAD_ID.test(threadId)) return null;
  const text = (value) => (typeof value === 'string' ? value.slice(0, ATTENTION_TEXT_MAX) : '');
  return { threadId, title: text(payload.title) || PRODUCT_NAME, body: text(payload.body) };
}

/** 배지 수 — 0~9999 의 정수. */
export function normalizeAttentionCount(count) {
  const value = Math.floor(Number(count));
  return Number.isFinite(value) && value > 0 ? Math.min(value, ATTENTION_COUNT_MAX) : 0;
}

/** Windows 작업 표시줄의 겹침 표시 — 16×16 빨간 원(BGRA, 미리 곱한 알파). 그림 파일 없이 만든다. */
function attentionDotBitmap() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = 6.5;
  // #d93a30 — 앱의 오류 빨강.
  const [r, g, b] = [0xd9, 0x3a, 0x30];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(b * alpha);
      buffer[offset + 1] = Math.round(g * alpha);
      buffer[offset + 2] = Math.round(r * alpha);
      buffer[offset + 3] = Math.round(255 * alpha);
    }
  }
  return { buffer, size };
}

/**
 * 백그라운드 채팅 알림과 앱 아이콘 배지 — 창마다 알렸지만 아직 보지 않은 채팅 수를 모은다.
 *
 * - notify: 초점 없는 창의 채팅만 알린다(초점이 있으면 렌더러가 토스트로 대신한다 — 경쟁을 막는다).
 *   macOS 는 Dock 을 튕기고, Windows·Linux 는 작업 표시줄 단추를 깜빡인다. 알림을 누르면 창을
 *   되살려 앞으로 가져오고 그 채팅을 열게 한다. 렌더러가 고장 나거나 탈취돼도 알림을 쏟아내지
 *   못하게 창마다 같은 채팅은 10초에 한 번, 모두 합쳐 1분에 6번까지만 알리고 나머지는 조용히 버린다.
 * - setCount/forget: macOS·Linux 는 창들의 합을 앱 배지(app.setBadgeCount)로, Windows 는 창마다
 *   자기 수로 작업 표시줄 겹침 표시를 단다.
 * - focused: 창이 초점을 얻으면 깜빡임을 멈춘다.
 *
 * Electron 모듈과 플랫폼은 주입받는다 — 테스트가 모든 갈래를 돌린다.
 */
export class AgentAttention {
  #app;
  #Notification;
  #nativeImage;
  #platform;
  #now;
  /** windowId → { window, count } */
  #counts = new Map();
  /** windowId → { times: 최근 1분의 알림 시각, threads: threadId → 마지막 알림 시각 } */
  #recent = new Map();
  #notifications = new Set();
  #overlay = null;

  constructor({ app, Notification, nativeImage = null, platform = process.platform, now = Date.now }) {
    this.#app = app;
    this.#Notification = Notification;
    this.#nativeImage = nativeImage;
    this.#platform = platform;
    this.#now = now;
  }

  notify(window, payload) {
    const notice = normalizeAttentionNotice(payload);
    if (!notice || !window || window.isDestroyed() || window.isFocused()) return;
    if (!this.#admit(window.id, notice.threadId)) return;
    try {
      if (this.#platform === 'darwin') this.#app.dock?.bounce('informational');
      else window.flashFrame?.(true);
    } catch (error) {
      console.warn('[hamaeditor] agent attention flash failed:', error);
    }
    try {
      if (!this.#Notification?.isSupported?.()) return;
      const notification = new this.#Notification({ title: notice.title, body: notice.body, silent: false });
      // 클릭 전에 GC 되지 않도록 붙잡아 둔다.
      this.#notifications.add(notification);
      const release = () => this.#notifications.delete(notification);
      notification.on('click', () => {
        release();
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (!window.webContents.isDestroyed()) {
          window.webContents.send('desktop:open-agent-chat', { threadId: notice.threadId });
        }
      });
      notification.on('close', release);
      notification.show();
    } catch (error) {
      console.warn('[hamaeditor] agent notification failed:', error);
    }
  }

  setCount(window, count) {
    if (!window) return;
    const next = normalizeAttentionCount(count);
    if (next === 0) this.#counts.delete(window.id);
    else this.#counts.set(window.id, { window, count: next });
    this.#syncBadge();
    if (this.#platform === 'win32') this.#syncOverlay(window, next);
  }

  forget(windowId) {
    this.#recent.delete(windowId);
    if (this.#counts.delete(windowId)) this.#syncBadge();
  }

  /** 이 창의 이 채팅 알림을 지금 올려도 되는가 — 되면 시각을 남긴다. */
  #admit(windowId, threadId) {
    const at = this.#now();
    let entry = this.#recent.get(windowId);
    if (!entry) {
      entry = { times: [], threads: new Map() };
      this.#recent.set(windowId, entry);
    }
    entry.times = entry.times.filter((time) => at - time < ATTENTION_WINDOW_SPAN_MS);
    for (const [id, time] of entry.threads) {
      if (at - time >= ATTENTION_THREAD_INTERVAL_MS) entry.threads.delete(id);
    }
    if (entry.threads.has(threadId) || entry.times.length >= ATTENTION_WINDOW_LIMIT) return false;
    entry.times.push(at);
    entry.threads.set(threadId, at);
    return true;
  }

  focused(window) {
    if (!window || window.isDestroyed?.()) return;
    if (this.#platform === 'darwin') return;
    try {
      window.flashFrame?.(false);
    } catch {
      /* 깜빡임을 멈추지 못해도 다음 초점에서 다시 시도한다 */
    }
  }

  #total() {
    let total = 0;
    for (const entry of this.#counts.values()) total += entry.count;
    return Math.min(total, ATTENTION_COUNT_MAX);
  }

  #syncBadge() {
    if (this.#platform !== 'darwin' && this.#platform !== 'linux') return;
    try {
      // Linux 는 .desktop 파일이 있는 런처(Unity 계열)에서만 보인다 — 없으면 조용히 false 다.
      this.#app.setBadgeCount?.(this.#total());
    } catch (error) {
      console.warn('[hamaeditor] badge update failed:', error);
    }
  }

  #syncOverlay(window, count) {
    if (window.isDestroyed?.() || typeof window.setOverlayIcon !== 'function') return;
    try {
      if (count > 0) {
        this.#overlay ??= this.#createOverlay();
        if (!this.#overlay) return;
        window.setOverlayIcon(this.#overlay, `확인할 채팅 ${count}개`);
      } else {
        window.setOverlayIcon(null, '');
      }
    } catch (error) {
      console.warn('[hamaeditor] taskbar overlay update failed:', error);
    }
  }

  #createOverlay() {
    if (!this.#nativeImage?.createFromBitmap) return null;
    const { buffer, size } = attentionDotBitmap();
    return this.#nativeImage.createFromBitmap(buffer, { width: size, height: size });
  }
}

/** 렌더러가 넘긴 항목을 검증해 네이티브 메뉴로 띄우고 고른 id 를 돌려준다. */
export function popupContextMenu({ Menu, window, items }) {
  return new Promise((resolve) => {
    const template = [];
    for (const item of Array.isArray(items) ? items.slice(0, 64) : []) {
      if (item?.type === 'separator') {
        if (template.length && template.at(-1).type !== 'separator') template.push({ type: 'separator' });
        continue;
      }
      if (typeof item?.id !== 'string' || typeof item.label !== 'string') continue;
      const id = item.id.slice(0, 200);
      const entry = {
        label: item.label.slice(0, 200),
        enabled: item.enabled !== false,
        click: () => resolve(id),
      };
      if (typeof item.checked === 'boolean' && item.checked) {
        entry.type = 'checkbox';
        entry.checked = true;
      }
      template.push(entry);
    }
    while (template.at(-1)?.type === 'separator') template.pop();
    if (!template.length || window.isDestroyed()) {
      resolve(null);
      return;
    }
    // 닫힘 callback 이 click 보다 먼저 올 수 있어 null 은 조금 늦게 확정한다.
    Menu.buildFromTemplate(template).popup({
      window,
      callback: () => setTimeout(() => resolve(null), 50),
    });
  });
}

/** 입력 필드나 선택한 글자에만 네이티브 텍스트 메뉴를 띄운다. */
export function installTextContextMenu({ Menu, webContents, window, isMac }) {
  webContents.on('context-menu', (_event, params) => {
    const hasSelection = typeof params.selectionText === 'string' && params.selectionText.trim().length > 0;
    if (!params.isEditable && !hasSelection) return;
    const flags = params.editFlags ?? {};
    const template = [];
    if (params.isEditable && params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions ?? []).slice(0, 5);
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion),
        });
      }
      if (suggestions.length) template.push({ type: 'separator' });
    }
    if (isMac && hasSelection) {
      const word = params.selectionText.trim().replace(/\s+/g, ' ');
      const shown = word.length > 24 ? `${word.slice(0, 24)}…` : word;
      template.push({ label: `"${shown}" 찾아보기`, click: () => webContents.showDefinitionForSelection() });
      template.push({ type: 'separator' });
    }
    if (params.isEditable) {
      template.push({ role: 'cut', label: '오려두기', enabled: flags.canCut !== false });
    }
    template.push({ role: 'copy', label: '복사하기', enabled: flags.canCopy !== false });
    if (params.isEditable) {
      template.push({ role: 'paste', label: '붙여넣기', enabled: flags.canPaste !== false });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll', label: '모두 선택', enabled: flags.canSelectAll !== false });
    }
    Menu.buildFromTemplate(template).popup({ window });
  });
}

/** macOS 창에 붙는 저장 확인 시트. */
export async function showUnsavedChangesSheet({ dialog, window, fileName }) {
  const name = typeof fileName === 'string' && fileName.trim() ? fileName.trim().slice(0, 200) : '현재 문서';
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `"${name}"의 변경 내용을 저장하시겠습니까?`,
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
}

/** 닫기 버튼의 미저장 점. */
export function applyDocumentState(window, { edited }) {
  if (process.platform !== 'darwin' || window.isDestroyed()) return;
  window.setDocumentEdited(edited === true);
}
