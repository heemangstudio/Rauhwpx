/**
 * Vite 개발 서버 전용 가짜 rhwpDesktop.updates. `?update-hippo=<상황>` 으로 하마의 팻말을
 * Electron 없이 띄운다. update-hippo.ts 가 import.meta.env.DEV 일 때만 동적으로 불러온다.
 *
 * 상황: available · downloading · downloaded · error · install-error · external · up-to-date ·
 * check-error · release-notes(업데이트 팻말 없이 `?release-notes` 클립보드만).
 * `&update-hippo-chats=N` 은
 * 실행 중인 채팅 수(기본 2)다. 다운로드는 3초 동안 비율을 올린 뒤 downloaded 가 되고, 재시작은
 * 콘솔에 남긴 뒤 잠시 restarting 을 보이고 돌아온다.
 * 개발 도구에서 `__updateHippoMock.set({ ... })` 로 상태를 바로 바꿀 수 있다.
 */
import type { DesktopUpdateState, DesktopUpdatesApi } from '../../desktop-integration.ts';

const VERSION = '3.0.3';

function initialState(scenario: string, chats: number): DesktopUpdateState {
  const base: DesktopUpdateState = {
    status: 'available',
    currentVersion: '3.0.2',
    version: VERSION,
    percent: null,
    install: 'in-app',
    error: null,
    manual: false,
    runningChats: chats,
  };
  switch (scenario) {
    case 'downloading': return { ...base, status: 'downloading', percent: 0 };
    case 'downloaded': return { ...base, status: 'downloaded', percent: 100 };
    case 'error':
      return { ...base, status: 'error', error: { context: 'download', message: 'net::ERR_CONNECTION_RESET' } };
    case 'install-error':
      return { ...base, error: { context: 'install', message: 'update was not applied' } };
    case 'external': return { ...base, install: 'external' };
    case 'up-to-date': return { ...base, status: 'up-to-date', version: null, manual: true };
    case 'release-notes': return { ...base, status: 'up-to-date', version: null };
    case 'check-error':
      return { ...base, status: 'idle', version: null, manual: true, error: { context: 'check', message: 'offline' } };
    default: return base;
  }
}

export function createDevUpdatesApi(scenario: string, search = location.search): DesktopUpdatesApi {
  const chatsParam = new URLSearchParams(search).get('update-hippo-chats');
  const chats = chatsParam === null ? 2 : Math.max(0, Number(chatsParam) || 0);
  let state = initialState(scenario, chats);
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  let progressTimer = 0;

  function set(patch: Partial<DesktopUpdateState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function simulateDownload(from = 0): void {
    window.clearInterval(progressTimer);
    let percent = from;
    set({ status: 'downloading', percent, error: null });
    progressTimer = window.setInterval(() => {
      percent = Math.min(100, percent + 4 + Math.random() * 6);
      if (percent >= 100) {
        window.clearInterval(progressTimer);
        set({ status: 'downloaded', percent: 100 });
      } else {
        set({ percent });
      }
    }, 200);
  }

  (window as unknown as { __updateHippoMock?: unknown }).__updateHippoMock = {
    set,
    get: () => state,
    /** 진행 시뮬레이션을 멈춘다(스크린숏용). */
    freeze: () => window.clearInterval(progressTimer),
  };

  if (state.status === 'downloading') window.setTimeout(() => simulateDownload(0), 600);

  return {
    getState: async () => state,
    onState(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async check() {
      set({ status: 'checking', manual: true, error: null });
      window.setTimeout(() => set({ status: 'available', version: VERSION, manual: true }), 800);
    },
    async download() {
      if (state.install === 'external') {
        console.info('[update-hippo mock] 릴리스 페이지를 엽니다');
        return;
      }
      simulateDownload(0);
    },
    async restart() {
      console.info('[update-hippo mock] restart', { runningChats: state.runningChats });
      set({ status: 'restarting' });
      window.setTimeout(() => set({ status: 'downloaded' }), 2400);
      return { ok: true };
    },
    setRunningChatCount(count) {
      set({ runningChats: count });
    },
    onPrepareRestart: () => () => {},
    onCommitRestart: () => () => {},
    getRestore: async () => null,
  };
}
