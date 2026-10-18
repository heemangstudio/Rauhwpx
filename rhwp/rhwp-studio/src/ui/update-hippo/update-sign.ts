/**
 * 업데이트 상태 → 하마가 든 팻말. DOM 이 없는 순수 함수라 update-hippo.ts 와 테스트가 같이 쓴다.
 *
 * 팻말이 없으면(null) 하마는 숨는다. key 가 바뀌면 하마가 가장자리 밑으로 내려갔다가 새 팻말을
 * 들고 올라오고, 같은 key 안의 변화(내려받은 비율, 채팅 수)는 그 자리에서 바뀐다.
 */
import type { DesktopUpdateState } from '../../desktop-integration.ts';

export type UpdateSignIcon = 'download' | 'reload';

export interface UpdateSignAction {
  id: 'download' | 'restart' | 'confirm' | 'cancel' | 'check';
  /** 단추 이름(aria-label). 글자 단추면 보이는 글자이기도 하다. */
  label: string;
  /** 아이콘 단추. 없으면 label 을 글자로 보인다. */
  icon?: UpdateSignIcon;
}

export interface UpdateSign {
  key: string;
  tone: 'plain' | 'warning';
  /** 팻말의 글 줄. 문장마다 한 줄이다. */
  lines: string[];
  /** 0..100. 내려받는 동안에만 있다. */
  progress: number | null;
  actions: UpdateSignAction[];
  /** 화면 읽기 프로그램이 한 번 읽을 문장. */
  spoken: string;
  /** 직접 누른 확인의 결과처럼 잠깐 보이고 내려가는 팻말이면 그 시간(ms). */
  transientMs?: number;
}

export interface UpdateSignView {
  /** 재시작 팻말을 눌러 경고 팻말을 보는 중. */
  confirming: boolean;
}

const RETRY_DOWNLOAD: UpdateSignAction = { id: 'download', label: '다시 다운로드', icon: 'reload' };

function offer(state: DesktopUpdateState, lines: string[]): UpdateSign {
  return {
    key: `offer:${state.version}:${lines.join(' ')}`,
    tone: 'plain',
    lines,
    progress: null,
    actions: [{
      id: 'download',
      label: state.install === 'external' ? '다운로드 페이지 열기' : '다운로드',
      icon: 'download',
    }],
    spoken: lines.join(' '),
  };
}

function installFailed(state: DesktopUpdateState): UpdateSign {
  return offer(state, [`v${state.version} 업데이트를 설치하지 못했어요.`, '다시 받을까요?']);
}

export function updateSign(state: DesktopUpdateState | null, view: UpdateSignView): UpdateSign | null {
  if (!state) return null;
  switch (state.status) {
    case 'available':
      if (!state.version) return null;
      if (state.error?.context === 'install') return installFailed(state);
      return offer(state, [`v${state.version} 업데이트가 있어요.`, '다운로드할까요?']);
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(state.percent ?? 0)));
      return {
        key: 'downloading',
        tone: 'plain',
        lines: [],
        progress: percent,
        actions: [],
        spoken: '다운로드하고 있어요.',
      };
    }
    case 'downloaded':
      if (view.confirming) {
        const chats = Math.max(0, Math.floor(state.runningChats));
        const line = chats > 0 ? `채팅 ${chats}개가 재시작돼요` : '앱이 재시작돼요';
        return {
          key: 'confirm',
          tone: 'warning',
          lines: [line],
          progress: null,
          actions: [{ id: 'confirm', label: '재시작', icon: 'reload' }, { id: 'cancel', label: '취소' }],
          spoken: line,
        };
      }
      return {
        key: 'downloaded',
        tone: 'plain',
        lines: ['앱 재시작'],
        progress: null,
        actions: [{ id: 'restart', label: '앱 재시작', icon: 'reload' }],
        spoken: '업데이트를 받았어요. 앱 재시작',
      };
    case 'restarting':
      return {
        key: 'restarting',
        tone: 'plain',
        lines: ['재시작하고 있어요'],
        progress: null,
        actions: [],
        spoken: '재시작하고 있어요',
      };
    case 'error':
      if (state.error?.context === 'install' && state.version) return installFailed(state);
      if (state.error?.context === 'check') return checkFailed();
      return {
        key: 'download-failed',
        tone: 'plain',
        lines: ['다운로드하지 못했어요'],
        progress: null,
        actions: [RETRY_DOWNLOAD],
        spoken: '다운로드하지 못했어요',
      };
    case 'idle':
      return state.manual && state.error?.context === 'check' ? checkFailed() : null;
    case 'up-to-date':
      if (!state.manual) return null;
      return {
        key: 'up-to-date',
        tone: 'plain',
        lines: ['최신 버전이에요'],
        progress: null,
        actions: [],
        spoken: '최신 버전이에요',
        transientMs: 3200,
      };
    default:
      return null;
  }
}

function checkFailed(): UpdateSign {
  return {
    key: 'check-failed',
    tone: 'plain',
    lines: ['업데이트를 확인하지 못했어요'],
    progress: null,
    actions: [{ id: 'check', label: '다시 확인', icon: 'reload' }],
    spoken: '업데이트를 확인하지 못했어요',
    transientMs: 8000,
  };
}
