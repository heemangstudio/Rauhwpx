// 요금제 상태 한 벌. rhwpDesktop.plan 을 읽고 바뀔 때마다 알린다.
// 요금제 API 가 없으면(웹 Studio, 예전 데스크톱) 에이전트는 열려 있고 잠금도 업그레이드 단추도 없다.
import type { DesktopPlanApi, PlanStatus } from './plan-types.ts';

export interface PlanStore {
  readonly api: DesktopPlanApi | null;
  /** 아직 모르거나 API 가 없으면 null. */
  status(): PlanStatus | null;
  subscribe(listener: (status: PlanStatus | null) => void): () => void;
  dispose(): void;
}

/** 데스크톱 앱의 요금제 API. 웹·미리보기에는 없다. */
export function desktopPlanApi(host: { rhwpDesktop?: { plan?: DesktopPlanApi } } = globalThis as never): DesktopPlanApi | null {
  return host?.rhwpDesktop?.plan ?? null;
}

/** 무료 요금제에서 에이전트를 잠그는지. 상태를 모르면 잠그지 않는다. */
export function planLocksAgent(status: PlanStatus | null): boolean {
  return status !== null && status.tier === 'free' && !status.agentUnlocked;
}

/** 모델 이름 옆 ↑ 단추. 요금제를 알고 Hama 가 아닐 때만. */
export function planShowsUpgrade(status: PlanStatus | null): boolean {
  return status !== null && status.tier !== 'hama';
}

export function createPlanStore(api: DesktopPlanApi | null): PlanStore {
  let current: PlanStatus | null = null;
  let disposed = false;
  const listeners = new Set<(status: PlanStatus | null) => void>();
  const accept = (next: PlanStatus): void => {
    if (disposed || !next || typeof next.tier !== 'string') return;
    current = next;
    for (const listener of [...listeners]) listener(current);
  };
  const unsubscribe = api?.onChange(accept) ?? (() => {});
  if (api) {
    void api.getStatus().then((status) => {
      // onChange 가 먼저 더 새 상태를 줬으면 덮지 않는다.
      if (current === null) accept(status);
    }, () => { /* 모르면 잠그지 않는다 */ });
  }
  return {
    api,
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      unsubscribe();
    },
  };
}
