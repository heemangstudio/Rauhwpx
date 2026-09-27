import type { CloudLinkState, CloudSnapshot } from './types.ts';

export const READY_CLOUD_LINK: CloudLinkState = {
  kind: 'ready',
  error: null,
  attempt: 0,
  canRecreate: false,
};

export function inferCloudLink(snapshot: CloudSnapshot): CloudLinkState {
  if (snapshot.link) return snapshot.link;
  const canRecreate = snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted';
  if (snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'testing') {
    return { kind: 'reconnecting', error: null, attempt: 0, canRecreate };
  }
  if (snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'error') {
    return { kind: 'failed', error: snapshot.profile.message, attempt: 0, canRecreate };
  }
  return { ...READY_CLOUD_LINK, canRecreate };
}

export function beginCloudReconnect(current: CloudLinkState, canRecreate: boolean): CloudLinkState {
  if (current.kind === 'reconnecting' || current.kind === 'recreating') {
    return { ...current, canRecreate: current.kind === 'recreating' ? true : canRecreate };
  }
  return {
    kind: 'reconnecting',
    error: null,
    attempt: current.attempt + 1,
    canRecreate,
  };
}

export function beginCloudRecreate(current: CloudLinkState): CloudLinkState {
  if (current.kind === 'recreating') return current;
  return {
    kind: 'recreating',
    error: null,
    attempt: current.attempt + 1,
    canRecreate: true,
  };
}

export function markCloudLinkReady(canRecreate: boolean): CloudLinkState {
  return { kind: 'ready', error: null, attempt: 0, canRecreate };
}

export function markCloudLinkFailed(
  current: CloudLinkState,
  error: string,
  canRecreate: boolean,
): CloudLinkState {
  return {
    kind: 'failed',
    error,
    attempt: current.attempt,
    canRecreate,
  };
}

export function shouldAutoRecreate(link: CloudLinkState): boolean {
  return link.canRecreate && link.kind === 'failed' && link.attempt >= 2;
}

export function cloudLinkNeedsAttention(link: CloudLinkState): boolean {
  return link.kind !== 'ready';
}

/** 복구 줄의 버튼이 하는 일. */
export type CloudLinkAction =
  | 'reconnect'
  | 'pair'
  | 'boat-key'
  | 'trust-host-key'
  | 'restart'
  | 'discard'
  | 'recreate';

export interface CloudLinkRecovery {
  title: string;
  actions: Array<{ action: CloudLinkAction; label: string }>;
}

/**
 * 실패한 링크에 보일 제목과 버튼. 첫 버튼이 주 동작이고 보조 동작은 하나까지다.
 * boat 는 앱이 VM 을 다루므로 페어링과 호스트 키를 다시 연결 안에서 스스로 고친다.
 */
export function cloudLinkRecovery(
  link: CloudLinkState,
  host: { boat: boolean; selfHosted: boolean; canRestart: boolean },
): CloudLinkRecovery {
  const reconnect = { action: 'reconnect' as const, label: '다시 연결' };
  const recreate = link.canRecreate ? [{ action: 'recreate' as const, label: '서버 다시 만들기' }] : [];
  const restartable = host.canRestart && (host.boat || host.selfHosted);
  const title = link.message ?? 'Cloud 서버에 연결할 수 없습니다.';
  switch (link.reason) {
    case 'pairing':
      return { title, actions: [host.selfHosted && !host.boat
        ? { action: 'pair', label: '다시 페어링' }
        : { ...reconnect, label: '다시 페어링' }] };
    case 'boat-auth':
      return { title, actions: [{ action: 'boat-key', label: 'API 키 입력' }] };
    case 'host-key':
      return { title, actions: [host.selfHosted && !host.boat
        ? { action: 'trust-host-key', label: '서버 키 다시 확인' }
        : reconnect] };
    case 'server':
      return { title, actions: restartable ? [{ action: 'restart', label: '서버 재시작' }, reconnect] : [reconnect, ...recreate] };
    case 'session-missing':
      return { title, actions: [{ action: 'discard', label: '기록 지우기' }, ...recreate] };
    default:
      return { title, actions: [reconnect, ...recreate] };
  }
}
