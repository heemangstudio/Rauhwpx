import type { DesktopUpdateState, UpdateAllState } from '../../desktop-integration.ts';
import type { PlanStatus } from '../plan/plan-types.ts';
import { updateSign, type UpdateSign, type UpdateSignAction, type UpdateSignView } from './update-sign.ts';

const NAME = { app: 'HamaEditor', claude: 'Claude', codex: 'Codex' };
const STATUS = { available: '', manual: '직접 설치', queued: '대기', waiting: '채팅 종료 대기',
  running: '업데이트 중', ready: '재시작 대기', done: '완료', failed: '실패' };

/** 홈에서는 로그인한 유료 사용자에게만 CLI 업데이트를 권한다. 앱 업데이트는 누구나 받는다. */
export function homeUpdateSign(
  all: UpdateAllState | null,
  app: DesktopUpdateState | null,
  plan: PlanStatus | null,
  view: UpdateSignView,
): UpdateSign | null {
  return plan?.signedIn && plan.tier !== 'free' && plan.agentUnlocked
    ? updateAllSign(all)
    : updateSign(app, view);
}

/** One sign for the whole application-wide run, with stable keys during progress. */
export function updateAllSign(state: UpdateAllState | null): UpdateSign | null {
  if (!state || state.items.length === 0 && !state.error) return null;
  const offers = state.items.filter((item) => item.status === 'available' || item.status === 'manual');
  const failed = state.items.some((item) => item.status === 'failed');
  const actions: UpdateSignAction[] = [];
  const active = ['checking', 'updating', 'waiting', 'countdown', 'restarting'].includes(state.phase);
  const lines = state.items.map((item) => `${NAME[item.id]} ${item.targetVersion}${STATUS[item.status] ? ` ${STATUS[item.status]}` : ''}`);
  if (state.phase === 'countdown') {
    lines.push('곧 앱을 재시작해요');
    actions.push({ id: 'later', label: '나중에' });
  } else if (state.phase === 'deferred') {
    actions.push({ id: 'update-all', label: '재시작', icon: 'reload' });
  } else if (state.phase === 'restarting') {
    lines.push('앱을 재시작하고 있어요');
  } else if (state.phase === 'waiting') {
    lines.push('채팅이 끝나면 계속할게요');
  } else if (!active && (offers.some((item) => item.status === 'available') || failed || state.error)) {
    actions.push({ id: 'update-all', label: failed || state.error ? '실패한 항목 다시 시도'
      : offers.some((item) => item.id === 'app' && item.status !== 'manual') ? '모두 업데이트하고 재시작' : '모두 업데이트', icon: failed ? 'reload' : 'download' });
  }
  if (!active && state.items.some((item) => item.status === 'manual')) {
    actions.push({ id: 'download', label: '앱 다운로드 페이지', icon: 'download' });
  }
  const failure = state.items.find((item) => item.status === 'failed' && item.message);
  const detail = failure?.message ?? state.error ?? '';
  if (detail) lines.push(detail.slice(0, 32));
  const appDownloading = state.items.some((item) => item.id === 'app' && item.status === 'running');
  return {
    key: `all:${active ? 'working' : state.phase}:${lines.length}:${actions.map((action) => action.id).join(',')}:${appDownloading}`,
    tone: failed || state.error ? 'warning' : 'plain', lines,
    progress: appDownloading ? Math.max(0, Math.min(100, Math.floor(state.appPercent ?? 0))) : null,
    actions, spoken: lines.join(' '), detail,
    ...(!active && !failed && !offers.length && state.phase === 'complete' ? { transientMs: 5000 } : {}),
  };
}
